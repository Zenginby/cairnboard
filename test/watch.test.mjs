import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync, symlinkSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { watch } from '../core/watch.mjs';
import { rows, refresh } from '../core/index.mjs';
import { openContext } from '../core/context.mjs';
import { initDataDir } from '../core/roots.mjs';
import { tempDir } from './support/env.mjs';

function fixture(t, fake = false, options = {}) {
  const root = tempDir(t), home = tempDir(t);
  initDataDir(root, { home, env: {} });
  const put = (path, text = '---\nid: c-000001\ntitle: Work\ncolumn: planned\n---\n') => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put('cards/work.md');
  const ctx = openContext({ mode: 'read', dataDir: root, home, env: {} });
  const native = new EventEmitter();
  native.close = async () => {};
  let settings;
  const watcher = watch(ctx, { ...options, ...(fake ? { createWatcher: (path, opts) => { settings = opts; return native; } } : {}) });
  t.after(() => watcher.close());
  const changes = [];
  watcher.on('change', (change) => changes.push(change));
  return { root, put, ctx, watcher, native, changes, settings };
}

test('watch ignores metadata anywhere and rejects symlink events', async (t) => {
  const f = fixture(t, true);
  assert.equal(f.settings.ignoreInitial, true);
  assert.equal(f.settings.followSymlinks, false);
  assert.equal(f.settings.atomic, true);
  assert.equal(f.settings.awaitWriteFinish, false);
  assert.equal(f.settings.usePolling, false);
  for (const path of ['.cairn/x.md', '.git/x.md', 'cards/.git/x.md', 'notes/.cairn/x.md',
    'node_modules/x.md', 'notes/node_modules/x.md']) {
    assert.equal(f.settings.ignored(join(f.root, path)), true);
    f.put(path);
    f.native.emit('all', 'add', join(f.root, path));
  }
  assert.equal(f.settings.ignored(join(f.root, 'cards/work.md')), false);
  try { symlinkSync(join(f.root, 'cards/work.md'), join(f.root, 'cards/link.md')); } catch (error) {
    if (error.code === 'EPERM') { t.skip('Symlinks unavailable'); return; }
    throw error;
  }
  f.native.emit('all', 'add', join(f.root, 'cards/link.md'));
  await delay(250);
  assert.deepEqual(f.changes, []);
  assert.ok(!rows(f.ctx).some((row) => row.path === 'cards/link.md'));
});

test('watch batches twenty rapid file writes into at most two changes and drops removed files', async (t) => {
  const f = fixture(t, true);
  const changed = once(f.watcher, 'change', { signal: AbortSignal.timeout(2000) });
  for (let i = 0; i < 20; i++) {
    f.put(`cards/work-${i}.md`, `---\nid: c-0000${String(i + 10)}\ntitle: Work ${i}\n---\n`);
    f.native.emit('all', 'add', join(f.root, `cards/work-${i}.md`));
  }
  await changed;
  await delay(350);
  assert.ok(f.changes.length <= 2);
  assert.equal(rows(f.ctx, 'card').length, 21);
  const removed = once(f.watcher, 'change', { signal: AbortSignal.timeout(2000) });
  unlinkSync(join(f.root, 'cards/work.md'));
  f.native.emit('all', 'unlink', join(f.root, 'cards/work.md'));
  assert.ok((await removed)[0].ids.includes('c-000001'));
  assert.ok(!rows(f.ctx).some((row) => row.path === 'cards/work.md'));
});

test('own-write suppression matches SHA-256 bytes, consumes once and preserves other changes', async (t) => {
  const f = fixture(t, true);
  const text = '---\nid: c-000001\ntitle: Own write\n---\n';
  f.watcher.suppress('cards/work.md', createHash('sha256').update(text).digest('hex'));
  f.put('cards/work.md', text);
  f.native.emit('all', 'change', join(f.root, 'cards/work.md'));
  await delay(250);
  assert.deepEqual(f.changes, []);
  f.put('cards/work.md', text + 'External write');
  f.native.emit('all', 'change', join(f.root, 'cards/work.md'));
  await delay(250);
  assert.equal(f.changes.length, 1);
  f.watcher.suppress(join(f.root, 'cards/work.md'), 'wrong digest');
  f.put('cards/work.md', text + 'Another write');
  f.watcher.reconcile();
  assert.equal(f.changes.length, 2);
});

test('reconcile detects missed changes, even after another process refreshes the shared index', (t) => {
  const f = fixture(t, true);
  f.put('cards/work.md', '---\nid: c-000001\ntitle: Missed\n---\n');
  rows(openContext({ mode: 'read', dataDir: f.root, home: tempDir(t), env: {} }));
  f.watcher.reconcile();
  assert.deepEqual(f.changes, [{ kinds: ['card', 'board'], ids: ['c-000001'] }]);
  f.watcher.reconcile();
  assert.equal(f.changes.length, 1);
});

test('resource exhaustion logs once, closes native watching and retains periodic reconcile', async (t) => {
  const logs = [], f = fixture(t, true, { reconcileMs: 30, log: (message) => logs.push(message) });
  let closes = 0;
  f.native.close = async () => { closes++; };
  for (const code of ['ENOSPC', 'EMFILE']) f.native.emit('error', { code });
  assert.equal(logs.length, 1);
  assert.equal(closes, 1);
  f.put('cards/work.md', '---\nid: c-000001\ntitle: Reconciled\n---\n');
  await delay(80);
  assert.equal(f.changes.length, 1);
  await f.watcher.close();
  f.put('cards/work.md', '---\nid: c-000001\ntitle: Closed\n---\n');
  await delay(80);
  assert.equal(f.changes.length, 1);
});

test('watcher close cancels queued work, settles readiness and closes only once', async (t) => {
  const f = fixture(t, true);
  let closes = 0, stopped = 0;
  f.native.close = async () => { closes++; };
  f.watcher.on('close', () => { stopped++; });
  f.put('cards/work.md', '---\nid: c-000001\ntitle: Queued\n---\n');
  f.native.emit('all', 'change', join(f.root, 'cards/work.md'));
  await f.watcher.close();
  await f.watcher.close();
  assert.equal(await f.watcher.ready, false);
  assert.equal(closes, 1);
  assert.equal(stopped, 1);
  await delay(200);
  assert.deepEqual(f.changes, []);
});


test('one thousand queued paths trigger one index refresh per batch', async (t) => {
  let scans = 0;
  const f = fixture(t, true, { refreshIndex(ctx) { scans++; return refresh(ctx); } });
  f.put('cards/work.md', '---\nid: c-000001\ntitle: Batched\n---\n');
  const changed = once(f.watcher, 'change', { signal: AbortSignal.timeout(15_000) });
  for (let i = 0; i < 1000; i++) f.native.emit('all', 'change', join(f.root, `cards/missing-${i}.md`));
  f.native.emit('all', 'change', join(f.root, 'cards/work.md'));
  assert.ok((await changed)[0].ids.includes('c-000001'));
  assert.equal(scans, 2, 'initial refresh plus one batch refresh');
});

test('ready reconciles a change hidden by ignoreInitial during startup', async (t) => {
  const f = fixture(t, true);
  f.put('cards/work.md', '---\nid: c-000001\ntitle: Startup gap\n---\n');
  f.native.emit('ready');
  assert.equal(await f.watcher.ready, true);
  assert.deepEqual(f.changes, [{ kinds: ['card', 'board'], ids: ['c-000001'] }]);
});

test('pending, closed and failed watchers never lend freshness to new contexts', async (t) => {
  for (const state of ['pending', 'closed', 'error', 'startup error']) {
    const f = fixture(t, true, { log: () => {} });
    if (state === 'startup error') f.native.emit('error', { code: 'EIO' });
    f.native.emit('ready');
    if (state === 'error') f.native.emit('error', { code: 'EIO' });
    if (state === 'closed') await f.watcher.close();
    f.put('cards/work.md', '---\nid: c-000001\ntitle: Unseen edit\n---\n');
    if (state === 'pending') f.native.emit('all', 'change', join(f.root, 'cards/work.md'));
    const ctx = { ...f.ctx, warnings: [] };
    f.watcher.reuseFresh(ctx);
    assert.equal(rows(ctx, 'card')[0].title, 'Unseen edit', state);
  }
});

test('a failed path stat does not block other paths in the batch', async (t) => {
  const logs = [], calls = new Map();
  const f = fixture(t, true, { log: (error) => logs.push(error), stat(path) {
    const count = (calls.get(path) ?? 0) + 1;
    calls.set(path, count);
    if (path.endsWith('bad.md') && count === 2) throw Object.assign(new Error('Stat failed'), { code: 'EACCES' });
    return lstatSync(path);
  } });
  f.put('cards/bad.md');
  f.put('cards/work.md', '---\nid: c-000002\ntitle: Good path\n---\n');
  const changed = once(f.watcher, 'change', { signal: AbortSignal.timeout(15_000) });
  for (const path of ['cards/bad.md', 'cards/work.md']) f.native.emit('all', 'change', join(f.root, path));
  assert.ok((await changed)[0].ids.includes('c-000002'));
  assert.equal(calls.get(join(f.root, 'cards/work.md')), 2);
  assert.equal(logs.length, 1);
});

test('failed publication retains batch paths and retries without another native event', async (t) => {
  let snapshots = 0, stats = 0;
  const logs = [];
  const f = fixture(t, true, { log: (error) => logs.push(error), readRows(ctx) {
    if (++snapshots === 2) throw new Error('Snapshot unavailable');
    return rows(ctx);
  }, stat(path) { stats++; return lstatSync(path); } });
  f.put('cards/work.md', '---\nid: c-000001\ntitle: Retry publication\n---\n');
  const changed = once(f.watcher, 'change', { signal: AbortSignal.timeout(15_000) });
  f.native.emit('all', 'change', join(f.root, 'cards/work.md'));
  assert.ok((await changed)[0].ids.includes('c-000001'));
  assert.equal(stats, 3, 'event stat and both batch attempts');
  assert.equal(logs.length, 1);
});

test('unused suppressions expire after ten seconds', (t) => {
  const f = fixture(t, true);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const text = '---\nid: c-000001\ntitle: After expiry\n---\n';
  f.watcher.suppress('cards/work.md', createHash('sha256').update(text).digest('hex'));
  t.mock.timers.tick(10_000);
  f.put('cards/work.md', text);
  f.watcher.reconcile();
  assert.equal(f.changes.length, 1, 'an expired digest cannot suppress a later matching write');
});
