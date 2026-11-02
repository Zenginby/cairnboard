import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadDenylist } from './denylist.mjs';
import { git, gitBuffer } from './git.mjs';
import { formatFindings, scanText } from './scan.mjs';

const allowlistPath = 'security/binary-allowlist.txt';

const lines = (text) => text.split('\n').filter(Boolean);

export function releaseCheck({ cwd, denylistPath, privateRoots = [], allowIdentities = [], github = false }) {
  const { terms } = loadDenylist(denylistPath);
  const findings = [];
  const errors = [];
  const allowed = new Set();
  const current = new Set();
  const scan = (text, file) => findings.push(...scanText(text, { file, terms, allowIdentities }));
  // A label is printed only when it is itself clean; otherwise a neutral fallback hides it.
  const label = (name, fallback) => (scanText(name, { file: '', terms, allowIdentities }).length ? fallback : name);
  const step = (name, fn) => {
    try {
      fn();
    } catch (error) {
      // git's own message can echo paths or ref names, so only the step name is reported.
      errors.push(`${name}: failed`);
    }
  };

  // 1. Tracked files: path and contents.
  step('files', () => {
    const entries = git(['ls-files', '--stage', '-z'], { cwd }).split('\0').filter(Boolean);
    const paths = entries.map((entry) => {
      const tab = entry.indexOf('\t');
      current.add(entry.slice(0, tab).split(' ')[1]);
      return entry.slice(tab + 1);
    });
    if (paths.includes(allowlistPath)) {
      for (const line of git(['show', `:${allowlistPath}`], { cwd }).split(/\r?\n/)) {
        const value = line.trim();
        if (value && !value.startsWith('#')) allowed.add(value);
      }
    }
    for (const [index, path] of paths.entries()) {
      const file = label(path, `file#${index + 1}`);
      scan(path, `${file} (path)`);
      const content = gitBuffer(['cat-file', 'blob', `:${path}`], { cwd });
      if (content.includes(0)) {
        if (!allowed.has(path)) findings.push({ file, line: 1, rule: 'binary' });
      } else {
        scan(content.toString('utf8'), file);
      }
    }
  });

  // 2-3. History: patches, messages and identities. Notes are scanned separately (their tree paths are hashes).
  step('history', () => {
    // --text puts raw binary patches (NUL bytes included) in the log, so commits are split on a per-run nonce.
    const marker = `\0cairn-${randomBytes(16).toString('hex')}\n`;
    const log = git(['-c', 'core.quotePath=false', 'log', '--exclude=refs/notes/*', '--all', '-p', '--text', '--no-textconv', '--no-ext-diff', '--diff-merges=first-parent', `--format=${marker.replace('\0', '%x00').replace('\n', '%n')}%H%n%an%n%ae%n%cn%n%ce%n%B`], { cwd });
    for (const chunk of log.split(marker).filter(Boolean)) {
      const [hash, ...rest] = chunk.split('\n');
      const file = `commit:${hash.slice(0, 12)}`;
      scan(rest.join('\n'), file);
      for (const line of [3, 5]) {
        const email = rest[line - 2]?.trim();
        if (email !== undefined && !allowIdentities.includes(email)) findings.push({ file, line, rule: 'identity' });
      }
    }
    const names = git(['log', '--exclude=refs/notes/*', '--all', '--format=', '--name-only', '-z', '--diff-merges=first-parent'], { cwd });
    for (const [index, name] of names.split('\0').entries()) scan(name, `history name#${index + 1}`);
  });

  // 4. Ref names and notes.
  step('refs', () => {
    const refs = lines(git(['for-each-ref', '--format=%(refname)'], { cwd }));
    for (const [index, ref] of refs.entries()) scan(ref, `ref#${index + 1}`);
    // Annotated tag messages are published with the tag.
    for (const [index, ref] of refs.filter((r) => r.startsWith('refs/tags/')).entries()) {
      if (git(['cat-file', '-t', ref], { cwd }).trim() !== 'tag') continue;
      const tag = git(['for-each-ref', '--format=%(taggername)%00%(taggeremail:trim)%00%(contents)', ref], { cwd });
      const [, email] = tag.split('\0');
      const file = `tag#${index + 1}`;
      scan(tag.replaceAll('\0', '\n'), file);
      if (!allowIdentities.includes(email)) findings.push({ file, line: 2, rule: 'identity' });
    }
    for (const ref of refs.filter((r) => r.startsWith('refs/notes/'))) {
      for (const entry of lines(git(['notes', `--ref=${ref}`, 'list'], { cwd }))) {
        const [blob, object] = entry.split(' ');
        scan(git(['cat-file', 'blob', blob], { cwd }), `note:${object.slice(0, 12)}`);
      }
    }
  });

  // 4b. Notes history (earlier note versions) and every binary blob ever committed.
  step('notes history', () => {
    for (const ref of lines(git(['for-each-ref', '--format=%(refname)', 'refs/notes/'], { cwd }))) {
      // Note paths are object hashes. Current notes are scanned above; here only replaced or removed
      // note text (the '-' lines of each change) is scanned.
      const added = git(['-c', 'core.quotePath=false', 'log', '-p', '--text', '--format=', ref], { cwd }).split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).join('\n');
      scan(added, `notes-history#${ref.split('/').length}`);
    }
  });
  step('historical blobs', () => {
    // Current blob contents were already scanned, even when their path has older versions.
    const objects = lines(git(['rev-list', '--objects', '--all', '--exclude=refs/notes/*'], { cwd }));
    for (const [index, entry] of objects.entries()) {
      const space = entry.indexOf(' ');
      if (space < 0) continue; // commits have no path
      const [sha, path] = [entry.slice(0, space), entry.slice(space + 1)];
      if (current.has(sha) || allowed.has(path) || git(['cat-file', '-t', sha], { cwd }).trim() !== 'blob') continue;
      if (gitBuffer(['cat-file', 'blob', sha], { cwd }).includes(0)) findings.push({ file: label(path, `blob#${index + 1}`), line: 1, rule: 'binary' });
    }
  });

  // 5. Root commits shared with a private repository.
  step('roots', () => {
    const roots = new Set(privateRoots.map((sha) => sha.trim().toLowerCase()).filter(Boolean));
    for (const root of lines(git(['rev-list', '--max-parents=0', '--all'], { cwd }))) {
      if (roots.has(root)) findings.push({ file: `root:${root.slice(0, 12)}`, line: 1, rule: 'private-root' });
    }
  });

  // 6. GitHub issue and pull request titles and bodies.
  if (github) {
    step('github', () => {
      const gh = (args) => execFileSync('gh', args, { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
      for (const kind of ['issues', 'pulls']) {
        const items = gh(['api', '--paginate', `repos/${repo}/${kind}?state=all&per_page=100`, '--jq', '.[] | {number, title, body}']);
        for (const item of lines(items).map((line) => JSON.parse(line))) {
          scan(`${item.title ?? ''}\n${item.body ?? ''}`, `${kind}#${item.number}`);
        }
      }
    });
  }

  return { findings, errors };
}

function main() {
  const env = process.env;
  if (!env.CAIRN_DENYLIST) {
    console.error('CAIRN_DENYLIST is required');
    return 2;
  }
  const cwd = process.cwd();
  const list = (value) => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  let allowIdentities = list(env.CAIRN_ALLOW_IDENTITIES);
  if (!allowIdentities.length) {
    try {
      allowIdentities = list(git(['config', '--local', '--get', 'user.email'], { cwd }));
    } catch {
      allowIdentities = [];
    }
  }
  let result;
  try {
    result = releaseCheck({
      cwd,
      denylistPath: env.CAIRN_DENYLIST,
      privateRoots: list(env.CAIRN_PRIVATE_ROOTS),
      allowIdentities,
      github: process.argv.includes('--github'),
    });
  } catch (error) {
    console.error(`release:check failed (${error.code ?? 'UNKNOWN'})`);
    return 2;
  }
  if (result.findings.length) console.log(formatFindings(result.findings));
  for (const error of result.errors) console.error(`release:check error: ${error}`);
  if (result.errors.length) return 2;
  if (result.findings.length) {
    console.error(`release:check: ${result.findings.length} finding(s); do not publish`);
    return 1;
  }
  console.log('release:check: clean');
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
