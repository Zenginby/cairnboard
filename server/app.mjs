import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { t, uiLanguage } from '../src/i18n/index.mjs';

const escapeHtml = (text) => String(text).replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);

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

async function clientFile(root, appDir, path) {
  const parts = [...appDir.split('/').filter(Boolean), 'client', ...path.split('/').filter(Boolean)];
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

// appDir is the Astro output folder under root; tests and checks build to their own so a running server keeps its files.
export function createApp({ root, appDir = 'dist/app', handler, guard, api, writes, locals = {} }) {
  // Fail closed: a server without its access check must not start.
  if (typeof guard !== 'function') throw new TypeError('createApp needs a guard.');
  root = resolve(root);
  /** The app's own /404 or /500 page, rendered now so it is in the current interface language. */
  async function renderedErrorPage(req, res, status) {
    const url = req.url;
    try {
      req.url = `/${status}`;
      await handler(req, res, () => {}, locals);
    } catch (error) {
      console.error(error);
      // Half an answer cannot be completed with another page, as in the main path.
      if (res.headersSent) res.destroy();
    } finally {
      req.url = url;
    }
    return res.headersSent || res.writableEnded;
  }
  // `viaApp`: the request had already reached the app's handler, so its error page may be rendered by it too.
  // Refused targets (assets, malformed paths, the API) never reach the handler and get the plain page.
  async function errorPage(req, res, status, viaApp = false) {
    if (viaApp && await renderedErrorPage(req, res, status)) return;
    const title = escapeHtml(t(status === 404 ? 'error.notFoundTitle' : 'error.serverTitle'));
    const plain = `<!doctype html><html lang="${uiLanguage()}"><title>${status}</title><h1>${title}</h1></html>`;
    const body = Buffer.from(plain);
    // The guard's `no-store` stays: the page depends on the interface language.
    res.statusCode = status;
    res.setHeader('Content-Length', body.length);
    res.setHeader('Content-Type', types['.html']);
    res.end(req.method === 'HEAD' ? undefined : body);
  }
  return async (req, res) => {
    let viaApp = false;
    try {
      if (await guard(req, res) === false) return;
      const path = requestPath(req.url);
      if (req.method === 'POST') {
        // Only table writes reach this point (see guard); anything else a guard let through stays refused.
        if (path && writes && await writes(req, res, path)) return;
        res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Method not allowed.');
        return;
      }
      if (path?.startsWith('/api/') || req.url.split('?')[0].startsWith('/api/')) {
        if (api && await api(req, res, path)) return;
        return await errorPage(req, res, 404);
      }
      if (path === null) return await errorPage(req, res, 404);
      const body = await clientFile(root, appDir, path);
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
      viaApp = true;
      await handler(req, res, (error) => { nextError = error; }, locals);
      if (nextError) throw nextError;
      if (!res.writableEnded && !res.headersSent) await errorPage(req, res, 404, true);
    } catch (error) {
      console.error(error);
      if (res.headersSent) { res.destroy(); return; }
      try { await errorPage(req, res, 500, viaApp); } catch (pageError) {
        console.error(pageError);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(req.method === 'HEAD' ? undefined : 'Something went wrong.');
      }
    }
  };
}
