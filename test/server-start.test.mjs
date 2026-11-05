import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { installShutdown } from '../server/shutdown.mjs';
import { readServerState, writeServerState } from '../server/state.mjs';
import { tempDir } from './support/env.mjs';

function shutdownFixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const runtime = new EventEmitter(), calls = [];
  runtime.exit = (code) => calls.push(['exit', code]);
  let closed;
  const server = {
    close: (callback) => { calls.push('close'); closed = callback; },
    closeIdleConnections: () => calls.push('idle'),
    closeAllConnections: () => calls.push('force'),
  };
  installShutdown(server, { runtime, removeState: () => calls.push('remove') });
  return { runtime, calls, finish: () => closed() };
}

test('shutdown lets requests finish and removes state without waiting for the deadline', (t) => {
  const f = shutdownFixture(t);
  f.runtime.emit('SIGINT');
  assert.deepEqual(f.calls, ['close', 'idle']);
  f.finish();
  t.mock.timers.tick(2000);
  assert.deepEqual(f.calls, ['close', 'idle', 'remove']);
});

test('shutdown closes remaining connections after two seconds and removes state', (t) => {
  const f = shutdownFixture(t);
  f.runtime.emit('SIGTERM');
  t.mock.timers.tick(1999);
  assert.deepEqual(f.calls, ['close', 'idle']);
  t.mock.timers.tick(1);
  assert.deepEqual(f.calls, ['close', 'idle', 'force', 'remove']);
  f.finish();
});

test('a second signal removes state before exiting immediately', (t) => {
  for (const second of ['SIGINT', 'SIGTERM']) {
    const f = shutdownFixture(t);
    f.runtime.emit('SIGINT');
    f.runtime.emit(second);
    assert.deepEqual(f.calls, ['close', 'idle', 'remove', ['exit', 0]]);
    f.finish();
    t.mock.timers.reset();
  }
});

test('startup with a live recorded pid returns successfully without listening or changing state', (t) => {
  const home = tempDir(t), options = { home, env: {} };
  const state = writeServerState({ ...options, port: 4321, instance: 'run-ffffffffffffffff' });
  const stdout = execFileSync(process.execPath, ['server/start.mjs'], { encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, XDG_STATE_HOME: '', LOCALAPPDATA: '', CAIRN_NO_OPEN: '1' }, timeout: 10000 });
  assert.equal(stdout, `Cairnboard is already running: ${state.url}\n`);
  assert.deepEqual(readServerState(options), state);
});
