import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkRuntime } from '../core/runtime.mjs';
import { createApp } from './app.mjs';
import { createGuard } from './guard.mjs';
import { loginUrl, newInstanceId, sessionKey, siteHost } from './session.mjs';
import { stateDir } from '../core/roots.mjs';
import { listenLoopback, serverGroup } from './listen.mjs';
import { isAlive, readServerState, writeServerState } from './state.mjs';
import { openLogin } from './open-browser.mjs';
import { watch } from '../core/watch.mjs';
import { createEvents } from './events.mjs';
import { createSettings } from './settings.mjs';
import { createCards } from './cards.mjs';
import { createProjects } from './projects.mjs';
import { createJournal } from './journal.mjs';
import { createWrites } from './writes.mjs';
import { createLiveWatcher } from './live.mjs';
import { installShutdown } from './shutdown.mjs';
import { reconcileExternal } from '../core/changes.mjs';

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
  // Build only after the running check: rebuilding dist/app under a live server renames its chunks
  // and its next lazy page import fails with ERR_MODULE_NOT_FOUND.
  if (process.argv.includes('--build')) {
    const built = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/build-app.mjs', import.meta.url))],
      { stdio: 'inherit' });
    if (built.status !== 0) throw new Error('The app build failed.');
  }
  const { handler } = await import('../dist/app/server/entry.mjs');
  const { createApi } = await import('./api.mjs');
  const { createRead } = await import('./read.mjs');
  const { createRenderPool } = await import('./render-pool.mjs');
  const { openContext } = await import('../core/context.mjs');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { port, servers } = await listenLoopback();
  const instance = newInstanceId();
  let readWatcher;
  const openRead = () => {
    const ctx = openContext({ mode: 'read' });
    readWatcher?.reuseFresh(ctx);
    return ctx;
  };
  const { render } = createRenderPool();
  const watcher = createLiveWatcher(() => {
    readWatcher = watch(openRead(), { recordExternal: (paths) => {
      const ctx = openContext({ mode: 'write', actor: 'owner:external' });
      reconcileExternal(ctx, paths.length ? { paths } : {});
    } });
    return readWatcher;
  });
  const events = createEvents(watcher);
  const settings = createSettings({ key, port, open: openRead,
    openWrite: () => openContext({ mode: 'write', actor: 'web:owner' }) });
  const cards = createCards({ key, port, open: openRead,
    openWrite: () => openContext({ mode: 'write', actor: 'web:owner' }) });
  const projects = createProjects({ key, port, open: openRead,
    openWrite: () => openContext({ mode: 'write', actor: 'web:owner' }) });
  const journal = createJournal({ key, port, open: openRead,
    openWrite: () => openContext({ mode: 'write', actor: 'web:owner' }) });
  // One table for every write, so the guard, the rate limit and the checks are the same for all of them.
  const writes = createWrites({ key, port, routes: [...settings.routes, ...cards.routes, ...projects.routes,
    ...journal.routes] });
  const app = createApp({ root, handler, guard: createGuard({ port, key, instance, writable: writes.writable }),
    writes: writes.handle,
    api: createApi({ open: openRead, render, events, live: settings.liveUpdates }),
    locals: { cairn: createRead({ open: openRead, render }), settings, cards, projects, journal } });
  for (const server of servers) server.on('request', app);
  const server = serverGroup(servers);
  const shutdown = installShutdown(server, { close: async () => { events.close(); await watcher.close(); } });
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
