import { fileURLToPath } from 'node:url';
import { checkRuntime } from '../core/runtime.mjs';
import { createApp } from './app.mjs';
import { createGuard } from './guard.mjs';
import { loginUrl, newInstanceId, sessionKey, siteHost } from './session.mjs';
import { stateDir } from '../core/roots.mjs';
import { listenLoopback, serverGroup } from './listen.mjs';
import { isAlive, readServerState, writeServerState } from './state.mjs';
import { openLogin } from './open-browser.mjs';
import { installShutdown } from './shutdown.mjs';

async function start() {
  await checkRuntime();
  const open = !process.argv.includes('--no-open') && process.env.CAIRN_NO_OPEN !== '1';
  const key = sessionKey();
  const previous = readServerState();
  if (previous && typeof previous.instance === 'string' && isAlive(previous.pid)) {
    console.log(`Cairnboard is already running: ${previous.url}`);
    if (open) openLogin(loginUrl(previous.port, key, previous.instance), { dir: stateDir() });
    return;
  }
  const { handler } = await import('../dist/app/server/entry.mjs');
  const { createApi } = await import('./api.mjs');
  const { createRead } = await import('./read.mjs');
  const { createRenderPool } = await import('./render-pool.mjs');
  const { openContext } = await import('../core/context.mjs');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { port, servers } = await listenLoopback();
  const instance = newInstanceId();
  const openRead = () => openContext({ mode: 'read' });
  const { render } = createRenderPool();
  const app = createApp({ root, handler, guard: createGuard({ port, key, instance }),
    api: createApi({ open: openRead, render }), locals: { cairn: createRead({ open: openRead, render }) } });
  for (const server of servers) server.on('request', app);
  const server = serverGroup(servers);
  const shutdown = installShutdown(server);
  try {
    const { url } = writeServerState({ port, instance, host: siteHost(key) });
    console.log(`Cairnboard: ${url}`);
    if (open) openLogin(loginUrl(port, key, instance), { dir: stateDir() });
    else console.log('Run cairn open to sign this browser in.');
  } catch (error) {
    shutdown();
    throw error;
  }
}

// Entry point only: always starts. Shared pieces live in other modules so tests never import this file.
try { await start(); } catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
