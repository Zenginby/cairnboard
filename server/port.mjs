import { createServer } from 'node:net';

function listen(port, host) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, host, () => server.close((error) => error ? reject(error) : resolve()));
  });
}

// A port is free only if the IPv6 loopback is free too: browsers resolve localhost to ::1 first, so another app
// on [::1]:<port> would answer localhost:<port> instead of us (4321 is also Astro's default dev port).
// Machines without IPv6 report EADDRNOTAVAIL or EAFNOSUPPORT for ::1, which counts as free.
const NO_IPV6 = ['EADDRNOTAVAIL', 'EAFNOSUPPORT'];

export async function findPort({ from = 4321, to = 4340, host = '127.0.0.1', listen: probe = listen } = {}) {
  for (let port = from; port <= to; port += 1) {
    try {
      await probe(port, host);
      try { await probe(port, '::1'); } catch (error) { if (!NO_IPV6.includes(error.code)) throw error; }
      return port;
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw new Error(`No free port on ${host} in ${from}–${to}; stop another server and try again.`);
}
