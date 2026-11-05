import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSync as realOpen } from 'node:fs';
import { __setFsHooks } from '../core/fsx.mjs';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { retryWhileLocked, withLock } from '../core/lock.mjs';
import { fixedClock, tempDir } from './support/env.mjs';

// On Windows a file that another process is deleting stays "delete pending" until its last handle closes. Opening
// or creating that name meanwhile fails with EPERM (sometimes EACCES/EBUSY), not EEXIST or ENOENT. For a lock file
// that is ordinary contention: it must surface as `locked`, which callers retry, never as an internal error.
function withPlatform(t, platform) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  t.after(() => Object.defineProperty(process, 'platform', original));
}

function context(t) {
  const root = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(root, { home, env: {}, clock });
  return openContext({ mode: 'write', dataDir: root, home, env: {}, clock, actor: 'cli:test' });
}

function failLockOpens(t, code, times) {
  let left = times;
  t.after(() => __setFsHooks({}));
  __setFsHooks({ openSync(path, ...rest) {
    if (/[\\/]\.cairn[\\/]locks[\\/][^\\/]+\.lock$/u.test(String(path)) && left > 0) {
      left -= 1;
      throw Object.assign(new Error(`${code}: operation not permitted`), { code });
    }
    return realOpen(path, ...rest);
  } });
  return () => left;
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`win32: ${code} on a lock file is contention, and a retry gets the lock`, (t) => {
    const ctx = context(t);
    withPlatform(t, 'win32');
    failLockOpens(t, code, 2);
    assert.throws(() => withLock(ctx, 'x', () => 'ran'), (error) => error.code === 'locked');
    assert.equal(retryWhileLocked((state) => withLock(ctx, 'x', () => { state.entered = true; return 'ran'; })), 'ran');
  });
}

test('other platforms keep EPERM as a real error', (t) => {
  const ctx = context(t);
  withPlatform(t, 'linux');
  failLockOpens(t, 'EPERM', 1);
  assert.throws(() => withLock(ctx, 'x', () => 'ran'), (error) => error.code === 'EPERM');
});
