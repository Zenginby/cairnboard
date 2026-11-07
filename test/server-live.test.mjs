import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLiveWatcher } from '../server/live.mjs';
import { createEvents } from '../server/events.mjs';
import { CairnError } from '../core/errors.mjs';

function fakeWatcher() {
  const watcher = new EventEmitter();
  watcher.reconciles = 0;
  watcher.reconcile = () => { watcher.reconciles++; };
  watcher.close = async () => { watcher.closed = true; watcher.emit('close'); };
  return watcher;
}

function fixture(t, { failures = 1 } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const logs = [], real = fakeWatcher();
  let attempts = 0;
  const live = createLiveWatcher(() => {
    attempts++;
    if (attempts <= failures) throw new CairnError('validation', 'Initialization is required.');
    return real;
  }, { retryMs: 5000, log: (line) => logs.push(line) });
  t.after(() => live.close());
  return { live, real, logs, attempts: () => attempts };
}

test('a server started before the data directory exists begins watching once it appears', (t) => {
  const { live, real, logs, attempts } = fixture(t, { failures: 2 });
  const changes = [];
  live.on('change', (change) => changes.push(change));
  assert.equal(attempts(), 1);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /\n\s+at /u, 'one readable line, not a stack trace');
  t.mock.timers.tick(5000);
  assert.equal(attempts(), 2);
  assert.equal(logs.length, 1, 'the same failure is not logged again');
  t.mock.timers.tick(5000);
  assert.equal(attempts(), 3);
  assert.deepEqual(changes, [{ kinds: ['card', 'project', 'note', 'journal', 'board'], ids: [] }],
    'open tabs refresh once the data directory is ready');
  real.emit('change', { kinds: ['card'], ids: ['c-000001'] });
  assert.deepEqual(changes.at(-1), { kinds: ['card'], ids: ['c-000001'] });
  t.mock.timers.tick(20_000);
  assert.equal(attempts(), 3, 'no retries after the watcher started');
});

test('a reconcile request retries at once and reconciles the started watcher afterwards', async (t) => {
  const { live, real, attempts } = fixture(t);
  await live.reconcile();
  assert.equal(attempts(), 2);
  assert.equal(real.reconciles, 0);
  await live.reconcile();
  assert.equal(real.reconciles, 1);
});

test('the SSE route exists while waiting, and closing stops retries and the watcher', async (t) => {
  const { live, real, attempts } = fixture(t);
  const events = createEvents(live);
  let closed = false;
  live.once('close', () => { closed = true; });
  const res = { writeHead() {}, write() { return true; }, end() {}, once() {}, destroy() {} };
  assert.equal(events.handle({ method: 'GET' }, res, '/api/events'), true);
  await live.reconcile();
  await live.close();
  assert.equal(real.closed, true);
  assert.equal(closed, true);
  t.mock.timers.tick(20_000);
  assert.equal(attempts(), 2);
});

test('closing before the data directory appears stops retrying', async (t) => {
  const { live, attempts } = fixture(t, { failures: Infinity });
  await live.close();
  t.mock.timers.tick(20_000);
  await live.reconcile();
  assert.equal(attempts(), 1);
});
