import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function requestPath(url) {
  try {
    // Inspect the raw path before URL parsing can normalize away traversal segments.
    const path = decodeURIComponent(url.split('?')[0]);
    if (!path.startsWith('/') || path.includes('\\') || path.includes('\0')
      || /%[0-9a-f]{2}/iu.test(path) || path.split('/').some((part) => part === '..' || part === '.')) return null;
    // Windows trims trailing dots/spaces and uses colons for alternate data streams.
    if (process.platform === 'win32' && path.split('/').some((part) => /[:<>"|?*]|[. ]$/u.test(part)
      || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part))) return null;
    return path;
  } catch {
    return null;
  }
}

const lookupErrors = ['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'EINVAL', 'EACCES', 'EPERM'];

async function clientFile(root, path) {
  const parts = ['dist', 'app', 'client', ...path.split('/').filter(Boolean)];
  let file = root;
  for (const [i, part] of parts.entries()) {
    file = join(file, part);
    let stat;
    try { stat = await lstat(file); } catch (error) {
      if (lookupErrors.includes(error.code)) return null;
      throw error;
    }
    if (stat.isSymbolicLink()) return false;
    if (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) return null;
  }
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    return await handle.readFile();
  } catch (error) {
    if (error.code === 'ELOOP') return false;
    if (lookupErrors.includes(error.code)) return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

export function createApp({ root, handler, guard, api, locals = {} }) {
  // Fail closed: a server without its access check must not start.
  if (typeof guard !== 'function') throw new TypeError('createApp needs a guard.');
  root = resolve(root);
  async function errorPage(req, res, status) {
    // Prerendered Astro error pages also work when middleware calls next() without a body.
    const body = await clientFile(root, `/${status}.html`)
      || Buffer.from(`<!doctype html><html lang="en"><title>${status}</title><h1>${status === 404 ? 'Page not found' : 'Something went wrong'}</h1></html>`);
    res.statusCode = status;
    res.removeHeader('Cache-Control');
    res.setHeader('Content-Length', body.length);
    res.setHeader('Content-Type', types['.html']);
    res.end(req.method === 'HEAD' ? undefined : body);
  }
  return async (req, res) => {
    try {
      if (await guard(req, res) === false) return;
      const path = requestPath(req.url);
      if (path?.startsWith('/api/') || req.url.split('?')[0].startsWith('/api/')) {
        if (api && await api(req, res, path)) return;
        return await errorPage(req, res, 404);
      }
      if (path === null) return await errorPage(req, res, 404);
      const body = await clientFile(root, path);
      // The guard lets /_astro/ through without a cookie, so a missing asset must never reach page routes.
      if (body === false || (body === null && path.startsWith('/_astro/'))) return await errorPage(req, res, 404);
      if (body !== null) {
        res.setHeader('Content-Type', types[extname(path).toLowerCase()] ?? 'application/octet-stream');
        res.setHeader('Content-Length', body.length);
        if (path.startsWith('/_astro/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      let nextError;
      await handler(req, res, (error) => { nextError = error; }, locals);
      if (nextError) throw nextError;
      if (!res.writableEnded && !res.headersSent) await errorPage(req, res, 404);
    } catch (error) {
      console.error(error);
      if (res.headersSent) { res.destroy(); return; }
      try { await errorPage(req, res, 500); } catch (pageError) {
        console.error(pageError);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(req.method === 'HEAD' ? undefined : 'Something went wrong.');
      }
    }
  };
}
