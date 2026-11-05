import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listenLoopback, serverGroup } from '../server/listen.mjs';

const fakeServer = (log, port, host) => ({ port, host, close(callback) { log.push(['close', port, host]); callback?.(); } });
const error = (code) => Object.assign(new Error(code), { code });

test('listens on both loopbacks with the same port', async () => {
  const log = [];
  const { port, servers } = await listenLoopback({ find: async ({ from }) => from,
    listen: async (p, host) => { log.push(['listen', p, host]); return fakeServer(log, p, host); } });
  assert.equal(port, 4321);
  assert.deepEqual(servers.map((s) => s.host), ['127.0.0.1', '::1']);
});

test('if the IPv6 side is taken after the probe, the IPv4 listener is closed and the next port is tried', async () => {
  const log = [];
  const { port, servers } = await listenLoopback({ find: async ({ from }) => from,
    listen: async (p, host) => {
      if (p === 4321 && host === '::1') throw error('EADDRINUSE');
      return fakeServer(log, p, host);
    } });
  assert.equal(port, 4322);
  assert.deepEqual(log, [['close', 4321, '127.0.0.1']]);
  assert.equal(servers.length, 2);
});

test('a machine without IPv6 listens on 127.0.0.1 only; other errors stop', async () => {
  const { servers } = await listenLoopback({ find: async ({ from }) => from,
    listen: async (p, host) => { if (host === '::1') throw error('EADDRNOTAVAIL'); return fakeServer([], p, host); } });
  assert.deepEqual(servers.map((s) => s.host), ['127.0.0.1']);
  await assert.rejects(listenLoopback({ find: async ({ from }) => from, listen: async () => { throw error('EINVAL'); } }), /EINVAL/u);
  await assert.rejects(listenLoopback({ from: 4321, to: 4322, find: async ({ from }) => from,
    listen: async () => { throw error('EADDRINUSE'); } }), /No free port/u);
});

test('serverGroup closes every listener and calls back once', () => {
  const calls = [];
  const servers = [1, 2].map((n) => ({
    close(callback) { calls.push(`close${n}`); callback(); },
    closeIdleConnections() { calls.push(`idle${n}`); },
    closeAllConnections() { calls.push(`all${n}`); },
  }));
  const group = serverGroup(servers);
  let done = 0;
  group.close(() => { done += 1; });
  group.closeIdleConnections();
  group.closeAllConnections();
  assert.equal(done, 1);
  assert.deepEqual(calls, ['close1', 'close2', 'idle1', 'idle2', 'all1', 'all2']);
});
