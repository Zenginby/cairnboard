import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import * as fs from '../core/fsx.mjs';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { openIndex, refresh, rows, search, backlinks } from '../core/index.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { EventEmitter } from 'node:events';
import { watch } from '../core/watch.mjs';
import { reconcileExternal } from '../core/changes.mjs';
import { readEvents } from '../core/events.mjs';

// File system stamps differ between two folders with the same content; everything else must match.
const STAMPS = new Set(['mtime_ms', 'ctime_ms', 'ino']);
const TABLES = ['files', 'links', 'targets', 'journal_entries', 'catalog', 'fts'];

function setup(t) {
  const home = tempDir(t), root = tempDir(t);
  const opts = { home, env: {}, clock: fixedClock('2026-11-01T12:00:00Z') };
  initDataDir(root, opts);
  return { root, open: () => openContext({ ...opts, mode: 'write', dataDir: root, actor: 'cli:acme' }) };
}

function put(ctx, path, text) {
  fs.mkdirSync(dirname(join(ctx.root, path)), { recursive: true });
  fs.writeFileSync(join(ctx.root, path), text);
}

function snapshot(ctx) {
  const index = openIndex(ctx);
  try {
    return Object.fromEntries(TABLES.map((table) => {
      const columns = index.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name)
        .filter((name) => !STAMPS.has(name)).join(', ');
      return [table, index.db.prepare(`SELECT ${columns} FROM ${table} ORDER BY ${columns}`).all().map((row) => ({ ...row }))];
    }));
  } finally {
    index.close();
  }
}

// The same root indexed from nothing into a separate, empty cache.
function fromScratch(t, ctx) {
  const scratch = { ...ctx, warnings: [], indexPath: join(tempDir(t), 'index.db') };
  refresh(scratch);
  return snapshot(scratch);
}

test('a save through a temporary file and rename replaces the indexed page', (t) => {
  const { open } = setup(t);
  const ctx = open();
  put(ctx, 'notes/a.md', '# Old title\nfirst text');
  refresh(ctx);
  put(ctx, 'notes/a.md.tmp', '# New title\nsecond text with more words');
  fs.renameSync(join(ctx.root, 'notes/a.md.tmp'), join(ctx.root, 'notes/a.md'));
  const result = refresh(ctx);
  assert.equal(result.updated, 1);
  assert.equal(result.added, 0);
  assert.deepEqual(rows(ctx).map((row) => [row.path, row.title]), [['notes/a.md', 'New title']]);
  assert.deepEqual(search(ctx, 'first'), []);
  assert.equal(search(ctx, 'second')[0].path, 'notes/a.md');
  const snap = snapshot(ctx);
  assert.equal(snap.targets.some((row) => row.path.endsWith('.tmp')), false);
  assert.deepEqual(snap, fromScratch(t, ctx));
});

test('300 pages changed in bulk reconcile to the same cache as a fresh build', (t) => {
  const { open } = setup(t);
  const ctx = open();
  const name = (i) => `n-${String(i).padStart(3, '0')}`;
  for (let i = 0; i < 300; i++) put(ctx, `notes/${name(i)}.md`, `# Note ${i}\n[[${name(i + 1)}]] [[${name(i + 150)}]]`);
  assert.equal(refresh(ctx).added, 300);
  for (let i = 0; i < 100; i++) put(ctx, `notes/${name(i)}.md`, `# Changed ${i}\n[[${name(i + 250)}]]`);
  for (let i = 100; i < 200; i++) fs.unlinkSync(join(ctx.root, `notes/${name(i)}.md`));
  for (let i = 300; i < 400; i++) put(ctx, `notes/${name(i)}.md`, `# Added ${i}\n[[${name(i - 200)}]]`);
  const result = refresh(ctx);
  assert.deepEqual([result.added, result.updated, result.removed], [100, 100, 100]);
  assert.equal(rows(ctx).length, 300);
  assert.deepEqual(snapshot(ctx), fromScratch(t, ctx));
});

test('pages added, removed and renamed while no context was open are reconciled', (t) => {
  const { open } = setup(t);
  let ctx = open();
  put(ctx, 'notes/source.md', '# Source\n[[gone]] [[later]] [[old-name]] [[new-name]]');
  put(ctx, 'notes/gone.md', '# Gone');
  put(ctx, 'notes/old-name.md', '# Moved');
  refresh(ctx);
  assert.deepEqual(backlinks(ctx, 'notes/gone.md').map((link) => link.src_path), ['notes/source.md']);
  // Contexts hold no open handle; a new one is what a restarted application sees.
  ctx = open();
  fs.unlinkSync(join(ctx.root, 'notes/gone.md'));
  put(ctx, 'notes/later.md', '# Later');
  fs.renameSync(join(ctx.root, 'notes/old-name.md'), join(ctx.root, 'notes/new-name.md'));
  const result = refresh(ctx);
  assert.deepEqual([result.added, result.updated, result.removed], [2, 0, 2]);
  const links = snapshot(ctx).links.map((link) => [link.target_name, link.status, link.target_path]).sort();
  assert.deepEqual(links, [
    ['gone', 'unresolved', null], ['later', 'resolved', 'notes/later.md'],
    ['new-name', 'resolved', 'notes/new-name.md'], ['old-name', 'unresolved', null],
  ]);
  assert.deepEqual(backlinks(ctx, 'notes/gone.md'), []);
  assert.deepEqual(backlinks(ctx, 'notes/later.md').map((link) => link.src_path), ['notes/source.md']);
  assert.deepEqual(backlinks(ctx, 'notes/new-name.md').map((link) => link.src_path), ['notes/source.md']);
  assert.deepEqual(snapshot(ctx), fromScratch(t, ctx));
});

test('same size and mtime edits: refresh relies on ctime, verify compares content', (t) => {
  const { open } = setup(t);
  const ctx = open();
  const path = join(ctx.root, 'notes/a.md');
  // Whole seconds survive utimes exactly on every platform; a Date would lose the sub-millisecond part.
  const seconds = 1_700_000_000;
  put(ctx, 'notes/a.md', '# Alpha\nkalem');
  fs.utimesSync(path, seconds, seconds);
  refresh(ctx);
  const before = fs.statSync(path);
  put(ctx, 'notes/a.md', '# Bravo\nkalem');
  fs.utimesSync(path, seconds, seconds);
  let after = fs.statSync(path);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  // Plain refresh compares stamps only; a coarse ctime clock can leave all of them equal.
  const missed = after.ctimeMs === before.ctimeMs && after.ino === before.ino;
  assert.equal(refresh(ctx).updated, missed ? 0 : 1);
  if (missed) assert.equal(refresh(ctx, { verify: true }).updated, 1);
  assert.equal(rows(ctx)[0].title, 'Bravo');

  // A file system that keeps every stamp, simulated by recording the new stamps as already seen.
  put(ctx, 'notes/a.md', '# Delta\nkalem');
  fs.utimesSync(path, seconds, seconds);
  after = fs.statSync(path);
  const index = openIndex(ctx);
  try {
    index.db.prepare('UPDATE targets SET mtime_ms = ?, ctime_ms = ?, size = ?, ino = ? WHERE path = ?')
      .run(after.mtimeMs, after.ctimeMs, after.size, String(after.ino), 'notes/a.md');
  } finally {
    index.close();
  }
  assert.deepEqual(refresh(ctx), { added: 0, updated: 0, removed: 0, skipped: [] });
  assert.equal(rows(ctx)[0].title, 'Bravo');
  assert.equal(refresh(ctx, { verify: true }).updated, 1);
  assert.equal(rows(ctx)[0].title, 'Delta');
  assert.deepEqual(snapshot(ctx), fromScratch(t, ctx));
});

test('pages with broken frontmatter written from outside are indexed with an error, not a crash', (t) => {
  const { open } = setup(t);
  const ctx = open();
  put(ctx, 'notes/good.md', '# Good\n[[bad-yaml]]');
  refresh(ctx);
  put(ctx, 'notes/bad-yaml.md', '---\ntitle: [unclosed\n---\n# Heading\n[[good]]');
  put(ctx, 'notes/unclosed.md', '---\ntitle: Never closed\n# Heading');
  let result;
  assert.doesNotThrow(() => { result = refresh(ctx); });
  assert.equal(result.added, 2);
  assert.deepEqual(result.skipped, []);
  const byPath = Object.fromEntries(rows(ctx).map((row) => [row.path, row]));
  assert.equal(byPath['notes/bad-yaml.md'].error, 'invalid_frontmatter');
  assert.equal(byPath['notes/bad-yaml.md'].title, 'Heading');
  assert.equal(byPath['notes/unclosed.md'].error, 'invalid_frontmatter');
  assert.equal(byPath['notes/good.md'].error, null);
  assert.deepEqual(backlinks(ctx, 'notes/bad-yaml.md').map((link) => link.src_path), ['notes/good.md']);
  assert.deepEqual(snapshot(ctx), fromScratch(t, ctx));
});

test('a page with cyclic frontmatter aliases is indexed with an error, not a crash', (t) => {
  const { open } = setup(t);
  const ctx = open();
  put(ctx, 'notes/good.md', '# Good');
  put(ctx, 'notes/cycle.md', '---\nloop: &x [*x]\n---\n# Cycle');
  let result;
  assert.doesNotThrow(() => { result = refresh(ctx); });
  assert.deepEqual(result.skipped, []);
  const byPath = Object.fromEntries(rows(ctx).map((row) => [row.path, row]));
  assert.equal(byPath['notes/cycle.md'].error, 'invalid_frontmatter');
  assert.equal(byPath['notes/cycle.md'].title, 'Cycle');
  assert.deepEqual(snapshot(ctx), fromScratch(t, ctx));
});

test('burst of saves records one event', async (t) => {
  const { open } = setup(t), ctx = open();
  put(ctx, 'notes/a.md', 'before');
  reconcileExternal(ctx);
  const native = new EventEmitter();
  native.close = async () => {};
  const recorded = [], logs = [];
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const watcher = watch(ctx, { createWatcher: () => native, log: (error) => logs.push(error),
    recordExternal: (paths) => {
      recorded.push(paths);
      reconcileExternal(ctx, paths.length ? { paths } : {});
    } });
  t.after(() => watcher.close());
  native.emit('ready');
  await watcher.ready;
  assert.deepEqual(recorded, [[]]);
  for (let i = 0; i < 5; i++) {
    put(ctx, 'notes/a.md', `owner ${i}`);
    native.emit('all', 'change', join(ctx.root, 'notes/a.md'));
    t.mock.timers.tick(2000);
  }
  assert.equal(readEvents(ctx).length, 0);
  t.mock.timers.tick(2999);
  assert.equal(readEvents(ctx).length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(recorded, [[], ['notes/a.md']]);
  assert.equal(readEvents(ctx).length, 1);
  assert.equal(readEvents(ctx)[0].actor, 'owner:external');
  assert.deepEqual(logs, []);
});

test('server start reconciles changes made while stopped', async (t) => {
  const { open } = setup(t), ctx = open();
  put(ctx, 'notes/a.md', 'before');
  reconcileExternal(ctx);
  put(ctx, 'notes/a.md', 'while stopped');
  const native = new EventEmitter();
  native.close = async () => {};
  const watcher = watch(ctx, { createWatcher: () => native,
    recordExternal: (paths) => reconcileExternal(open(), paths.length ? { paths } : {}) });
  t.after(() => watcher.close());
  native.emit('ready');
  await watcher.ready;
  assert.equal(readEvents(ctx).length, 1);
});

test('ready reconciles once even when saves are pending and recording errors do not stop watching', async (t) => {
  const { open } = setup(t), ctx = open(), calls = [], logs = [];
  const native = new EventEmitter();
  native.close = async () => {};
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const watcher = watch(ctx, { createWatcher: () => native, log: (error) => logs.push(error),
    recordExternal: (paths) => {
      calls.push(paths);
      if (!paths.length) throw new Error('recording unavailable');
    } });
  t.after(() => watcher.close());
  put(ctx, 'notes/a.md', 'pending');
  native.emit('all', 'change', join(ctx.root, 'notes/a.md'));
  native.emit('ready');
  await watcher.ready;
  assert.deepEqual(calls, [[]]);
  assert.equal(logs.length, 1);
  t.mock.timers.tick(5000);
  assert.deepEqual(calls, [[], ['notes/a.md']]);
});
