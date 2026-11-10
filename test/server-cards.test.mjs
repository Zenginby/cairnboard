import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.mjs';
import { createGuard } from '../server/guard.mjs';
import { createCards } from '../server/cards.mjs';
import { createSettings } from '../server/settings.mjs';
import { createWrites } from '../server/writes.mjs';
import { createRead } from '../server/read.mjs';
import { cookieName, csrfToken, mintCookie, siteHost, verifyCsrf } from '../server/session.mjs';
import { openContext } from '../core/context.mjs';
import { initDataDir } from '../core/roots.mjs';
import { readEvents } from '../core/events.mjs';
import { addCard, listCards } from '../core/card.mjs';
import * as project from '../core/project.mjs';
import { fixedClock, tempDir } from './support/env.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const port = 4332, key = Buffer.alloc(32, 6), instance = 'run-cccccccccccccccc';
const site = `${siteHost(key)}:${port}`;
const built = existsSync(join(repo, 'dist/app/server/entry.mjs'));

async function call(app, { method = 'GET', path, headers = {}, body }) {
  const req = new IncomingMessage(new Socket());
  const data = body === undefined ? undefined : Buffer.from(body);
  Object.assign(req, { url: path, method,
    headers: { host: site, ...headers, ...(data ? { 'content-length': String(data.length) } : {}) } });
  if (data) req.push(data);
  req.push(null);
  let output = '';
  const res = new ServerResponse(req);
  res.useChunkedEncodingByDefault = false;
  res.assignSocket(new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } }));
  const finished = new Promise((resolve) => res.once('finish', resolve));
  await app(req, res);
  await finished;
  return { status: res.statusCode, headers: res.getHeaders(), body: output.slice(output.indexOf('\r\n\r\n') + 4) };
}

function fixture(t, { handler } = {}) {
  const dataDir = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-08T12:00:00Z');
  initDataDir(dataDir, { home, env: {}, clock });
  const options = { dataDir, home, env: {}, clock };
  const open = () => openContext({ mode: 'read', ...options });
  let writeCalls = 0;
  const openWrite = () => {
    writeCalls += 1;
    return openContext({ mode: 'write', ...options, actor: 'web:owner' });
  };
  const cards = createCards({ key, port, open, openWrite });
  const settings = createSettings({ key, port, open, openWrite });
  const writes = createWrites({ key, port, routes: [...settings.routes, ...cards.routes] });
  const app = createApp({ root: repo, guard: createGuard({ key, port, instance, writable: writes.writable }),
    writes: writes.handle, handler: handler ?? ((req, res, next) => next()),
    locals: { cards, settings, cairn: createRead({ open, render: async () => ({ html: '' }) }) } });
  const column = open().config.columns[1].key;
  const post = (fields = {}, { cookie = mintCookie(key, port), form = 'card', token } = {}) => {
    const values = { title: 'Prepare the reading list', column, project: '', priority: '', ...fields };
    const present = Object.entries(values).filter(([, value]) => value !== undefined);
    return call(app, { method: 'POST', path: '/cards',
      body: new URLSearchParams({ csrf: token ?? csrfToken(key, port, cookie, form),
        ...Object.fromEntries(present) }).toString(),
      headers: { origin: `http://${site}`, 'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded', cookie: `${cookieName(port)}=${cookie}` } });
  };
  const stored = () => readdirSync(dataDir, { recursive: true }).filter((path) => path.endsWith('.md')).sort()
    .map((path) => [path, readFileSync(join(dataDir, path), 'utf8')]);
  return { dataDir, open, openWrite, cards, app, column, post, stored, writeCalls: () => writeCalls };
}

test('a valid card add appends in the selected column and records web:owner', async (t) => {
  const f = fixture(t);
  const first = addCard(f.openWrite(), { title: 'Choose books', column: f.column });
  const selected = project.create(f.openWrite(), { title: 'Reading garden' });
  const response = await f.post({ title: '  Prepare the reading list  ',
    project: 'Reading garden', priority: 'urgent' });
  assert.equal(response.status, 303);
  const cards = listCards(f.open(), { column: f.column, includeDone: true });
  assert.equal(cards.length, 2);
  assert.equal(cards[0].id, first.entity.id);
  const card = cards[1];
  assert.equal(response.headers.location, `/board#card-${card.id}`);
  assert.equal(card.title, 'Prepare the reading list');
  assert.equal(card.data.column, f.column);
  assert.equal(card.data.project, selected.entity.id);
  assert.equal(card.data.priority, 'urgent');
  assert.ok(existsSync(join(f.dataDir, card.path)));
  const event = readEvents(f.open()).at(-1);
  assert.equal(event.op, 'card.create');
  assert.equal(event.actor, 'web:owner');
});

test('empty or omitted optional fields are not stored; boundary titles and all priorities are accepted', async (t) => {
  const f = fixture(t);
  for (const priority of ['', undefined, 'urgent', 'important', 'low']) {
    const response = await f.post({ title: 'x'.repeat(200), project: undefined, priority });
    assert.equal(response.status, 303);
    const card = listCards(f.open(), { column: f.column }).at(-1);
    assert.equal(card.data.project, undefined);
    assert.equal(card.data.priority, priority || undefined);
  }
});

test('invalid card fields return 400 without opening a write context or changing content or events', async (t) => {
  const f = fixture(t);
  const before = f.stored(), events = readEvents(f.open());
  const cases = [
    { title: '' }, { title: '  ' }, { title: undefined }, { title: 'x'.repeat(201) },
    { title: 'First\nSecond' }, { title: 'First\rSecond' }, { title: 'Trailing line\n' },
    { title: 'First\u2028Second' }, { title: 'First\u2029Second' }, { title: 'First\tSecond' },
    { title: 'First\u0085Second' }, { title: '\u200B' }, { title: 'Hid\u200Bden' }, { title: 'Right\u202Eleft' },
    { title: 'Bell\u0007' }, { title: 'Soft\u00ADhyphen' },
    { column: undefined }, { column: '' }, { column: 'missing-column' }, { column: '__proto__' },
    { project: 'missing-project' }, { priority: 'high' }, { extra: 'value' },
  ];
  for (const fields of cases) {
    const response = await f.post(fields);
    assert.equal(response.status, 400, JSON.stringify(fields));
    assert.match(response.body, /href="\/board"/u);
  }
  assert.equal(f.writeCalls(), 0);
  assert.deepEqual(f.stored(), before);
  assert.deepEqual(readEvents(f.open()), events);
});

test('a settings token or another session token cannot create a card', async (t) => {
  const f = fixture(t);
  const before = f.stored();
  assert.equal((await f.post({}, { form: 'settings' })).status, 403);
  const cookie = mintCookie(key, port), other = mintCookie(key, port);
  const token = f.cards.view(`${cookieName(port)}=${cookie}`).csrf;
  assert.equal((await f.post({}, { cookie: other, token })).status, 403);
  assert.equal(verifyCsrf(key, port, other, token, 'card'), false);
  assert.equal(verifyCsrf(key, port, cookie, token, 'card'), true);
  assert.equal(f.cards.view(null).csrf, '');
  assert.equal(f.writeCalls(), 0);
  assert.deepEqual(f.stored(), before);
  assert.deepEqual(readEvents(f.open()), []);
});

test('the guard still decides who may post a card: session, origin, fetch site and the exact target', async (t) => {
  const f = fixture(t);
  const cookie = mintCookie(key, port);
  const body = new URLSearchParams({ csrf: csrfToken(key, port, cookie, 'card'), title: 'A', column: f.column })
    .toString();
  const good = { origin: `http://${site}`, 'sec-fetch-site': 'same-origin',
    'content-type': 'application/x-www-form-urlencoded', cookie: `${cookieName(port)}=${cookie}` };
  const cases = [
    ['no session', '/cards', { ...good, cookie: undefined }, 401],
    ['no Origin', '/cards', { ...good, origin: undefined }, 403],
    ['another Origin', '/cards', { ...good, origin: 'http://evil.test' }, 403],
    ['cross-site fetch', '/cards', { ...good, 'sec-fetch-site': 'cross-site' }, 403],
    ['a query string', '/cards?x=1', good, 405],
    ['a trailing slash', '/cards/', good, 405],
  ];
  for (const [name, path, all, status] of cases) {
    const headers = Object.fromEntries(Object.entries(all).filter(([, value]) => value !== undefined));
    assert.equal((await call(f.app, { method: 'POST', path, headers, body })).status, status, name);
  }
  assert.equal(f.writeCalls(), 0);
  assert.equal((await call(f.app, { method: 'POST', path: '/cards', headers: good, body })).status, 303);
});

test('a data folder that is not ready answers 409 on the form data and the write, not a field error', async (t) => {
  const dataDir = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-08T12:00:00Z');
  const open = () => openContext({ mode: 'read', dataDir, home, env: {}, clock });
  const cards = createCards({ key, port, open, openWrite: () => assert.fail('nothing may be written') });
  const cookie = mintCookie(key, port);
  const view = cards.view(`${cookieName(port)}=${cookie}`);
  assert.equal(view.state, 'notReady');
  assert.equal(view.columns, undefined);
  const result = cards.routes[0].run({ values: { title: 'A', column: 'todo' }, params: {} });
  assert.deepEqual([result.status, result.title], [409, 'state.notReadyTitle']);
});

test('the form lists projects without a status and the write accepts the id the form sends', async (t) => {
  const f = fixture(t);
  const plain = project.create(f.openWrite(), { title: 'Reading garden' });
  const file = join(f.dataDir, plain.entity.path);
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^status: .*\n/mu, ''));
  const paused = project.create(f.openWrite(), { title: 'Winter drawings', status: 'paused' });
  const view = f.cards.view(null);
  assert.equal(view.state, 'ready');
  assert.deepEqual(view.projects.map((item) => item.id), [plain.entity.id]);
  assert.ok(!view.projects.some((item) => item.id === paused.entity.id));
  assert.equal((await f.post({ project: plain.entity.id })).status, 303);
  assert.equal(listCards(f.open(), { column: f.column }).at(-1).data.project, plain.entity.id);
});

test('the built card form has its session token, selected column and active projects; board links have anchors',
  async (t) => {
    if (!built) return t.skip('Astro output missing; run npm run build:app to enable integration coverage.');
    const { handler } = await import('../dist/app/server/entry.mjs');
    const f = fixture(t, { handler });
    const active = project.create(f.openWrite(), { title: 'Reading garden' });
    const paused = project.create(f.openWrite(), { title: 'Winter drawings', status: 'paused' });
    const archived = project.create(f.openWrite(), { title: 'Old sketches', status: 'archived' });
    const cookie = mintCookie(key, port);
    const headers = { cookie: `${cookieName(port)}=${cookie}` };
    const page = await call(f.app, { path: `/cards/new?column=${f.column}`, headers });
    assert.equal(page.status, 200);
    assert.equal(page.headers['referrer-policy'], 'same-origin');
    assert.match(page.body, /<meta name="referrer" content="same-origin"/u);
    assert.match(page.body, /<form class="card-form" method="post" action="\/cards"/u);
    assert.match(page.body, /name="title"[^>]*required[^>]*maxlength="200"/u);
    const token = page.body.match(/name="csrf" value="([^"]+)"/u)?.[1];
    assert.ok(verifyCsrf(key, port, cookie, token, 'card'));
    assert.equal(verifyCsrf(key, port, cookie, token, 'settings'), false);
    assert.ok(page.body.includes(`value="${f.column}" selected`));
    assert.ok(page.body.includes(`value="${active.entity.id}"`));
    assert.ok(!page.body.includes(paused.entity.id));
    assert.ok(!page.body.includes(archived.entity.id));
    const other = mintCookie(key, port);
    const otherPage = await call(f.app, { path: '/cards/new?column=unknown',
      headers: { cookie: `${cookieName(port)}=${other}` } });
    assert.ok(otherPage.body.includes(`value="${f.open().config.columns[0].key}" selected`));
    const otherToken = otherPage.body.match(/name="csrf" value="([^"]+)"/u)?.[1];
    assert.ok(verifyCsrf(key, port, other, otherToken, 'card'));
    assert.notEqual(otherToken, token);
    const added = await f.post();
    const board = await call(f.app, { path: '/board', headers });
    assert.equal(board.status, 200);
    assert.ok(board.body.includes(`id="${added.headers.location.split('#')[1]}"`));
    for (const column of f.open().config.columns) {
      assert.ok(board.body.includes(`href="/cards/new?column=${encodeURIComponent(column.key)}"`));
    }
  });
