// Git hook entry point. Fails closed: any read error or missing configuration blocks the operation.
// Usage: node security/hook.mjs staged | commit-msg <file> | push   (push reads git's stdin ref lines)
import { readFileSync } from 'node:fs';
import { loadDenylist } from './denylist.mjs';
import { annotatedTags, git, gitBuffer } from './git.mjs';
import { fixtureLines, scanLines, scanText, formatFindings } from './scan.mjs';

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
    findings.push(...scanText(content.toString('utf8'), { ...ctx, file: label, fixtures: path.startsWith('test/') }));
  }
  return findings;
}

function advertisedCommits(remote) {
  try {
    const hashes = git(['ls-remote', '--', remote]).split('\n').filter(Boolean).map((line) => line.split('\t')[0]);
    return [...new Set(hashes)].map((hash) => {
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) throw new Error('invalid object id');
      return git(['rev-parse', '--verify', `${hash}^{commit}`]).trim();
    });
  } catch {
    // Unavailable remotes or objects we do not have locally: scan the full history.
    return [];
  }
}

function outgoing(ctx, refLines, remote) {
  const findings = [];
  let exclusions;
  for (const [index, line] of refLines.split('\n').filter(Boolean).entries()) {
    const [, localSha, remoteRef, remoteSha] = line.split(' ');
    if (ZERO.test(localSha)) continue; // branch deletion
    const file = `push ref #${index + 1}`;
    const range = ZERO.test(remoteSha) ? [localSha, '--not', ...(exclusions ??= advertisedCommits(remote))] : [`${remoteSha}..${localSha}`];
    const log = git(['-c', 'core.quotePath=false', 'log', '-p', '--text', '--no-textconv', '--no-ext-diff', '--no-color', '--diff-merges=first-parent', '--format=%n%an <%ae>%n%cn <%ce>%n%w(0,4,4)%B%w(0,0,0)', ...range]);
    // Messages are indented (%w) so a message line can never pass for a diff header and unlock the fixture marker.
    findings.push(...scanLines(log, fixtureLines(log), { ...ctx, file }));
    const identities = git(['log', '--format=%ae%x00%ce%x00', '--no-patch', ...range]);
    for (const [index, email] of identities.split('\0').slice(0, -1).entries()) {
      if (!ctx.allowIdentities.includes(email.replace(/^\n/, ''))) findings.push({ file, line: index + 1, rule: 'identity' });
    }
    findings.push(...scanText(remoteRef, { ...ctx, file }));
    const names = git(['log', '--format=', '--name-only', '-z', '--diff-merges=first-parent', ...range]);
    for (const name of names.split('\0')) findings.push(...scanText(name, { ...ctx, file }));
    for (const tag of annotatedTags(localSha)) {
      findings.push(...scanText(tag.text, { ...ctx, file }), ...scanText(tag.signature, { ...ctx, file, patterns: false }));
      if (!ctx.allowIdentities.includes(tag.email)) findings.push({ file, line: 2, rule: 'identity' });
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
