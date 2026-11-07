import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openContext } from '../core/context.mjs';
import { initDataDir } from '../core/roots.mjs';
import { reconcileExternal } from '../core/changes.mjs';
import { readEvents } from '../core/events.mjs';
import { watch } from '../core/watch.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { runCli } from './support/cli.mjs';

for (const server of [true, false]) {
  test(`owner edits plan, agent write rejected, changes --diff shows edit (${server ? 'watch' : 'CLI only'})`,
    async (t) => {
      const home = tempDir(t), data = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
      initDataDir(data, { home, env: {}, clock });
      const opts = { home, data, clock };
      const run = (args, extra = {}) => runCli([...args, '--json'], { ...opts, ...extra });
      const added = await run(['note', 'add', '--title', 'Plan', '--actor', 'agent', '--body', '-'],
        { stdin: 'original\n' });
      assert.equal(added.code, 0, added.stdout);
      const item = added.json.data;
      const read = await run(['note', 'show', item.ref]);
      const stale = read.json.data.revision;
      const ctx = openContext({ mode: 'write', dataDir: data, home, env: {}, clock, actor: 'owner:external' });
      let native;
      if (server) {
        native = new EventEmitter();
        native.close = async () => {};
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: clock.now().getTime() });
        const watcher = watch(ctx, { createWatcher: () => native,
          recordExternal: (paths) => reconcileExternal(ctx, paths.length ? { paths } : {}) });
        t.after(() => watcher.close());
        native.emit('ready');
        await watcher.ready;
      }
      const path = join(data, item.path);
      writeFileSync(path, readFileSync(path, 'utf8').replace('original', 'owner edit'));
      if (server) {
        native.emit('all', 'change', path);
        t.mock.timers.tick(5000);
        assert.equal(readEvents(ctx).at(-1).actor, 'owner:external');
      }
      const rejected = await run(['note', 'update', item.ref, '--title', 'Stale',
        '--if-revision', stale, '--actor', 'agent']);
      assert.equal(rejected.code, 4, rejected.stdout);
      assert.equal(rejected.json.error.current.last.actor, 'owner:external');
      assert.match(readFileSync(path, 'utf8'), /owner edit/u);
      const changes = await run(['changes', '--target', item.ref, '--actor', 'owner:external', '--diff']);
      assert.equal(changes.code, 0, changes.stdout);
      assert.match(changes.json.data.changes[0].diff, /-original\n\+owner edit/u);
      const latest = await run(['note', 'show', item.ref]);
      const saved = await run(['note', 'update', item.ref, '--body', '-', '--actor', 'agent',
        '--if-revision', latest.json.data.revision], { stdin: 'agent done\n' });
      assert.equal(saved.code, 0, saved.stdout);
      assert.match(readFileSync(path, 'utf8'), /agent done/u);
      assert.deepEqual(readEvents(ctx).map(({ op }) => op), ['note.create', 'external.change', 'note.update']);
    });
}
