import { EventEmitter } from 'node:events';

// Every live kind a page can listen for; sent once when watching starts so open tabs leave the not-ready state.
const allKinds = ['card', 'project', 'note', 'journal', 'board'];

// A stable watcher for createEvents. The real file watcher needs an initialised data directory, which may appear
// only after the server started (`cairn init` from the first-run page), so keep trying until it can start.
export function createLiveWatcher(start, { retryMs = 5000, log = console.error } = {}) {
  const live = new EventEmitter();
  let real, closed = false, lastFailure;
  const forward = (change) => live.emit('change', change);

  function attempt() {
    if (real || closed) return;
    try {
      real = start();
    } catch (error) {
      if (error?.message !== lastFailure) log(`Live updates wait for the data directory: ${error?.message}`);
      lastFailure = error?.message;
      return;
    }
    clearInterval(timer);
    real.on('change', forward);
    if (lastFailure !== undefined) live.emit('change', { kinds: allKinds, ids: [] });
  }

  const timer = setInterval(attempt, retryMs);
  timer.unref?.();
  live.reconcile = async () => {
    if (closed) return;
    if (real) return real.reconcile();
    attempt();
  };
  live.close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    real?.off('change', forward);
    live.emit('close');
    live.removeAllListeners();
    await real?.close();
  };
  attempt();
  return live;
}
