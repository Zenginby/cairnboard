import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openContext } from '../core/context.mjs';
import { initDataDir, recordRepo, repoFor, stateDir } from '../core/roots.mjs';
import { lint } from '../core/lint.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { runCli } from './support/cli.mjs';

const PROJECT = 'p-abc234';
const clock = () => fixedClock('2026-11-01T12:00:00Z');

function setup(t, { pages = {}, repoFiles = {}, linked = true, preset = 'default' } = {}) {
  const dir = tempDir(t);
  const repo = tempDir(t);
  const entries = { 'projects/ornek-proje.md': `---\nid: ${PROJECT}\nkind: project\n---\n# Ornek Proje\n`, ...pages };
  for (const [path, text] of Object.entries(entries)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  for (const [path, text] of Object.entries(repoFiles)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  const ctx = openContext({ mode: 'read', dataDir: dir, home: tempDir(t), env: {}, clock: clock(), platform: process.platform, preset });
  if (linked) recordRepo(ctx.stateDir, PROJECT, repo);
  return { dir, repo, ctx };
}
const page = (code, extra = '') => `---\nkind: concept\ntags: [a]\nupdated: 2026-10-30\nproject: ${PROJECT}\ncode: ${JSON.stringify(code)}\n${extra}---\n# T\n`;
const run = (ctx, opts = { code: true }) => lint(ctx, opts).findings.filter((item) => item.code.startsWith('code_'));
const touch = (path, iso) => utimesSync(path, new Date(iso), new Date(iso));

test('recordRepo writes links.json atomically and repoFor reads it back', (t) => {
  const state = tempDir(t);
  assert.equal(repoFor(state, PROJECT), null);
  recordRepo(join(state, 'nested'), PROJECT, '/acme/repo');
  recordRepo(join(state, 'nested'), 'p-bcd345', '/acme/other');
  recordRepo(join(state, 'nested'), PROJECT, '/acme/repo2');
  assert.deepEqual(JSON.parse(readFileSync(join(state, 'nested', 'links.json'), 'utf8')), { [PROJECT]: '/acme/repo2', 'p-bcd345': '/acme/other' });
  assert.equal(repoFor(join(state, 'nested'), PROJECT), '/acme/repo2');
  assert.equal(repoFor(join(state, 'nested'), 'p-zzzzzz'), null);
  assert.deepEqual(readdirSync(join(state, 'nested')), ['links.json']);
  writeFileSync(join(state, 'nested', 'links.json'), '{broken');
  assert.equal(repoFor(join(state, 'nested'), PROJECT), null);
  assert.throws(() => recordRepo(state, 'not-an-id', '/x'), { code: 'validation' });
  assert.throws(() => recordRepo(state, PROJECT, 'relative/path'), { code: 'validation' });
});

test('cairn link records the repository root in the state directory, never in the data folder', async (t) => {
  const home = tempDir(t), data = tempDir(t), cwd = tempDir(t);
  initDataDir(data, { home, env: {}, clock: clock() });
  mkdirSync(join(cwd, '.git'));
  const opts = { home, data, cwd, clock: clock() };
  const added = await runCli(['project', 'add', '--title', 'Acme', '--actor', 'acme', '--json'], opts);
  const id = added.json.data.id;
  const state = stateDir({ home, env: {}, platform: process.platform });
  const dry = await runCli(['link', id, '--dry-run', '--actor', 'acme', '--json'], opts);
  assert.equal(dry.code, 0);
  assert.equal(repoFor(state, id), null);
  const linked = await runCli(['link', id, '--actor', 'acme', '--json'], { ...opts, isTTY: true, stdin: 'yes\n' });
  assert.equal(linked.code, 0, linked.stdout + linked.stderr);
  assert.equal(repoFor(state, id), cwd);
  assert.ok(!readdirSync(data, { recursive: true }).some((name) => name.endsWith('links.json')));
});

test('code_changed: a file modified after the page updated day; older or same-day files are fine', (t) => {
  const { repo, ctx } = setup(t, {
    pages: { 'wiki/concepts/a.md': page(['src/new.mjs', 'src/old.mjs', 'src/same.mjs']) },
    repoFiles: { 'src/new.mjs': 'x', 'src/old.mjs': 'x', 'src/same.mjs': 'x' },
  });
  touch(join(repo, 'src/new.mjs'), '2026-10-31T12:00:00Z');
  touch(join(repo, 'src/old.mjs'), '2026-10-29T12:00:00Z');
  touch(join(repo, 'src/same.mjs'), '2026-10-30T12:00:00Z');
  const result = run(ctx);
  assert.deepEqual(result.map((item) => [item.code, item.path, item.target, item.severity]),
    [['code_changed', 'wiki/concepts/a.md', 'src/new.mjs', 'info']]);
});

test('code_missing: absent files, escaping paths and symlinks are missing and never followed', (t) => {
  const { repo, ctx } = setup(t, {
    pages: { 'wiki/concepts/a.md': page(['src/gone.mjs', '../outside.txt', 'src/link.mjs', 'linkdir/inner.mjs', '/etc/hosts']) },
    repoFiles: { 'src/real.mjs': 'x' },
  });
  writeFileSync(join(dirname(repo), 'outside.txt'), 'x');
  symlinkSync(join(repo, 'src/real.mjs'), join(repo, 'src/link.mjs'));
  mkdirSync(join(dirname(repo), 'elsewhere'), { recursive: true });
  writeFileSync(join(dirname(repo), 'elsewhere/inner.mjs'), 'x');
  symlinkSync(join(dirname(repo), 'elsewhere'), join(repo, 'linkdir'));
  const result = run(ctx);
  assert.deepEqual(result.map((item) => [item.code, item.severity]), Array(5).fill(['code_missing', 'warn']));
  assert.deepEqual(result.map((item) => item.target).sort(), ['../outside.txt', '/etc/hosts', 'linkdir/inner.mjs', 'src/gone.mjs', 'src/link.mjs']);
});

test('code_unlinked: a project without a link on this machine, or a page without a project, yields one finding per page', (t) => {
  const { ctx } = setup(t, {
    linked: false,
    pages: { 'wiki/concepts/a.md': page(['src/a.mjs', 'src/b.mjs']), 'wiki/concepts/b.md': page(['src/a.mjs']).replace(`project: ${PROJECT}\n`, '') },
  });
  const result = run(ctx);
  assert.deepEqual(result.map((item) => [item.code, item.path, item.severity]),
    [['code_unlinked', 'wiki/concepts/a.md', 'info'], ['code_unlinked', 'wiki/concepts/b.md', 'info']]);
});

test('the project may be named by a link to its page; pages without code are ignored; the flag is required', (t) => {
  const { repo, ctx } = setup(t, {
    pages: {
      'wiki/concepts/a.md': page(['src/a.mjs']).replace(`project: ${PROJECT}`, 'project: "[[ornek-proje]]"'),
      'wiki/concepts/b.md': '---\nkind: concept\ntags: [a]\nupdated: 2026-10-30\n---\n# B\n',
    },
    repoFiles: { 'src/a.mjs': 'x' },
  });
  touch(join(repo, 'src/a.mjs'), '2026-10-31T12:00:00Z');
  assert.deepEqual(run(ctx).map((item) => [item.code, item.path]), [['code_changed', 'wiki/concepts/a.md']]);
  assert.deepEqual(run(ctx, {}), []);
});

test('a page code path in a finding is clipped and cleaned', (t) => {
  const long = `src/${'a'.repeat(400)}.mjs`;
  const { ctx } = setup(t, { pages: { 'wiki/concepts/a.md': page([long]) } });
  const [item] = run(ctx);
  assert.equal(item.code, 'code_missing');
  assert.ok(item.target.length <= 200);
});
