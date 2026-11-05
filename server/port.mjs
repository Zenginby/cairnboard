import { createServer } from 'node:net';

function listen(port, host) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, host, () => server.close((error) => error ? reject(error) : resolve()));
  });
}

export async function findPort({ from = 4321, to = 4340, host = '127.0.0.1', listen: probe = listen } = {}) {
  for (let port = from; port <= to; port += 1) {
    try {
      await probe(port, host);
      return port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`No free port on ${host} in ${from}–${to}; stop another server and try again.`);
}
