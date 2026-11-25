// Git hook entry point. Fails closed: any read error or missing configuration blocks the operation.
// Usage: node security/hook.mjs staged | commit-msg <file> | push   (push reads git's stdin ref lines)
import { lstatSync, readFileSync } from 'node:fs';
import { loadDenylist } from './denylist.mjs';
import { annotatedTags, git, gitBuffer } from './git.mjs';
import { GITHUB_COMMITTER } from './rules.mjs';
import { fixtureLines, scanLines, scanText, formatFindings } from './scan.mjs';

const ZERO = /^0+$/;
const COMMIT_MARK = '\u0001cairn-commit';

// Reviewed binaries (security/binary-allowlist.txt, as in release:check and the CI scan) are bytes, not text: read
// with --text they match the e-mail and token rules at random. Their diff sections are blanked line for line; a commit
// header (COMMIT_MARK, which an indented message line cannot start with) ends the blanking, so every message is read.
function allowedBinaries() {
  try {
    return new Set(readFileSync(`${git(['rev-parse', '--show-toplevel']).trim()}/security/binary-allowlist.txt`, 'utf8')
      .split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')));
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw error;
  }
}

export function blankAllowedBinaries(log, allowed) {
  let skip = false;
  return log.split('\n').map((line) => {
    if (line.startsWith(COMMIT_MARK)) {
      skip = false;
      return '';
    }
    if (line.startsWith('diff --git ')) {
      const paths = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      skip = Boolean(paths) && allowed.has(paths[1]) && allowed.has(paths[2]);
    }
    return skip ? '' : line;
  }).join('\n');
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

// Grafts and shallow history rewrite local ancestry (replace refs are already ignored: see git.mjs), so neither the
// outgoing range nor the exclusions can be trusted: the push is refused, as release-check refuses them.
function rewrittenAncestry() {
  if (git(['rev-parse', '--is-shallow-repository']).trim() === 'true') return true;
  try {
    // Strip only Git's own newline: GIT_GRAFT_FILE may name a path with surrounding spaces.
    lstatSync(git(['rev-parse', '--git-path', 'info/grafts']).replace(/\r?\n$/u, ''));
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

// `remote` is the push destination URL from pre-push's second argument, so a separate pushurl is honoured. Returns the
// advertised ref tips and the advertised commits we have locally.
function advertised(remote) {
  const none = { refs: new Map(), commits: [] };
  try {
    const refs = new Map();
    for (const line of git(['ls-remote', '--', remote]).split('\n').filter(Boolean)) {
      const [hash, ref] = line.split('\t');
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) throw new Error('invalid object id');
      refs.set(ref, hash);
    }
    const commits = [...new Set(refs.values())].flatMap((hash) => {
      // GitHub also advertises refs/pull/*; an object we never fetched cannot be in the outgoing range, so skip it
      // instead of dropping every exclusion.
      try {
        return [git(['rev-parse', '--verify', '--quiet', `${hash}^{commit}`]).trim()];
      } catch {
        return [];
      }
    });
    return { refs, commits };
  } catch {
    // Unavailable remotes: scan the full history.
    return none;
  }
}

function outgoing(ctx, refLines, remote) {
  if (rewrittenAncestry()) stop('grafts or shallow history: the outgoing commits cannot be verified', 2);
  const findings = [];
  let exclusions;
  let allowed;
  for (const [index, line] of refLines.split('\n').filter(Boolean).entries()) {
    const [, localSha, remoteRef, remoteSha] = line.split(' ');
    if (ZERO.test(localSha)) continue; // branch deletion
    const file = `push ref #${index + 1}`;
    // History the remote already advertises (other branches, merged pull requests) was published before; an update
    // that merges it in only sends its own commits. For an update the queried repository must show the ref at the tip
    // git push reported, or it may not be the destination (URL rewrites) and nothing beyond that tip is excluded.
    exclusions ??= advertised(remote);
    const update = !ZERO.test(remoteSha);
    const trusted = !update || exclusions.refs.get(remoteRef) === remoteSha;
    const range = [localSha, '--not', ...(update ? [remoteSha] : []), ...(trusted ? exclusions.commits : [])];
    const log = blankAllowedBinaries(git(['-c', 'core.quotePath=false', 'log', '-p', '--text', '--no-textconv', '--no-ext-diff', '--no-color', '--diff-merges=first-parent', `--format=${COMMIT_MARK}%n%an <%ae>%n%cn <%ce>%n%w(0,4,4)%B%w(0,0,0)`, ...range]), allowed ??= allowedBinaries());
    // Messages are indented (%w) so a message line can never pass for a diff header and unlock the fixture marker.
    findings.push(...scanLines(log, fixtureLines(log), { ...ctx, file }));
    const identities = git(['log', '--format=%ae%x00%ce%x00', '--no-patch', ...range]);
    for (const [index, raw] of identities.split('\0').slice(0, -1).entries()) {
      const email = raw.replace(/^\n/, '');
      if (index % 2 === 1 && email === GITHUB_COMMITTER) continue;
      if (!ctx.allowIdentities.includes(email)) findings.push({ file, line: index + 1, rule: 'identity' });
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
