import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.mjs';
import { createGuard, guard } from '../server/guard.mjs';
import { createWrites } from '../server/writes.mjs';
import { cookieName, csrfToken, mintCookie, siteHost, verifyCsrf } from '../server/session.mjs';
import { CairnError } from '../core/errors.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const port = 4331, key = Buffer.alloc(32, 5), instance = 'run-bbbbbbbbbbbbbbbb';
const site = `${siteHost(key)}:${port}`;

async function call(app, { method = 'POST', path, headers = {}, body }) {
  const req = new IncomingMessage(new Socket());
  const data = body === undefined ? undefined : Buffer.from(body);
  const all = { host: site, ...headers, ...(data ? { 'content-length': String(data.length) } : {}) };
  Object.assign(req, { url: path, method,
    headers: Object.fromEntries(Object.entries(all).filter(([, value]) => value !== undefined)) });
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

function fixture({ limit } = {}) {
  const seen = [];
  let time = 1_900_000_000_000, fail = null;
  const back = { href: '/things', label: 'shell.board' };
  const routes = [
    { path: '/things', form: 'thing', back,
      run: ({ values }) => { seen.push(['add', values]); return '/things/t-1'; } },
    { path: /^\/things\/(?<id>t-[0-9a-z]{1,26})\/poke$/u, form: 'thing', back, bodyLimit: 64,
      run: ({ values, params }) => {
        if (fail) throw fail;
        if (values.title === '') return { status: 400, title: 'write.badRequestTitle', message: 'write.badRequest' };
        seen.push(['poke', params.id, values]);
        return `/things/${params.id}`;
      } },
    { path: '/other', form: 'other', back, run: () => '/' },
  ];
  const writes = createWrites({ key, port, routes, now: () => time, limit });
  const app = createApp({ root: repo, writes: writes.handle, handler: (req, res, next) => next(),
    guard: createGuard({ port, key, instance, writable: writes.writable }) });
  const cookie = mintCookie(key, port);
  const post = (path, fields = {}, { form = 'thing', headers = {}, body } = {}) => call(app, { path,
    body: body ?? new URLSearchParams({ csrf: csrfToken(key, port, cookie, form), ...fields }).toString(),
    headers: { origin: `http://${site}`, 'sec-fetch-site': 'same-origin',
      'content-type': 'application/x-www-form-urlencoded', cookie: `${cookieName(port)}=${cookie}`, ...headers } });
  return { writes, app, seen, post, cookie, tick: (ms) => { time += ms; }, failWith: (error) => { fail = error; } };
}

test('a table route runs with its fields and path parameters, then redirects', async () => {
  const f = fixture();
  const added = await f.post('/things', { title: 'A' });
  assert.equal(added.status, 303);
  assert.equal(added.headers.location, '/things/t-1');
  const poked = await f.post('/things/t-9z/poke', { title: 'B' });
  assert.equal(poked.headers.location, '/things/t-9z');
  assert.deepEqual(f.seen, [['add', { title: 'A' }], ['poke', 't-9z', { title: 'B' }]],
    'the token never reaches a route');
});

test('only exact table targets are writable; everything else stays 405', async () => {
  const f = fixture();
  for (const path of ['/things/', '/things?x=1', '/things/t-1/poke/', '/things/T-1/poke', '/things/t-1%2f/poke',
    '/things/../things', '/nope', '//things', `/things/t-${'a'.repeat(27)}/poke`]) {
    assert.equal(f.writes.writable(path), false, path);
    assert.equal((await f.post(path, { title: 'A' })).status, 405, path);
  }
  assert.deepEqual(f.seen, []);
  const res = { setHeader() {}, writeHead() {}, end() {} };
  const bare = guard({ method: 'POST', url: '/things', headers: {} }, res);
  assert.equal(bare, false, 'the bare guard knows only settings');
  assert.equal(guard({ method: 'POST', url: '/things', headers: {} }, res, f.writes.writable), true);
  assert.equal(guard({ method: 'PUT', url: '/things', headers: {} }, res, f.writes.writable), false);
});

test('a token is bound to its form: other forms, the settings token and a foreign session fail', async () => {
  const f = fixture();
  assert.equal(csrfToken(key, port, f.cookie), csrfToken(key, port, f.cookie, 'settings'), 'default: settings');
  assert.notEqual(csrfToken(key, port, f.cookie, 'thing'), csrfToken(key, port, f.cookie, 'other'));
  assert.equal(verifyCsrf(key, port, f.cookie, csrfToken(key, port, f.cookie, 'thing'), 'thing'), true);
  assert.equal(verifyCsrf(key, port, f.cookie, csrfToken(key, port, f.cookie, 'thing'), 'other'), false);
  assert.throws(() => csrfToken(key, port, f.cookie, 'a|b'), TypeError);
  for (const form of ['other', 'settings']) {
    assert.equal((await f.post('/things', { title: 'A' }, { form })).status, 403, form);
  }
  const foreign = new URLSearchParams({ csrf: csrfToken(key, port, mintCookie(key, port), 'thing'), title: 'A' });
  assert.equal((await f.post('/things', {}, { body: foreign.toString() })).status, 403);
  assert.equal((await f.post('/things', {}, { body: 'title=A' })).status, 403);
  assert.deepEqual(f.seen, []);
  assert.equal(f.writes.token(`${cookieName(port)}=${f.cookie}`, 'thing'), csrfToken(key, port, f.cookie, 'thing'));
  assert.equal(f.writes.token(undefined, 'thing'), '');
});

test('request shape: content type, repeated fields, per-route body limit and the shared rate limit', async () => {
  const f = fixture({ limit: 3 });
  const json = await f.post('/things', { title: 'A' }, { headers: { 'content-type': 'application/json' } });
  assert.equal(json.status, 415);
  f.tick(1000);
  const token = csrfToken(key, port, f.cookie, 'thing');
  assert.equal((await f.post('/things', {}, { body: `csrf=${token}&title=A&title=B` })).status, 400);
  const large = await f.post('/things/t-1/poke', { title: 'x'.repeat(64) });
  assert.equal(large.status, 413);
  assert.equal(large.headers.connection, 'close');
  assert.equal((await f.post('/things', { title: 'x'.repeat(64) })).status, 303, 'the default limit is larger');
  f.tick(1000);
  const statuses = [];
  for (const path of ['/things', '/things/t-1/poke', '/other', '/things']) {
    statuses.push((await f.post(path, { title: 'A' }, { form: path === '/other' ? 'other' : 'thing' })).status);
  }
  assert.deepEqual(statuses, [303, 303, 303, 429], 'one budget for every route of a session');
  f.tick(1000);
  assert.equal((await f.post('/things', { title: 'A' })).status, 303);
});

test('a route can refuse with its own page; core errors map to conflict, busy, invalid and missing pages', async () => {
  const f = fixture({ limit: 50 });
  const refused = await f.post('/things/t-1/poke', { title: '' });
  assert.equal(refused.status, 400);
  assert.match(refused.body, /href="\/things"/u, 'error pages link back to where the form lives');
  const cases = [['conflict', 409], ['locked', 503], ['validation', 400], ['not_found', 404], ['unsafe_path', 500]];
  const log = console.error;
  console.error = () => {};
  try {
    for (const [code, status] of cases) {
      f.failWith(new CairnError(code, '<b>secret detail</b>'));
      const response = await f.post('/things/t-1/poke', { title: 'A' });
      assert.equal(response.status, status, code);
      assert.doesNotMatch(response.body, /secret detail/u, 'core messages are not echoed');
      if (code === 'locked') assert.equal(response.headers['retry-after'], '1');
    }
    f.failWith(new Error('boom'));
    assert.equal((await f.post('/things/t-1/poke', { title: 'A' })).status, 500);
  } finally { console.error = log; }
  assert.deepEqual(f.seen, []);
});

test('route tables are validated when the server starts', () => {
  const run = () => '/';
  const back = { href: '/', label: 'shell.home' };
  assert.throws(() => createWrites({ key, port, routes: [{ path: 'things', form: 'x', back, run }] }), TypeError);
  assert.throws(() => createWrites({ key, port, routes: [{ path: /things/u, form: 'x', back, run }] }), TypeError);
  assert.throws(() => createWrites({ key, port, routes: [{ path: '/x', form: 'a b', back, run }] }), TypeError);
  assert.throws(() => createWrites({ key, port, routes: [{ path: '/x', form: 'x', back }] }), TypeError);
  assert.throws(() => createWrites({ key, port, routes: [{ path: '/x', form: 'x', run }] }), TypeError);
});
