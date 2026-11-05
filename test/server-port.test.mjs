import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { findPort } from '../server/port.mjs';

const busy = () => Object.assign(new Error('busy'), { code: 'EADDRINUSE' });

test('findPort skips busy ports and passes the loopback host to the probe', async () => {
  const calls = [];
  assert.equal(await findPort({ listen: async (port, host) => {
    calls.push([port, host]);
    if (port === 4321) throw busy();
  } }), 4322);
  assert.deepEqual(calls, [[4321, '127.0.0.1'], [4322, '127.0.0.1']]);
  await assert.rejects(findPort({ listen: async () => { throw busy(); } }), /No free port.*4321–4340/u);
  await assert.rejects(findPort({ listen: async () => { throw new Error('probe failed'); } }), /probe failed/u);
});

test('findPort detects a real occupied loopback port and releases its probe', async (t) => {
  const occupied = createServer();
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  try {
    await new Promise((resolve, reject) => occupied.once('error', reject).listen(0, '127.0.0.1', resolve));
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.skip('Loopback listen is forbidden (EPERM); real port probing requires socket permission.');
    return;
  }
  const from = occupied.address().port;
  await assert.rejects(findPort({ from, to: from }), /No free port/u);
  const port = await findPort({ from, to: from + 20 });
  assert.ok(port > from);
  const free = createServer();
  await new Promise((resolve, reject) => free.once('error', reject).listen(port, '127.0.0.1', resolve));
  await new Promise((resolve) => free.close(resolve));
});
