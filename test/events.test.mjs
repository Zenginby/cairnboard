import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent, readEvents } from '../core/events.mjs';
import { withLock } from '../core/lock.mjs';
import { __setFsHooks } from '../core/fsx.mjs';
import { fixedClock, tempDir } from './support/env.mjs';

function fixture(t) {
  const root = tempDir(t, 'cairn-data-');
  mkdirSync(join(root, '.cairn', 'events'), { recursive: true });
  mkdirSync(join(root, '.cairn', 'locks'));
  return { root, config: {}, clock: fixedClock('2026-11-01T12:00:00Z'), actor: 'acme',
    mode: 'write', host: 'acme', pid: process.pid, instance: 'instance-a' };
}

const event = (ctx, tx = 'tx-a', patch = {}) => ({ tx, op: 'card.update', target: 'c-000001',
  rev: 'rev-a', actor: ctx.actor, ts: ctx.clock.now().toISOString(), ...patch });
const file = (ctx, name) => join(ctx.root, '.cairn', 'events', name);
const mirror = (ctx) => readFileSync(file(ctx, 'seq'), 'utf8');

test('events use the public envelope, preserve metadata and deduplicate transactions', (t) => {
  const ctx = fixture(t);
  const input = event(ctx, 'tx-a', { fields: ['column'], from: 'todo', to: 'doing' });
  assert.equal(appendEvent(ctx, input), 1);
  const bytes = readFileSync(file(ctx, '2026-11.jsonl'), 'utf8');
  assert.equal(bytes.split('\n').length, 2);
  assert.deepEqual(JSON.parse(bytes), { v: 1, seq: 1, ts: input.ts, actor: input.actor, op: input.op,
    target: input.target, fields: ['column'], from: 'todo', to: 'doing', tx: input.tx, rev: input.rev });
  assert.equal(appendEvent(ctx, { ...input, rev: 'rev-b' }), 1);
  assert.equal(readFileSync(file(ctx, '2026-11.jsonl'), 'utf8'), bytes);
  assert.equal(mirror(ctx), '1 2026-11\n');
});

test('duplicate transactions do not rewrite the sequence mirror', (t) => {
  const ctx = fixture(t);
  appendEvent(ctx, event(ctx));
  t.after(() => __setFsHooks({}));
  __setFsHooks({ rename() { throw new Error('unexpected rename'); } });
  assert.equal(appendEvent(ctx, event(ctx)), 1);
});

test('actor and timestamp default to the context', (t) => {
  const ctx = fixture(t);
  const input = event(ctx);
  delete input.actor;
  delete input.ts;
  appendEvent(ctx, input);
  assert.equal(readEvents(ctx)[0].actor, ctx.actor);
  assert.equal(readEvents(ctx)[0].ts, ctx.clock.now().toISOString());
});

test('sequence numbers are gapless and sinceSeq is an exclusive cursor', (t) => {
  const ctx = fixture(t);
  for (let i = 1; i <= 6; i++) assert.equal(appendEvent(ctx, event(ctx, `tx-${i}`)), i);
  assert.equal(appendEvent(ctx, event(ctx, 'tx-2')), 2);
  assert.equal(appendEvent(ctx, event(ctx, 'tx-7')), 7);
  assert.deepEqual(readEvents(ctx).map(({ seq }) => seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(readEvents(ctx, { sinceSeq: 5 }).map(({ seq }) => seq), [6, 7]);
  assert.deepEqual(readEvents(ctx, { sinceSeq: 7 }), []);
  assert.equal(mirror(ctx), '7 2026-11\n');
});

test('appending and deduplicating do not read older month files', { skip: process.platform === 'win32' }, (t) => {
  const ctx = fixture(t);
  for (const month of ['09', '10', '11']) {
    appendEvent(ctx, event(ctx, `tx-${month}`, { ts: `2026-${month}-01T12:00:00Z` }));
  }
  const older = ['2026-09.jsonl', '2026-10.jsonl'].map((name) => file(ctx, name));
  try {
    for (const path of older) chmodSync(path, 0o000);
    for (const path of older) assert.throws(() => readFileSync(path), { code: 'EACCES' });
    assert.equal(appendEvent(ctx, event(ctx, 'tx-11')), 3);
    assert.equal(appendEvent(ctx, event(ctx, 'tx-next')), 4);
  } finally {
    for (const path of older) chmodSync(path, 0o600);
  }
  assert.deepEqual(readEvents(ctx).map(({ seq }) => seq), [1, 2, 3, 4]);
});

test('the next sequence uses the greater of the mirror and the newest month tail', (t) => {
  for (const saved of [0, 6]) {
    const ctx = fixture(t);
    appendEvent(ctx, event(ctx));
    writeFileSync(file(ctx, 'seq'), `${saved}\n`);
    assert.equal(appendEvent(ctx, event(ctx, 'tx-b')), Math.max(saved, 1) + 1);
  }
});

test('deduplication checks the newest month even when the input timestamp is older', (t) => {
  const ctx = fixture(t);
  appendEvent(ctx, event(ctx));
  assert.equal(appendEvent(ctx, event(ctx, 'tx-a', { ts: '2026-10-01T12:00:00Z' })), 1);
  assert.equal(existsSync(file(ctx, '2026-10.jsonl')), false);
});

test('content keys are rejected before writing, including nested metadata', (t) => {
  const ctx = fixture(t);
  for (const key of ['title', 'body', 'text', 'content']) {
    for (const extra of [{ [key]: 'private' }, { changes: [{ [key]: 'private' }] }]) {
      assert.throws(() => appendEvent(ctx, event(ctx, 'tx-a', extra)), TypeError);
    }
  }
  for (const extra of [{ v: 2 }, { seq: 100 }]) {
    assert.throws(() => appendEvent(ctx, event(ctx, 'tx-a', extra)), TypeError);
  }
  assert.deepEqual(readdirSync(file(ctx, '')), []);
  assert.deepEqual(readdirSync(join(ctx.root, '.cairn', 'locks')), []);
});

test('the events lock serializes writers', (t) => {
  const ctx = fixture(t);
  withLock(ctx, '_events', () => {
    assert.throws(() => appendEvent(ctx, event(ctx)), { code: 'locked' });
  });
  assert.deepEqual(readEvents(ctx), []);
});

test('UTC month files preserve append order across boundaries and clock rollback', (t) => {
  const ctx = fixture(t);
  const times = ['2026-10-31T23:59:59Z', '2026-11-01T00:00:00Z', '2026-10-31T23:59:58Z'];
  times.forEach((ts, i) => assert.equal(appendEvent(ctx, event(ctx, `tx-${i}`, { ts })), i + 1));
  assert.deepEqual(readdirSync(file(ctx, '')).sort(), ['2026-10.jsonl', '2026-11.jsonl', 'seq']);
  assert.deepEqual(readEvents(ctx).map(({ seq, ts }) => [seq, ts]), times.map((ts, i) => [i + 1, ts]));
  assert.deepEqual(readEvents(ctx, { sinceSeq: 1 }).map(({ seq }) => seq), [2, 3]);
});

test('the month follows UTC even when the timestamp contains an offset', (t) => {
  const ctx = fixture(t);
  appendEvent(ctx, event(ctx, 'tx-a', { ts: '2026-11-01T00:30:00+01:00' }));
  assert.ok(existsSync(file(ctx, '2026-10.jsonl')));
  assert.equal(existsSync(file(ctx, '2026-11.jsonl')), false);
});

// Byte length of the stored record for an event whose marker is still empty.
const recordBytes = (seq, input) => Buffer.byteLength(JSON.stringify({ v: 1, seq, ...input }) + '\n');

test('records over 16 KB are rejected before anything is written', (t) => {
  const ctx = fixture(t);
  assert.throws(() => appendEvent(ctx, event(ctx, 'tx-a', { marker: 'a'.repeat(70000) })), TypeError);
  const input = event(ctx, 'tx-a', { marker: '' });
  input.marker = 'ş'.repeat(Math.ceil((16 * 1024 - recordBytes(1, input)) / 2) + 1);
  assert.throws(() => appendEvent(ctx, input), TypeError);
  assert.deepEqual(readdirSync(file(ctx, '')), []);
  input.marker = 'a'.repeat(16 * 1024 - 64 - recordBytes(1, { ...input, marker: '' }));
  assert.equal(appendEvent(ctx, input), 1);
});

test('deduplication reads complete records at the 64 KB tail boundary', (t) => {
  const ctx = fixture(t);
  for (let i = 1; i <= 6; i++) assert.equal(appendEvent(ctx, event(ctx, `tx-${i}`, { marker: 'iş'.repeat(5000) })), i);
  assert.ok(readFileSync(file(ctx, '2026-11.jsonl')).length > 64 * 1024);
  assert.equal(appendEvent(ctx, event(ctx, 'tx-6')), 6);
  assert.equal(appendEvent(ctx, event(ctx, 'tx-7')), 7);
  assert.equal(readEvents(ctx).length, 7);
});

test('a record beginning exactly at the tail boundary is still deduplicated', (t) => {
  const ctx = fixture(t);
  appendEvent(ctx, event(ctx, 'tx-a', { marker: 'a'.repeat(15000) }));
  // tx-b and four fillers make up exactly the last 64 KB of the month file.
  const inputs = ['tx-b', 'tx-c', 'tx-d', 'tx-e', 'tx-f'].map((tx) => event(ctx, tx, { marker: '' }));
  const sizes = inputs.map((input, i) => recordBytes(i + 2, input));
  const free = 64 * 1024 - sizes.reduce((sum, size) => sum + size, 0);
  inputs.forEach((input, i) => {
    input.marker = 'a'.repeat(Math.floor(free / 5) + (i === 4 ? free % 5 : 0));
    assert.equal(appendEvent(ctx, input), i + 2);
  });
  const bytes = readFileSync(file(ctx, '2026-11.jsonl'));
  assert.equal(bytes.subarray(bytes.length - 64 * 1024).toString('utf8').indexOf('"tx":"tx-b"') > 0, true);
  assert.equal(bytes[bytes.length - 64 * 1024 - 1], 0x0a);
  assert.equal(appendEvent(ctx, event(ctx, 'tx-b')), 2);
  assert.equal(readEvents(ctx).length, 6);
});

test('a failed sequence rename can be retried without duplicates or gaps', (t) => {
  const ctx = fixture(t);
  t.after(() => __setFsHooks({}));
  __setFsHooks({ rename(from, to) {
    if (to === file(ctx, 'seq')) throw new Error('rename failed');
    renameSync(from, to);
  } });
  assert.throws(() => appendEvent(ctx, event(ctx)), /rename failed/u);
  __setFsHooks({});
  assert.equal(appendEvent(ctx, event(ctx)), 1);
  assert.equal(mirror(ctx), '1 2026-11\n');
  assert.equal(appendEvent(ctx, event(ctx, 'tx-b')), 2);
  assert.deepEqual(readEvents(ctx).map(({ seq }) => seq), [1, 2]);
  assert.deepEqual(readdirSync(file(ctx, '')).sort(), ['2026-11.jsonl', 'seq']);
});

test('a different transaction after a sequence write failure also stays gapless', (t) => {
  const ctx = fixture(t);
  t.after(() => __setFsHooks({}));
  __setFsHooks({ rename() { throw new Error('rename failed'); } });
  assert.throws(() => appendEvent(ctx, event(ctx)), /rename failed/u);
  __setFsHooks({});
  assert.equal(appendEvent(ctx, event(ctx, 'tx-b')), 2);
  assert.deepEqual(readEvents(ctx).map(({ seq }) => seq), [1, 2]);
});

test('an after-event fault leaves one durable event that can be retried', (t) => {
  const ctx = fixture(t);
  ctx.faults = (point) => {
    assert.equal(point, 'after-event');
    throw new Error('interrupted');
  };
  assert.throws(() => appendEvent(ctx, event(ctx)), /interrupted/u);
  assert.equal(appendEvent(ctx, event(ctx)), 1);
  assert.deepEqual(readEvents(ctx).map(({ seq }) => seq), [1]);
});

test('readEvents is read-only and empty roots do not acquire metadata directories', (t) => {
  const ctx = fixture(t);
  const root = tempDir(t, 'cairn-data-');
  for (const mode of ['read', 'dry-run', 'inspect']) {
    assert.deepEqual(readEvents({ ...ctx, root, mode }), []);
    assert.throws(() => appendEvent({ ...ctx, mode }, event(ctx)), TypeError);
  }
  assert.deepEqual(readdirSync(root), []);
  assert.deepEqual(readdirSync(file(ctx, '')), []);
});

test('malformed log records and symlinks fail closed', (t) => {
  const ctx = fixture(t);
  writeFileSync(file(ctx, '2026-11.jsonl'), '{broken\n');
  assert.throws(() => readEvents(ctx), { code: 'validation' });
  assert.throws(() => appendEvent(ctx, event(ctx)), { code: 'validation' });
  assert.equal(readFileSync(file(ctx, '2026-11.jsonl'), 'utf8'), '{broken\n');
  symlinkSync(file(ctx, '2026-11.jsonl'), file(ctx, '2026-10.jsonl'));
  assert.throws(() => readEvents(ctx));
});

test('a clock moved back a month keeps sequences unique after a lost mirror write', (t) => {
  const ctx = fixture(t);
  assert.equal(appendEvent(ctx, event(ctx, 'tx-nov')), 1);
  ctx.clock = fixedClock('2026-10-20T12:00:00Z');
  t.after(() => __setFsHooks({}));
  __setFsHooks({ rename(from, to) {
    if (to === file(ctx, 'seq') && existsSync(file(ctx, '2026-10.jsonl'))) throw new Error('crashed');
    renameSync(from, to);
  } });
  assert.throws(() => appendEvent(ctx, event(ctx, 'tx-oct')), /crashed/u);
  __setFsHooks({});
  assert.equal(appendEvent(ctx, event(ctx, 'tx-oct')), 2);
  assert.equal(appendEvent(ctx, event(ctx, 'tx-next')), 3);
  assert.equal(mirror(ctx), '3 2026-10\n');
  assert.deepEqual(readEvents(ctx).map(({ seq, tx }) => [seq, tx]), [[1, 'tx-nov'], [2, 'tx-oct'], [3, 'tx-next']]);
});

test('the bare sequence mirror of earlier versions is still read', (t) => {
  const ctx = fixture(t);
  appendEvent(ctx, event(ctx));
  writeFileSync(file(ctx, 'seq'), '1\n');
  assert.equal(appendEvent(ctx, event(ctx)), 1);
  assert.equal(mirror(ctx), '1 2026-11\n');
  assert.equal(appendEvent(ctx, event(ctx, 'tx-b')), 2);
  for (const text of ['x\n', '1 2026\n', '-1\n']) {
    writeFileSync(file(ctx, 'seq'), text);
    assert.throws(() => appendEvent(ctx, event(ctx, 'tx-c')), { code: 'validation' });
  }
});

test('an events folder swapped for an outside symlink is never appended to', (t) => {
  const ctx = fixture(t);
  appendEvent(ctx, event(ctx));
  const outside = tempDir(t, 'cairn-outside-');
  writeFileSync(join(outside, '2026-11.jsonl'), 'outside\n');
  t.after(() => __setFsHooks({}));
  let checks = 0;
  // The second check of the month file is the append; the first reads its tail.
  __setFsHooks({ afterCheck(path) {
    if (path !== file(ctx, '2026-11.jsonl') || ++checks < 2) return;
    __setFsHooks({});
    renameSync(file(ctx, ''), join(ctx.root, '.cairn', 'old'));
    symlinkSync(outside, file(ctx, ''), 'dir');
  } });
  assert.throws(() => appendEvent(ctx, event(ctx, 'tx-b')), { code: 'unsafe_path' });
  assert.equal(readFileSync(join(outside, '2026-11.jsonl'), 'utf8'), 'outside\n');
  assert.deepEqual(readdirSync(outside), ['2026-11.jsonl']);
});
