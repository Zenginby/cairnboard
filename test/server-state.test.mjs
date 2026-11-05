import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from '../core/roots.mjs';
import { readServerState, writeServerState, removeServerState } from '../server/state.mjs';
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
