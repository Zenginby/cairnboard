import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeServerState } from '../server/state.mjs';
import { sessionKey, siteHost, tokenVerifier } from '../server/session.mjs';
import { runCli, spawnCli } from './support/cli.mjs';
import { tempDir } from './support/env.mjs';

test('cairn open reports a missing server with the usual envelope and a nonzero exit', async (t) => {
  const home = tempDir(t);
  for (const run of [runCli, spawnCli]) {
    const response = await run(['open', '--json'], { home });
    assert.equal(response.code, 3);
    assert.deepEqual(response.json, { v: 1, ok: false,
      error: { code: 'not_found', message: 'Cairnboard is not running; start it with npm start.' }, warnings: [] });
  }
});

test('cairn open needs no data directory and sends a one-time login URL only to the opener', async (t) => {
  const home = tempDir(t), opened = [];
  const { url } = writeServerState({ home, env: {}, port: 4322, instance: 'run-cccccccccccccccc' });
  const response = await runCli(['open', '--json', '--data', join(home, 'missing')], {
    home, openBrowser: (target) => opened.push(target),
  });
  assert.equal(response.code, 0);
  assert.deepEqual(response.json, { v: 1, ok: true, data: { url }, warnings: [] });
  assert.equal(opened.length, 1);
  const login = new URL(opened[0]);
  assert.equal(login.origin, `http://${siteHost(sessionKey({ home, env: {} }))}:4322`);
  assert.equal(login.pathname, '/auth');
  const token = login.searchParams.get('t');
  assert.equal(tokenVerifier(sessionKey({ home, env: {} }), 4322, 'run-cccccccccccccccc')(token), true);
  assert.doesNotMatch(response.stdout + response.stderr, new RegExp(token.split('.')[2]));
});

test('cairn open ignores a record whose server process is gone', async (t) => {
  const home = tempDir(t), opened = [];
  writeServerState({ home, env: {}, port: 4322, instance: 'run-cccccccccccccccc', pid: 2 ** 30 });
  const response = await runCli(['open', '--json'], { home, openBrowser: (target) => opened.push(target), isAlive: () => false });
  assert.equal(response.code, 3);
  assert.equal(response.json.error.code, 'not_found');
  assert.deepEqual(opened, []);
});

test('cairn open treats a record without a run id (older server) as not running', async (t) => {
  const home = tempDir(t), opened = [];
  writeServerState({ home, env: {}, port: 4322 });
  const response = await runCli(['open', '--json'], { home, openBrowser: (target) => opened.push(target) });
  assert.equal(response.code, 3);
  assert.deepEqual(opened, []);
});
