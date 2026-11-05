import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { checkRuntime } from '../core/runtime.mjs';
import { createApp } from './app.mjs';
import { createGuard } from './guard.mjs';
import { loginUrl, sessionKey } from './session.mjs';
import { findPort } from './port.mjs';
import { isAlive, readServerState, writeServerState } from './state.mjs';
import { openBrowser } from './open-browser.mjs';
import { installShutdown } from './shutdown.mjs';

async function start() {
  await checkRuntime();
  const open = !process.argv.includes('--no-open') && process.env.CAIRN_NO_OPEN !== '1';
  const key = sessionKey();
  const previous = readServerState();
  if (previous && isAlive(previous.pid)) {
    console.log(`Cairnboard is already running: ${previous.url}`);
    if (open) openBrowser(loginUrl(previous.port, key));
    return;
  }
  const { handler } = await import('../dist/app/server/entry.mjs');
  const host = '127.0.0.1';
  const root = fileURLToPath(new URL('../', import.meta.url));
  // The access check needs the port, so requests are attached once listen() has picked one.
  const server = createServer();
  // A probe cannot reserve a port: retry if another process wins the race before listen().
  let port;
  for (let from = 4321; from <= 4340; from = port + 1) {
    port = await findPort({ from, to: 4340, host });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
      });
      break;
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
    }
  }
  if (!server.listening) throw new Error('No free port on 127.0.0.1 in 4321–4340; stop another server and try again.');
  server.on('request', createApp({ root, handler, guard: createGuard({ port, key }) }));
  const shutdown = installShutdown(server);
  try {
    const { url } = writeServerState({ port });
    console.log(`Cairnboard: ${url}`);
    if (open) openBrowser(loginUrl(port, key));
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
