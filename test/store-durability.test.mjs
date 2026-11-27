import './support/durable-mode.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { recover, write } from '../core/store.mjs';
import { appendEvent, readEvents } from '../core/events.mjs';
import { __setFsHooks } from '../core/fsx.mjs';
import { fixedClock, tempDir } from './support/env.mjs';

function fixture(t, now = '2026-11-01T12:00:00Z') {
  const root = tempDir(t), home = tempDir(t), clock = fixedClock(now);
  initDataDir(root, { home, env: {}, clock });
  return openContext({ mode: 'write', dataDir: root, home, env: {}, clock, actor: 'agent:acme' });
}
function watchSyncs(t, onSync = () => {}) {
  const synced = [];
  t.after(() => __setFsHooks({}));
  __setFsHooks({ syncDirectory(dir) { synced.push(dir); onSync(dir); } });
  return synced;
}
// Windows cannot open a directory to flush it, so directory flushes are skipped there.
const flushes = { skip: process.platform === 'win32' && 'no directory flush on Windows' };
const event = (ts, tx) => ({ tx, op: 'note.write', target: 'a.md', rev: null, ts });

test('the first event of a month makes its new file name durable', flushes, (t) => {
  const ctx = fixture(t);
  appendEvent(ctx, event('2026-10-31T12:00:00Z', 't-a'));
  const synced = watchSyncs(t);
  appendEvent(ctx, event('2026-11-01T12:00:00Z', 't-b'));
  assert.ok(synced.includes(join(ctx.root, '.cairn/events')));
});

test('a finished transaction removes its intent durably', flushes, (t) => {
  const ctx = fixture(t);
  let durable = false;
  watchSyncs(t, (dir) => {
    if (dir === join(ctx.root, '.cairn/pending') && !readdirSync(dir).length) durable = true;
  });
  write(ctx, { op: 'note.write', path: 'note.md', apply: () => 'new' });
  assert.ok(durable);
});

test('recovery flushes a renamed target before recording the commit', flushes, (t) => {
  const ctx = fixture(t);
  writeFileSync(join(ctx.root, 'note.md'), 'old');
  ctx.faults = (point) => { if (point === 'after-rename') throw new Error('crashed'); };
  assert.throws(() => write(ctx, { op: 'note.write', path: 'note.md', apply: () => 'new' }), /crashed/u);
  delete ctx.faults;
  let flushedBeforeEvent = false;
  watchSyncs(t, (dir) => {
    if (dir === ctx.root && !readEvents(ctx).length) flushedBeforeEvent = true;
  });
  assert.equal(recover(ctx).completed, 1);
  assert.ok(flushedBeforeEvent);
});

test('a sequence hint torn by a crash is rebuilt from the event log', (t) => {
  const ctx = fixture(t);
  appendEvent(ctx, event('2026-11-01T12:00:00Z', 't-a'));
  writeFileSync(join(ctx.root, '.cairn/events/seq'), '\0\0\0\0\0\0\0\0\0\0');
  assert.equal(appendEvent(ctx, event('2026-11-01T12:00:01Z', 't-b')), 2);
  assert.ok(existsSync(join(ctx.root, '.cairn/events/seq')));
});

test('any torn sequence hint is rebuilt, keeping the month of the newest event', (t) => {
  const ctx = fixture(t);
  appendEvent(ctx, event('2026-11-01T12:00:00Z', 't-a'));
  assert.equal(appendEvent(ctx, event('2026-10-31T12:00:00Z', 't-b')), 2);
  for (const torn of ['', '2 20', '2 ', 'x\n']) {
    writeFileSync(join(ctx.root, '.cairn/events/seq'), torn);
    // A retried older-month event is found again instead of being appended twice.
    assert.equal(appendEvent(ctx, event('2026-10-31T12:00:00Z', 't-b')), 2, JSON.stringify(torn));
  }
  assert.equal(appendEvent(ctx, event('2026-11-01T12:00:01Z', 't-c')), 3);
});
