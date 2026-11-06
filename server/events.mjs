// Called only after createApp's normal Host and session guard.
export function createEvents(watcher, { limit = 32 } = {}) {
  const streams = new Map();
  const reconcileClients = new Set();
  let closed = false, reconciling, scheduled, cancelReconcile;
  function reconcile() {
    reconciling ??= new Promise((resolve) => {
      cancelReconcile = resolve;
      scheduled = setImmediate(resolve);
    }).then(async () => {
      scheduled = undefined;
      if (closed) return 503;
      await watcher.reconcile();
      return 204;
    }).catch((error) => { console.error(error); return 500; })
      .finally(() => { reconciling = undefined; cancelReconcile = undefined; });
    return reconciling;
  }
  const broadcast = (change) => {
    const message = `event: change\ndata: ${JSON.stringify(change)}\n\n`;
    for (const res of streams.keys()) if (!res.write(message)) res.destroy();
  };
  function close() {
    if (closed) return;
    closed = true;
    clearImmediate(scheduled);
    cancelReconcile?.();
    for (const res of reconcileClients) { res.writeHead(503); res.end(); res.destroy(); }
    reconcileClients.clear();
    watcher.off('change', broadcast);
    watcher.off('close', close);
    for (const [res, timer] of streams) {
      clearInterval(timer);
      res.end();
      res.destroy();
    }
    streams.clear();
  }
  watcher.on('change', broadcast);
  watcher.once('close', close);
  return {
    handle(req, res, path) {
      if (path !== '/api/events' && path !== '/api/reconcile') return false;
      if (closed || (path === '/api/events' && streams.size >= limit)) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Live updates unavailable.');
        return true;
      }
      if (path === '/api/reconcile') {
        reconcileClients.add(res);
        res.once('close', () => reconcileClients.delete(res));
        void reconcile().then((status) => {
          reconcileClients.delete(res);
          if (!res.destroyed) { res.writeHead(status); res.end(); }
        });
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') { res.end(); return true; }
      res.write('retry: 2000\n\n');
      const timer = setInterval(() => { if (!res.write(': heartbeat\n\n')) res.destroy(); }, 25_000);
      timer.unref();
      streams.set(res, timer);
      res.once('close', () => { clearInterval(timer); streams.delete(res); });
      return true;
    },
    close,
  };
}
