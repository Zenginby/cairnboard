import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { __setTestFsync, syncFile, testFsyncSkipped } from '../core/fsx.mjs';

const fsx = new URL('../core/fsx.mjs', import.meta.url).href;

function outsideRunner(fastMode, script, context) {
  const env = { ...process.env };
  if (context === undefined) delete env.NODE_TEST_CONTEXT;
  else env.NODE_TEST_CONTEXT = context;
  if (fastMode === undefined) delete env.CAIRN_TEST_NO_FSYNC;
  else env.CAIRN_TEST_NO_FSYNC = fastMode;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
}

test('a fast-mode request outside the test runner warns once and still calls fsync', () => {
  const result = outsideRunner('1', `
    import assert from 'node:assert/strict';
    for (const url of ${JSON.stringify([fsx, fsx + '?second-copy'])}) {
      const { syncFile, testFsyncSkipped } = await import(url);
      assert.equal(testFsyncSkipped(), false);
      assert.throws(() => syncFile(-1), { code: 'ERR_OUT_OF_RANGE' });
    }
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr.trim(), /^Ignoring CAIRN_TEST_NO_FSYNC outside the Node test runner\.$/u);
});

test('an empty NODE_TEST_CONTEXT does not count as the test runner', () => {
  const result = outsideRunner('1', `
    import assert from 'node:assert/strict';
    const { __setTestFsync, testFsyncSkipped } = await import(${JSON.stringify(fsx)});
    assert.equal(testFsyncSkipped(), false);
    __setTestFsync(true);
    assert.equal(testFsyncSkipped(), false);
  `, '');
  assert.equal(result.status, 0, result.stderr);
});

test('the test override cannot turn fast mode on outside the test runner', () => {
  for (const fastMode of [undefined, '0', '1']) {
    const result = outsideRunner(fastMode, `
      import assert from 'node:assert/strict';
      const { __setTestFsync, syncFile, testFsyncSkipped } = await import(${JSON.stringify(fsx)});
      for (const skip of [true, undefined]) {
        __setTestFsync(skip);
        assert.equal(testFsyncSkipped(), false);
        assert.throws(() => syncFile(-1), { code: 'ERR_OUT_OF_RANGE' });
      }
    `);
    assert.equal(result.status, 0, `${fastMode}: ${result.stderr}`);
  }
});

test('inside the test runner the override switches flushes and restores the environment mode', (t) => {
  const requested = process.env.CAIRN_TEST_NO_FSYNC === '1';
  t.after(() => __setTestFsync());
  assert.equal(testFsyncSkipped(), requested);
  __setTestFsync(false);
  assert.equal(testFsyncSkipped(), false);
  assert.throws(() => syncFile(-1), { code: 'ERR_OUT_OF_RANGE' });
  __setTestFsync(true);
  assert.equal(testFsyncSkipped(), true);
  assert.doesNotThrow(() => syncFile(-1));
  __setTestFsync();
  assert.equal(testFsyncSkipped(), requested);
});
