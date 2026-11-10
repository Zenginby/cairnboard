import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.mjs';
import { createApi } from '../server/api.mjs';
import { createGuard, guard } from '../server/guard.mjs';
import { createSettings } from '../server/settings.mjs';
import { cookieName, csrfToken, mintCookie, siteHost, verifyCsrf } from '../server/session.mjs';
import { openContext } from '../core/context.mjs';
import { initDataDir } from '../core/roots.mjs';
import { readEvents } from '../core/events.mjs';
import { features, loadConfig } from '../core/config.mjs';
import { readSettings, setFeature } from '../core/settings.mjs';
import { reconcileExternal } from '../core/changes.mjs';
import { fixedClock, tempDir } from './support/env.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const port = 4330, key = Buffer.alloc(32, 7), instance = 'run-aaaaaaaaaaaaaaaa';
const site = `${siteHost(key)}:${port}`;
const built = existsSync(join(repo, 'dist/app/server/entry.mjs'));

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

function fixture(t, { handler } = {}) {
  const dataDir = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-08T12:00:00Z');
  initDataDir(dataDir, { home, env: {}, clock });
  const options = { dataDir, home, env: {}, clock };
  const open = () => openContext({ mode: 'read', ...options });
  const openWrite = () => openContext({ mode: 'write', ...options, actor: 'web:owner' });
  let time = 1_900_000_000_000;
  const settings = createSettings({ key, port, open, openWrite, now: () => time });
  const app = createApp({ root: repo, guard: createGuard({ port, key, instance }), writes: settings.handle,
    handler: handler ?? ((req, res, next) => next()),
    api: createApi({ open, live: settings.liveUpdates,
      events: { handle(req, res) { res.writeHead(200); res.end('stream'); return true; } } }),
    locals: { settings, cairn: { home: async () => ({ data: { pinned: [], recentNotes: [], openCards: [], projects: [],
      featuredProject: null, journal: null }, warnings: [] }) } } });
  const configFile = join(dataDir, '.cairn/config.json');
  const session = () => mintCookie(key, port);
  const revision = () => readSettings(open()).revision;
  const form = (fields) => new URLSearchParams(fields).toString();
  /** A fully valid write; each test spoils one thing. */
  const post = (fields = {}, { path = '/settings/feature', cookie = session(), token, headers = {}, ...rest } = {}) => {
    const fresh = fields?.revision === undefined && fields !== null ? { revision: revision() } : {};
    const body = fields === null ? undefined : form({ csrf: token ?? csrfToken(key, port, cookie),
      name: 'liveUpdates', value: 'off', ...fresh, ...fields });
    return call(app, { method: 'POST', path, body, ...rest, headers: {
      origin: `http://${site}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded',
      cookie: `${cookieName(port)}=${cookie}`, ...headers } });
  };
  return { dataDir, open, openWrite, settings, app, configFile, session, revision, post, form,
    tick: (ms) => { time += ms; },
    stored: () => readFileSync(configFile, 'utf8'), actors: () => readEvents(open()).map((event) => event.actor) };
}

test('a valid settings write redirects, stores the value and records the web owner', (t) => {
  const f = fixture(t);
  return f.post().then((response) => {
    assert.equal(response.status, 303);
    assert.equal(response.headers.location, '/settings?saved=liveUpdates');
    assert.equal(loadConfig(f.dataDir).features.liveUpdates, false);
    const [event] = readEvents(f.open());
    assert.deepEqual([event.op, event.feature, event.after, event.actor],
      ['config.change', 'liveUpdates', false, 'web:owner']);
    assert.equal(features(loadConfig(f.dataDir)).mentions, true);
  });
});

test('writes without a real same-origin request are refused and change nothing', async (t) => {
  const f = fixture(t);
  const before = f.stored();
  const other = mintCookie(key, port);
  const cases = [
    ['no Origin', { headers: { origin: undefined } }, 403],
    ['another Origin', { headers: { origin: 'http://evil.test' } }, 403],
    ['Origin null', { headers: { origin: 'null' } }, 403],
    ['same host, other port', { headers: { origin: `http://${siteHost(key)}:${port + 1}` } }, 403],
    ['cross-site', { headers: { 'sec-fetch-site': 'cross-site' } }, 403],
    ['same-site only', { headers: { 'sec-fetch-site': 'same-site' } }, 403],
    ['no cookie', { headers: { cookie: undefined } }, 401],
    ['no cookie, wrong Origin', { headers: { cookie: undefined, origin: 'http://evil.test' } }, 401],
    ["another session's token", { token: csrfToken(key, port, other) }, 403],
    ['no token', { token: '' }, 403],
    ['a token of another key', { token: csrfToken(Buffer.alloc(32, 8), port, 'x') }, 403],
    ['wrong content type', { headers: { 'content-type': 'application/json' } }, 415],
    ['no content type', { headers: { 'content-type': undefined } }, 415],
  ];
  for (const [label, options, status] of cases) assert.equal((await f.post({}, options)).status, status, label);
  assert.equal(f.stored(), before, 'nothing was written');
});

test('fields are strict: unknown, repeated, missing and malformed ones are 400; an old revision is 409', async (t) => {
  const f = fixture(t);
  const before = f.stored();
  for (const fields of [{ extra: '1' }, { value: 'yes' }, { value: 'true' }, { name: 'formatVersion' },
    { name: '__proto__' }, { revision: 'abc' }, { revision: 'A'.repeat(16) }, { value: '' }]) {
    assert.equal((await f.post(fields)).status, 400, JSON.stringify(fields));
  }
  // A repeated name and a missing field cannot be built with the helper's merge.
  const cookie = f.session(), csrf = csrfToken(key, port, cookie);
  const raw = (body) => call(f.app, { method: 'POST', path: '/settings/feature', body, headers: {
    origin: `http://${site}`, 'content-type': 'application/x-www-form-urlencoded',
    cookie: `${cookieName(port)}=${cookie}` } });
  const common = `csrf=${csrf}&name=liveUpdates&value=off&revision=${f.revision()}`;
  assert.equal((await raw(`${common}&value=on`)).status, 400);
  assert.equal((await raw(`csrf=${csrf}&name=liveUpdates&value=off`)).status, 400);
  assert.equal((await raw(`csrf=${csrf}&value=off&revision=${f.revision()}`)).status, 400);
  assert.equal((await f.post({ revision: '0123456789abcdef' })).status, 409);
  assert.equal(f.stored(), before);
});

test('the body is capped at 4 KiB and reading stops at the limit', async (t) => {
  const f = fixture(t);
  const before = f.stored();
  const pad = 'x'.repeat(4097);
  assert.equal((await f.post(null, { body: pad })).status, 413);
  const chunked = await f.post(null, { body: pad, length: false });
  assert.equal(chunked.status, 413, 'no Content-Length: counted while reading');
  const exact = await f.post(null, { body: `csrf=${csrfToken(key, port, 'x')}&pad=${'x'.repeat(4096 - 64)}` });
  assert.equal(exact.status, 403, 'a body at the limit is read in full');
  assert.equal(f.stored(), before);
});

test('at most five writes per second per session', async (t) => {
  const f = fixture(t);
  const cookie = f.session();
  for (let i = 0; i < 5; i += 1) assert.equal((await f.post({ value: 'bad' }, { cookie })).status, 400);
  const sixth = await f.post({ value: 'bad' }, { cookie });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.headers['retry-after'], '1');
  assert.equal((await f.post({ value: 'bad' })).status, 400, 'another session has its own budget');
  f.tick(1001);
  assert.equal((await f.post({ value: 'bad' }, { cookie })).status, 400);
});

test('only the two settings paths accept POST; everything else stays 405 and GET never writes', async (t) => {
  const f = fixture(t);
  const before = f.stored();
  for (const path of ['/settings', '/', '/api/board', '/api/events', '/settings/feature/', '/settings/feature?x=1',
    '/settings/clear-shadow?x=1', '/settings//feature', '/Settings/feature']) {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await f.post({}, { path, method });
      assert.equal(response.status, 405, `${method} ${path}`);
    }
  }
  const body = f.form({ name: 'liveUpdates', value: 'off', revision: f.revision() });
  const cookie = { cookie: `${cookieName(port)}=${f.session()}` };
  for (const path of ['/settings/feature', `/settings/feature?${body}`]) {
    const response = await call(f.app, { path, headers: cookie });
    assert.equal(response.status, 404, 'no page answers a GET here');
  }
  assert.equal(f.stored(), before);
  for (const target of ['/settings/feature', '/settings/clear-shadow']) {
    const res = { setHeader() {}, writeHead() { assert.fail('the baseline guard must let it pass'); }, end() {} };
    assert.equal(guard({ method: 'POST', url: target, headers: {} }, res), true);
  }
});

test('clearing the shadow needs the confirmation box', async (t) => {
  const f = fixture(t);
  const path = '/settings/clear-shadow';
  for (const fields of [{}, { confirm: 'no' }, { confirm: 'yes', name: 'x' }]) {
    const response = await f.post(null, { path, body: f.form({ csrf: csrfToken(key, port, 'ignored'), ...fields }) });
    assert.ok([400, 403].includes(response.status));
  }
  const cookie = f.session(), csrf = csrfToken(key, port, cookie);
  const send = (fields) => f.post(null, { path, cookie, body: f.form({ csrf, ...fields }) });
  assert.equal((await send({})).status, 400);
  assert.equal((await send({ confirm: 'no' })).status, 400);
  assert.equal((await send({ confirm: 'yes', name: 'x' })).status, 400);
  assert.deepEqual(readEvents(f.open()), []);
  const done = await send({ confirm: 'yes' });
  assert.equal(done.status, 303);
  assert.equal(done.headers.location, '/settings?saved=shadow');
  assert.deepEqual(readEvents(f.open()).map((event) => [event.op, event.actor]), [['shadow.clear', 'web:owner']]);
});

test('two tabs changing settings: the second gets 409 and the file stays valid', async (t) => {
  const f = fixture(t);
  const stale = f.revision();
  assert.equal((await f.post({ name: 'mentions', value: 'off', revision: stale })).status, 303);
  const second = await f.post({ name: 'changeTrail', value: 'off', revision: stale });
  assert.equal(second.status, 409);
  assert.match(second.body, /sayfayı yenile/u);
  assert.deepEqual(features(loadConfig(f.dataDir)),
    { changeTrail: true, changeContent: true, liveUpdates: true, mentions: false });
  assert.equal((await f.post({ name: 'changeTrail', value: 'off' })).status, 303, 'with the fresh revision it works');
});

test('a hand-broken features block is reported, never crashes, and blocks writes', async (t) => {
  for (const broken of [{ foo: true }, { mentions: 'false' }, 'false', []]) {
    const f = fixture(t);
    const config = JSON.parse(f.stored());
    const revision = f.revision();
    writeFileSync(f.configFile, JSON.stringify({ ...config, features: broken }));
    const view = f.settings.view(null);
    assert.equal(view.state, 'invalid');
    assert.match(view.detail, /^Invalid configuration: features/u);
    const write = await f.post({ revision });
    assert.equal(write.status, 409);
    assert.equal(JSON.parse(f.stored()).features.constructor, JSON.parse(JSON.stringify(broken)).constructor);
    assert.equal(f.settings.liveUpdates(), true, 'unreadable settings keep the default');
    const headers = { cookie: `${cookieName(port)}=${f.session()}` };
    assert.equal((await call(f.app, { path: '/api/events', headers })).status, 200);
  }
});

test('/api/events answers 404 once live updates are off, for GET and HEAD', async (t) => {
  const f = fixture(t);
  const headers = { cookie: `${cookieName(port)}=${f.session()}` };
  assert.equal((await call(f.app, { path: '/api/events', headers })).status, 200);
  setFeature(f.openWrite(), { name: 'liveUpdates', value: false, expectedRevision: f.revision() });
  assert.equal((await call(f.app, { path: '/api/events', headers })).status, 404);
  assert.equal((await call(f.app, { path: '/api/events', method: 'HEAD', headers })).status, 404);
  setFeature(f.openWrite(), { name: 'liveUpdates', value: true, expectedRevision: f.revision() });
  assert.equal((await call(f.app, { path: '/api/events', headers })).status, 200);
});

test('the CSRF token is bound to the key, the port and the session cookie', () => {
  const cookie = mintCookie(key, port), token = csrfToken(key, port, cookie);
  assert.equal(csrfToken(key, port, cookie), token, 'stable per session so the page and the write agree');
  assert.equal(verifyCsrf(key, port, cookie, token), true);
  assert.equal(verifyCsrf(key, port + 1, cookie, token), false);
  assert.equal(verifyCsrf(Buffer.alloc(32, 9), port, cookie, token), false);
  assert.equal(verifyCsrf(key, port, mintCookie(key, port), token), false);
  for (const bad of [undefined, null, '', 'x', token.slice(1), `${token}x`, 5, [token]]) {
    assert.equal(verifyCsrf(key, port, cookie, bad), false, String(bad));
  }
  assert.equal(verifyCsrf(key, port, null, token), false);
  assert.throws(() => csrfToken(key, port, ''), TypeError);
});

test('the built Settings page shows the forms, reflects the state and drops the live script when off', async (t) => {
  if (!built) return t.skip('Astro output missing; run npm run build:app to enable integration coverage.');
  const { handler } = await import('../dist/app/server/entry.mjs');
  const f = fixture(t, { handler });
  const cookie = f.session();
  const headers = { cookie: `${cookieName(port)}=${cookie}` };
  const home = await call(f.app, { path: '/', headers });
  assert.equal(home.status, 200);
  assert.match(home.body, /live-updates[^"]*\.js/u, 'live script present while on');
  assert.match(home.body, /data-live-status/u);
  const page = await call(f.app, { path: '/settings', headers });
  assert.equal(page.status, 200);
  assert.equal(page.headers['referrer-policy'], 'same-origin');
  assert.match(page.body, /<meta name="referrer" content="same-origin"/u);
  assert.match(page.body, /href="\/settings" aria-current="page"/u);
  assert.equal([...page.body.matchAll(/<form method="post" action="\/settings\/feature"/gu)].length, 4);
  const tokens = [...page.body.matchAll(/name="csrf" value="([^"]+)"/gu)].map((match) => match[1]);
  assert.equal(tokens.length, 5);
  assert.ok(tokens.every((token) => verifyCsrf(key, port, cookie, token)));
  assert.ok(page.body.includes(`name="revision" value="${f.revision()}"`));
  for (const name of ['Değişiklik izi', 'Ne değişti', 'Canlı güncelleme', 'Bağlantısız anmalar',
    'Gölgeyi temizle']) {
    assert.ok(page.body.includes(name), name);
  }
  assert.doesNotMatch(page.body, /<button[^>]*disabled/u);
  assert.doesNotMatch(page.body, /<script(?![^>]*src=)/u, 'no inline script: the CSP stays as it is');

  const saved = await call(f.app, { path: '/settings?saved=liveUpdates', headers });
  assert.match(saved.body, /role="status"[^>]*>Kaydedildi: Canlı güncelleme/u);
  assert.doesNotMatch((await call(f.app, { path: '/settings?saved=%3Cb%3E', headers })).body, /Kaydedildi/u);

  assert.equal((await f.post({ name: 'liveUpdates', value: 'off' }, { cookie })).status, 303);
  assert.equal((await f.post({ name: 'changeTrail', value: 'off' }, { cookie })).status, 303);
  const off = await call(f.app, { path: '/settings', headers });
  const content = off.body.match(/<button[^>]*aria-label="Ne değişti: Kapat"[^>]*>/u)[0];
  assert.match(content, /\bdisabled\b/u);
  assert.match(off.body, /data-state="off"/u);
  assert.doesNotMatch(off.body, /live-updates|data-live-status|data-live=/u);
  const homeOff = await call(f.app, { path: '/', headers });
  assert.equal(homeOff.status, 200);
  assert.doesNotMatch(homeOff.body, /live-updates|data-live-status|data-live=/u);
  assert.equal((await call(f.app, { path: '/api/events', headers })).status, 404);

  const config = JSON.parse(f.stored());
  writeFileSync(f.configFile, JSON.stringify({ ...config, features: { mentions: 'false' } }));
  const invalid = await call(f.app, { path: '/settings', headers });
  assert.equal(invalid.status, 200);
  assert.match(invalid.body, /Invalid configuration: features\.mentions/u);
  assert.match(invalid.body, /features/u);
  assert.doesNotMatch(invalid.body, /<form/u);
});

test('the Settings page without a session is the sign-in page', async (t) => {
  const f = fixture(t);
  assert.equal((await call(f.app, { path: '/settings' })).status, 401);
});

test('web settings survive a corrupt shadow manifest and repair it on clear-shadow', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.dataDir, 'notes'), { recursive: true });
  writeFileSync(join(f.dataDir, 'notes/a.md'), 'alpha');
  reconcileExternal(f.openWrite());
  const manifestPath = join(f.dataDir, '.cairn/shadow/manifest.json');
  writeFileSync(manifestPath, '{broken');

  const viewed = f.settings.view(`${cookieName(port)}=${f.session()}`);
  assert.equal(viewed.state, 'ready');
  assert.deepEqual(viewed.shadow, { blobs: 1, bytes: 5 });

  const toggled = await f.post({ name: 'changeTrail', value: 'off' });
  assert.equal(toggled.status, 303);
  assert.equal(toggled.headers.location, '/settings?saved=changeTrail');
  assert.equal(features(loadConfig(f.dataDir)).changeTrail, false);

  const cookie = f.session();
  const cleared = await f.post(null, {
    path: '/settings/clear-shadow',
    cookie,
    body: f.form({ csrf: csrfToken(key, port, cookie), confirm: 'yes' }),
  });
  assert.equal(cleared.status, 303);
  assert.equal(cleared.headers.location, '/settings?saved=shadow');
  assert.deepEqual(readdirSync(join(f.dataDir, '.cairn/shadow/blobs')), []);
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')), { v: 1, initialized: false, entries: {} });
  assert.equal(readEvents(f.open()).at(-1).manifestReset, true);
});
