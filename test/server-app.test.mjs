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
import { createRead } from '../server/read.mjs';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { tempDir, fixedClock } from './support/env.mjs';

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
  assert.equal(logged.mock.callCount(), 3,
    logged.mock.calls.map((call) => String(call.arguments[0]?.stack ?? call.arguments[0]).slice(0, 300)).join('\n---\n'));
  // The guard lets /_astro/ through without a cookie, so a missing asset must not reach page routes.
  for (const path of ['/_astro/missing.js', '/_astro/', '/_astro/sub/']) {
    calls.length = 0;
    const response = await get(path, 'GET');
    assert.equal(response.status, 404, path);
    assert.deepEqual(calls, ['guard'], path);
  }
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
  const get = await serve(t, createApp({ root, guard, handler, locals: { cairn: { home: homeFixture } } }), true);
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(home.body, /<title>Ana sayfa · Cairnboard<\/title>/u);
  const notFound = await get('/does-not-exist');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body, readFileSync(join(root, 'dist/app/client/404.html'), 'utf8'));
  const error = await get('/500.html');
  for (const response of [home, notFound, error]) {
    headers(response);
    externalAssets(response.body);
  }
  for (const name of readdirSync(join(root, 'dist/app'), { recursive: true }).filter((name) => name.endsWith('.html'))) {
    externalAssets(readFileSync(join(root, 'dist/app', name), 'utf8'));
  }
  const script = /<script src="([^"]+)"/u.exec(home.body)?.[1];
  assert.ok(script);
  const asset = await get(script);
  assert.equal(asset.status, 200);
  headers(asset);
  assert.match(asset.body, /cairn-mode/u);
  assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
});

function externalAssets(html) {
  assert.doesNotMatch(html, /<style\b|\bstyle\s*=/iu);
  for (const [, attributes, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)) {
    assert.match(attributes, /\bsrc=/u);
    assert.equal(body.trim(), '');
  }
}

function homeFixture() {
  const item = (type, id, title, meta = {}) => ({ type, id, meta, content: { title, snippet: '' } });
  return { data: {
    pinned: [item('note', 'n-000001', 'Pinned title')],
    recentNotes: [item('note', 'n-000002', 'Recent title')],
    openCards: [item('card', 'c-000001', 'Card title', { priority: 'important' })],
    journal: { meta: {}, content: { title: 'Today title', body: 'Today body', html: '<p>Today body</p>' } },
    projects: [item('project', 'p-000001', 'Project title', { tone: 2 }),
      item('project', 'p-000002', 'Featured title', { acceptance: { done: 2, total: 5 } })],
    featuredProject: 'p-000002',
  }, warnings: ['pending_recovery', 'journal_unreadable'] };
}

test('built Home uses injected in-process data, escapes titles and renders safe failure states', async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  if (!existsSync(join(root, 'dist/app/server/entry.mjs'))) {
    t.skip('Astro output missing; run npm run build:app to enable integration coverage.');
    return;
  }
  const { handler } = await import('../dist/app/server/entry.mjs');
  const render = async (cairn) => {
    const response = await inProcess(createApp({ root, guard, handler, locals: { cairn } }), '/');
    headers(response);
    externalAssets(response.body);
    return response;
  };
  const full = await render({ home: homeFixture });
  assert.equal(full.status, 200);
  for (const title of ['Pinned title', 'Recent title', 'Card title', 'Today title', 'Today body', 'Project title', 'Featured title']) {
    assert.ok(full.body.includes(title), title);
  }
  assert.match(full.body, /<html lang="tr"/u);
  assert.match(full.body, /href="\/" aria-current="page"/u);
  assert.match(full.body, /href="\/board"/u);
  assert.match(full.body, /href="\/notes\/n-000001"/u);
  assert.match(full.body, /href="\/notes\/n-000002"/u);
  assert.match(full.body, /href="\/cards\/c-000001"/u);
  assert.match(full.body, /priority-important[^>]*>Önemli/u);
  assert.match(full.body, /project-featured[^>]*aria-label="Featured title"/u);
  const projects = [...full.body.matchAll(/<section class="[^"]*\bproject-box\b[^"]*"[^>]*>([\s\S]*?)<\/section>/gu)].map((match) => match[1]);
  assert.equal(projects.length, 2);
  for (const box of projects) assert.doesNotMatch(box, /<a\b|project-description|açıklaması yok/u);
  assert.doesNotMatch(projects.find((box) => box.includes('Project title')), /project-progress/u);
  const featured = projects.find((box) => box.includes('Featured title'));
  assert.match(featured, /2\/5 ölçüt tamamlandı/u);
  assert.match(featured, /stroke-dasharray="40 100"/u);
  assert.match(full.body, /Tamamlanmayı bekleyen bir işlem var/u);
  assert.match(full.body, /Bugünün günlüğü okunamadı/u);
  assert.doesNotMatch(full.body, /href="\/(?:projects|journal|graph|search)\b/u);

  const escaped = await render({ home: () => {
    const result = homeFixture();
    result.data.openCards[0].content.title = '<img src=x onerror=alert(1)>';
    result.data.projects[0].content.title = '" onmouseover="attrAttack(1)';
    return result;
  } });
  assert.equal(escaped.status, 200);
  assert.match(escaped.body, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.doesNotMatch(escaped.body, /<img\b/u);
  assert.doesNotMatch(escaped.body, /"\s*onmouseover=/u);
  assert.match(escaped.body, /&quot; onmouseover=&quot;attrAttack\(1\)|&#34; onmouseover=&#34;attrAttack\(1\)/u);

  const fallback = await render({ home: () => {
    const result = homeFixture();
    result.data.journal.content = { title: 'Today title', body: '## Plain <script>journalAttack(1)</script>', html: null };
    result.data.projects[1].meta.acceptance = { done: 0, total: 0 };
    result.warnings.push('render_timeout');
    return result;
  } });
  assert.equal(fallback.status, 200);
  assert.match(fallback.body, /## Plain &lt;script&gt;journalAttack\(1\)&lt;\/script&gt;/u);
  assert.match(fallback.body, /Günlüğün biçimlendirilmesi çok uzun sürdü/u);
  assert.doesNotMatch(fallback.body, /project-progress|<script>journalAttack/u);

  const empty = await render({ home: () => ({ data: {
    pinned: [], recentNotes: [], openCards: [], projects: [], featuredProject: null, journal: null,
  }, warnings: [] }) });
  assert.equal(empty.status, 200);
  for (const message of ['Henüz sabitlenmiş', 'Notların eklendiğinde', 'Şu anda açık kartın yok', 'Projelerin eklendiğinde', 'Bugün için henüz']) {
    assert.ok(empty.body.includes(message), message);
  }

  const notReady = await render(createRead({ open: () => { throw new Error('/private/data missing'); } }));
  assert.equal(notReady.status, 409);
  assert.match(notReady.body, /Veri klasörün hazır değil/u);
  assert.match(notReady.body, /cairn init/u);
  assert.doesNotMatch(notReady.body, /private|missing|Error:|stack/u);

  const failed = await render({ home: () => { throw new Error('/private/data\nsecret stack text'); } });
  assert.equal(failed.status, 500);
  assert.match(failed.body, /Ana sayfa yüklenemedi/u);
  assert.doesNotMatch(failed.body, /private|secret|stack|Error:/u);
});

test('built Home inserts only sanitized journal HTML from the in-process reader', async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  if (!existsSync(join(root, 'dist/app/server/entry.mjs'))) {
    t.skip('Astro output missing; run npm run build:app to enable integration coverage.');
    return;
  }
  const { handler } = await import('../dist/app/server/entry.mjs');
  const data = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(data, { home, env: {}, clock });
  mkdirSync(join(data, 'journal'), { recursive: true });
  writeFileSync(join(data, 'journal/2026-11-01.md'), '---\ndate: 2026-11-01\n---\n## Daily work\n\n**Finished** [[missing|A page]].\n\n<script>journalAttack(1)</script>');
  const cairn = createRead({ open: () => openContext({ mode: 'read', dataDir: data, home, env: {}, clock }) });
  const response = await inProcess(createApp({ root, guard, handler, locals: { cairn } }), '/');
  assert.equal(response.status, 200);
  externalAssets(response.body);
  assert.match(response.body, /<h2>Daily work<\/h2>/u);
  assert.match(response.body, /<strong>Finished<\/strong>/u);
  assert.match(response.body, /wikilink-ghost/u);
  assert.doesNotMatch(response.body, /journalAttack|## Daily work|\[\[missing/u);
});
