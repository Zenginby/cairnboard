import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.mjs';
import { createGuard } from '../server/guard.mjs';
import { createSettings } from '../server/settings.mjs';
import { createWrites } from '../server/writes.mjs';
import { cookieName, csrfToken, mintCookie, siteHost } from '../server/session.mjs';
import { openContext } from '../core/context.mjs';
import { initDataDir } from '../core/roots.mjs';
import { readEvents } from '../core/events.mjs';
import { CairnError } from '../core/errors.mjs';
import { loadConfig } from '../core/config.mjs';
import { readSettings } from '../core/settings.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import tr from '../src/i18n/tr.json' with { type: 'json' };
// The pages are asserted in Turkish, the way the server sets the language at start.
process.env.CAIRN_LANGUAGE = 'tr';

const repo = fileURLToPath(new URL('../', import.meta.url));
const port = 4331, key = Buffer.alloc(32, 7), instance = 'run-bbbbbbbbbbbbbbbb';
const site = `${siteHost(key)}:${port}`;
const escape = (text) => String(text).replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);
const column = (name, action) => `/settings/board/columns/${name}/${action}`;
const LEASE = '/settings/board/lease';
const SAVED = '/settings?saved=board#settings-board';

async function call(app, { method = 'GET', path = '/', headers = {}, body, length = true }) {
  const req = new IncomingMessage(new Socket());
  const data = body === undefined ? undefined : Buffer.from(body);
  // An undefined value removes the header, so a test can send a request that lacks one.
  const all = { host: site, ...headers, ...(data && length ? { 'content-length': String(data.length) } : {}) };
  const present = Object.entries(all).filter(([, value]) => value !== undefined);
  Object.assign(req, { url: path, method, headers: Object.fromEntries(present) });
  if (data) req.push(data);
  req.push(null);
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

function fixture(t) {
  const dataDir = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-08T12:00:00Z');
  initDataDir(dataDir, { home, env: {}, clock });
  const options = { dataDir, home, env: {}, clock };
  const open = () => openContext({ mode: 'read', ...options });
  // Another actor on the context, so the events prove each route names the web owner itself.
  const openWrite = () => openContext({ mode: 'write', ...options, actor: 'cli:owner' });
  let time = 1_900_000_000_000;
  t.after(() => { process.env.CAIRN_LANGUAGE = 'tr'; });
  const settings = createSettings({ key, port, open, openWrite, now: () => time, switchLanguage: () => {} });
  // The server's write table, as in server/start.mjs.
  const { writable } = createWrites({ key, port, routes: settings.routes });
  const app = createApp({ root: repo, guard: createGuard({ port, key, instance, writable }), writes: settings.handle,
    handler: (req, res, next) => next(), locals: { settings } });
  const configFile = join(dataDir, '.cairn/config.json');
  const cookie = mintCookie(key, port);
  const revision = () => readSettings(open(), { stats: false }).revision;
  const stored = () => readFileSync(configFile, 'utf8');
  /**
   * A fully valid write to `path` with `fields` (a fresh revision unless given). Each call moves the clock a second
   * on, so the rate limit stays out of the way unless `tick: false`. `body` replaces the whole encoded body.
   */
  const send = (path, fields = {}, { token, headers = {}, body, tick = true, session = cookie, ...rest } = {}) => {
    if (tick) time += 1000;
    const fresh = Object.hasOwn(fields, 'revision') ? {} : { revision: revision() };
    const encoded = body ?? new URLSearchParams({ csrf: token ?? csrfToken(key, port, session), ...fresh,
      ...fields }).toString();
    return call(app, { method: 'POST', path, body: encoded, ...rest, headers: {
      origin: `http://${site}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded',
      cookie: `${cookieName(port)}=${session}`, ...headers } });
  };
  const events = () => readEvents(open());
  const columns = () => loadConfig(dataDir).columns;
  return { dataDir, open, openWrite, settings, app, configFile, cookie, revision, stored, send, events, columns,
    tick: (ms) => { time += ms; } };
}

/** The message page for a dictionary key, as `messagePage` escapes it. */
const message = (key) => `<p>${escape(tr[key])}</p>`;
const silent = (t) => t.mock.method(console, 'error', () => {});

test('every board route stores its value, redirects to the card and records the web owner', async (t) => {
  const f = fixture(t);
  const logged = silent(t);
  const steps = [
    [column('doing', 'label'), { label: '  In progress  ' }, ['columns.label']],
    [column('review', 'up'), {}, ['columns.order']],
    [column('doing', 'hidden'), { value: 'on' }, ['columns.hidden']],
    [column('backlog', 'down'), {}, ['columns.order']],
    [LEASE, { minutes: '45' }, ['leaseMinutes']],
  ];
  for (const [path, fields, changed] of steps) {
    const response = await f.send(path, fields);
    assert.equal(response.status, 303, path);
    assert.equal(response.headers.location, SAVED);
    const last = f.events().at(-1);
    assert.deepEqual([last.op, last.actor, last.fields], ['config.change', 'web:owner', changed], path);
    assert.equal(last.before, undefined);
    assert.equal(last.after, undefined);
    assert.equal(last.feature, undefined);
  }
  assert.deepEqual(f.columns().map(({ key: name, label, hidden }) => [name, label, hidden]), [
    ['review', 'Review', undefined], ['backlog', 'Backlog', undefined], ['doing', 'In progress', true],
    ['done', 'Done', undefined]]);
  assert.equal(loadConfig(f.dataDir).leaseMinutes, 45);
  assert.equal(f.events().length, 5);
  // Showing the column again removes the flag rather than storing false.
  assert.equal((await f.send(column('doing', 'hidden'), { value: 'off' })).status, 303);
  assert.equal(Object.hasOwn(f.columns()[2], 'hidden'), false);
  // The stored name, the lease and the language never appear in the log.
  const log = JSON.stringify(f.events());
  for (const value of ['In progress', '"45"', ':45', 'Review']) assert.equal(log.includes(value), false, value);
  assert.deepEqual(logged.mock.calls.map(({ arguments: [first] }) => String(first?.stack ?? first)), []);
});

test('saving an unchanged value redirects and writes nothing', async (t) => {
  const f = fixture(t);
  const before = f.stored();
  for (const [path, fields] of [[column('doing', 'label'), { label: 'Doing' }],
    [column('doing', 'label'), { label: ' Doing ' }], [column('review', 'hidden'), { value: 'off' }],
    [LEASE, { minutes: '120' }]]) {
    const response = await f.send(path, fields);
    assert.equal(response.status, 303, JSON.stringify(fields));
    assert.equal(response.headers.location, SAVED);
  }
  assert.equal(f.stored(), before);
  assert.deepEqual(f.events(), []);
});

test('board fields are exactly the listed ones; anything else is 400 and an old revision is 409', async (t) => {
  const f = fixture(t);
  const before = f.stored();
  const csrf = csrfToken(key, port, f.cookie);
  const bad = [
    [column('doing', 'label'), { label: 'X', extra: '1' }],
    [column('doing', 'label'), { name: 'X' }],
    [column('doing', 'label'), { label: 'X', value: 'on' }],
    [column('doing', 'label'), { label: 'x'.repeat(201) }],
    [column('doing', 'label'), { label: 'X', revision: 'abc' }],
    [column('doing', 'label'), { label: 'X', revision: 'A'.repeat(16) }],
    [column('review', 'hidden'), { value: 'yes' }],
    [column('review', 'hidden'), { value: 'true' }],
    [column('review', 'hidden'), { value: '' }],
    [column('review', 'hidden'), { value: 'on', label: 'X' }],
    [column('review', 'up'), { by: '-1' }],
    [column('review', 'down'), { value: 'on' }],
    [column('review', 'up'), { revision: '' }],
    [LEASE, { minutes: '45', extra: '1' }],
    [LEASE, { value: '45' }],
    [LEASE, { minutes: '45', revision: 'xyz' }],
  ];
  for (const [path, fields] of bad) {
    const response = await f.send(path, fields);
    assert.equal(response.status, 400, `${path} ${JSON.stringify(fields)}`);
    assert.ok(response.body.includes(message('write.badRequest')), `${path} ${JSON.stringify(fields)}`);
  }
  // Missing and repeated fields cannot be built with the helper's merge.
  const raw = (path, body) => f.send(path, {}, { body });
  const rev = f.revision();
  for (const [path, body] of [
    [column('doing', 'label'), `csrf=${csrf}&label=X`],
    [column('doing', 'label'), `csrf=${csrf}&revision=${rev}`],
    [column('doing', 'label'), `csrf=${csrf}&label=X&label=Y&revision=${rev}`],
    [column('review', 'hidden'), `csrf=${csrf}&revision=${rev}`],
    [column('review', 'hidden'), `csrf=${csrf}&value=on`],
    [column('review', 'up'), `csrf=${csrf}`],
    [column('review', 'up'), `csrf=${csrf}&revision=${rev}&revision=${rev}`],
    [LEASE, `csrf=${csrf}&revision=${rev}`],
    [LEASE, `csrf=${csrf}&minutes=45`],
    [LEASE, `csrf=${csrf}&minutes=45&minutes=50&revision=${rev}`],
  ]) assert.equal((await raw(path, body)).status, 400, `${path} ${body}`);
  // A stale revision is a conflict, for every route alike.
  const stale = '0123456789abcdef';
  for (const [path, fields] of [[column('doing', 'label'), { label: 'X' }],
    [column('review', 'hidden'), { value: 'on' }], [column('review', 'up'), {}], [column('review', 'down'), {}],
    [LEASE, { minutes: '45' }]]) {
    const response = await f.send(path, { ...fields, revision: stale });
    assert.equal(response.status, 409, path);
    assert.ok(response.body.includes(message('settings.conflict')));
    assert.match(response.body, /<a href="\/settings">/u);
  }
  assert.equal(f.stored(), before);
  assert.deepEqual(f.events(), []);
});

test('only the exact board targets accept POST; any other shape is 405', async (t) => {
  const f = fixture(t);
  const before = f.stored();
  const long = `a${'b'.repeat(64)}`;
  for (const path of [column('doing', 'rename'), column('doing', 'Label'), column('Doing', 'label'),
    column(long, 'label'), `${column('doing', 'label')}/`, `${column('doing', 'label')}?x=1`,
    column('', 'label'), column('1doing', 'up'), column('do_ing', 'up'), column('doing%2Fx', 'up'),
    '/settings/board/columns/doing', '/settings/board/columns', '/settings/board', `${LEASE}/`, `${LEASE}?minutes=5`,
    '/settings/board//lease', '/Settings/board/lease', '/settings/board/columns/doing/../review/up']) {
    const response = await f.send(path, { label: 'X' });
    assert.equal(response.status, 405, path);
  }
  // The longest key the pattern allows still reaches the core, which does not know it.
  assert.equal((await f.send(column(`a${'b'.repeat(63)}`, 'up'), {})).status, 400);
  // GET never writes.
  const headers = { cookie: `${cookieName(port)}=${f.cookie}` };
  assert.equal((await call(f.app, { path: `${LEASE}?minutes=45&revision=${f.revision()}`, headers })).status, 404);
  assert.equal(f.stored(), before);
});

test('the shared write guards hold on every board route', async (t) => {
  const f = fixture(t);
  const before = f.stored();
  const other = mintCookie(key, port);
  const routes = [[column('doing', 'label'), { label: 'Guarded' }], [column('review', 'hidden'), { value: 'on' }],
    [column('review', 'up'), {}], [column('review', 'down'), {}], [LEASE, { minutes: '45' }]];
  const cases = [
    ['no Origin', { headers: { origin: undefined } }, 403],
    ['another Origin', { headers: { origin: 'http://evil.test' } }, 403],
    ['Origin null', { headers: { origin: 'null' } }, 403],
    ['cross-site', { headers: { 'sec-fetch-site': 'cross-site' } }, 403],
    ['no cookie', { headers: { cookie: undefined } }, 401],
    ['no token', { token: '' }, 403],
    ["another session's token", { token: csrfToken(key, port, other) }, 403],
    ['a token for another form', { token: csrfToken(key, port, f.cookie, 'home-projects') }, 403],
    ['wrong content type', { headers: { 'content-type': 'application/json' } }, 415],
    ['no content type', { headers: { 'content-type': undefined } }, 415],
  ];
  for (const [path, fields] of routes) {
    for (const [label, options, status] of cases) {
      assert.equal((await f.send(path, fields, options)).status, status, `${path}: ${label}`);
    }
    const large = await f.send(path, fields, { body: `csrf=x&pad=${'x'.repeat(4096)}` });
    assert.equal(large.status, 413, `${path}: body over 4 KiB`);
    const chunked = await f.send(path, fields, { body: `pad=${'x'.repeat(4096)}`, length: false });
    assert.equal(chunked.status, 413, `${path}: counted while reading`);
  }
  assert.equal(f.stored(), before);
  assert.deepEqual(f.events(), []);
});

test('at most five writes per second per session, board routes included', async (t) => {
  const f = fixture(t);
  const paths = [column('review', 'hidden'), column('review', 'up'), LEASE, column('doing', 'label'),
    column('review', 'down')];
  // Five refused writes (bad fields) use the session's budget for this second.
  for (const path of paths) assert.equal((await f.send(path, { bad: '1' }, { tick: false })).status, 400, path);
  const sixth = await f.send(LEASE, { minutes: '45' }, { tick: false });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.headers['retry-after'], '1');
  assert.equal(loadConfig(f.dataDir).leaseMinutes, 120);
  assert.equal((await f.send(LEASE, { minutes: '45' })).status, 303, 'a second later it works');
});

test('the core refusal reasons map to their own messages, never echoing the submitted value', async (t) => {
  const f = fixture(t);
  const logged = silent(t);
  const marker = 'Zq<b>marker</b>';
  const cases = [
    [column('doing', 'label'), { label: '   ' }, 'settings.board.labelEmpty'],
    [column('doing', 'label'), { label: `${marker}${'x'.repeat(40)}` }, 'settings.board.labelLong'],
    [column('doing', 'label'), { label: `${marker}\tx` }, 'settings.board.labelChars'],
    [column('doing', 'label'), { label: `${marker}\nx` }, 'settings.board.labelChars'],
    [column('doing', 'label'), { label: `${marker}​x` }, 'settings.board.labelChars'],
    [column('doing', 'label'), { label: `${marker}‮x` }, 'settings.board.labelChars'],
    [column('doing', 'label'), { label: 'DONE' }, 'settings.board.labelDuplicate'],
    [column('doing', 'label'), { label: 'backlog' }, 'settings.board.labelDuplicate'],
    [column('backlog', 'hidden'), { value: 'on' }, 'settings.board.roleFirstHidden'],
    [column('doing', 'hidden'), { value: 'on' }, 'settings.board.roleFirstHidden'],
    [column('done', 'hidden'), { value: 'on' }, 'settings.board.roleFirstHidden'],
    [LEASE, { minutes: '4' }, 'settings.board.leaseRange'],
    [LEASE, { minutes: '1441' }, 'settings.board.leaseRange'],
    [LEASE, { minutes: '0' }, 'settings.board.leaseRange'],
    [LEASE, { minutes: '05' }, 'settings.board.leaseRange'],
    [LEASE, { minutes: '12345' }, 'settings.board.leaseRange'],
    [LEASE, { minutes: '1.5' }, 'settings.board.leaseRange'],
    [LEASE, { minutes: '-5' }, 'settings.board.leaseRange'],
    [LEASE, { minutes: '' }, 'settings.board.leaseRange'],
    [LEASE, { minutes: marker }, 'settings.board.leaseRange'],
    [column('nope', 'label'), { label: 'X' }, 'write.badRequest'],
    [column('nope', 'hidden'), { value: 'on' }, 'write.badRequest'],
    [column('nope', 'up'), {}, 'write.badRequest'],
    [column('backlog', 'up'), {}, 'write.badRequest'],
    [column('done', 'down'), {}, 'write.badRequest'],
  ];
  const before = f.stored();
  for (const [path, fields, key] of cases) {
    const response = await f.send(path, fields);
    const label = `${path} ${JSON.stringify(fields)}`;
    assert.equal(response.status, 400, label);
    assert.ok(response.body.includes(`<title>${escape(tr['write.badRequestTitle'])} · `), label);
    assert.ok(response.body.includes(message(key)), label);
    assert.equal(response.body.includes('marker'), false, `${label} echoes the value`);
    assert.equal(response.body.includes('Invalid setting'), false, `${label} shows the core message`);
  }
  assert.equal(f.stored(), before);
  assert.deepEqual(f.events(), []);
  // A move that would put a hidden column first in its role is refused by the same rule.
  assert.equal((await f.send(column('review', 'hidden'), { value: 'on' })).status, 303);
  const moved = await f.send(column('review', 'up'), {});
  assert.equal(moved.status, 400);
  assert.ok(moved.body.includes(message('settings.board.roleFirstHidden')));
  // A full reorder is not offered over the web; its refusal still maps to the generic message.
  const route = f.settings.routes.find((item) => item.path instanceof RegExp && item.path.test(column('doing', 'up')));
  const mismatch = new CairnError('validation', 'Invalid setting: columns.order',
    { field: 'columns.order', reason: 'order_mismatch' });
  assert.deepEqual({ ...route.failure(mismatch) },
    { status: 400, title: 'write.badRequestTitle', message: 'write.badRequest' });
  // An unknown reason falls back to the settings wording rather than inventing one.
  const future = new CairnError('validation', 'Invalid setting: x', { field: 'x', reason: 'toString' });
  assert.equal(route.failure(future).message, 'settings.invalidWrite');
  assert.equal(logged.mock.callCount(), 0);
});

test('a broken, missing or newer settings file answers 409 with the settings wording', async (t) => {
  const breakers = [
    ['reasonless validation', (f) => writeFileSync(f.configFile, '{broken')],
    ['invalid columns', (f) => writeFileSync(f.configFile, JSON.stringify({ ...JSON.parse(f.stored()), columns: [] }))],
    ['format too new', (f) => writeFileSync(f.configFile,
      JSON.stringify({ ...JSON.parse(f.stored()), formatVersion: 99 }))],
    ['not found', (f) => rmSync(f.configFile)],
  ];
  for (const [label, spoil] of breakers) {
    const f = fixture(t);
    const logged = silent(t);
    const revision = f.revision();
    spoil(f);
    for (const [path, fields] of [[column('doing', 'label'), { label: 'X' }], [LEASE, { minutes: '45' }]]) {
      const response = await f.send(path, { ...fields, revision });
      assert.equal(response.status, 409, `${label}: ${path}`);
      assert.ok(response.body.includes(message('settings.invalidWrite')), `${label}: ${path}`);
    }
    assert.equal(logged.mock.callCount(), 0, label);
    logged.mock.restore();
  }
});

test('a held settings lock answers 503 with Retry-After and changes nothing', async (t) => {
  const f = fixture(t);
  const revision = f.revision();
  const before = f.stored();
  const ctx = f.openWrite();
  mkdirSync(join(f.dataDir, '.cairn/locks'), { recursive: true });
  writeFileSync(join(f.dataDir, '.cairn/locks/_config.lock'), JSON.stringify({ host: ctx.host, pid: process.pid,
    instance: 'another-run', ts: '2026-11-08T12:00:00Z' }));
  for (const [path, fields] of [[column('doing', 'label'), { label: 'X' }], [column('review', 'up'), {}],
    [LEASE, { minutes: '45' }]]) {
    const response = await f.send(path, { ...fields, revision });
    assert.equal(response.status, 503, path);
    assert.equal(response.headers['retry-after'], '1');
    assert.ok(response.body.includes(message('settings.busy')));
  }
  assert.equal(f.stored(), before);
  rmSync(join(f.dataDir, '.cairn/locks/_config.lock'));
  assert.equal((await f.send(LEASE, { minutes: '45', revision })).status, 303);
});

test('the view lists the columns with the actions the writer allows, and the lease', async (t) => {
  const f = fixture(t);
  const view = () => f.settings.view(`${cookieName(port)}=${f.cookie}`);
  const flags = () => view().columns.map(({ key: name, hidden, editable, canToggle, canUp, canDown }) =>
    [name, hidden, editable, canToggle, canUp, canDown]);
  const ready = view();
  assert.equal(ready.state, 'ready');
  assert.equal(ready.leaseMinutes, 120);
  assert.deepEqual(ready.columns.map(({ key: name, label, role }) => [name, label, role]), [
    ['backlog', 'Backlog', 'todo'], ['doing', 'Doing', 'doing'], ['review', 'Review', 'doing'],
    ['done', 'Done', 'done']]);
  // The only column of a role, or the first of its role, cannot be hidden; the first cannot move up, the last down.
  assert.deepEqual(flags(), [
    ['backlog', false, true, false, false, true],
    ['doing', false, true, false, true, true],
    ['review', false, true, true, true, true],
    ['done', false, true, false, true, false],
  ]);
  assert.equal((await f.send(column('review', 'hidden'), { value: 'on' })).status, 303);
  // A hidden second column may be shown again, but may not move above the first of its role.
  assert.deepEqual(flags()[2], ['review', true, true, true, false, true]);
  assert.equal((await f.send(LEASE, { minutes: '30' })).status, 303);
  assert.equal(view().leaseMinutes, 30);
  assert.equal(view().revision, f.revision());
});

test('a hand-written breach and an over-long key are shown, but only the actions the web can post are offered',
  async (t) => {
    const f = fixture(t);
    const long = `a${'b'.repeat(64)}`;
    const config = JSON.parse(f.stored());
    config.columns[0].hidden = true;
    config.columns.push({ key: long, label: 'Far away', role: 'done' });
    writeFileSync(f.configFile, JSON.stringify(config, null, 2));
    const columns = f.settings.view(null).columns;
    // Showing the hidden first column mends the breach and is offered. Any other change of visibility or order would
    // leave the breach in place, so the writer refuses it and no form is offered for it.
    assert.deepEqual(columns.map(({ key: name, editable, canToggle, canUp, canDown }) =>
      [name, editable, canToggle, canUp, canDown]), [
      ['backlog', true, true, false, false],
      ['doing', true, false, false, false],
      ['review', true, false, false, false],
      ['done', true, false, false, false],
      [long, false, false, false, false],
    ]);
    // The breach does not block an unrelated write, and the mending write is accepted.
    assert.equal((await f.send(LEASE, { minutes: '60' })).status, 303);
    assert.equal((await f.send(column('doing', 'label'), { label: 'Active' })).status, 303);
    assert.equal((await f.send(column('review', 'up'), {})).status, 400);
    assert.equal((await f.send(column('backlog', 'hidden'), { value: 'off' })).status, 303);
    assert.equal((await f.send(column(long, 'hidden'), { value: 'on' })).status, 405);
  });

test('a body field named __proto__ is refused instead of slipping past the exact-field check', async (t) => {
  const f = fixture(t);
  const before = f.stored();
  const csrf = csrfToken(key, port, f.cookie);
  for (const extra of ['&__proto__=a', '&__proto__=a&__proto__=b']) {
    const body = `csrf=${csrf}&minutes=45&revision=${f.revision()}${extra}`;
    const res = await f.send(LEASE, {}, { body });
    assert.equal(res.status, 400);
  }
  // Boundary values the route accepts or refuses on its own.
  for (const minutes of ['0', '00030', '1e3', ' 30', '30 ']) {
    assert.equal((await f.send(LEASE, { minutes })).status, 400);
  }
  assert.equal(f.stored(), before);
  for (const minutes of ['5', '1440']) assert.equal((await f.send(LEASE, { minutes })).status, 303);
  assert.equal(loadConfig(f.dataDir).leaseMinutes, 1440);
});
