// Git hook entry point. Fails closed: any read error or missing configuration blocks the operation.
// Usage: node security/hook.mjs staged | commit-msg <file> | push   (push reads git's stdin ref lines)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadDenylist } from './denylist.mjs';
import { scanText, formatFindings } from './scan.mjs';

const ZERO = /^0+$/;

function git(args, input) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, input });
}

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
    stop(error.code ? `cannot read denylist (${error.code})` : `invalid denylist: ${error.message}`, 2);
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
    const content = execFileSync('git', ['show', `:${path}`], { maxBuffer: 256 * 1024 * 1024 });
    // Binary files are left to gitleaks and release:check's allowlist.
    if (content.includes(0)) continue;
    findings.push(...scanText(content.toString('utf8'), { ...ctx, file: label }));
  }
  return findings;
}

function outgoing(ctx, refLines, remote) {
  const findings = [];
  for (const line of refLines.split('\n').filter(Boolean)) {
    const [, localSha, remoteRef, remoteSha] = line.split(' ');
    if (ZERO.test(localSha)) continue; // branch deletion
    const range = ZERO.test(remoteSha) ? [localSha, '--not', `--remotes=${remote}`] : [`${remoteSha}..${localSha}`];
    const log = git(['log', '-p', '--diff-merges=first-parent', '--format=%n%an <%ae>%n%cn <%ce>%n%B', ...range]);
    findings.push(...scanText(log, { ...ctx, file: `push ${remoteRef}` }));
    findings.push(...scanText(remoteRef, { ...ctx, file: 'push ref name' }));
  }
  return findings;
}

const [mode, arg] = process.argv.slice(2);
const ctx = context();
let findings;
try {
  if (mode === 'staged') findings = staged(ctx);
  else if (mode === 'commit-msg') findings = scanText(readFileSync(arg, 'utf8'), { ...ctx, file: 'commit message' });
  else if (mode === 'push') findings = outgoing(ctx, readFileSync(0, 'utf8'), arg || 'origin');
  else stop(`unknown mode ${mode}`, 2);
} catch {
  stop('could not read what is being committed or pushed', 2);
}
if (findings.length) {
  console.error(formatFindings(findings));
  stop(`${findings.length} finding(s); nothing was printed from the matched text`, 1);
}
