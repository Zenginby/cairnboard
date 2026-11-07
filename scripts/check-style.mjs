import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

const extensions = new Set(['.mjs', '.js', '.ts', '.astro', '.css', '.json', '.md', '.yml', '.yaml']);
const excluded = ['dist/', 'design/prototypes/', 'test/fixtures/'];
const git = (...args) => execFileSync('git', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
});

function baseRef(args) {
  if (args.length && (args.length !== 2 || args[0] !== '--base' || !args[1])) {
    throw new Error('Usage: check-style.mjs [--base <ref>]');
  }
  const requested = args[1] || process.env.CAIRN_STYLE_BASE;
  if (requested && !/^0+$/u.test(requested)) {
    return git('rev-parse', '--verify', '--end-of-options', `${requested}^{commit}`).trim();
  }
  if (!requested) {
    try {
      const base = git('merge-base', 'HEAD', 'origin/main').trim();
      if (base !== git('rev-parse', 'HEAD').trim()) return base;
    } catch {
      // A local checkout may have no origin/main.
    }
  }
  return git('rev-parse', '--verify', 'HEAD^').trim();
}

function check() {
  const base = baseRef(process.argv.slice(2));
  const untracked = new Set(git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean));
  const changed = git('diff', '--name-only', '--no-renames', '-z', base, '--').split('\0').filter(Boolean);
  let findings = 0;
  const report = (path, line, rule) => {
    console.error(`${path}:${line}: ${rule}`);
    findings++;
  };
  for (const path of new Set([...changed, ...untracked])) {
    if (!extensions.has(extname(path)) || path === 'package-lock.json'
      || excluded.some((prefix) => path.startsWith(prefix))) continue;
    let stat;
    try { stat = lstatSync(path); } catch (error) {
      if (error.code === 'ENOENT') continue; // Deleted files have no added lines.
      throw error;
    }
    if (!stat.isFile()) continue;
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n');
    const added = new Set();
    if (untracked.has(path)) {
      for (let i = 0; i < lines.length - (text.endsWith('\n') ? 1 : 0); i++) added.add(i + 1);
    } else {
      const diff = git('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '-U0', base, '--', path);
      for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu)) {
        const start = Number(match[1]), count = match[2] === undefined ? 1 : Number(match[2]);
        for (let line = start; line < start + count; line++) added.add(line);
      }
    }
    for (const number of added) {
      const raw = lines[number - 1];
      const line = raw.replace(/\r$/u, '');
      const markdownException = extname(path) === '.md' && (/https?:\/\/\S+/u.test(line) || /^\s*\|/u.test(line));
      if ([...line].length > 120 && !markdownException) report(path, number, 'line exceeds 120 characters');
      if (/[\t ]$/u.test(line)) report(path, number, 'trailing whitespace');
      if (/^[\t ]*\t/u.test(line)) report(path, number, 'tab indentation');
      if (raw.endsWith('\r') && number < lines.length) report(path, number, 'CRLF line ending');
    }
    if (text.length && !text.endsWith('\n')) report(path, lines.length, 'missing final newline');
  }
  if (findings) return 1;
  console.log('style: clean');
  return 0;
}

try {
  process.exitCode = check();
} catch (error) {
  console.error(`style: ${error.message}`);
  process.exitCode = 1;
}
