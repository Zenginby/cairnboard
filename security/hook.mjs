// Git hook entry point. Fails closed: any read error or missing configuration blocks the operation.
// Usage: node security/hook.mjs staged | commit-msg <file> | push   (push reads git's stdin ref lines)
import { readFileSync } from 'node:fs';
import { loadDenylist } from './denylist.mjs';
import { git, gitBuffer } from './git.mjs';
import { scanText, formatFindings } from './scan.mjs';

const ZERO = /^0+$/;

function stop(message, code) {
  console.error(`blocked: ${message}`);
  process.exit(code);
}

function context() {
  if (!process.env.CAIRN_DENYLIST) stop('denylist not configured (set CAIRN_DENYLIST)', 2);
  let terms;
  try {
    ({ terms } = loadDenylist(process.env.CAIRN_DENYLIST));
  } catch (error) {
    stop(`cannot read denylist (${error.code ?? 'INVALID'})`, 2);
  }
  // The local commit identity is public by design; it must not trip its own owner's denylist.
  const identity = git(['config', 'user.email']).trim();
  return { terms, allowIdentities: identity ? [identity] : [] };
}

function staged(ctx) {
  const findings = [];
  const paths = git(['-c', 'core.quotePath=false', 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']).split('\0').filter(Boolean);
  for (const [index, path] of paths.entries()) {
    // A path that itself matches must not be printed: label it by position instead.
    const nameFindings = scanText(path, { ...ctx, file: `staged file #${index + 1} (name)` });
    findings.push(...nameFindings);
    const label = nameFindings.length ? `staged file #${index + 1}` : path;
    const content = gitBuffer(['show', `:${path}`]);
    // Binary files are left to gitleaks and release:check's allowlist.
    if (content.includes(0)) continue;
    findings.push(...scanText(content.toString('utf8'), { ...ctx, file: label }));
  }
  return findings;
}

function outgoing(ctx, refLines, remote) {
  const findings = [];
  for (const [index, line] of refLines.split('\n').filter(Boolean).entries()) {
    const [localRef, localSha, remoteRef, remoteSha] = line.split(' ');
    if (ZERO.test(localSha)) continue; // branch deletion
    const file = `push ref #${index + 1}`;
    const range = ZERO.test(remoteSha) ? [localSha, '--not', `--remotes=${remote}`] : [`${remoteSha}..${localSha}`];
    const log = git(['-c', 'core.quotePath=false', 'log', '-p', '--diff-merges=first-parent', '--format=%n%an <%ae>%n%cn <%ce>%n%B', ...range]);
    findings.push(...scanText(log, { ...ctx, file }));
    findings.push(...scanText(remoteRef, { ...ctx, file }));
    const names = git(['log', '--format=', '--name-only', '-z', '--diff-merges=first-parent', ...range]);
    for (const name of names.split('\0')) findings.push(...scanText(name, { ...ctx, file }));
    if (git(['cat-file', '-t', localSha]).trim() === 'tag') {
      const tag = git(['for-each-ref', '--format=%(taggername)%00%(taggeremail:trim)%00%(contents)', localRef]);
      const [, email] = tag.split('\0');
      findings.push(...scanText(tag.replaceAll('\0', '\n'), { ...ctx, file }));
      if (!ctx.allowIdentities.includes(email)) findings.push({ file, line: 2, rule: 'identity' });
    }
  }
  return findings;
}

const [mode, arg] = process.argv.slice(2);
let findings;
try {
  const ctx = context();
  if (mode === 'staged') findings = staged(ctx);
  else if (mode === 'commit-msg') findings = scanText(readFileSync(arg, 'utf8'), { ...ctx, file: 'commit message' });
  else if (mode === 'push') findings = outgoing(ctx, readFileSync(0, 'utf8'), arg || 'origin');
  else stop(`unknown mode ${mode}`, 2);
} catch (error) {
  stop(`could not read what is being committed or pushed (${error.code ?? 'UNKNOWN'})`, 2);
}
if (findings.length) {
  console.error(formatFindings(findings));
  stop(`${findings.length} finding(s); nothing was printed from the matched text`, 1);
}
