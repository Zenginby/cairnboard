import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from '../core/roots.mjs';
import { isAlive, readServerState, writeServerState, removeServerState } from '../server/state.mjs';
import { tempDir } from './support/env.mjs';

test('server state is private, complete and removed only for its owning pid', (t) => {
  const options = { home: tempDir(t), env: {} };
  assert.equal(readServerState(options), null);
  removeServerState(options);
  const state = { v: 1, port: 4322, pid: process.pid, url: 'http://127.0.0.1:4322/', startedAt: '2026-11-05T12:00:00.000Z' };
  assert.deepEqual(writeServerState({ ...options, ...state }), state);
  const dir = stateDir(options), file = join(dir, 'server.json');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), state);
  assert.deepEqual(readServerState(options), state);
  assert.deepEqual(readdirSync(dir), ['server.json']);
  if (process.platform !== 'win32') {
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  removeServerState({ ...options, pid: process.pid + 1 });
  assert.deepEqual(readServerState(options), state);
  writeServerState({ ...options, port: 4323, pid: process.pid + 1 });
  removeServerState(options);
  assert.equal(readServerState(options).pid, process.pid + 1);
  removeServerState({ ...options, pid: process.pid + 1 });
  assert.equal(readServerState(options), null);
});

test('isAlive recognizes running, dead and inaccessible processes without probing invalid pids', () => {
  assert.equal(isAlive(process.pid), true);
  for (const pid of [0, -1, 1.5, undefined, '1']) {
    assert.equal(isAlive(pid, { kill: () => assert.fail('invalid pid must not be probed') }), false);
  }
  for (const [code, expected] of [['ESRCH', false], ['EPERM', true]]) {
    assert.equal(isAlive(123, { kill: (pid, signal) => {
      assert.equal(pid, 123);
      assert.equal(signal, 0);
      throw Object.assign(new Error('probe failed'), { code });
    } }), expected);
  }
});

test('server state retries transient renames and preserves the old record if retries fail', (t) => {
  const options = { home: tempDir(t), env: {} };
  writeServerState({ ...options, port: 4321 });
  let attempts = 0;
  writeServerState({ ...options, port: 4322, rename: (from, to) => {
    attempts += 1;
    if (attempts <= 2) throw Object.assign(new Error('busy'), { code: attempts === 1 ? 'EPERM' : 'EBUSY' });
    renameSync(from, to);
  } });
  assert.equal(attempts, 3);
  assert.equal(readServerState(options).port, 4322);
  attempts = 0;
  assert.throws(() => writeServerState({ ...options, port: 4323, rename: () => {
    attempts += 1;
    throw Object.assign(new Error('busy'), { code: 'EBUSY' });
  } }), { code: 'EBUSY' });
  assert.equal(attempts, 6);
  assert.equal(readServerState(options).port, 4322);
  assert.deepEqual(readdirSync(stateDir(options)), ['server.json']);
});
