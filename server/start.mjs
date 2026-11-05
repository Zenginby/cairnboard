import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { checkRuntime } from '../core/runtime.mjs';
import { createApp } from './app.mjs';
import { findPort } from './port.mjs';
import { writeServerState, removeServerState } from './state.mjs';
import { openBrowser } from './open-browser.mjs';

try {
  await checkRuntime();
  const { handler } = await import('../dist/app/server/entry.mjs');
  const host = '127.0.0.1';
  const server = createServer(createApp({ root: fileURLToPath(new URL('../', import.meta.url)), handler }));
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
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  if (!server.listening) throw new Error('No free port on 127.0.0.1 in 4321–4340; stop another server and try again.');
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close(() => {
      try { removeServerState(); } catch (error) { console.error(error); process.exitCode = 1; }
    });
    server.closeIdleConnections();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    const { url } = writeServerState({ port });
    console.log(`Cairnboard: ${url}`);
    if (!process.argv.includes('--no-open') && process.env.CAIRN_NO_OPEN !== '1') openBrowser(url);
  } catch (error) {
    shutdown();
    throw error;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
