import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { EventEmitter, once } from 'node:events';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { watch } from '../core/watch.mjs';
import { openContext } from '../core/context.mjs';
import { createApp } from '../server/app.mjs';
import { createApi } from '../server/api.mjs';
import { createEvents } from '../server/events.mjs';
import { createGuard } from '../server/guard.mjs';
import { mintCookie, cookieName, siteHost } from '../server/session.mjs';
import { tempDir } from './support/env.mjs';
import { spawnCli } from './support/cli.mjs';
import { liveBudgetMs, liveCleanup, liveUnavailable } from './support/live.mjs';

const port = 4330, key = Buffer.alloc(32, 7);
const host = `${siteHost(key)}:${port}`;
const cookie = `${cookieName(port)}=${mintCookie(key, port)}`;

function fixture(t, { watcher = new EventEmitter(), limit, cleanup = liveCleanup(t) } = {}) {
  watcher.reconcile ??= () => {};
  const events = createEvents(watcher, { limit });
  cleanup(() => events.close());
  const app = createApp({ root: tempDir(t), handler: () => assert.fail('Unexpected page route'),
    guard: createGuard({ port, key, instance: 'run-aaaaaaaaaaaaaaaa' }),
    api: createApi({ open: () => assert.fail('SSE must not open a read context'), events }) });
  return async (path = '/api/events', headers = { host, cookie }, method = 'GET') => {
    const req = new IncomingMessage(new Socket());
    Object.assign(req, { url: path, method, headers });
    let output = '';
    const socket = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } });
    const res = new ServerResponse(req);
    res.useChunkedEncodingByDefault = false;
    res.assignSocket(socket);
    cleanup(() => { res.destroy(); socket.destroy(); req.destroy(); req.socket.destroy(); });
    await app(req, res);
    await setImmediate();
    return { res, body: () => output, close: () => res.destroy() };
  };
}

test('SSE uses the normal session and Host guards, including reconcile', async (t) => {
  const request = fixture(t);
  for (const path of ['/api/events', '/api/reconcile']) {
    assert.equal((await request(path, { host })).res.statusCode, 401);
    assert.equal((await request(path, { host: 'localhost:4330', cookie })).res.statusCode, 421);
    assert.equal((await request(path, { host, cookie }, 'POST')).res.statusCode, 405);
  }
});

test('SSE caps streams, frees a closed slot, sends retry and heartbeat, and cleans up', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const watcher = new EventEmitter();
  let reconciles = 0;
  watcher.reconcile = () => { reconciles++; };
  const request = fixture(t, { watcher, limit: 2 });
  const first = await request(), second = await request();
  assert.equal(first.res.getHeader('Content-Type'), 'text/event-stream; charset=utf-8');
  assert.match(first.body(), /retry: 2000\n\n/u);
  assert.equal((await request()).res.statusCode, 503);
  first.close();
  await setImmediate();
  assert.equal((await request()).res.statusCode, 200);
  t.mock.timers.tick(25_000);
  await setImmediate();
  assert.match(second.body(), /: heartbeat\n\n/u);
  const before = first.body();
  watcher.emit('change', { kinds: ['card'], ids: ['c-000001'] });
  await setImmediate();
  assert.match(second.body(), /event: change\ndata: \{"kinds":\["card"\],"ids":\["c-000001"\]\}\n\n/u);
  assert.equal(first.body(), before);
  assert.equal((await request('/api/reconcile')).res.statusCode, 204);
  assert.equal(reconciles, 1);
});

test('a CLI claim on sample data reaches an authenticated SSE stream', async (t) => {
  const cleanup = liveCleanup(t);
  const data = join(tempDir(t), 'data'), home = tempDir(t);
  cpSync('sample-data', data, { recursive: true });
  const watcher = watch(openContext({ mode: 'read', dataDir: data, home, env: {} }));
  cleanup(() => watcher.close());
  if (!await watcher.ready) { liveUnavailable(t, 'Native file watching unavailable'); return; }
  const request = fixture(t, { watcher, cleanup });
  const stream = await request();
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), liveBudgetMs);
  timer.unref();
  cleanup(() => { clearTimeout(timer); controller.abort(); });
  try {
    const [claimed] = await Promise.all([
      spawnCli(['card', 'claim', 'c-fat009', '--json'], { data, home, cleanup, signal: controller.signal,
        env: { CAIRN_ACTOR: 'test-agent' }, stdin: 'yes\n' }),
      once(watcher, 'change', { signal: controller.signal }),
    ]);
    assert.equal(claimed.code, 0, claimed.stdout + claimed.stderr);
    if (process.env.CAIRN_LIVE_STRICT === '1') assert.ok(Date.now() - start < liveBudgetMs);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  assert.match(stream.body(), /event: change/u);
  assert.match(stream.body(), /c-fat009/u);
});

test('watcher shutdown destroys open streams and clears heartbeat timers immediately', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const watcher = new EventEmitter();
  const request = fixture(t, { watcher });
  const stream = await request();
  watcher.emit('close');
  assert.equal(stream.res.destroyed, true);
  assert.equal(stream.res.writableEnded, true);
  assert.equal(watcher.listenerCount('change'), 0);
  const body = stream.body();
  const writes = t.mock.method(stream.res, 'write');
  t.mock.timers.tick(50_000);
  assert.equal(writes.mock.callCount(), 0);
  assert.equal(stream.body(), body);
  assert.equal((await request()).res.statusCode, 503);
});

test('concurrent reconcile requests share one deferred in-flight reconcile', async (t) => {
  const cleanup = liveCleanup(t), watcher = new EventEmitter();
  let calls = 0, finish;
  watcher.reconcile = () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
  const service = createEvents(watcher);
  cleanup(() => service.close());
  const response = () => {
    const res = new EventEmitter();
    res.writeHead = (status) => { res.status = status; };
    res.end = () => { res.ended = true; };
    res.destroy = () => { res.destroyed = true; };
    return res;
  };
  const first = response(), second = response(), third = response();
  service.handle({}, first, '/api/reconcile');
  service.handle({}, second, '/api/reconcile');
  assert.equal(calls, 0, 'reconcile does not run in the request stack');
  await setImmediate();
  assert.equal(calls, 1);
  service.handle({}, third, '/api/reconcile');
  assert.equal(calls, 1, 'a call during the in-flight reconcile shares its result');
  assert.equal(first.ended, undefined);
  finish();
  await setImmediate();
  for (const res of [first, second, third]) {
    assert.equal(res.status, 204);
    assert.equal(res.ended, true);
  }
  service.handle({}, response(), '/api/reconcile');
  service.close();
  await setImmediate();
  assert.equal(calls, 1, 'shutdown cancels a scheduled reconcile');
});
