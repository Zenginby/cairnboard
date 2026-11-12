import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, IncomingMessage, request, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.mjs';
import { guard, CSP } from '../server/guard.mjs';
import { createRead } from '../server/read.mjs';
import { createRenderPool } from '../server/render-pool.mjs';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { defaultConfig } from '../core/config.mjs';
import { PRESETS } from '../core/presets.mjs';
import { tempDir, fixedClock } from './support/env.mjs';
import { runCli } from './support/cli.mjs';

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
  // Count logged errors only: Node 22 prints its SQLite ExperimentalWarning through console.error too.
  const errors = logged.mock.calls.filter((call) => call.arguments[0] instanceof Error);
  assert.equal(errors.length, 3,
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
  assert.equal(logged.mock.calls.filter((call) => call.arguments[0] instanceof Error).length, 0);
});

test('real Astro output serves CSP-safe HTML, our 404 body and an external script', async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  if (!existsSync(join(root, 'dist/app/server/entry.mjs'))) {
    t.skip('Astro output missing; run npm run build:app to enable integration coverage.');
    return;
  }
  const { handler } = await import('../dist/app/server/entry.mjs');
  const get = await serve(t, createApp({ root, guard, handler, locals: { cairn: { home: () => ({ data: {
    pinned: [], recentNotes: [], projects: [], featuredProject: null,
  }, warnings: [] }) } } }), true);
  const home = await get('/');
  assert.equal(home.status, 200);
  const icon = /<link rel="icon"[^>]*href="([^"]+)"/u.exec(home.body)?.[1];
  assert.ok(icon, 'Declare an icon so browsers do not request a missing /favicon.ico.');
  const favicon = await get(icon);
  assert.equal(favicon.status, 200, icon);
  assert.equal(favicon.headers['content-type'], 'image/svg+xml');

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

for (const [vault, loosePath] of [['plain', 'Ideas/Spark.md'], ['daily', 'Archive/Old.md'],
  ['tagged', 'Topics/Loose.md']]) {
  for (const preset of ['default', 'tr-wiki']) {
    test(`${vault}/${preset}: loose notes have indexed references, Home links and readable pages`, async (t) => {
      const root = fileURLToPath(new URL('../', import.meta.url));
      if (!existsSync(join(root, 'dist/app/server/entry.mjs'))) {
        t.skip('Astro output missing; run npm run build:app to enable integration coverage.');
        return;
      }
      const { handler } = await import('../dist/app/server/entry.mjs');
      const data = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-07T12:00:00Z');
      cpSync(join(root, 'test/fixtures/vaults', vault), data, { recursive: true });
      const schema = structuredClone(PRESETS[preset]);
      schema.sourceRoots.push('Clippings');
      schema.ignore.push('Ignored/**');
      schema.catalog = 'Catalog.md';
      mkdirSync(join(data, '.cairn'));
      writeFileSync(join(data, '.cairn/config.json'), JSON.stringify({ ...defaultConfig(), schema }));
      for (const [path, text] of Object.entries({
        'raw/hidden.md': '# Hidden lantern raw', 'Clippings/hidden.md': '# Hidden lantern source',
        'Ignored/hidden.md': '# Hidden lantern ignore', '.obsidian/hidden.md': '# Hidden lantern metadata',
        'Catalog.md': '# Hidden lantern catalog',
        'notes/identified.md': '---\nid: n-000001\n---\n# Identified\n[[notes/loose]]',
        'notes/loose.md': '---\nid: zettel-42\n---\n# Loose backlink\n[[identified]]',
      })) {
        mkdirSync(dirname(join(data, path)), { recursive: true });
        writeFileSync(join(data, path), text);
      }
      const cli = (args) => runCli([...args, '--preset', preset, '--json'], { data, home, clock });
      const listed = await cli(['note', 'list']);
      assert.equal(listed.code, 0, listed.stdout);
      const loose = listed.json.data.items.find((item) => item.path === loosePath);
      assert.ok(loose, loosePath);
      assert.equal(loose.id, null);
      assert.equal(loose.ref, `n-${createHash('sha256').update(loosePath).digest('hex').slice(0, 16)}`);
      const shown = await cli(['note', 'show', loose.ref]);
      assert.equal(shown.code, 0, shown.stdout);
      assert.equal(shown.json.data.path, loosePath);
      assert.equal(shown.json.data.ref, loose.ref);
      const searched = await cli(['search', 'lantern']);
      assert.equal(searched.code, 0, searched.stdout);
      assert.equal(searched.json.data.items.find((item) => item.path === loosePath)?.ref, loose.ref);
      for (const items of [listed.json.data.items, searched.json.data.items]) {
        assert.ok(items.every((item) => !/^(?:raw|Clippings|Ignored|\.obsidian)\//u.test(item.path)
          && item.path !== 'Catalog.md'));
      }

      const open = () => openContext({ mode: 'read', dataDir: data, home, env: {}, clock, preset });
      const pool = createRenderPool();
      t.after(() => pool.close());
      const cairn = createRead({ open, render: pool.render });
      const app = createApp({ root, guard, handler, locals: { cairn } });
      const response = await inProcess(app, '/');
      assert.equal(response.status, 200);
      headers(response);
      assert.ok(response.body.includes(`href="/notes/${loose.ref}"`));
      assert.ok(response.body.includes(loose.content.title));
      assert.doesNotMatch(response.body, /Hidden lantern/u);
      for (const ref of [loose.ref, 'n-000001']) {
        const page = await inProcess(app, `/notes/${ref}`);
        assert.equal(page.status, 200, ref);
        headers(page);
        assert.match(page.body, /class="document-body"/u);
      }
      const identified = await inProcess(app, '/notes/n-000001');
      const backlink = listed.json.data.items.find((item) => item.path === 'notes/loose.md');
      assert.equal(backlink.id, null);
      const external = await inProcess(app, `/notes/${backlink.ref}`);
      assert.equal(external.status, 200);
      assert.match(external.body, /Loose backlink/u);
      assert.ok(identified.body.includes(`class="wikilink" href="/notes/${backlink.ref}"`));
      assert.ok(identified.body.includes(`class="row-title" href="/notes/${backlink.ref}"`));
      for (const invalid of ['n-0000000000000000', 'n-ABCDEF0123456789', 'n-123', 'n-../',
        'n-%2e%2e%2f', 'n-%252e%252e%252f', 'n-%5c..%5c', 'n-%00', `@${loosePath}`]) {
        assert.equal((await inProcess(app, `/notes/${invalid}`)).status, 404, invalid);
      }
    });
  }
}

function documentFixture(type = 'card') {
  return { data: {
    id: type === 'card' ? 'c-000001' : 'n-000001', type,
    content: { title: `${type} title`, body: 'Plain body', html: '<h2>Rendered body</h2>' },
    meta: { priority: 'urgent', assignee: 'owner', updated: '2026-11-01T12:00:00Z', acceptance: { done: 1, total: 2 },
      backlinks: [{ type: 'card', id: 'c-000002', title: 'Backlink card', src_path: 'cards/source.md', line: 1 },
        { type: 'note', id: 'n-000002', title: 'Backlink note', src_path: 'notes/source.md', line: 2 },
        { type: 'journal', id: '2026-11-01', title: 'Journal source', src_path: 'journal/2026-11-01.md', line: 1 },
        { type: 'project', id: 'p-000001', title: 'Project source', src_path: 'projects/source.md', line: 1 },
        { src_path: 'notes/unresolved.md', line: 1 }] },
    project: { id: 'p-000001', title: 'Joined project', tone: 3 },
    ...(type === 'card' ? { column: { key: 'doing', label: 'Working column', role: 'doing' },
      relatedCards: [{ id: 'c-000002', content: { title: 'Related card' } }] } : {}),
  }, warnings: [] };
}

function boardFixture() {
  return { data: { columns: [
    { key: 'custom', label: 'Custom column', role: 'doing', total: 1, cards: [documentFixture().data] },
    { key: 'done', label: 'Done column', role: 'done', total: 51, cards: [{ ...documentFixture().data, id: 'c-000002', column: undefined }] },
    { key: 'empty', label: 'Empty column', role: 'planned', total: 0, cards: [] },
    { key: 'loose', label: 'Loose column', role: 'todo', total: 1, cards: [{ ...documentFixture().data, id: null, content: { ...documentFixture().data.content, title: 'Card without id' } }] },
  ] }, warnings: [] };
}

test('built Board, Card and Note routes use injected data, safe states and external assets', async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  if (!existsSync(join(root, 'dist/app/server/entry.mjs'))) {
    t.skip('Astro output missing; run npm run build:app to enable integration coverage.');
    return;
  }
  const { handler } = await import('../dist/app/server/entry.mjs');
  const render = async (path, cairn) => {
    const response = await inProcess(createApp({ root, guard, handler, locals: { cairn } }), path);
    headers(response);
    externalAssets(response.body);
    return response;
  };
  for (const [path, method, makeResult] of [
    ['/board', 'board', boardFixture], ['/cards/c-000001', 'card', documentFixture], ['/notes/n-000001', 'note', () => documentFixture('note')],
  ]) {
    const response = await render(path, { [method]: (id) => {
      if (method !== 'board') assert.equal(id, method === 'card' ? 'c-000001' : 'n-000001');
      return makeResult();
    } });
    assert.equal(response.status, 200, path);
    assert.match(response.body, /Joined project/u);
    assert.match(response.body, /tone-3/u);
    assert.match(response.body, /priority-urgent[^>]*>Acil/u);
    assert.match(response.body, /Atanan: owner/u);
    assert.match(response.body, /1\/2 ölçüt tamamlandı/u);
    if (method === 'board') {
      for (const title of ['Custom column', 'card title', 'Empty column', 'son 50']) assert.ok(response.body.includes(title), title);
      assert.match(response.body, /href="\/cards\/c-000001"/u);
      assert.ok(response.body.includes('Card without id'));
      assert.doesNotMatch(response.body, /href="\/cards\/(?:null|undefined)?"/u);
      assert.ok(response.body.indexOf('Custom column') < response.body.indexOf('Done column'));
    } else {
      assert.match(response.body, /<h2>Rendered body<\/h2>/u);
      assert.match(response.body, /1\.11\.2026/u);
      if (method === 'card') {
        assert.doesNotMatch(response.body, /<form\b|name="csrf"|<meta name="referrer"/u);
        assert.match(response.body, /data-live="card project board"/u);
        assert.match(response.body, /Working column/u);
        assert.match(response.body, /href="\/cards\/c-000002"[^>]*>Related card/u);
      } else {
        for (const title of ['Backlink card', 'Backlink note', 'Journal source', 'Project source', 'notes/unresolved.md']) assert.ok(response.body.includes(title), title);
        assert.match(response.body, /href="\/notes\/n-000002"/u);
        assert.match(response.body, /href="\/cards\/c-000002"/u);
        assert.doesNotMatch(response.body, /href="\/(?:journal|projects)\//u);
        assert.doesNotMatch(response.body, /document-sidebar/u);
      }
    }
    if (method === 'note') assert.doesNotMatch(response.body, /aria-current="page"/u);
    else assert.match(response.body, /href="\/board" aria-current="page"/u);

    const malicious = '<img src=x onerror=attack(1)>';
    const escaped = await render(path, { [method]: () => {
      const result = makeResult();
      const item = method === 'board' ? result.data.columns[0].cards[0] : result.data;
      item.content.title = malicious;
      item.project.title = malicious;
      item.meta.assignee = malicious;
      if (method === 'note') {
        item.meta.backlinks[0].title = malicious;
        item.meta.backlinks[4].src_path = malicious;
      }
      return result;
    } });
    assert.equal(escaped.status, 200);
    assert.ok((escaped.body.match(/&lt;img src=x onerror=attack\(1\)&gt;/gu) ?? []).length >= (method === 'note' ? 5 : 3));
    assert.doesNotMatch(escaped.body, /<img\b/u);

    const notReady = await render(path, createRead({ open: () => { throw new Error('/private/data missing'); } }));
    assert.equal(notReady.status, 409, path);
    assert.match(notReady.body, /Veri klasörün hazır değil/u);
    assert.match(notReady.body, /npm run cairn -- init/u);
    const failed = await render(path, { [method]: () => { throw new Error('/private/data\nsecret stack'); } });
    assert.equal(failed.status, 500, path);
    for (const result of [notReady, failed]) assert.doesNotMatch(result.body, /private|secret|stack|Error:/u);

    if (method !== 'board') {
      const missing = await render(path, { [method]: () => { throw Object.assign(new Error('/private/missing'), { code: 'entity_not_found' }); } });
      assert.equal(missing.status, 404);
      assert.match(missing.body, /Sayfa bulunamadı/u);
      assert.doesNotMatch(missing.body, /private|missing|Error:/u);
      for (const warning of ['too_large', 'render_timeout', 'render_failed']) {
        const fallback = await render(path, { [method]: () => {
          const result = makeResult();
          result.data.content.html = null;
          result.data.content.body = '## Plain <script>bodyAttack(1)</script>';
          result.warnings.push(warning);
          return result;
        } });
        assert.equal(fallback.status, 200);
        assert.match(fallback.body, /## Plain &lt;script&gt;bodyAttack\(1\)&lt;\/script&gt;/u);
        assert.match(fallback.body, /düz metin gösteriliyor/u);
      }
    }
  }
});

function projectFixture() {
  const card = (id, title, priority, column) =>
    ({ id, type: 'card', meta: priority ? { priority } : {}, content: { title }, column });
  const planned = { key: 'planned', label: 'Planned column', role: 'planned' };
  return { data: {
    id: 'p-000001', type: 'project', tone: 4,
    content: { title: 'Project title', body: 'Plain body', html: '<h2>Rendered body</h2>' },
    meta: { status: 'active', updated: '2026-11-01T12:00:00Z' },
    openCards: [card('c-000001', 'Other card', null, { key: 'doing', label: 'Working column', role: 'doing' }),
      card('c-000002', 'Urgent card', 'urgent', planned), card(null, 'Card without id', 'important', planned)],
    doneCount: 7,
    notes: [{ ref: 'n-000001', title: 'Project note' }], notesTotal: 9,
  }, warnings: [] };
}

test('built Project page shows the cover, grouped open cards, notes and safe states', async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  if (!existsSync(join(root, 'dist/app/server/entry.mjs'))) {
    t.skip('Astro output missing; run npm run build:app to enable integration coverage.');
    return;
  }
  const { handler } = await import('../dist/app/server/entry.mjs');
  const render = async (cairn, path = '/projects/p-000001') => {
    const response = await inProcess(createApp({ root, guard, handler, locals: { cairn } }), path);
    headers(response);
    externalAssets(response.body);
    return response;
  };
  const response = await render({ project: (id) => { assert.equal(id, 'p-000001'); return projectFixture(); } });
  assert.equal(response.status, 200);
  const body = response.body;
  assert.match(body, /class="panel project-hero tone-4"/u);
  assert.match(body, /<h1>Project title<\/h1>/u);
  assert.match(body, /<h2>Rendered body<\/h2>/u);
  assert.match(body, /href="\/board\?project=p-000001"/u);
  assert.match(body, /3 açık · 7\/10 bitti/u);
  const at = (title) => body.indexOf(title);
  assert.ok(at('Urgent card') < at('Card without id') && at('Card without id') < at('Other card'),
    'urgent, important, then other');
  assert.match(body, /href="\/cards\/c-000002"[^>]*>Urgent card/u);
  assert.match(body, /status-doing[^>]*>Working column/u);
  assert.doesNotMatch(body, /href="\/cards\/(?:null|undefined)?"/u);
  assert.match(body, /href="\/notes\/n-000001"[^>]*>Project note/u);
  assert.match(body, /Son 1 not gösteriliyor, toplam 9/u);
  assert.match(body, /data-live="project card note board"/u);

  const empty = await render({ project: () => {
    const result = projectFixture();
    Object.assign(result.data, { openCards: [], notes: [], notesTotal: 0, doneCount: 0 });
    result.data.content.html = '';
    return result;
  } });
  assert.match(empty.body, /Bu projede açık kart yok/u);
  assert.match(empty.body, /Bu projeye bağlı not yok/u);
  assert.doesNotMatch(empty.body, /project-description/u);

  const malicious = '<img src=x onerror=attack(1)>';
  const escaped = await render({ project: () => {
    const result = projectFixture();
    result.data.content.title = malicious;
    result.data.openCards[0].content.title = malicious;
    result.data.notes[0].title = malicious;
    return result;
  } });
  assert.ok((escaped.body.match(/&lt;img src=x onerror=attack\(1\)&gt;/gu) ?? []).length >= 3);
  assert.doesNotMatch(escaped.body, /<img\b/u);

  const notReady = await render(createRead({ open: () => { throw new Error('/private/data missing'); } }));
  assert.equal(notReady.status, 409);
  const missing = await render({ project: () => {
    throw Object.assign(new Error('/private/missing'), { code: 'entity_not_found' });
  } });
  assert.equal(missing.status, 404);
  const failed = await render({ project: () => { throw new Error('/private/data\nsecret stack'); } });
  assert.equal(failed.status, 500);
  for (const result of [notReady, missing, failed]) assert.doesNotMatch(result.body, /private|secret|stack|Error:/u);
});

test('built My projects page groups every project by status with Home boxes and safe states', async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  if (!existsSync(join(root, 'dist/app/server/entry.mjs'))) {
    t.skip('Astro output missing; run npm run build:app to enable integration coverage.');
    return;
  }
  const { handler } = await import('../dist/app/server/entry.mjs');
  const render = async (cairn) => {
    const response = await inProcess(createApp({ root, guard, handler, locals: { cairn } }), '/projects');
    headers(response);
    externalAssets(response.body);
    return response;
  };
  const project = (id, title, status, path) => ({ type: 'project', id, path,
    meta: status ? { status } : {}, content: { title, snippet: '' } });
  const fixture = () => ({ data: { projects: [project('p-000001', 'Archived one', 'archived', 'projects/a.md'),
    project('p-000002', 'Active one', undefined, 'projects/b.md'),
    project('p-000003', 'Paused one', 'paused', 'projects/c.md'),
    project(null, 'Loose one', 'active', 'projects/d.md')],
  projectCards: { 'projects/b.md': { total: 4, done: 1, doing: 1, todo: 2, upcoming: [] } } }, warnings: [] });
  const response = await render({ projects: fixture });
  assert.equal(response.status, 200);
  const body = response.body;
  assert.match(body, /href="\/projects" aria-current="page">Projeler</u);
  assert.match(body, /4 proje · 2 aktif/u);
  const at = (text) => body.indexOf(text);
  assert.ok(at('>Aktif') < at('>Beklemede') && at('>Beklemede') < at('>Arşiv'), 'active, paused, archive');
  assert.ok(at('Active one') < at('Paused one') && at('Paused one') < at('Archived one'));
  assert.match(body, /href="\/projects\/p-000002"/u);
  assert.ok(body.includes('Loose one'), 'a project without an id still has a box');
  assert.match(body, /1\/4 kart/u);
  assert.equal((body.match(/class="panel project-box/gu) ?? []).length, 4);
  assert.doesNotMatch(body, /project-featured/u);
  const empty = await render({ projects: async () => ({ data: { projects: [], projectCards: {} }, warnings: [] }) });
  assert.match(empty.body, /Projelerin eklendiğinde burada görünecek/u);
  const escaped = await render({ projects: () => {
    const result = fixture();
    result.data.projects[1].content.title = '<img src=x onerror=attack(1)>';
    return result;
  } });
  assert.match(escaped.body, /&lt;img src=x onerror=attack\(1\)&gt;/u);
  // Inside a quoted attribute (the box's aria-label) a "<" is plain text; outside one it must never be markup.
  assert.doesNotMatch(escaped.body.replace(/"[^"]*"/gu, '""'), /<img\b/u);
  const notReady = await render(createRead({ open: () => { throw new Error('/private/data missing'); } }));
  assert.equal(notReady.status, 409);
  const failed = await render({ projects: () => { throw new Error('/private/data\nsecret stack'); } });
  assert.equal(failed.status, 500);
  for (const result of [notReady, failed]) assert.doesNotMatch(result.body, /private|secret|stack|Error:/u);
});

test('built Card and Note insert only sanitized Markdown from the reader', async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  if (!existsSync(join(root, 'dist/app/server/entry.mjs'))) {
    t.skip('Astro output missing; run npm run build:app to enable integration coverage.');
    return;
  }
  const { handler } = await import('../dist/app/server/entry.mjs');
  const data = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(data, { home, env: {}, clock });
  for (const [folder, id] of [['cards', 'c-000001'], ['notes', 'n-000001']]) {
    mkdirSync(join(data, folder), { recursive: true });
    writeFileSync(join(data, folder, 'page.md'), `---\nid: ${id}\ntitle: Read page\n---\n## Safe heading\n\n- [x] Finished\n\n<script>bodyAttack(1)</script>`);
  }
  const cairn = createRead({ open: () => openContext({ mode: 'read', dataDir: data, home, env: {}, clock }) });
  for (const path of ['/cards/c-000001', '/notes/n-000001']) {
    const response = await inProcess(createApp({ root, guard, handler, locals: { cairn } }), path);
    assert.equal(response.status, 200);
    externalAssets(response.body);
    assert.match(response.body, /<h2>Safe heading<\/h2>/u);
    assert.match(response.body, /type="checkbox"/u);
    assert.doesNotMatch(response.body, /bodyAttack|## Safe heading/u);
  }
});

test('built Search page lists grouped rows, inserts only the snippet HTML and keeps safe states', async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  if (!existsSync(join(root, 'dist/app/server/entry.mjs'))) {
    t.skip('Astro output missing; run npm run build:app to enable integration coverage.');
    return;
  }
  const { handler } = await import('../dist/app/server/entry.mjs');
  const calls = [];
  const render = async (path, cairn) => {
    const response = await inProcess(createApp({ root, guard, handler, locals: { cairn } }), path);
    headers(response);
    externalAssets(response.body);
    return response;
  };
  const row = (type, ref, title) => ({ type, ref, title, snippetHtml: `a <mark>plan</mark> b`,
    project: { id: 'p-1', name: '<b>Proj</b>', tone: 3 }, column: type === 'card' ? 'Doing' : null, updated: null });
  const search = ({ q, type, limit }) => {
    calls.push({ q, type, limit });
    if (type !== undefined && !['card', 'note'].includes(type)) {
      throw Object.assign(new Error('bad'), { code: 'validation' });
    }
    const results = { card: [row('card', 'c-1', '<img src=x onerror=attack(1)>')],
      note: [row('note', 'notlar/şu not', 'Not')] };
    if (type) for (const kind of ['card', 'note']) if (kind !== type) results[kind] = [];
    return { ok: true, data: { query: q.trim(), type: type ?? null, results, counts: { card: 1, note: '1000+' },
      more: { card: false, note: !type } }, warnings: [] };
  };

  const all = await render('/search?q=plan', { search });
  assert.equal(all.status, 200);
  assert.deepEqual(calls.at(-1), { q: 'plan', type: undefined, limit: 50 });
  assert.match(all.body, /<title>Ara: plan · Cairnboard<\/title>/u);
  assert.match(all.body, /<body[^>]*data-search-page/u);
  assert.match(all.body, /<input class="search-input" id="search-query" name="q"[^>]*value="plan"/u);
  const groups = [...all.body.matchAll(/<h2 class="search-group"[^>]*>([^<]*)<\/h2>/gu)].map((match) => match[1]);
  assert.deepEqual(groups, ['Kartlar', 'Notlar']);
  assert.match(all.body, /class="search-row" href="\/cards\/c-1"/u);
  assert.match(all.body, /class="search-row" href="\/notes\/notlar%2F%C5%9Fu%20not"/u);
  assert.match(all.body, /a <mark>plan<\/mark> b/u);
  assert.match(all.body, /&lt;img src=x onerror=attack\(1\)&gt;/u);
  assert.match(all.body, /&lt;b&gt;Proj&lt;\/b&gt;/u);
  assert.doesNotMatch(all.body, /<img\b|<b>Proj/u);
  assert.match(all.body, /1001\+ sonuç/u);
  assert.match(all.body, /href="\/search\?q=plan&amp;type=note"[^>]*>Tüm notlar \(1000\+\)/u);
  assert.match(all.body, /class="search-filter" href="\/search\?q=plan" aria-current="true"/u);

  const filtered = await render('/search?q=plan&type=card', { search });
  assert.deepEqual(calls.at(-1), { q: 'plan', type: 'card', limit: 50 });
  assert.doesNotMatch(filtered.body, /class="search-group"|href="\/notes\//u);
  assert.match(filtered.body, /<input type="hidden" name="type" value="card"/u);
  assert.match(filtered.body, /href="\/search\?q=plan&amp;type=card" aria-current="true"/u);

  const unknown = await render('/search?q=plan&type=wiki', { search });
  assert.equal(unknown.status, 200);
  assert.deepEqual(calls.slice(-2).map((call) => call.type), ['wiki', undefined], 'an unknown type falls back to All');
  assert.doesNotMatch(unknown.body, /name="type"/u);

  const none = await render('/search?q=zzz&type=note', { search: ({ q, type }) => ({ ok: true, warnings: [], data: {
    query: q, type, results: { card: [], note: [] }, counts: { card: 2, note: 0 },
    more: { card: false, note: false } } }) });
  assert.match(none.body, /Sonuç yok/u);
  assert.match(none.body, /href="\/search\?q=zzz"[^>]*>Süzgeci kaldır/u);
  assert.match(none.body, /href="\/search"[^>]*>Temizle/u);

  const empty = await render('/search', { search });
  assert.match(empty.body, /Aramak için yaz/u);
  assert.match(empty.body, /<ul class="search-recent" data-recent-searches[^>]*hidden/u);
  assert.match(empty.body, /<title>Ara · Cairnboard<\/title>/u);

  const unready = createRead({ open: () => { throw new Error('/private/data missing'); } });
  const notReady = await render('/search?q=plan', unready);
  assert.equal(notReady.status, 409);
  assert.match(notReady.body, /Veri klasörün hazır değil/u);
  const failed = await render('/search?q=plan', { search: () => { throw new Error('/private/data\nsecret stack'); } });
  assert.equal(failed.status, 500);
  for (const result of [notReady, failed]) assert.doesNotMatch(result.body, /private|secret|stack|Error:/u);
});
