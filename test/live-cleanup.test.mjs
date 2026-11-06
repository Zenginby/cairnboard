import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('a failed live test exits with its watcher, heartbeat and CLI child closed', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--test', 'test/support/live-failure.mjs'], {
    encoding: 'utf8', timeout: 15_000, env,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null);
  assert.equal(child.status, 1, child.stdout + child.stderr);
  assert.match(child.stdout, /Intentional cleanup regression failure/u);
  assert.doesNotMatch(child.stdout + child.stderr, /unhandledRejection/u);
});

test('strict acceptance fails instead of skipping unavailable live prerequisites', () => {
  const script = `
    import { liveUnavailable } from './test/support/live.mjs';
    liveUnavailable({ skip() { process.stdout.write('skipped'); } }, process.argv[1]);
  `;
  for (const reason of ['Browser unavailable', 'Native file watching unavailable', 'Loopback listen unavailable']) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, reason], {
      env: { ...process.env, CAIRN_LIVE_STRICT: '1' }, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.ok(child.stderr.includes(reason));
  }
});
