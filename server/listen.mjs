import { createServer } from 'node:http';
import { findPort } from './port.mjs';

const BUSY = ['EADDRINUSE', 'EACCES'];
const NO_IPV6 = ['EADDRNOTAVAIL', 'EAFNOSUPPORT'];

function listenOn(port, host) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(server); });
  });
}

/**
 * Listens on the same port on both loopbacks. The site name resolves to ::1 first in every browser we measured, so
 * leaving [::1]:<port> free would let another local account take it and receive our requests and cookie.
 * Machines without IPv6 listen on 127.0.0.1 only.
 */
export async function listenLoopback({ from = 4321, to = 4340, listen = listenOn, find = findPort } = {}) {
  for (let start = from; start <= to;) {
    const port = await find({ from: start, to });
    const servers = [];
    try {
      servers.push(await listen(port, '127.0.0.1'));
      try {
        servers.push(await listen(port, '::1'));
      } catch (error) {
        if (!NO_IPV6.includes(error.code)) throw error;
      }
      return { port, servers };
    } catch (error) {
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
      if (!BUSY.includes(error.code)) throw error;
      start = port + 1; // another process won the race after the probe
    }
  }
  throw new Error(`No free port on the loopback in ${from}–${to}; stop another server and try again.`);
}

/** One handle for several listeners, shaped like the http.Server methods that shutdown uses. */
export function serverGroup(servers) {
  return {
    close(callback) {
      let left = servers.length;
      for (const server of servers) server.close(() => { left -= 1; if (left === 0) callback?.(); });
    },
    closeIdleConnections() { for (const server of servers) server.closeIdleConnections(); },
    closeAllConnections() { for (const server of servers) server.closeAllConnections(); },
  };
}
