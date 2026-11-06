import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import chokidar from 'chokidar';
import { readChecked } from './paths.mjs';
import { refresh, rows } from './index.mjs';

// The snapshot is notification state, never an alternate query index. Keep it across CLI cache updates.
export function watch(ctx, { createWatcher = chokidar.watch, reconcileMs = 300_000, log = console.error,
  refreshIndex = refresh, readRows = rows, stat = lstatSync } = {}) {
  const events = new EventEmitter();
  const root = resolve(ctx.root).replaceAll('\\', '/');
  const relative = (path) => {
    const absolute = resolve(ctx.root, path).replaceAll('\\', '/');
    return absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : '';
  };
  const ignored = (path) => relative(path).split('/').some((part) => part === '.cairn' || part === '.git');
  const snapshot = () => new Map(readRows(ctx).map(({ path, type, id, revision }) => [path, { type, id, revision }]));
  refreshIndex(ctx);
  let previous = snapshot();
  let closed = false, debounce, deadline, failed = false, closing, ready;
  const pending = new Set(), suppressed = new Map();
  const watcher = createWatcher(root, { ignoreInitial: true, followSymlinks: false, atomic: true,
    awaitWriteFinish: false, usePolling: false, ignored });

  function forget(path, entry) {
    clearTimeout(entry.timer);
    if (suppressed.get(path) === entry) suppressed.delete(path);
  }

  function publish(paths = []) {
    const next = snapshot(), kinds = new Set(), ids = new Set(), consumed = new Map();
    for (const path of new Set([...paths, ...previous.keys(), ...next.keys()])) {
      const before = previous.get(path), after = next.get(path);
      if (before?.revision === after?.revision && before?.type === after?.type && before?.id === after?.id) continue;
      const expected = suppressed.get(path);
      if (expected) {
        consumed.set(path, expected);
        const bytes = readChecked(ctx.root, path);
        if (Date.now() < expected.expires && bytes
          && createHash('sha256').update(bytes).digest('hex') === expected.digest) continue;
      }
      for (const row of [before, after]) if (row) {
        kinds.add(row.type === 'research' ? 'note' : row.type);
        if (row.type === 'card' || row.type === 'project') kinds.add('board');
        if (row.id) ids.add(row.id);
      }
    }
    if (kinds.size) events.emit('change', { kinds: [...kinds], ids: [...ids] });
    previous = next;
    for (const [path, entry] of consumed) forget(path, entry);
  }

  function flush() {
    clearTimeout(debounce);
    clearTimeout(deadline);
    deadline = undefined;
    if (closed) return;
    try {
      const batch = [...pending], paths = [];
      for (const path of batch) {
        try {
          if (!stat(resolve(ctx.root, path)).isSymbolicLink()) paths.push(path);
        } catch (error) {
          if (['ENOENT', 'ENOTDIR'].includes(error.code)) paths.push(path);
          else log(error);
        }
      }
      // refresh already discovers additions, changes and removals in one scan.
      refreshIndex(ctx);
      publish(paths);
      for (const path of batch) pending.delete(path);
    } catch (error) { log(error); schedule(); }
  }

  function schedule() {
    if (closed) return;
    clearTimeout(debounce);
    debounce = setTimeout(flush, 150);
    deadline ??= setTimeout(flush, 1000);
  }

  watcher.on('all', (event, path) => {
    if (closed || ignored(path)) return;
    const rel = relative(path);
    if (!rel) return;
    // Check every event, including unlink and directory events; never follow a link supplied by chokidar.
    try { if (stat(resolve(ctx.root, rel)).isSymbolicLink()) return; } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) { log(error); return; }
    }
    pending.add(rel);
    schedule();
  });
  watcher.on('error', (error) => {
    if (['ENOSPC', 'EMFILE'].includes(error.code)) {
      if (failed) return;
      failed = true;
      log(`File watcher unavailable (${error.code}); using periodic reconcile.`);
      void watcher.close().catch(log);
    } else log(error);
  });
  events.reconcile = () => {
    if (closed) return;
    try { refreshIndex(ctx); publish(); } catch (error) { log(error); schedule(); }
  };
  const timer = setInterval(events.reconcile, reconcileMs);
  timer.unref();
  events.ready = new Promise((done) => {
    ready = done;
    watcher.once('ready', () => { events.reconcile(); done(true); });
    watcher.once('error', () => done(false));
  });
  events.suppress = (path, digest) => {
    if (closed) return;
    path = relative(path);
    if (suppressed.has(path)) forget(path, suppressed.get(path));
    const entry = { digest, expires: Date.now() + 10_000 };
    entry.timer = setTimeout(() => forget(path, entry), 10_000);
    entry.timer.unref();
    suppressed.set(path, entry);
  };
  events.close = () => {
    if (closed) return closing;
    closed = true;
    ready(false);
    clearInterval(timer);
    clearTimeout(debounce);
    clearTimeout(deadline);
    pending.clear();
    for (const [path, entry] of suppressed) forget(path, entry);
    events.emit('close');
    events.removeAllListeners();
    closing = watcher.close();
    return closing;
  };
  return events;
}
