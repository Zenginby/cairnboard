import { spawnSync } from 'node:child_process';

// Isolate the product latency target from the parallel, filesystem-heavy unit suite.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1',
  'test/server-events.test.mjs', 'test/live-updates.test.mjs'], {
  env: { ...process.env, CAIRN_LIVE_STRICT: '1' }, stdio: 'inherit', timeout: 180_000,
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
