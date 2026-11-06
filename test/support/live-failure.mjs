import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { watch } from '../../core/watch.mjs';
import { openContext } from '../../core/context.mjs';
import { initDataDir } from '../../core/roots.mjs';
import { createEvents } from '../../server/events.mjs';
import { spawnCli } from './cli.mjs';
import { tempDir } from './env.mjs';
import { liveCleanup } from './live.mjs';

test('intentional failure with open live resources', (t) => {
  const cleanup = liveCleanup(t);
  const data = tempDir(t), home = tempDir(t);
  initDataDir(data, { home, env: {} });
  const native = new EventEmitter();
  const handle = setInterval(() => {}, 1000);
  native.close = async () => clearInterval(handle);
  const watcher = watch(openContext({ mode: 'read', dataDir: data, home, env: {} }), { createWatcher: () => native });
  cleanup(() => watcher.close());
  const service = createEvents(watcher);
  cleanup(() => service.close());
  // End does not imply close: this was enough to leak the heartbeat in the original implementation.
  const response = new EventEmitter();
  response.writeHead = response.end = response.destroy = () => {};
  response.write = () => true;
  service.handle({ method: 'GET' }, response, '/api/events');
  void spawnCli(['note', 'add', '--title', 'Blocked', '--body', '-', '--json'], {
    data, home, cleanup, keepStdinOpen: true, timeout: 3000,
  }).catch(() => {});
  native.emit('all', 'change', `${data}/notes/missing.md`);
  assert.fail('Intentional cleanup regression failure.');
});
