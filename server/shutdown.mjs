import { removeServerState } from './state.mjs';

// Ctrl-C closes idle sockets at once and every socket after 2 s; a second signal exits immediately.
export function installShutdown(server, { runtime = process, removeState = removeServerState } = {}) {
  let closing = false, timer;
  const cleanup = () => {
    try { removeState(); } catch (error) { console.error(error); runtime.exitCode = 1; }
  };
  const shutdown = () => {
    if (closing) {
      cleanup();
      runtime.exit(runtime.exitCode ?? 0);
      return;
    }
    closing = true;
    server.close(() => {
      clearTimeout(timer);
      cleanup();
    });
    timer = setTimeout(() => {
      server.closeAllConnections();
      cleanup();
    }, 2000);
    timer.unref();
    server.closeIdleConnections();
  };
  runtime.on('SIGINT', shutdown);
  runtime.on('SIGTERM', shutdown);
  return shutdown;
}
