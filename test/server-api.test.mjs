import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { dirname, join } from 'node:path';
import { mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { __setFsHooks } from '../core/fsx.mjs';
import * as entity from '../core/entity.mjs';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { openIndex } from '../core/index.mjs';
import { watch } from '../core/watch.mjs';
import { CairnError } from '../core/errors.mjs';
import { createApp } from '../server/app.mjs';
import { createApi } from '../server/api.mjs';
import { createGuard, CSP } from '../server/guard.mjs';
import { cookieName, mintCookie, siteHost } from '../server/session.mjs';
import { homeView, boardView } from '../cli/views.mjs';
import { tempDir, fixedClock } from './support/env.mjs';
import { runCli } from './support/cli.mjs';

const port = 4330, key = Buffer.alloc(32, 7), instance = 'run-aaaaaaaaaaaaaaaa';
const cookie = `${cookieName(port)}=${mintCookie(key, port)}`;

// Exercise real Node messages, the real guard and app without needing a listening socket.
async function request(app, path, { method = 'GET', signedIn = true } = {}) {
  const req = new IncomingMessage(new Socket());
  req.url = path;
  req.method = method;
  req.headers = { host: `${siteHost(key)}:${port}`, ...(signedIn ? { cookie } : {}) };
  let output = '';
  const socket = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } });
  const res = new ServerResponse(req);
  res.useChunkedEncodingByDefault = false;
  res.assignSocket(socket);
  const finished = new Promise((resolve) => res.once('finish', resolve));
  await app(req, res);
  await finished;
  const body = output.slice(output.indexOf('\r\n\r\n') + 4);
  const headers = res.getHeaders();
  assert.equal(headers['content-security-policy'], CSP);
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  if (headers['content-type'] === 'application/json; charset=utf-8' || ![404, 500].includes(res.statusCode)) {
    assert.equal(headers['cache-control'], 'no-store');
  }
  if (headers['content-type'] === 'application/json; charset=utf-8' && method !== 'HEAD') {
    assert.equal(headers['content-length'], Buffer.byteLength(body));
  }
  return { status: res.statusCode, headers, body, json: body.startsWith('{') ? JSON.parse(body) : null };
}

function fixture(t) {
  const home = tempDir(t), data = tempDir(t), root = tempDir(t);
  const clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(data, { home, env: {}, clock });
  const put = (path, fields, body = '') => {
    mkdirSync(dirname(join(data, path)), { recursive: true });
    writeFileSync(join(data, path), `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n${body}`);
  };
  put('projects/alpha.md', { id: 'p-000001', title: 'Alpha', status: 'active' });
  put('notes/quick.md', { id: 'n-000001', title: 'Quick', kind: 'note', pinned: true }, 'Quick body');
  put('wiki/concepts/topic.md', { id: 'n-000002', title: 'Topic', kind: 'concept' }, 'Wiki body');
  put('cards/work.md', { id: 'c-000001', title: 'Work', project: 'p-000001', column: 'doing', position: 'a1', priority: 'important' },
    'Full body [[quick|Quick note]] and [[2026-11-01|Today]] and [[missing]].');
  put('journal/2026-11-01.md', { date: '2026-11-01' }, '## Work\n- Entry');
  const open = () => openContext({ mode: 'read', dataDir: data, home, env: {}, clock });
  const appFor = (api = createApi({ open })) => createApp({ root, api,
    guard: createGuard({ port, key, instance }), handler: () => assert.fail('API must not reach Astro') });
  return { home, data, root, clock, put, open, appFor, app: appFor(),
    cli: (args) => runCli([...args, '--json'], { home, data, clock }) };
}

test('read endpoints use CLI envelopes and data, while the guard protects every request', async (t) => {
  const f = fixture(t);
  const noCookie = await request(f.app, '/api/home', { signedIn: false });
  assert.equal(noCookie.status, 401);
  assert.match(noCookie.headers['content-type'], /text\/html/u);
  assert.equal(noCookie.json, null);
  for (const [path, args] of [['/api/home', ['home']], ['/api/board', ['board']],
    ['/api/cards/c-000001', ['card', 'show', 'c-000001']], ['/api/notes/n-000001', ['note', 'show', 'n-000001']]]) {
    const response = await request(f.app, path);
    const cli = await f.cli(args);
    assert.equal(cli.code, 0, cli.stdout);
    assert.equal(response.status, 200, path);
    assert.equal(response.json.v, 1);
    assert.equal(response.json.ok, true);
    const expected = structuredClone(cli.json);
    if (args.includes('show')) {
      assert.equal(typeof response.json.data.content.html, 'string');
      expected.data.content.html = response.json.data.content.html;
    }
    assert.deepEqual(response.json, expected, path);
    const head = await request(f.app, path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], response.headers['content-length']);
  }
  const card = await request(f.app, '/api/cards/C-OOOOO1');
  assert.equal(card.status, 200, 'normalizeId aliases are accepted');
  assert.match(card.json.data.content.html, /href="\/notes\/n-000001"/u);
  assert.match(card.json.data.content.html, /href="\/journal\/2026-11-01"/u);
  assert.match(card.json.data.content.html, /wikilink-ghost/u);
  const post = await request(f.app, '/api/home', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
  assert.equal(post.json, null);
});

test('unknown and malformed routes fail with not_found before reading data', async (t) => {
  const f = fixture(t);
  for (const path of ['/api/cards/c-000099', '/api/notes/n-000099', '/api/cards/n-000001',
    '/api/cards/invalid', '/api/cards/' + '@cards/work', '/api/notes/' + '@notes/quick', '/api/notes/a/b',
    '/api/notes/n-000001%2Fextra', '/api%2Fnotes/n-000001', '/api/notes/%2F',
    '/api/notes/%252F', '/api/notes/bad%', '/api/unknown', '/api/home/extra']) {
    const response = await request(f.app, path);
    assert.equal(response.status, 404, path);
    assert.deepEqual(response.json, { v: 1, ok: false, error: { code: 'not_found', message: 'Entity was not found.' }, warnings: [] });
  }
  const api = createApi({ open: () => assert.fail('invalid paths must not open a context') });
  assert.equal((await request(f.appFor(api), '/api/cards/not-an-id')).status, 404);
  assert.equal(await api({ url: '/page' }, {}, '/page'), false);
  assert.throws(() => createApp({ root: f.root, api }), /guard/u);
  const noApi = createApp({ root: f.root, guard: createGuard({ port, key, instance }), handler: () => assert.fail('no API fallback to Astro') });
  // A missing API still produces a 404 page; use the existing app tests for page cache headers.
  let status;
  await noApi({ url: '/api/home', method: 'GET', headers: { host: `${siteHost(key)}:${port}`, cookie } }, {
    setHeader() {}, removeHeader() {}, end() { status = this.statusCode; },
  });
  assert.equal(status, 404);
});

test('external and noncanonical note ids have readable pages and live wiki links', async (t) => {
  const f = fixture(t);
  f.put('notes/external.md', { id: 'zettel-42', title: 'External' }, '**External body**');
  f.put('notes/upper.md', { id: 'N-ABC123', title: 'Upper' });
  f.put('notes/links.md', { id: 'n-000008' }, '[[external]] [[upper]]');
  const external = entity.resolve(f.open(), 'note', '@notes/external');
  assert.equal(external.id, null);
  const links = await request(f.app, '/api/notes/n-000008');
  assert.equal(links.status, 200);
  assert.ok(links.json.data.content.html.includes(`href="/notes/${external.ref}"`));
  assert.match(links.json.data.content.html, /href="\/notes\/n-abc123"/u);
  const page = await request(f.app, `/api/notes/${external.ref}`);
  assert.equal(page.status, 200);
  assert.equal(page.json.data.ref, external.ref);
  assert.match(page.json.data.content.html, /<strong>External body<\/strong>/u);
  assert.equal((await request(f.app, '/api/notes/n-abc123')).status, 200);
});

test('server reads reuse healthy watcher freshness, notice cache generations and fall back on failure', async (t) => {
  const f = fixture(t), native = new EventEmitter();
  native.close = async () => {};
  const watcher = watch(f.open(), { createWatcher: () => native, log: () => {} });
  t.after(() => watcher.close());
  let opened = 0, scans = 0;
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) {
    if (sql === 'SELECT * FROM targets') scans++;
    return prepare.call(this, sql, ...args);
  });
  const open = () => {
    opened++;
    const ctx = f.open();
    watcher.reuseFresh(ctx);
    return ctx;
  };
  const app = f.appFor(createApi({ open }));
  assert.equal((await request(app, '/api/board')).status, 200);
  assert.equal(scans, 1, 'before native readiness each new context refreshes');
  native.emit('ready');
  assert.equal(await watcher.ready, true);
  const readyScans = scans;
  for (let i = 0; i < 2; i++) assert.equal((await request(app, '/api/board')).status, 200);
  assert.equal(opened, 3, 'each request still opens a separate context');
  assert.equal(scans, readyScans, 'successive ready requests do not scan the vault');

  const changed = once(watcher, 'change', { signal: AbortSignal.timeout(5000) });
  f.put('cards/work.md', { id: 'c-000001', title: 'External edit', column: 'doing' }, 'New body');
  native.emit('all', 'change', join(f.data, 'cards/work.md'));
  const pending = await request(app, '/api/board');
  assert.equal(pending.status, 200);
  assert.equal(scans, readyScans + 1, 'pending watcher events prevent freshness reuse');
  await changed;
  const changedScans = scans;
  const page = await request(app, '/api/cards/c-000001');
  assert.equal(page.status, 200);
  assert.equal(page.json.data.content.title, 'External edit');
  assert.equal(page.json.data.content.body, 'New body');
  assert.equal(scans, changedScans, 'the watcher already refreshed the external edit');

  // Model another process rebuilding the cache without populating it.
  const db = new DatabaseSync(f.open().indexPath);
  db.exec("UPDATE meta SET value = '9' WHERE key = 'schema_version'");
  db.close();
  openIndex(f.open()).close();
  assert.equal((await request(app, '/api/cards/c-000001')).status, 200);
  assert.equal(scans, changedScans + 1, 'a new cache generation requires a full refresh');
  assert.equal((await request(app, '/api/board')).status, 200);
  assert.equal(scans, changedScans + 1, 'the refreshed generation is reused by later requests');

  entity.list(f.open());
  assert.equal(scans, changedScans + 2, 'ordinary contexts retain CLI freshness behavior');
  native.emit('error', { code: 'ENOSPC' });
  for (const title of ['Polling fallback', 'Another fallback']) {
    f.put('cards/work.md', { id: 'c-000001', title, column: 'doing' });
    const page = await request(app, '/api/cards/c-000001');
    assert.equal(page.status, 200);
    assert.equal(page.json.data.content.title, title);
  }
  assert.equal(scans, changedScans + 4, 'failed watching restores one refresh per new request context');
});

test('API renders the full body, skips bodies over 5 MB and resolves ambiguity as a ghost', async (t) => {
  const f = fixture(t);
  f.put('notes/full.md', { id: 'n-000003', kind: 'note' }, `${'a'.repeat(70 * 1024)}\n\n**Tail** [[quick]]`);
  const full = await request(f.app, '/api/notes/n-000003');
  assert.equal(full.status, 200);
  assert.ok(Buffer.byteLength(full.json.data.content.body) <= 65536);
  assert.match(full.json.data.content.html, /<strong>Tail<\/strong>/u);
  assert.match(full.json.data.content.html, /href="\/notes\/n-000001"/u);
  assert.ok(full.json.warnings.includes('truncated'));
  f.put('notes/large.md', { id: 'n-000004', kind: 'note' }, 'a'.repeat(5 * 1024 * 1024 + 1));
  const large = await request(f.app, '/api/notes/n-000004');
  assert.equal(large.status, 200);
  assert.equal(large.json.data.content.html, null);
  assert.ok(large.json.warnings.includes('too_large'));
  f.put('wiki/concepts/quick.md', { id: 'n-000005', kind: 'concept' }, 'Other quick');
  const ambiguous = await request(f.app, '/api/cards/c-000001');
  assert.match(ambiguous.json.data.content.html, /class="wikilink wikilink-ghost">Quick note<\/span>/u);
  assert.doesNotMatch(ambiguous.json.data.content.html, /\/notes\/n-000001/u);
});

test('API reads original file paths while keeping cleaned CLI output', async (t) => {
  const f = fixture(t);
  f.put('notes/hidden\u200b.md', { id: 'n-000006', title: 'Hidden path', kind: 'note' }, '**Full body** [[quick]]');
  f.put('notes/referrer.md', { id: 'n-000007', kind: 'note' }, '[[hidden\u200b]]');
  const response = await request(f.app, '/api/notes/n-000006');
  const cli = await f.cli(['note', 'show', 'n-000006']);
  assert.equal(response.status, 200);
  assert.match(response.json.data.content.html, /<strong>Full body<\/strong>/u);
  assert.match(response.json.data.content.html, /href="\/notes\/n-000001"/u);
  assert.equal(response.json.data.path, 'notes/hidden.md');
  assert.equal(response.json.data.content.links[0].target_path, 'notes/quick.md');
  assert.equal(response.json.data.meta.backlinks[0].src_path, 'notes/referrer.md');
  const expected = structuredClone(cli.json);
  expected.data.content.html = response.json.data.content.html;
  assert.deepEqual(response.json, expected);
});

test('API keeps processing errors generic and opening failures at 409', async (t) => {
  const f = fixture(t);
  const logged = t.mock.method(console, 'error', () => {});
  for (const error of [new Error('/private/secret/page.mjs\nstack trace'),
    new CairnError('internal', '/private/secret/page.mjs', { current: { path: '/private/secret' } }),
    new CairnError('unsafe_path', '/private/secret/page.mjs'),
    new CairnError('validation', '/private/secret/page.mjs'),
    new CairnError('not_found', '/private/secret/page.mjs')]) {
    const open = () => {
      const ctx = f.open();
      Object.defineProperty(ctx.config, 'columns', { get() { throw error; } });
      return ctx;
    };
    const app = f.appFor(createApi({ open }));
    const response = await request(app, '/api/home');
    assert.equal(response.status, 500);
    assert.deepEqual(response.json, { v: 1, ok: false, error: { code: 'internal', message: 'An internal error occurred.' }, warnings: [] });
    assert.doesNotMatch(response.body, /private|secret|page\.mjs|stack|Error:/u);
    const head = await request(app, '/api/home', { method: 'HEAD' });
    assert.equal(head.status, 500);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], response.headers['content-length']);
  }
  assert.equal(logged.mock.callCount(), 10);
  const missing = () => openContext({ mode: 'read', dataDir: join(f.data, 'missing'), home: f.home, env: {} });
  const validation = await request(f.appFor(createApi({ open: missing })), '/api/home');
  assert.equal(validation.status, 409);
  assert.equal(validation.json.error.code, 'validation');
  assert.doesNotMatch(validation.body, /missing|private|stack/u);
  const head = await request(f.appFor(createApi({ open: missing })), '/api/home', { method: 'HEAD' });
  assert.equal(head.status, 409);
  assert.equal(head.body, '');
});

test('home sorts and bounds collections, includes all pinned types and chooses a featured project', (t) => {
  const f = fixture(t);
  f.put('projects/beta.md', { id: 'p-000002', title: 'Beta', pinned: true, updated: '2026-11-02', status: 'active' });
  f.put('projects/old.md', { id: 'p-000003', title: 'Old', status: 'archived' });
  f.put('projects/no-status.md', { id: 'p-000004', title: 'No status' });
  f.put('research/source.md', { id: 'r-000001', title: 'Source', pinned: true, updated: '2026-11-03' });
  f.put('journal/2026-11-01.md', { date: '2026-11-01', pinned: true, updated: '2026-11-04' });
  f.put('wiki/concepts/topic.md', { id: 'n-000002', title: 'Topic', kind: 'concept', pinned: true, updated: '2026-11-05' });
  for (let i = 0; i < 12; i++) f.put(`notes/recent-${i}.md`, { title: `Recent ${i}`, kind: 'note', updated: `2026-11-${String(i + 1).padStart(2, '0')}` });
  for (let i = 0; i < 55; i++) f.put(`cards/open-${i}.md`, { title: `Card ${i}`, project: '@projects/beta', column: 'backlog',
    position: `a${String(i).padStart(2, '0')}`, priority: ['low', 'urgent', 'important', undefined][i % 4] ?? null });
  f.put('cards/done.md', { title: 'Done', column: 'done', priority: 'urgent', project: 'p-000001' });
  f.put('cards/unknown.md', { title: 'Unknown column', column: 'absent', pinned: true, updated: '2026-11-06' });
  const ctx = f.open();
  const view = homeView(ctx);
  assert.deepEqual(view.data.pinned.map((item) => item.type), ['card', 'note', 'journal', 'research', 'project', 'note']);
  assert.equal(view.data.recentNotes.length, 10);
  assert.equal(view.data.recentNotes[0].content.title, 'Recent 11');
  assert.ok(view.data.recentNotes.every((item) => item.meta.kind === 'note'));
  assert.equal(view.data.openCards.length, 50);
  const priorities = { urgent: 0, important: 1, low: 2 };
  const rank = view.data.openCards.map((item) => priorities[item.meta.priority] ?? 3);
  assert.deepEqual(rank, [...rank].sort((a, b) => a - b));
  for (const priority of ['urgent', 'important', 'low']) {
    const positions = view.data.openCards.filter((item) => item.meta.priority === priority).map((item) => item.meta.position ?? item.content.position);
    assert.deepEqual(positions, [...positions].sort());
  }
  assert.ok(view.warnings.includes('unknown_column'));
  assert.deepEqual(view.data.projects.map((item) => item.content.title), ['Alpha', 'Beta', 'No status']);
  assert.equal(view.data.featuredProject, 'p-000002');
  assert.equal(view.data.journal.type, 'journal');
  ctx.config.home = { featuredProject: 'p-000001' };
  assert.equal(homeView(ctx).data.featuredProject, 'p-000001');
  for (const value of ['n-000001', 'p-000099', '@projects/alpha', {}]) {
    ctx.config.home.featuredProject = value;
    assert.equal(homeView(ctx).data.featuredProject, 'p-000002');
  }
});

test('board retains position order, falls back for unknown columns, and limits done cards by recency', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 55; i++) f.put(`cards/done-${String(i).padStart(2, '0')}.md`, { title: `Done ${i}`, column: 'done',
    position: `a${String(i).padStart(2, '0')}`, updated: new Date(Date.UTC(2026, 0, i + 1)).toISOString() });
  f.put('cards/unknown.md', { title: 'Unknown', column: 'absent', position: 'a0' });
  const ctx = f.open();
  const view = boardView(ctx);
  assert.deepEqual(view.data.columns.map(({ key, label, role }) => ({ key, label, role })), ctx.config.columns);
  const done = view.data.columns.find((column) => column.role === 'done');
  assert.equal(done.total, 55);
  assert.equal(done.cards.length, 50);
  assert.equal(done.cards[0].content.title, 'Done 5');
  assert.equal(done.cards.at(-1).content.title, 'Done 54');
  assert.equal(view.data.columns[0].cards[0].content.title, 'Unknown');
  assert.ok(view.warnings.includes('unknown_column'));
});

test('home uses title order to break featured ties and returns null when projects or today are absent', (t) => {
  const home = tempDir(t), data = tempDir(t);
  initDataDir(data, { home, env: {} });
  const ctx = openContext({ mode: 'read', dataDir: data, home, env: {} });
  assert.deepEqual(homeView(ctx).data, { pinned: [], recentNotes: [], openCards: [], journal: null, projects: [], featuredProject: null });
  const f = fixture(t);
  f.put('projects/beta.md', { id: 'p-000002', title: 'Beta' });
  f.put('cards/beta.md', { column: 'doing', project: 'p-000002' });
  assert.equal(homeView(f.open()).data.featuredProject, 'p-000001');
});


test('home treats unreadable journal files and folders as optional with CLI warning parity', async (t) => {
  for (const kind of ['directory', 'symlink', 'folder symlink', 'unreadable']) {
    await t.test(kind, async (t) => {
      const f = fixture(t), path = join(f.data, 'journal/2026-11-01.md');
      if (kind === 'directory') {
        rmSync(path);
        mkdirSync(path);
      } else if (kind.includes('symlink')) {
        const link = kind === 'symlink' ? path : dirname(path);
        rmSync(link, { recursive: true });
        try { symlinkSync(join(f.data, 'notes', kind === 'symlink' ? 'quick.md' : ''), link,
          kind === 'symlink' ? 'file' : 'dir'); } catch (error) {
          if (process.platform !== 'win32') throw error;
          t.skip(`Symlink privileges unavailable: ${error.code}`);
          return;
        }
      } else {
        await f.cli(['home']);
        __setFsHooks({ openSync(file, ...args) {
          if (file === path) throw Object.assign(new Error('private journal read failure'), { code: 'EACCES' });
          return openSync(file, ...args);
        } });
        t.after(() => __setFsHooks());
      }
      const response = await request(f.app, '/api/home');
      assert.equal(response.status, 200);
      assert.equal(response.json.data.journal, null);
      assert.ok(response.json.warnings.includes('journal_unreadable'));
      const cli = await f.cli(['home']);
      assert.equal(cli.code, 0, cli.stdout);
      assert.deepEqual(response.json, cli.json);
    });
  }
});

test('featured project read failures fall back to open-card counts', (t) => {
  const f = fixture(t);
  f.put('projects/beta.md', { id: 'p-000002', title: 'Beta' });
  f.put('cards/beta-1.md', { column: 'doing', project: 'p-000002' });
  f.put('cards/beta-2.md', { column: 'doing', project: 'p-000002' });
  const ctx = f.open();
  entity.list(ctx);
  ctx.config.home = { featuredProject: 'p-000001' };
  let attempted = false;
  __setFsHooks({ openSync(path, ...args) {
    if (path === join(f.data, 'projects/alpha.md')) {
      attempted = true;
      throw new CairnError('unsafe_path', 'private project path');
    }
    return openSync(path, ...args);
  } });
  t.after(() => __setFsHooks());
  assert.equal(homeView(ctx).data.featuredProject, 'p-000002');
  assert.equal(attempted, true);
});

test('opening and config failures return safe 409 envelopes on every endpoint', async (t) => {
  for (const kind of ['missing config', 'newer config', 'invalid config', 'open failure']) {
    await t.test(kind, async (t) => {
      const f = fixture(t), path = join(f.data, '.cairn/config.json');
      t.mock.method(console, 'error', () => {});
      if (kind === 'missing config') rmSync(path);
      if (kind === 'newer config') {
        const config = JSON.parse(readFileSync(path, 'utf8'));
        config.formatVersion++;
        writeFileSync(path, JSON.stringify(config));
      }
      if (kind === 'invalid config') writeFileSync(path, '{}');
      const app = kind === 'open failure' ? f.appFor(createApi({ open: () => { throw new Error('private open failure'); } })) : f.app;
      for (const endpoint of ['/api/home', '/api/board', '/api/cards/c-000001', '/api/notes/n-000001']) {
        const response = await request(app, endpoint);
        assert.equal(response.status, 409, endpoint);
        assert.deepEqual(response.json, { v: 1, ok: false,
          error: { code: 'validation', message: 'The data directory is not ready.' }, warnings: [] });
      }
      const unknown = await request(app, '/api/unknown');
      assert.equal(unknown.status, 404, 'unknown routes do not open data');
    });
  }
});

test('HEAD refusals, query strings and unusual paths never expose data', async (t) => {
  const f = fixture(t);
  for (const path of ['/api/unknown', '/api/notes/n-000099']) {
    const head = await request(f.app, path, { method: 'HEAD' });
    const get = await request(f.app, path);
    assert.equal(head.status, 404);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], get.headers['content-length']);
  }
  const query = await request(f.app, '/api/home?x=1');
  assert.equal(query.status, 200);
  assert.deepEqual(query.json, (await f.cli(['home'])).json);
  const traversal = await request(f.app, '/api/%2e%2e/_astro/x', { signedIn: false });
  assert.ok([401, 404].includes(traversal.status));
  assert.equal(traversal.json?.ok ?? false, false);
  const app = createApp({ root: f.root, api: createApi({ open: f.open }),
    guard: createGuard({ port, key, instance }), handler: (req, res, next) => next() });
  const doubled = await request(app, '//api/home');
  assert.equal(doubled.status, 404);
  assert.equal(doubled.json, null);
});

test('journal links use dates; idless notes link by key while other idless entities stay ghosts', async (t) => {
  const f = fixture(t);
  f.put('journal/2026-11-02.md', {}, 'No frontmatter date');
  f.put('journal/2026-11-03.md', { date: '2026-02-30' }, 'Invalid date uses filename');
  f.put('journal/named-day.md', { date: '2026-11-04' }, 'Date overrides filename');
  f.put('journal/invalid-day.md', { date: '2026-02-30' }, 'No valid date');
  f.put('notes/idless-note.md', { kind: 'note' });
  f.put('research/idless-research.md', {});
  f.put('cards/idless-card.md', { column: 'doing' });
  f.put('projects/idless-project.md', {});
  f.put('notes/links.md', { id: 'n-000008', kind: 'note' },
    '[[2026-11-01]] [[2026-11-02]] [[2026-11-03]] [[named-day]] [[invalid-day]] '
      + '[[idless-note]] [[idless-research]] [[idless-card]] [[idless-project]]');
  const response = await request(f.app, '/api/notes/n-000008');
  assert.equal(response.status, 200);
  for (const day of ['01', '02', '03', '04']) {
    assert.ok(response.json.data.content.html.includes(`href="/journal/2026-11-${day}"`));
  }
  const note = await f.cli(['note', 'show', '@notes/idless-note']);
  const ref = note.json.data.ref;
  assert.ok(response.json.data.content.html.includes(`href="/notes/${ref}"`));
  const page = await request(f.app, `/api/notes/${ref}`);
  assert.equal(page.status, 200);
  assert.equal(page.json.data.ref, ref);
  assert.equal(page.json.data.id, null);
  assert.equal((await request(f.app, `/api/notes/${ref}`, { signedIn: false })).status, 401);
  for (const path of [`/api/cards/${ref}`, '/api/notes/n-0000000000000000',
    '/api/notes/n-ABCDEF0123456789', '/api/notes/n-../', '/api/notes/n-%2e%2e%2f']) {
    assert.equal((await request(f.app, path)).status, 404, path);
  }
  for (const name of ['invalid-day', 'idless-research', 'idless-card', 'idless-project']) {
    assert.ok(response.json.data.content.html.includes(`class="wikilink wikilink-ghost">${name}</span>`));
  }
});

test('home and board preserve CLI warning parity for unknown columns and duplicate ids', async (t) => {
  const f = fixture(t);
  f.put('cards/unknown.md', { id: 'c-000002', title: 'Unknown', column: 'absent' });
  f.put('cards/duplicate.md', { id: 'c-000002', title: 'Duplicate', column: 'doing' });
  for (const view of ['home', 'board']) {
    const response = await request(f.app, `/api/${view}`);
    const cli = await f.cli([view]);
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, cli.json);
    assert.ok(response.json.warnings.includes('unknown_column'));
    assert.ok(response.json.warnings.includes('duplicate_id'));
  }
});

test('home reads one summary snapshot and uses fixed title and path ordering', (t) => {
  const f = fixture(t);
  f.put('projects/ten.md', { id: 'p-000002', title: 'Project 10' });
  f.put('projects/two.md', { id: 'p-000003', title: 'Project 2' });
  f.put('projects/zeta.md', { id: 'p-000004', title: 'ÁLPHA' });
  const ctx = f.open();
  entity.list(ctx);
  const prepare = DatabaseSync.prototype.prepare;
  let reads = 0;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) {
    if (sql === 'SELECT * FROM files ORDER BY path') reads++;
    return prepare.call(this, sql, ...args);
  });
  const view = homeView(ctx);
  assert.equal(reads, 1);
  assert.deepEqual(view.data.projects.map((item) => item.content.title), ['Alpha', 'ÁLPHA', 'Project 2', 'Project 10']);
});

test('shown JSON and rendered HTML reuse one full source read', async (t) => {
  const f = fixture(t), ctx = f.open();
  entity.list(ctx);
  const source = join(f.data, 'notes/quick.md');
  let reads = 0;
  __setFsHooks({ openSync(path, ...args) {
    if (path === source) reads++;
    return openSync(path, ...args);
  } });
  t.after(() => __setFsHooks());
  const response = await request(f.appFor(createApi({ open: () => ctx })), '/api/notes/n-000001');
  assert.equal(response.status, 200);
  assert.equal(reads, 1);
  assert.equal(response.json.data.content.body, 'Quick body');
  assert.equal(response.json.data.content.html, '<p>Quick body</p>');
});
