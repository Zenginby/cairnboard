import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/check-style.mjs', import.meta.url));
const long = 'x'.repeat(121);
let templateRoot = null;

before(() => {
  templateRoot = mkdtempSync(join(tmpdir(), 'style-check-tpl-'));
  const git = (...args) => execFileSync('git', args, { cwd: templateRoot, encoding: 'utf8' }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Test Runner');
  git('config', 'user.email', 'runner@example.com');
  git('config', 'core.autocrlf', 'false');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(templateRoot, 'old.mjs'), `${long}\nconst value = 1;\n`);
  git('add', '.');
  git('commit', '-qm', 'Initial fixture');
});

after(() => {
  if (templateRoot) rmSync(templateRoot, { recursive: true, force: true });
});

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'style-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(templateRoot, root, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const run = (args = ['--base', 'main'], env = {}) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, CAIRN_STYLE_BASE: '', ...env },
    });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  };
  return { git, write, run };
}

test('style checks only changed lines and includes unstaged and staged changes', (t) => {
  const { git, write, run } = repository(t);
  write('old.mjs', `${long}\nconst value = 2;\n`);
  assert.deepEqual(run(), { status: 0, output: 'style: clean\n' });
  git('add', '.');
  assert.equal(run().status, 0);
  write('old.mjs', `${long}\nconst value = 2;\n${long}\n`);
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.output, /old\.mjs:3: line exceeds 120 characters/);
  assert.doesNotMatch(result.output, /old\.mjs:1:/);
});

for (const [name, text, rule] of [
  ['long line', `${long}\n`, 'line exceeds 120 characters'],
  ['trailing space', 'value \n', 'trailing whitespace'],
  ['trailing tab', 'value\t\n', 'trailing whitespace'],
  ['tab indentation', '  \tvalue\n', 'tab indentation'],
  ['missing newline', 'value', 'missing final newline'],
  ['CRLF', 'value\r\n', 'CRLF line ending'],
]) {
  test(`style rejects a new ${name}`, (t) => {
    const { write, run } = repository(t);
    write('new file.mjs', text);
    const result = run();
    assert.equal(result.status, 1);
    assert.ok(result.output.includes(`new file.mjs:1: ${rule}`), result.output);
  });
}

test('style checks final newline at file level even for a deletion-only diff', (t) => {
  const { git, write, run } = repository(t);
  write('ending.js', 'first\nlast');
  git('add', '.');
  git('commit', '-qm', 'Add legacy missing newline');
  write('ending.js', 'last');
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.output, /ending\.js:1: missing final newline/);
});

test('style ignores excluded paths and unsupported extensions', (t) => {
  const { write, git, run } = repository(t);
  for (const path of ['package-lock.json', 'dist/output.js', 'design/prototypes/board/page.js',
    'test/fixtures/sample.md', 'image.svg']) write(path, `\t${long} `);
  assert.equal(run().status, 0);
  git('add', '.');
  assert.equal(run().status, 0);
});

test('style exempts Markdown URLs and tables only from the length rule', (t) => {
  const { write, run } = repository(t);
  write('page.md', `https://example.com/${long}\n| ${long} |\n`);
  assert.equal(run().status, 0);
  write('page.md', `https://example.com/${long} \n`);
  assert.match(run().output, /trailing whitespace/);
  write('page.md', `${long}\n`);
  assert.match(run().output, /line exceeds 120 characters/);
  write('page.md', `${'x'.repeat(120)}\n`);
  assert.equal(run().status, 0);
});

test('style includes committed changes and uses environment or explicit bases', (t) => {
  const { write, git, run } = repository(t);
  git('checkout', '-qb', 'feature');
  write('new.ts', `${long}\n`);
  git('add', '.');
  git('commit', '-qm', 'Add changed line');
  assert.equal(run([], { CAIRN_STYLE_BASE: 'main' }).status, 1);
  assert.equal(run(['--base', 'HEAD'], { CAIRN_STYLE_BASE: 'main' }).status, 0);
});

test('style defaults to merge-base with origin/main', (t) => {
  const { write, git, run } = repository(t);
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-qb', 'feature');
  write('new.js', `${long}\n`);
  git('add', '.');
  git('commit', '-qm', 'Add changed line');
  write('clean.js', 'value\n');
  git('add', '.');
  git('commit', '-qm', 'Add clean line');
  assert.equal(run([]).status, 1, 'merge-base includes both commits');
});

test('style falls back to HEAD parent for missing origin, main push and zero SHA', (t) => {
  const { write, git, run } = repository(t);
  write('new.js', `${long}\n`);
  git('add', '.');
  git('commit', '-qm', 'Add changed line');
  assert.equal(run([]).status, 1);
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.equal(run([]).status, 1);
  assert.equal(run([], { CAIRN_STYLE_BASE: '0'.repeat(40) }).status, 1);
  assert.match(run([], { CAIRN_STYLE_BASE: '0'.repeat(40) }).output, /new\.js:1:/);
});

test('style reports invalid arguments and invalid explicit refs', (t) => {
  const { run } = repository(t);
  for (const args of [['--base'], ['--unknown'], ['--base', 'absent']]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.output, /style:/);
    assert.doesNotMatch(result.output, /style: clean/);
  }
});
