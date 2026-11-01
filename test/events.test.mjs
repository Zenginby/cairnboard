import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent, readEvents } from '../core/events.mjs';
import { withLock } from '../core/lock.mjs';
import { __setFsHooks } from '../core/fsx.mjs';
import { fixedClock, tempData } from './support/env.mjs';

function fixture(t) {
  const root = realpathSync(tempData());
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.cairn', 'events'), { recursive: true });
  mkdirSync(join(root, '.cairn', 'locks'));
  return { root, config: {}, clock: fixedClock('2026-11-01T12:00:00Z'), actor: 'acme',
    mode: 'write', host: 'acme', pid: process.pid, instance: 'instance-a' };
}

const event = (ctx, tx = 'tx-a', patch = {}) => ({ tx, op: 'card.update', target: 'c-000001',
  rev: 'rev-a', actor: ctx.actor, ts: ctx.clock.now().toISOString(), ...patch });
const file = (ctx, name) => join(ctx.root, '.cairn', 'events', name);

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
  assert.equal(Number(readFileSync(file(ctx, 'seq'), 'utf8')), 1);
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
  assert.equal(Number(readFileSync(file(ctx, 'seq'), 'utf8')), 7);
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

test('deduplication reads complete records at the 64 KB tail boundary', (t) => {
  const ctx = fixture(t);
  appendEvent(ctx, event(ctx, 'tx-a', { marker: 'iş'.repeat(20000) }));
  assert.equal(appendEvent(ctx, event(ctx, 'tx-b')), 2);
  assert.equal(appendEvent(ctx, event(ctx, 'tx-b')), 2);
  assert.equal(readEvents(ctx).length, 2);
});

test('a record beginning exactly at the tail boundary is still deduplicated', (t) => {
  const ctx = fixture(t);
  appendEvent(ctx, event(ctx, 'tx-a'));
  const input = event(ctx, 'tx-b', { marker: '' });
  const length = Buffer.byteLength(JSON.stringify({ v: 1, seq: 2, ...input }) + '\n');
  input.marker = 'a'.repeat(64 * 1024 - length);
  assert.equal(appendEvent(ctx, input), 2);
  assert.equal(appendEvent(ctx, event(ctx, 'tx-b')), 2);
  assert.equal(readEvents(ctx).length, 2);
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
  assert.equal(Number(readFileSync(file(ctx, 'seq'), 'utf8')), 1);
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
  const root = realpathSync(tempData());
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
