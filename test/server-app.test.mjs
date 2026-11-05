import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, IncomingMessage, request, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.mjs';
import { guard, CSP } from '../server/guard.mjs';
import { tempDir } from './support/env.mjs';

// Real Node request/response objects let unit tests run without permission to bind a socket.
async function inProcess(app, path, method = 'GET') {
  const req = new IncomingMessage(new Socket());
  req.url = path;
  req.method = method;
  req.headers = { host: '127.0.0.1:4321' };
  let output = '';
  const socket = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } });
  const res = new ServerResponse(req);
  res.useChunkedEncodingByDefault = false;
  res.assignSocket(socket);
  const finished = new Promise((resolve) => res.once('finish', resolve));
  await app(req, res);
  await finished;
  return { status: res.statusCode, headers: res.getHeaders(), body: output.slice(output.indexOf('\r\n\r\n') + 4) };
}

async function serve(t, app, real = false) {
  if (!real) return (path, method) => inProcess(app, path, method);
  const server = createServer(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.diagnostic('Loopback listen is forbidden (EPERM); testing the real Astro listener in process.');
    return (path, method) => inProcess(app, path, method);
  }
  return (path, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path, method, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (text) => { body += text; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function headers(response) {
  assert.equal(response.headers['content-security-policy'], CSP);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
}

function fixture(t) {
  const root = tempDir(t), client = join(root, 'dist/app/client');
  mkdirSync(join(client, '_astro'), { recursive: true });
  writeFileSync(join(client, '_astro/app.js'), 'document.documentElement.dataset.ready = "1";');
  writeFileSync(join(client, '404.html'), '<!doctype html><h1>404 — Page not found</h1>');
  writeFileSync(join(client, '500.html'), '<!doctype html><h1>500 — Something went wrong</h1>');
  return { root, client };
}

test('createApp guards first and keeps headers on pages, errors, static files and methods', async (t) => {
  const { root } = fixture(t);
  const logged = t.mock.method(console, 'error', () => {});
  const calls = [];
  const get = await serve(t, createApp({ root, guard: (req, res) => {
    calls.push('guard');
    return guard(req, res);
  }, handler: async (req, res, next) => {
    calls.push('handler');
    if (req.url === '/throw') throw new Error('/private/secret/page.mjs\nstack trace');
    if (req.url === '/next-error') return next(new Error('/private/secret/page.mjs'));
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<h1>Cairnboard</h1>'); }
    else next();
  } }));
  for (const [path, method, status, text] of [
    ['/', 'GET', 200, 'Cairnboard'], ['/missing', 'GET', 404, '404 — Page not found'],
    ['/throw', 'GET', 500, '500 — Something went wrong'], ['/next-error', 'GET', 500, '500 — Something went wrong'],
    ['/', 'POST', 405, 'Method not allowed'], ['/_astro/app.js', 'GET', 200, 'dataset.ready'],
    ['/_astro/app.js', 'HEAD', 200, ''], ['/missing', 'HEAD', 404, ''], ['/throw', 'HEAD', 500, ''],
  ]) {
    calls.length = 0;
    const response = await get(path, method);
    assert.equal(response.status, status, `${method} ${path}`);
    headers(response);
    assert.ok(response.body.includes(text));
    assert.doesNotMatch(response.body, /private|secret|page\.mjs|stack trace|Error:/u);
    if (method === 'HEAD') assert.equal(response.body, '');
    assert.equal(calls[0], 'guard');
    if (status === 405 || path.startsWith('/_astro/')) assert.deepEqual(calls, ['guard']);
    if (status === 405) assert.equal(response.headers.allow, 'GET, HEAD');
    if (path.startsWith('/_astro/')) {
      assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8');
      assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
    }
  }
  assert.equal(logged.mock.callCount(), 3);
});

test('createApp refuses traversal, malformed paths and symlinks before invoking Astro', async (t) => {
  const { root, client } = fixture(t);
  writeFileSync(join(root, 'package.json'), 'outside secret');
  const get = await serve(t, createApp({ root, guard, handler: () => assert.fail('must not reach Astro') }));
  for (const path of ['/_astro/../../package.json', '/_astro/%2e%2e/%2e%2e/package.json',
    '/_astro/%252e%252e/package.json', '/_astro/%00app.js', '/_astro/%5c..%5cpackage.json', '/bad%']) {
    const response = await get(path);
    assert.equal(response.status, 404, path);
    assert.match(response.body, /404 — Page not found/u);
    headers(response);
  }
  if (process.platform === 'win32') {
    const names = ['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
      ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)];
    const paths = names.flatMap((name) => [`/_astro/${name}`, `/_astro/${name.toLowerCase()}.js`]);
    for (const path of [...paths, '/_astro/..%20/..%20/package.json', '/_astro/app.js:stream',
      ...['<', '>', '"', '|', '?', '*'].map((char) => `/_astro/file${encodeURIComponent(char)}.js`)]) {
      assert.equal((await get(path)).status, 404, path);
    }
  }
  try {
    symlinkSync(join(root, 'package.json'), join(client, '_astro/link.js'));
    symlinkSync(root, join(client, 'linked'), 'dir');
  } catch (error) {
    if (process.platform === 'win32') { t.diagnostic(`Symlink checks skipped: ${error.code}`); return; }
    throw error;
  }
  for (const path of ['/_astro/link.js', '/linked/package.json']) {
    const response = await get(path);
    assert.equal(response.status, 404);
    assert.doesNotMatch(response.body, /outside secret/u);
    headers(response);
  }
});

test('very long static paths return our 404 without logging a stack', async (t) => {
  const { root } = fixture(t);
  const logged = t.mock.method(console, 'error', () => {});
  const get = await serve(t, createApp({ root, guard, handler: (req, res, next) => next() }));
  const response = await get(`/_astro/${'a'.repeat(1000)}.js`);
  assert.equal(response.status, 404);
  assert.match(response.body, /404 — Page not found/u);
  assert.doesNotMatch(response.body, /Error:|ENAMETOOLONG|stack|dist\/app/u);
  headers(response);
  assert.equal(logged.mock.callCount(), 0);
});

test('real Astro output serves CSP-safe HTML, our 404 body and an external script', async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  if (!existsSync(join(root, 'dist/app/server/entry.mjs'))) {
    t.skip('Astro output missing; run npm run build:app to enable integration coverage.');
    return;
  }
  const { handler } = await import('../dist/app/server/entry.mjs');
  const get = await serve(t, createApp({ root, guard, handler }), true);
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(home.body, /<title>Cairnboard<\/title>/u);
  const notFound = await get('/does-not-exist');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body, readFileSync(join(root, 'dist/app/client/404.html'), 'utf8'));
  const error = await get('/500.html');
  for (const response of [home, notFound, error]) {
    headers(response);
    assert.doesNotMatch(response.body, /<style\b|\bstyle\s*=/iu);
    for (const [script] of response.body.matchAll(/<script\b[^>]*>/giu)) assert.match(script, /\bsrc=/u);
  }
  const script = readdirSync(join(root, 'dist/app/client/_astro')).find((name) => name.endsWith('.js'));
  assert.ok(script);
  assert.ok(home.body.includes(`/_astro/${script}`));
  const asset = await get(`/_astro/${script}`);
  assert.equal(asset.status, 200);
  headers(asset);
  assert.match(asset.body, /dataset\.ready/u);
  assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
});
