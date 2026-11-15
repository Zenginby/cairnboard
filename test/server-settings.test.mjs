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
import { createWrites } from '../server/writes.mjs';
import { cookieName, csrfToken, mintCookie, siteHost, verifyCsrf } from '../server/session.mjs';
import { openContext } from '../core/context.mjs';
import { initDataDir } from '../core/roots.mjs';
import { readEvents } from '../core/events.mjs';
import { features, loadConfig } from '../core/config.mjs';
import { readSettings, setFeature, setLanguage } from '../core/settings.mjs';
import { reconcileExternal } from '../core/changes.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
// The pages below are asserted in Turkish. The interface falls back to English, so this file sets the language
// explicitly, the way the server does at start.
process.env.CAIRN_LANGUAGE = 'tr';

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

function fixture(t, { handler, cairn, switchLanguage, locals = {} } = {}) {
  const dataDir = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-08T12:00:00Z');
  initDataDir(dataDir, { home, env: {}, clock });
  const options = { dataDir, home, env: {}, clock };
  const open = () => openContext({ mode: 'read', ...options });
  const openWrite = () => openContext({ mode: 'write', ...options, actor: 'web:owner' });
  let time = 1_900_000_000_000;
  // Each test that changes the language gets the file's language back, whatever it left behind.
  t.after(() => { process.env.CAIRN_LANGUAGE = 'tr'; });
  const settings = createSettings({ key, port, open, openWrite, now: () => time, switchLanguage });
  // The server's write table, as in server/start.mjs: the baseline guard alone knows only the feature paths.
  const { writable } = createWrites({ key, port, routes: settings.routes });
  const app = createApp({ root: repo, guard: createGuard({ port, key, instance, writable }), writes: settings.handle,
    handler: handler ?? ((req, res, next) => next()),
    api: createApi({ open, live: settings.liveUpdates,
      events: { handle(req, res) { res.writeHead(200); res.end('stream'); return true; } } }),
    locals: { settings, cairn: cairn ?? { home: async () => ({ data: { pinned: [], recentNotes: [], openCards: [],
      projects: [],
      featuredProject: null, journal: null }, warnings: [] }) }, ...locals } });
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
  // Settings is a round icon button beside search, not a tab.
  const settingsButton = new RegExp('<a class="shell-icon" href="/settings" data-settings-open'
    + ' aria-label="[^"]+" title="[^"]+"'
    + ' aria-current="page">', 'u');
  assert.match(page.body, settingsButton);
  assert.doesNotMatch(page.body, /<div class="app-tabs">[^]*?href="\/settings"[^]*?<\/nav>/u);
  assert.equal([...page.body.matchAll(/<form method="post" action="\/settings\/feature"/gu)].length, 4);
  assert.match(page.body, /<div class="settings" data-settings-panel>/u);
  assert.doesNotMatch(page.body, /settings-nav/u, 'the single-column layout has no side navigation');
  for (const id of ['settings-look', 'settings-language', 'settings-features', 'settings-shadow',
    'settings-danger']) {
    assert.equal([...page.body.matchAll(new RegExp(`id="${id}"`, 'gu'))].length, 1, 'unique section id');
  }
  assert.match(page.body, /<section[^>]*id="settings-look"[^>]*data-glass-choice hidden/u);
  // The dialog imports only this subtree; page layout and the dialog's own glass choice stay outside it.
  const panel = page.body.match(
    /<div class="settings" data-settings-panel>[^]*?<p class="settings-last">[^]*?<\/p>\s*<\/div>/u);
  assert.ok(panel);
  assert.doesNotMatch(panel[0], /settings-page|settings-nav|data-glass-choice/u);
  const forms = [...panel[0].matchAll(/<form method="post" action="([^"]+)">([^]*?)<\/form>/gu)];
  // Forms are found by their action, not by count or position, so a later section may add its own.
  const byAction = (action) => forms.filter((form) => form[1] === action);
  const [languageForm] = byAction('/settings/language'), [clearForm] = byAction('/settings/clear-shadow');
  assert.equal(byAction('/settings/language').length, 1, 'the dialog keeps the language form');
  assert.equal(byAction('/settings/clear-shadow').length, 1, 'and the clear form');
  assert.deepEqual(byAction('/settings/feature').map((form) => form[2].match(/name="name" value="([^"]+)"/u)[1]),
    ['changeTrail', 'changeContent', 'liveUpdates', 'mentions'], 'and the four feature forms');
  assert.match(clearForm[2], /<button type="submit" class="action-link">/u, 'clear remains secondary');
  // The language card sits above the features, with both choices, the stored one checked and its two notes.
  assert.ok(page.body.indexOf('id="settings-language"') < page.body.indexOf('id="settings-features"'));
  assert.match(page.body, /<h2 id="settings-language-title">Dil<\/h2>/u);
  assert.deepEqual([...languageForm[2].matchAll(/<input type="radio" name="language" value="([a-z]+)"( checked)?>/gu)]
    .map((match) => [match[1], Boolean(match[2])]), [['en', true], ['tr', false]]);
  assert.match(languageForm[2], /<span lang="en">English<\/span>/u);
  assert.match(languageForm[2], /<span lang="tr">Türkçe<\/span>/u);
  assert.ok(languageForm[2].includes('Pano sütun adları senin verindir; çevrilmez.'));
  assert.ok(languageForm[2].includes('Günlük etiketleri ve Türkçe yazım kuralları bu ayarı izler.'));
  assert.ok(page.body.includes('yeniden başlatma isteyebilir'), 'a change from outside the web may need a restart');
  assert.ok(languageForm[2].includes(`name="revision" value="${f.revision()}"`));
  assert.match(page.body, /<h2 id="settings-features-title">Özellikler<\/h2>/u);
  assert.match(page.body, /<h2 id="settings-shadow-title">Değişiklik izi deposu<\/h2>/u);
  assert.match(page.body, /<h2 id="settings-danger-title">Tehlikeli işlemler<\/h2>/u);
  assert.equal([...page.body.matchAll(/<li class="settings-row">/gu)].length, 4);
  assert.equal([...page.body.matchAll(/role="switch" aria-checked="true"/gu)].length, 4);
  assert.doesNotMatch(page.body, /class="panel settings-row"/u);
  assert.match(home.body, /<dialog class="settings-dialog" data-settings-dialog/u);
  assert.match(home.body, /<svg class="settings-icon"[^]*?<path fill-rule="evenodd"/u);
  assert.doesNotMatch(page.body, /<style\b|\sstyle=/u, 'no inline styles: the CSP stays as it is');
  const tokens = [...page.body.matchAll(/name="csrf" value="([^"]+)"/gu)].map((match) => match[1]);
  assert.equal(tokens.length, [...page.body.matchAll(/<form method="post"/gu)].length, 'every form carries a token');
  assert.ok(tokens.length >= 6 && tokens.every((token) => verifyCsrf(key, port, cookie, token)));
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
  assert.match((await call(f.app, { path: '/settings?saved=language', headers })).body,
    /role="status"[^>]*>Kaydedildi: Dil/u);

  assert.equal((await f.post({ name: 'liveUpdates', value: 'off' }, { cookie })).status, 303);
  assert.equal((await f.post({ name: 'changeTrail', value: 'off' }, { cookie })).status, 303);
  const off = await call(f.app, { path: '/settings', headers });
  const content = off.body.match(/<button[^>]*aria-label="Ne değişti: Kapat"[^>]*>/u)[0];
  assert.match(content, /\bdisabled\b/u);
  assert.match(off.body, /data-state="off"/u);
  assert.equal([...off.body.matchAll(/role="switch" aria-checked="false"/gu)].length, 2);
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
  assert.match(invalid.body, /data-settings-panel/u);
  assert.doesNotMatch(invalid.body, /class="settings-nav"/u, 'no links to unavailable sections');
  assert.doesNotMatch(invalid.body, /<form/u);
  for (const [state, status] of [['notReady', 409], ['busy', 503], ['error', 500]]) {
    f.settings.view = () => ({ state });
    const response = await call(f.app, { path: '/settings', headers });
    assert.equal(response.status, status, state);
    assert.match(response.body, /data-settings-panel/u, `${state} stays in the shared panel`);
    assert.doesNotMatch(response.body, /class="settings-nav"/u);
    assert.doesNotMatch(response.body, /<form/u);
  }
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

test('the Home project picker write stores hidden ids and refuses malformed fields', async (t) => {
  const f = fixture(t);
  const cookie = f.session();
  const send = (fields, token = csrfToken(key, port, cookie, 'home-projects')) => {
    f.tick(1000); // stay under five writes per second
    const body = new URLSearchParams({ csrf: token, revision: f.revision(), ...fields }).toString();
    return call(f.app, { method: 'POST', path: '/settings/home-projects', body, headers: {
      origin: `http://${site}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded',
      cookie: `${cookieName(port)}=${cookie}` } });
  };
  mkdirSync(join(f.dataDir, 'projects'), { recursive: true });
  writeFileSync(join(f.dataDir, 'projects/third.md'), '---\nid: p-000003\ntitle: Third\n---\n');
  const before = f.stored();
  for (const fields of [{ 'listed:p-000001': '1', 'project:p-000001': 'yes' }, { 'listed:p-000001': 'on' },
    { 'listed:bad id': '1' }, { 'project:p-000002': 'on' }, { project: 'on' }, { 'p-000001': 'on' }, { extra: '1' },
    { revision: 'abc' }]) {
    assert.equal((await send(fields)).status, 400, JSON.stringify(fields));
  }
  // A token for the settings form does not work here.
  assert.equal((await send({ 'listed:p-000001': '1' }, csrfToken(key, port, cookie))).status, 403);
  assert.equal(f.stored(), before);
  const ok = await send({ 'listed:p-000001': '1', 'listed:P-OOOOO2': '1', 'listed:p-000003': '1',
    'project:P-OOOOO2': 'on' });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.location, '/?saved=projects');
  assert.deepEqual(loadConfig(f.dataDir).home.hiddenProjects, ['p-000001', 'p-000003']);
  const [event] = readEvents(f.open());
  assert.deepEqual([event.op, event.fields, event.actor], ['config.change', ['home.hiddenProjects'], 'web:owner']);
  f.tick(1000);
  const old = new URLSearchParams({ csrf: csrfToken(key, port, cookie, 'home-projects'), revision: 'a'.repeat(16) });
  assert.equal((await call(f.app, { method: 'POST', path: '/settings/home-projects', body: old.toString(), headers: {
    origin: `http://${site}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded',
    cookie: `${cookieName(port)}=${cookie}` } })).status, 409);
  assert.equal((await send({ 'listed:p-000001': '1', 'project:p-000001': 'on' })).status, 303);
  assert.deepEqual(loadConfig(f.dataDir).home.hiddenProjects, ['p-000003'], 'only the listed project changed');
});

test('the built Home shows the project picker with a home-projects token and the saved notice', async (t) => {
  if (!built) return t.skip('Astro output missing; run npm run build:app to enable integration coverage.');
  const { handler } = await import('../dist/app/server/entry.mjs');
  const project = (id, title, path) => ({ type: 'project', id, path, meta: {}, content: { title, snippet: '' } });
  const homeData = { pinned: [], recentNotes: [], openCards: [], journal: null, featuredProject: null,
    projects: [project('p-000002', 'Shown project', 'projects/shown.md')], projectCards: {},
    projectChoices: [{ id: 'p-000001', title: '<b>Hidden</b>', tone: 2, shown: false },
      { id: 'p-000002', title: 'Shown project', tone: 5, shown: true }], hiddenProjects: ['p-000001'] };
  const f = fixture(t, { handler, cairn: { home: async () => ({ data: structuredClone(homeData), warnings: [] }) } });
  const cookie = f.session();
  const headers = { cookie: `${cookieName(port)}=${cookie}` };
  const home = await call(f.app, { path: '/', headers });
  assert.equal(home.status, 200);
  assert.equal(home.headers['referrer-policy'], 'same-origin');
  assert.match(home.body, /<form class="picker-form" method="post" action="\/settings\/home-projects">/u);
  const token = home.body
    .match(/action="\/settings\/home-projects">\s*<input type="hidden" name="csrf" value="([^"]+)"/u)[1];
  assert.ok(verifyCsrf(key, port, cookie, token, 'home-projects'));
  assert.ok(home.body.includes(`name="revision" value="${f.revision()}"`));
  assert.match(home.body, /<input type="hidden" name="listed:p-000001" value="1">/u);
  assert.match(home.body, /<input type="checkbox" name="project:p-000001">/u);
  assert.match(home.body, /<input type="checkbox" name="project:p-000002" checked>/u);
  assert.match(home.body, /&lt;b&gt;Hidden&lt;\/b&gt;/u);
  assert.match(home.body, />1\/2</u);
  assert.match(home.body, /href="\/projects">Tüm projeler/u);
  assert.doesNotMatch(home.body, /picker-saved/u);
  assert.match((await call(f.app, { path: '/?saved=projects', headers })).body,
    /role="status">Ana sayfa projeleri kaydedildi/u);
  homeData.projects = [];
  homeData.hiddenProjects = ['p-000001', 'p-000002'];
  assert.match((await call(f.app, { path: '/', headers })).body, /Ana sayfada gösterilecek proje seçmedin/u);
  // Without a session the page is the sign-in page; the picker never renders a form with an empty token.
  assert.equal((await call(f.app, { path: '/' })).status, 401);
});

test('the language write stores the code, records the web owner and switches the running interface', async (t) => {
  const switched = [];
  const f = fixture(t, { switchLanguage: (language) => switched.push(language) });
  const path = '/settings/language';
  const cookie = f.session(), csrf = csrfToken(key, port, cookie);
  const send = (fields, options = {}) => {
    f.tick(1000); // stay under five writes per second
    return f.post(null, { path, cookie, ...options,
      body: f.form({ csrf, language: 'tr', revision: f.revision(), ...fields }) });
  };
  const before = f.stored();

  // Fields are exactly `language` and `revision`.
  for (const fields of [{ language: 'de' }, { language: 'TR' }, { language: '' }, { language: 'on' },
    { extra: '1' }, { name: 'language' }, { revision: 'abc' }, { revision: 'A'.repeat(16) }]) {
    assert.equal((await send(fields)).status, 400, JSON.stringify(fields));
  }
  const raw = (body) => {
    f.tick(1000);
    return f.post(null, { path, cookie, body });
  };
  assert.equal((await raw(`csrf=${csrf}&revision=${f.revision()}`)).status, 400, 'no language');
  assert.equal((await raw(`csrf=${csrf}&language=tr`)).status, 400, 'no revision');
  assert.equal((await raw(`csrf=${csrf}&language=tr&language=en&revision=${f.revision()}`)).status, 400, 'repeated');

  // The shared guards: token, session, origin and content type.
  assert.equal((await raw(`language=tr&revision=${f.revision()}`)).status, 403, 'missing CSRF token');
  assert.equal((await send({ csrf: csrfToken(key, port, mintCookie(key, port)) })).status, 403);
  assert.equal((await send({ csrf: csrfToken(key, port, cookie, 'home-projects') })).status, 403, 'another form');
  assert.equal((await send({}, { headers: { origin: 'http://evil.test' } })).status, 403);
  assert.equal((await send({}, { headers: { cookie: undefined } })).status, 401);
  assert.equal((await send({}, { headers: { 'content-type': 'application/json' } })).status, 415);
  const stale = await send({ revision: '0123456789abcdef' });
  assert.equal(stale.status, 409);
  assert.match(stale.body, /sayfayı yenile/u);
  assert.equal(f.stored(), before, 'nothing was written');
  assert.deepEqual(readEvents(f.open()), []);
  assert.deepEqual(switched, [], 'a refused write never switches the interface');

  const done = await send({});
  assert.equal(done.status, 303);
  assert.equal(done.headers.location, '/settings?saved=language');
  assert.equal(loadConfig(f.dataDir).language, 'tr');
  assert.deepEqual(switched, ['tr']);
  const events = readEvents(f.open());
  assert.deepEqual(events.map((event) => [event.op, event.actor, event.fields, event.before, event.after]),
    [['config.change', 'web:owner', ['language'], undefined, undefined]]);
  assert.equal(f.settings.view(null).language, 'tr');
  assert.equal(features(loadConfig(f.dataDir)).mentions, true, 'the features are untouched');

  // Saving the stored value again writes and logs nothing, but still brings the interface in line with the file.
  const again = await send({});
  assert.equal(again.status, 303);
  assert.equal(readEvents(f.open()).length, 1);
  assert.deepEqual(switched, ['tr', 'tr']);
  assert.equal(readEvents(f.open()).some((event) => event.op === 'config.external'), false);
  // GET never writes and the path takes no query or trailing slash.
  const headers = { cookie: `${cookieName(port)}=${cookie}` };
  assert.equal((await call(f.app, { path: `${path}?language=en&revision=${f.revision()}`, headers })).status, 404);
  for (const target of [`${path}/`, `${path}?x=1`]) assert.equal((await send({}, { path: target })).status, 405);
  assert.equal(loadConfig(f.dataDir).language, 'tr');
});

test('by default a saved language switches this process, write messages included', async (t) => {
  const f = fixture(t);
  const path = '/settings/language';
  process.env.CAIRN_LANGUAGE = 'en';
  const refused = await f.post(null, { path, body: 'language=tr' });
  assert.equal(refused.status, 403);
  assert.match(refused.body, /<h1>Request refused<\/h1>/u);
  assert.match(refused.body, /<html lang="en">/u);
  const cookie = f.session(), csrf = csrfToken(key, port, cookie);
  const saved = await f.post(null, { path, cookie, body: f.form({ csrf, language: 'tr', revision: f.revision() }) });
  assert.equal(saved.status, 303);
  assert.equal(process.env.CAIRN_LANGUAGE, 'tr');
  const after = await f.post(null, { path, body: 'language=tr' });
  assert.match(after.body, /<h1>İstek reddedildi<\/h1>/u, 'the small write pages follow at once');
  assert.match(after.body, /<html lang="tr">/u);
  // A language set outside the web is not watched: the interface keeps its language until a restart or a save.
  setLanguage(f.openWrite(), { language: 'en', expectedRevision: f.revision(), actor: 'cli:owner' });
  assert.equal(process.env.CAIRN_LANGUAGE, 'tr');
  assert.equal(f.settings.view(null).language, 'en');
});

test('the built pages are in the new language right after the language POST, without a restart', async (t) => {
  if (!built) return t.skip('Astro output missing; run npm run build:app to enable integration coverage.');
  const { handler } = await import('../dist/app/server/entry.mjs');
  const { createRead } = await import('../server/read.mjs');
  const { createRenderPool } = await import('../server/render-pool.mjs');
  const pool = createRenderPool();
  t.after(() => pool.close());
  let f;
  const read = createRead({ open: () => f.open(), render: pool.render });
  const cairn = read;
  f = fixture(t, { handler, cairn, locals: { journal: { view: () => ({ state: 'off' }) } } });
  // A journal day whose body goes through the render pool's worker thread, started before the switch.
  mkdirSync(join(f.dataDir, 'journal'), { recursive: true });
  writeFileSync(join(f.dataDir, 'journal/2026-11-08.md'), '## Work\n\nA **bold** step through the worker.\n');
  const cookie = f.session();
  const headers = { cookie: `${cookieName(port)}=${cookie}` };
  const get = (path) => call(f.app, { path, headers });
  const save = (language) => f.post(null, { path: '/settings/language', cookie,
    body: f.form({ csrf: csrfToken(key, port, cookie), language, revision: f.revision() }) });
  const pages = ['/', '/settings', '/board', '/journal/2026-11-08', '/does-not-exist'];
  const expected = {
    tr: { title: 'Ayarlar', features: 'Özellikler', notFound: 'Sayfa bulunamadı',
      serverError: 'Bir şeyler ters gitti', saved: 'Kaydedildi: Dil' },
    en: { title: 'Settings', features: 'Features', notFound: 'Page not found',
      serverError: 'Something went wrong', saved: 'Saved: Language' },
  };
  const check = async (language, stored = language) => {
    const text = expected[language];
    for (const path of pages) {
      const response = await get(path);
      assert.match(response.body, new RegExp(`<html lang="${language}"`, 'u'), `${path} in ${language}`);
      assert.match(response.body, new RegExp(`aria-label="${text.title}"`, 'u'), `${path} shell in ${language}`);
    }
    const settings = await get('/settings?saved=language');
    assert.match(settings.body, new RegExp(`<title>${text.title} · Cairnboard</title>`, 'u'));
    assert.match(settings.body, new RegExp(`<h2 id="settings-features-title">${text.features}</h2>`, 'u'));
    assert.match(settings.body, new RegExp(`role="status"[^>]*>${text.saved}`, 'u'));
    assert.match(settings.body, new RegExp(`name="language" value="${stored}" checked`, 'u'));
    // A page that throws inside the app answers 500 with the app's own error page, rendered now, in this language.
    // (/settings reads its view without a catch of its own, so a throw there escapes the page.)
    const view = f.settings.view;
    f.settings.view = () => { throw new Error('settings view failed'); };
    const logged = t.mock.method(console, 'error', () => {});
    const broken = await get('/settings');
    logged.mock.restore();
    f.settings.view = view;
    assert.equal(broken.status, 500);
    assert.match(broken.body, new RegExp(`<html lang="${language}"`, 'u'));
    assert.match(broken.body,
      new RegExp(`<h1 id="state-title">${text.serverError}</h1>`, 'u'));
    const missing = await get('/does-not-exist');
    assert.equal(missing.status, 404);
    assert.match(missing.body, new RegExp(`<h1 id="state-title">${text.notFound}</h1>`, 'u'));
    // Markdown is rendered in the worker thread; it carries no interface text, and the page around it follows.
    const day = await get('/journal/2026-11-08');
    assert.equal(day.status, 200);
    assert.match(day.body, /<strong>bold<\/strong> step through the worker/u);
  };

  // The file's interface language is Turkish while the fresh data folder says English, as after a CLI change.
  await check('tr', 'en');
  const first = await save('en');
  assert.equal(first.status, 303);
  assert.equal(first.headers.location, '/settings?saved=language');
  assert.equal(readEvents(f.open()).length, 0, 'the stored value was already English');
  await check('en');
  f.tick(1000);
  assert.equal((await save('tr')).status, 303);
  assert.equal(loadConfig(f.dataDir).language, 'tr');
  await check('tr');
  f.tick(1000);
  assert.equal((await save('en')).status, 303);
  await check('en');
  assert.deepEqual(readEvents(f.open()).map((event) => [event.op, event.fields]),
    [['config.change', ['language']], ['config.change', ['language']]]);
});
