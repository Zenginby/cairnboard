import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

// Check every component, including the allowed root, without following symlinks.
async function inspect(root, parts) {
  let file = root;
  let info = await lstat(file);
  if (info.isSymbolicLink()) throw Object.assign(new Error('Forbidden'), { status: 403 });
  for (const part of parts) {
    file = join(file, part);
    info = await lstat(file);
    if (info.isSymbolicLink()) throw Object.assign(new Error('Forbidden'), { status: 403 });
  }
  return { file, info };
}

export function createDesignServer(root = repoRoot) {
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
        return;
      }
      // Inspect the raw path before URL normalization can hide traversal segments.
      const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
      const parts = pathname.split('/').filter(Boolean);
      if (!pathname.startsWith('/') || /[\\\0]/.test(pathname) || parts.some((part) => part === '..' || part === '.')) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      if (!parts.length) {
        res.writeHead(302, { Location: '/prototypes/' }).end();
        return;
      }
      let relative;
      if (parts[0] === 'src' && parts[1] === 'styles') {
        // Inspect src itself too; checking only src/styles would miss a symlinked src.
        relative = parts;
      } else if (parts[0] === 'src' || parts[0].startsWith('.')) {
        res.writeHead(403).end('Forbidden');
        return;
      } else {
        relative = ['design', ...parts];
      }
      let { file, info } = await inspect(root, relative);
      if (info.isDirectory()) {
        if (!pathname.endsWith('/')) {
          res.writeHead(302, { Location: `/${parts.map(encodeURIComponent).join('/')}/` }).end();
          return;
        }
        ({ file, info } = await inspect(file, ['index.html']));
      }
      if (!info.isFile()) {
        res.writeHead(404).end('Not found');
        return;
      }
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const body = await handle.readFile();
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
        res.end(req.method === 'HEAD' ? undefined : body);
      } finally {
        await handle.close();
      }
    } catch (error) {
      const status = error.status || (['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : error.code === 'ELOOP' ? 403 : 400);
      res.writeHead(status).end(status === 404 ? 'Not found' : status === 403 ? 'Forbidden' : 'Bad request');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  createDesignServer().listen(4391, '127.0.0.1', () => {
    console.log('Prototypes: http://127.0.0.1:4391/prototypes/');
  });
}
