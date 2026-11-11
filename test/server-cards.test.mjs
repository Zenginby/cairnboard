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
import { renderMarkdown } from '../core/render.mjs';
import { acceptanceItems } from '../core/frontmatter.mjs';
import { cardControls } from '../server/card-controls.mjs';
import { CairnError } from '../core/errors.mjs';
import { resolve, update } from '../core/entity.mjs';
import { addCard, claimCard, listCards } from '../core/card.mjs';
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
  let writeCalls = 0, writeError;
  const openWrite = () => {
    writeCalls += 1;
    if (writeError) throw writeError;
    return openContext({ mode: 'write', ...options, actor: 'web:owner' });
  };
  const cards = createCards({ key, port, open, openWrite });
  const settings = createSettings({ key, port, open, openWrite });
  const writes = createWrites({ key, port, routes: [...settings.routes, ...cards.routes] });
  const app = createApp({ root: repo, guard: createGuard({ key, port, instance, writable: writes.writable }),
    writes: writes.handle, handler: handler ?? ((req, res, next) => next()),
    locals: { cards, settings, cairn: createRead({ open, render: async (body) => renderMarkdown(body) }) } });
  const column = open().config.columns[1].key;
  const post = (fields = {}, { cookie = mintCookie(key, port), form = 'card', token, path = '/cards' } = {}) => {
    const values = path === '/cards'
      ? { title: 'Prepare the reading list', column, project: '', priority: '', ...fields } : fields;
    const present = Object.entries(values).filter(([, value]) => value !== undefined);
    return call(app, { method: 'POST', path,
      body: new URLSearchParams({ csrf: token ?? csrfToken(key, port, cookie, form),
        ...Object.fromEntries(present) }).toString(),
      headers: { origin: `http://${site}`, 'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded', cookie: `${cookieName(port)}=${cookie}` } });
  };
  const stored = () => readdirSync(dataDir, { recursive: true }).filter((path) => path.endsWith('.md')).sort()
    .map((path) => [path, readFileSync(join(dataDir, path), 'utf8')]);
  return { dataDir, options, open, openWrite, cards, app, column, post, stored, writeCalls: () => writeCalls,
    failWrites: (error) => { writeError = error; } };
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

function actionFixture(t, options) {
  const f = fixture(t, options);
  const body = '# Plan\n\n## Acceptance\n\n- [ ] Choose books\n- [x] Read the list\n\n## Comments\n\n- Earlier note\n';
  const added = addCard(f.openWrite(), { title: 'Reading plan', column: f.column }, body);
  const id = added.entity.id;
  const current = () => resolve(f.open(), 'card', id);
  const edit = () => ({ title: 'Revised plan', project: '', priority: '', body, revision: current().revision });
  const send = (suffix, fields, options = {}) => f.post(fields, { path: `/cards/${id}${suffix}`, ...options });
  // What the page's check form sends for item `n`: its number, the wanted state and the mark of its text.
  const check = (n, checked) => ({ n: String(n), checked, mark: f.cards.view(null, id).items[n - 1].mark });
  return { ...f, id, body, current, edit, send, check };
}

test('editing saves mapped fields and the complete Markdown, clears empty options and records web:owner', async (t) => {
  const f = actionFixture(t);
  const selected = project.create(f.openWrite(), { title: 'Reading garden' });
  const body = `# Changed\n\n${'Some text\n'.repeat(8000)}\u200b\n`;
  const response = await f.send('', { ...f.edit(), title: '  Revised plan  ',
    priority: 'important', project: 'Reading garden', body });
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, `/cards/${f.id}`);
  assert.equal(f.current().title, 'Revised plan');
  assert.equal(f.current().data.project, selected.entity.id);
  assert.equal(f.current().data.priority, 'important');
  assert.equal(f.current().body, body, 'no truncation or hidden-character stripping in the body');
  assert.equal(readEvents(f.open()).at(-1).op, 'card.update');
  assert.equal(readEvents(f.open()).at(-1).actor, 'web:owner');
  assert.equal((await f.send('', { ...f.edit(), body: '' })).status, 303);
  assert.equal(f.current().body, '');
  assert.equal(f.current().data.priority, undefined);
  assert.equal(f.current().data.project, undefined);
});

test('moving appends to the target column; checking and commenting preserve the other content', async (t) => {
  const f = actionFixture(t);
  const column = f.open().config.columns[0].key;
  const first = addCard(f.openWrite(), { title: 'Earlier card', column });
  for (const [suffix, fields, op] of [
    ['/move', { column }, 'card.move'],
    ['/check', f.check(1, 'on'), 'card.check'],
    ['/check', f.check(2, 'off'), 'card.check'],
    ['/comment', { text: '  Another thought\nwith a second line  ' }, 'card.comment'],
  ]) {
    const response = await f.send(suffix, fields);
    assert.equal(response.status, 303);
    assert.equal(response.headers.location, `/cards/${f.id}${suffix === '/comment' ? '#comments' : ''}`);
    assert.equal(readEvents(f.open()).at(-1).op, op);
    assert.equal(readEvents(f.open()).at(-1).actor, 'web:owner');
  }
  assert.deepEqual(listCards(f.open(), { column, includeDone: true }).map((card) => card.id), [first.entity.id, f.id]);
  assert.equal(f.current().body, f.body.replace('- [ ] Choose', '- [x] Choose').replace('- [x] Read', '- [ ] Read')
    + '- 2026-11-08T12:00:00.000Z owner: Another thought with a second line\n');
});

test('all action fields are strict and invalid requests do not open a write context or change files or events',
  async (t) => {
    const f = actionFixture(t);
    const edit = f.edit();
    const actions = [
      ['', edit, [
        { title: '' }, { title: ' ' }, { title: 'x'.repeat(201) }, { title: 'New\nline' },
        { title: 'Hidden\u200btitle' }, { title: 'New\tline' }, { title: 'New\rline' },
        { title: 'Soft\u00adhyphen' }, { title: 'Bell\u0007' }, { title: 'Right\u202eleft' },
        { title: 'New\u0085line' }, { title: 'New\u2028line' }, { title: 'New\u2029line' },
        { priority: 'high' }, { project: 'missing-project' }, { revision: '' }, { revision: 'f'.repeat(15) },
        { revision: 'z'.repeat(16) }, { body: 'x'.repeat(5 * 1024 * 1024 + 1) },
      ]],
      ['/move', { column: f.column }, [{ column: '' }, { column: 'missing' }, { column: '__proto__' }]],
      ['/check', f.check(1, 'on'), [
        { n: '0' }, { n: '-1' }, { n: '1.5' }, { n: '01' }, { n: '1e0' }, { n: ' 1' },
        { n: '9007199254740992' }, { mark: '' }, { mark: 'z'.repeat(16) }, { mark: 'A'.repeat(16) },
        { checked: '' }, { checked: 'yes' },
      ]],
      ['/comment', { text: 'A thought' }, [{ text: '' }, { text: ' \n ' }, { text: 'x'.repeat(2001) }]],
    ];
    const before = f.stored(), events = readEvents(f.open()), writes = f.writeCalls();
    for (const [suffix, valid, invalid] of actions) {
      const missing = Object.keys(valid).map((field) => ({ [field]: undefined }));
      for (const fields of [...invalid, ...missing, { extra: 'unexpected' }]) {
        const response = await f.send(suffix, { ...valid, ...fields });
        assert.equal(response.status, 400, `${suffix}: ${Object.keys(fields)}`);
        assert.ok(response.body.includes(`href="/cards/${f.id}"`));
        assert.ok(!response.body.includes('card.invalid'), 'the card-specific message is translated');
      }
    }
    assert.equal(f.writeCalls(), writes);
    assert.deepEqual(f.stored(), before);
    assert.deepEqual(readEvents(f.open()), events);
  });

test('the CRLF line breaks a browser submits do not change the line endings of the file', async (t) => {
  const f = actionFixture(t), crlf = (text) => text.replaceAll('\n', '\r\n');
  assert.equal((await f.send('', { ...f.edit(), body: crlf(f.body) })).status, 303);
  assert.equal(f.current().body, f.body, 'an unchanged form leaves an LF body as it was');
  const file = join(f.dataDir, f.current().path);
  writeFileSync(file, crlf(readFileSync(file, 'utf8')));
  for (const body of [f.body, crlf(f.body)]) {
    assert.equal((await f.send('', { ...f.edit(), body })).status, 303);
    assert.equal(f.current().body, crlf(f.body), 'a CRLF file stays CRLF');
  }
  const text = crlf(`${'a'.repeat(999)}\n${'b'.repeat(1000)}`);
  assert.equal((await f.send('/comment', { text })).status, 303, 'a line break counts once, as in the form');
  assert.equal((await f.send('/comment', { text: `${text}c` })).status, 400);
});

test('a card held by an agent answers 409 with its own page for edit, move and check; comments still work',
  async (t) => {
    const f = actionFixture(t);
    claimCard(openContext({ mode: 'write', ...f.options, actor: 'agent:reader' }), f.id);
    const before = f.stored(), events = readEvents(f.open());
    const column = f.open().config.columns[0].key;
    for (const [suffix, fields] of [['', f.edit()], ['/move', { column }], ['/check', f.check(1, 'on')]]) {
      const response = await f.send(suffix, fields);
      assert.equal(response.status, 409, suffix);
      assert.match(response.body, /Kart bir ajanda/u);
      assert.ok(response.body.includes(`href="/cards/${f.id}"`));
    }
    assert.deepEqual(f.stored(), before);
    assert.deepEqual(readEvents(f.open()), events);
    assert.equal((await f.send('/comment', { text: 'Please also read the appendix.' })).status, 303);
  });

test('stale edits answer 409 with a card warning and leave files and events unchanged', async (t) => {
  const f = actionFixture(t), stale = f.edit();
  update(f.openWrite(), 'card', f.id, { title: 'Changed elsewhere' });
  const before = f.stored(), events = readEvents(f.open());
  const response = await f.send('', stale);
  assert.equal(response.status, 409);
  assert.match(response.body, /Kart başka yerde değişti/u);
  assert.ok(response.body.includes(`href="/cards/${f.id}"`));
  assert.deepEqual(f.stored(), before);
  assert.deepEqual(readEvents(f.open()), events);
});

test('every action handles missing cards, wrong-form tokens, exact targets, conflicts and locked writes', async (t) => {
  const f = actionFixture(t);
  for (const [suffix, fields] of [
    ['', f.edit()], ['/move', { column: f.column }],
    ['/check', f.check(1, 'on')], ['/comment', { text: 'A thought' }],
  ]) {
    f.failWrites(undefined);
    const before = f.stored(), events = readEvents(f.open()), writes = f.writeCalls();
    assert.equal((await f.send(suffix, fields, { path: `/cards/c-000000${suffix}` })).status, 404);
    const forbidden = await f.send(suffix, fields, { form: 'settings' });
    assert.equal(forbidden.status, 403);
    assert.ok(forbidden.body.includes(`href="/cards/${f.id}"`), 'even pre-run refusals link to this card');
    assert.equal((await f.send(suffix, fields, { path: `/cards/${f.id}${suffix}?x=1` })).status, 405);
    assert.equal(f.writeCalls(), writes);
    for (const [code, status] of [['conflict', 409], ['locked', 503], ['duplicate_id', 409],
      ['unsupported_frontmatter', 409]]) {
      f.failWrites(new CairnError(code, 'Test refusal.'));
      const response = await f.send(suffix, fields);
      assert.equal(response.status, status);
      if (code === 'conflict') assert.match(response.body, /Kart başka yerde değişti/u);
      if (code === 'locked') assert.equal(response.headers['retry-after'], '1');
      if (status === 409 && code !== 'conflict') assert.match(response.body, /Kart dosyası onarım istiyor/u);
    }
    assert.deepEqual(f.stored(), before);
    assert.deepEqual(readEvents(f.open()), events);
  }
});

test('all actions refuse an uninitialised data folder before opening a write context', (t) => {
  const dataDir = tempDir(t), home = tempDir(t);
  const cards = createCards({ key, port,
    open: () => openContext({ mode: 'read', dataDir, home, env: {}, clock: fixedClock('2026-11-08T12:00:00Z') }),
    openWrite: () => assert.fail('nothing may be written') });
  const values = [
    { title: 'Reading plan', project: '', priority: '', body: '', revision: 'a'.repeat(16) },
    { column: 'todo' }, { n: '1', checked: 'on', mark: 'a'.repeat(16) }, { text: 'A thought' },
  ];
  for (const [index, route] of cards.routes.slice(1).entries()) {
    const response = route.run({ values: values[index], params: { id: 'c-000000' } });
    assert.deepEqual([response.status, response.message], [409, 'card.notReady']);
  }
});

const buttons = /<button class="card-check"[^]*?<\/button>/gu;
const items = (body) => acceptanceItems(body);

test('acceptance controls preserve renderer labels and leave other Markdown checkboxes read-only', () => {
  const body = '- [ ] Outside\n\n## Acceptance\n\n- [ ] **Choose** > <tag> & "books"\n  - [x] Nested\n\n'
    + '```md\n- [ ] Code task\n```\n\n- [ ]\n\n## Other\n\n- [ ] Outside again\n';
  const rendered = renderMarkdown(body).html;
  const controls = cardControls(rendered, items(body));
  assert.deepEqual([...controls.wired], [1, 2]);
  assert.equal((controls.html.match(buttons) ?? []).length, 2);
  for (const label of rendered.match(/aria-label="[^"]*"/gu).slice(1, 3)) {
    assert.ok(controls.html.includes(label));
  }
  assert.match(controls.html, /form="card-check-1" role="checkbox" aria-checked="false"/u);
  assert.match(controls.html, /form="card-check-2" role="checkbox" aria-checked="true"/u);
  assert.equal((controls.html.match(/<input/gu) ?? []).length, 2);
  assert.deepEqual(cardControls(null, items(body)), { html: null, wired: new Set() });
  assert.equal(cardControls('<p>No checkboxes</p>', items(body)).html, '<p>No checkboxes</p>');
  assert.equal(cardControls(rendered, []).html, rendered);
});

test('acceptance controls change real checkbox tags only, whatever link titles and labels contain', () => {
  const body = "## Acceptance\n\n[l](http://a '<input aria-label=')\n\n- [ ] one > \\<meta http-equiv=refresh "
    + "content=0;url=https://example.org>\\<form method=post action=/cards/c-000000/check>\n- [ ] two\n\n"
    + "[m](http://b '<input type=\"checkbox\" data-acceptance=\"2\" aria-label=\"x\">')\n";
  const rendered = renderMarkdown(body).html;
  const tags = rendered.match(/<input type="checkbox" disabled aria-label="[^"]*" data-acceptance="\d+">/gu);
  assert.equal(tags.length, 2);
  const controls = cardControls(rendered, items(body));
  assert.deepEqual([...controls.wired], [1, 2]);
  // Everything outside the two tags is byte for byte what the sanitizer produced.
  assert.equal(controls.html.replace(buttons, '<box>'),
    tags.reduce((html, tag) => html.replace(tag, '<box>'), rendered));
  assert.doesNotMatch(controls.html.replace(/"[^"]*"/gu, '""'), /<meta|<form/u, 'nothing leaves its attribute');
});

test('acceptance controls follow the items the core counts, with hidden characters and stray line breaks', () => {
  const stray = '## Acceptance\n\ntext\rmore\n- [ ] a\n- [x] b\n';
  const first = cardControls(renderMarkdown(stray).html, items(stray));
  assert.match(first.html, /form="card-check-1" role="checkbox" aria-checked="false" aria-label="a"/u);
  assert.match(first.html, /form="card-check-2" role="checkbox" aria-checked="true" aria-label="b"/u);
  const hidden = '## Acceptance\n\n- [ ] ​\n- [ ] B\n- [​ ] C\n';
  assert.deepEqual(items(hidden).map((item) => item.text), ['​', 'B']);
  const second = cardControls(renderMarkdown(hidden).html, items(hidden));
  assert.deepEqual([...second.wired], [2], 'the invisible item gets a labelled button below the body instead');
  assert.match(second.html, /form="card-check-2" role="checkbox" aria-checked="false" aria-label="B"/u);
  assert.match(second.html, /<input type="checkbox" disabled aria-label="C">/u, 'not an item for the core');
  // A forged number, a repeated number and a box without a name are left alone.
  const forged = '<input type="checkbox" disabled aria-label="x" data-acceptance="9">'
    + '<input type="checkbox" disabled aria-label="" data-acceptance="1">'
    + '<input type="checkbox" disabled aria-label="y" data-acceptance="2">'
    + '<input type="checkbox" disabled aria-label="z" data-acceptance="2">';
  const third = cardControls(forged, [{ checked: false }, { checked: false }]);
  assert.deepEqual([...third.wired], [2]);
  assert.equal((third.html.match(/<input/gu) ?? []).length, 3);
});

test('acceptance controls stay fast on a body full of look-alike tags', () => {
  const body = `## Acceptance\n\n- [ ] one\n\n${"[l](/a '<input x') ".repeat(8000)}\n`;
  const rendered = renderMarkdown(body).html;
  const start = performance.now();
  const controls = cardControls(rendered, items(body));
  assert.ok(performance.now() - start < 250, 'one linear pass over the HTML');
  assert.deepEqual([...controls.wired], [1]);
});

test('a check names the item the owner saw: a changed list answers 409, an item already as asked is not rewritten',
  async (t) => {
    const f = actionFixture(t), second = f.check(2, 'off'), first = f.check(1, 'on');
    const longer = f.body.replace('- [ ] Choose', '- [ ] Added above\n- [ ] Choose');
    update(f.openWrite(), 'card', f.id, {}, { body: longer });
    const before = f.stored(), events = readEvents(f.open()), writes = f.writeCalls();
    for (const stale of [second, first, { ...second, n: '4' }]) {
      const response = await f.send('/check', stale);
      assert.equal(response.status, 409, JSON.stringify(stale));
      assert.match(response.body, /Kart başka yerde değişti/u);
    }
    assert.equal((await f.send('/check', f.check(3, 'on'))).status, 303, 'already ticked');
    assert.equal((await f.send('/check', f.check(1, 'off'))).status, 303, 'already open');
    assert.equal(f.writeCalls(), writes);
    assert.deepEqual(f.stored(), before);
    assert.deepEqual(readEvents(f.open()), events);
    assert.equal((await f.send('/check', f.check(2, 'on'))).status, 303);
    assert.match(f.current().body, /- \[ \] Added above\n- \[x\] Choose books\n- \[x\] Read the list/u);
  });

test('saving writes only what the owner changed: heading titles, odd priorities and lost projects stay', async (t) => {
  const f = actionFixture(t);
  const file = join(f.dataDir, f.current().path);
  const rewrite = (change) => writeFileSync(file, change(readFileSync(file, 'utf8')));
  const same = () => ({ ...f.edit(), title: f.current().title });
  const writes = f.writeCalls(), events = readEvents(f.open());
  assert.equal((await f.send('', same())).status, 303);
  assert.equal(f.writeCalls(), writes, 'a form sent back unchanged writes nothing');
  assert.deepEqual(readEvents(f.open()), events);
  rewrite((text) => text.replace(/^title: .*\n/mu, '').replace(/^---\n/u, '---\nproject: p-zzzzzz\n'));
  assert.equal(f.current().title, 'Plan', 'the title now comes from the heading');
  const body = `${f.body}\nA new paragraph.\n`;
  assert.equal((await f.send('', { ...same(), project: 'p-zzzzzz', body })).status, 303);
  assert.equal(f.current().body, body);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /^title:/mu, 'no title field appears for an untouched title');
  assert.equal(f.current().data.project, 'p-zzzzzz', 'a project that no longer resolves is kept');
  assert.equal((await f.send('', { ...same(), project: 'p-yyyyyy', body })).status, 400, 'but cannot be chosen');
  rewrite((text) => text.replace(/^---\n/u, '---\npriority: high\n'));
  const view = f.cards.view(null, f.id);
  assert.deepEqual([view.priority, view.project], ['high', 'p-zzzzzz']);
  const kept = readFileSync(file, 'utf8');
  const response = await f.send('', { ...same(), project: 'p-zzzzzz', priority: 'high', body: `${body}More.\n` });
  assert.equal(response.status, 400, 'the core refuses to save over a priority it does not know');
  assert.equal(readFileSync(file, 'utf8'), kept, 'and the odd value is not silently dropped');
  assert.equal((await f.send('', { ...same(), project: '', priority: 'low', body })).status, 303);
  assert.deepEqual([f.current().data.priority, f.current().data.project], ['low', undefined]);
});

test('built card pages show token-bound actions and the edit form preserves the full raw body', async (t) => {
  if (!built) return t.skip('Astro output missing; run npm run build:app to enable integration coverage.');
  const { handler } = await import('../dist/app/server/entry.mjs');
  const f = actionFixture(t, { handler });
  const selected = project.create(f.openWrite(), { title: 'Reading garden', status: 'paused' });
  const body = f.body + '\n' + 'Body & <text>\u200b\n'.repeat(6000);
  update(f.openWrite(), 'card', f.id, { priority: 'urgent', project: selected.entity.id }, { body });
  const cookie = mintCookie(key, port), headers = { cookie: `${cookieName(port)}=${cookie}` };
  const token = csrfToken(key, port, cookie, 'card');
  const page = await call(f.app, { path: `/cards/${f.id}`, headers });
  assert.equal(page.status, 200);
  assert.equal(page.headers['referrer-policy'], 'same-origin');
  assert.ok(page.body.includes(`href="/cards/${f.id}/edit"`));
  for (const suffix of ['/move', '/check', '/comment']) {
    assert.ok(page.body.includes(`action="/cards/${f.id}${suffix}"`));
  }
  assert.ok(page.body.includes('id="comments"'));
  assert.equal((page.body.match(/name="mark" value="[0-9a-f]{16}"/gu) ?? []).length, 2);
  assert.match(page.body, /role="checkbox" aria-checked="false" aria-label="Choose books"/u);
  assert.match(page.body, /role="checkbox" aria-checked="true" aria-label="Read the list"/u);
  assert.equal((page.body.match(/name="csrf" value="([^"]+)"/gu) ?? []).length, 4);
  assert.ok([...page.body.matchAll(/name="csrf" value="([^"]+)"/gu)].every((match) => match[1] === token));
  assert.match(page.body, /data-live="card project board"/u);
  const edit = await call(f.app, { path: `/cards/${f.id}/edit`, headers });
  assert.equal(edit.status, 200);
  assert.equal(edit.headers['referrer-policy'], 'same-origin');
  assert.ok(edit.body.includes(`name="csrf" value="${token}"`));
  assert.ok(edit.body.includes(`name="revision" value="${f.current().revision}"`));
  assert.match(edit.body, /name="title"[^>]*value="Reading plan"/u);
  assert.ok(edit.body.includes(`value="${selected.entity.id}" selected`), 'the current paused project stays selected');
  assert.ok(edit.body.includes('value="urgent" selected'));
  const escaped = body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  assert.ok(edit.body.includes(`rows="20">\n${escaped}</textarea>`),
    'the parser drops one line break after the tag, so the page adds one and the body keeps its own first line');
  const missing = await call(f.app, { path: '/cards/c-000000/edit', headers });
  assert.equal(missing.status, 404);
  const path = f.current().path, file = join(f.dataDir, path);
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^id: .*\n/mu, ''));
  assert.equal(f.cards.view(null, `@${path}`).state, 'notFound');
});
