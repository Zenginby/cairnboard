// Tiny static server for the experiments. Usage: node design/experiments/serve.mjs
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize, sep } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    let rel = decodeURIComponent(url.pathname);
    if (rel.includes('\0')) throw Object.assign(new Error('bad'), { code: 400 });
    let file = normalize(join(root, rel));
    if (file !== root.slice(0, -1) && !file.startsWith(root)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let st = await stat(file).catch(() => null);
    if (st?.isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        res.writeHead(301, { Location: url.pathname + '/' }).end();
        return;
      }
      file = join(file, 'index.html');
      st = await stat(file).catch(() => null);
    }
    if (!st?.isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(400).end('Bad request');
  }
});

server.listen(4390, '127.0.0.1', () => {
  console.log(`Experiments: http://127.0.0.1:4390/ (root ${root.split(sep).slice(-3).join('/')})`);
});
