import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CSP, createGuard } from '../server/guard.mjs';
import { stateDir } from '../core/roots.mjs';
import {
  cookieName, loginUrl, mintCookie, mintToken, readCookie, sessionKey, siteHost, tokenVerifier, verifyCookie, TOKEN_TTL_MS,
} from '../server/session.mjs';
import { tempDir } from './support/env.mjs';

const PORT = 4330;
const key = Buffer.alloc(32, 7);
const instance = 'run-aaaaaaaaaaaaaaaa';
const SITE = `${siteHost(key)}:${PORT}`;

/** Runs the guard against a fake request and records what it answered. */
function call(guardFn, { url = '/', host = SITE, method = 'GET', cookie } = {}) {
  const headers = {};
  const res = {
    status: null, body: undefined, ended: false,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    writeHead(status, extra = {}) {
      this.status = status;
      for (const [name, value] of Object.entries(extra)) headers[name.toLowerCase()] = value;
    },
    end(body) { this.ended = true; this.body = body; },
  };
  const req = { url, method, headers: { ...(host === null ? {} : { host }), ...(cookie ? { cookie } : {}) } };
  const passed = guardFn(req, res);
  return { passed, status: passed ? 200 : res.status, headers, body: res.body === undefined ? '' : String(res.body) };
}

function signIn(guardFn, now) {
  const token = mintToken(key, PORT, instance, now);
  const response = call(guardFn, { url: `/auth?t=${token}` });
  assert.equal(response.status, 303);
  return response.headers['set-cookie'].split(';')[0];
}

test('security headers are on every answer, including refusals', () => {
  const guardFn = createGuard({ port: PORT, key, instance });
  for (const options of [{}, { host: 'evil.test' }, { host: `127.0.0.1:${PORT}` }, { method: 'POST' }, { url: '/auth?t=x' }]) {
    const { headers } = call(guardFn, options);
    assert.equal(headers['content-security-policy'], CSP);
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['referrer-policy'], 'no-referrer');
    assert.equal(headers['cache-control'], 'no-store');
  }
});

test('only the private site name with our port is served; nothing else is redirected or named', () => {
  const guardFn = createGuard({ port: PORT, key, instance });
  const label = siteHost(key).split('.')[0];
  assert.match(siteHost(key), /^[a-z2-7]{26}\.cairnboard\.localhost$/u);
  assert.notEqual(siteHost(Buffer.alloc(32, 8)), siteHost(key), 'the name comes from the key');
  for (const host of ['evil.test', `evil.test:${PORT}`, `127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`,
    `cairnboard.localhost:${PORT}`, `other.cairnboard.localhost:${PORT}`, siteHost(key), `${siteHost(key)}:${PORT + 1}`,
    `${siteHost(key).toUpperCase()}:${PORT}`, `${siteHost(key)}.:${PORT}`, `x.${siteHost(key)}:${PORT}`, '', null]) {
    const response = call(guardFn, { host });
    assert.equal(response.status, 421, String(host));
    assert.equal(response.headers.location, undefined);
    assert.ok(!response.body.includes(label), 'a refusal must not reveal the site name');
  }
  assert.equal(call(guardFn, { host: SITE }).status, 401);
});

test('without a cookie every page, reads included, gets the sign-in page; built assets stay public', () => {
  const guardFn = createGuard({ port: PORT, key, instance });
  for (const url of ['/', '/cards/c-1', '/api/board', '/404.html', '/auth']) {
    const response = call(guardFn, { url });
    assert.equal(response.status, 401, url);
    assert.match(response.body, /cairn open/);
    assert.doesNotMatch(response.body, /<script|<style|style=/);
  }
  assert.equal(call(guardFn, { url: '/_astro/index.abc.js' }).passed, true);
  assert.equal(call(guardFn, { url: '/_astro/../api/board' }).status, 401);
});

test('an asset path is public only as written: the guard and the router must read the same path', () => {
  const guardFn = createGuard({ port: PORT, key, instance });
  assert.equal(call(guardFn, { url: '/_astro/index.abc.js?v=1' }).passed, true);
  // URL parsing turns each of these into /_astro/…, while the router sees the raw path.
  for (const url of ['//host/_astro/x.js', '/api/%2e%2e/_astro/x.js', '/x/%2E%2E/_astro/x.js', '/_astro/%2e%2e/api/board',
    '/_astro/./x.js', '\\_astro/x.js', '/_astro\\..\\api/board']) {
    assert.equal(call(guardFn, { url }).status, 401, url);
  }
  assert.equal(call(guardFn, { url: '//host/auth?t=x' }).status, 401);
});

test('a token signs the browser in once, sets a strict cookie and clears the address bar', () => {
  let now = 1_800_000_000_000;
  const guardFn = createGuard({ port: PORT, key, instance, now: () => now });
  const token = mintToken(key, PORT, instance, now);
  const first = call(guardFn, { url: `/auth?t=${token}` });
  assert.equal(first.status, 303);
  assert.equal(first.headers.location, '/');
  const cookie = first.headers['set-cookie'];
  assert.match(cookie, new RegExp(`^${cookieName(PORT)}=[^;]+; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000$`));
  // The same token a second time is refused (reload of a stale link, or someone who saw it).
  assert.equal(call(guardFn, { url: `/auth?t=${token}` }).status, 401);
  // With the cookie, the page and a repeated /auth both work.
  const value = cookie.split(';')[0];
  assert.equal(call(guardFn, { url: '/', cookie: value }).passed, true);
  const again = call(guardFn, { url: `/auth?t=${token}`, cookie: value });
  assert.equal(again.status, 303);
  assert.equal(again.headers['set-cookie'], undefined);
  now += 29 * 24 * 60 * 60 * 1000;
  assert.equal(call(guardFn, { url: '/', cookie: value }).passed, true);
  now += 2 * 24 * 60 * 60 * 1000;
  assert.equal(call(guardFn, { url: '/', cookie: value }).status, 401, 'cookie expires after 30 days');
});

test('expired, forged and other-port tokens are refused', () => {
  const now = 1_800_000_000_000;
  const guardFn = createGuard({ port: PORT, key, instance, now: () => now });
  const expired = mintToken(key, PORT, instance, now - TOKEN_TTL_MS - 1);
  const otherPort = mintToken(key, PORT + 1, instance, now);
  const otherKey = mintToken(Buffer.alloc(32, 8), PORT, instance, now);
  const otherRun = mintToken(key, PORT, 'run-bbbbbbbbbbbbbbbb', now);
  const [nonce, expires, mac] = mintToken(key, PORT, instance, now).split('.');
  const extended = `${nonce}.${Number(expires) + 3_600_000}.${mac}`;
  for (const token of [expired, otherPort, otherKey, otherRun, extended, '', 'a.b.c', `${'x'.repeat(300)}`]) {
    assert.equal(call(guardFn, { url: `/auth?t=${encodeURIComponent(token)}` }).status, 401, token.slice(0, 20));
  }
  // A cookie minted for the token purpose, or the token itself as a cookie, is not a session.
  assert.equal(call(guardFn, { url: '/', cookie: `${cookieName(PORT)}=${mintToken(key, PORT, instance, now)}` }).status, 401);
});

test('a cookie is bound to its port and name; duplicates and copies fail closed', () => {
  const now = 1_800_000_000_000;
  const guardFn = createGuard({ port: PORT, key, instance, now: () => now });
  const other = mintCookie(key, PORT + 1, now);
  assert.equal(call(guardFn, { url: '/', cookie: `${cookieName(PORT + 1)}=${other}` }).status, 401);
  assert.equal(call(guardFn, { url: '/', cookie: `${cookieName(PORT)}=${other}` }).status, 401);
  const mine = signIn(guardFn, now);
  assert.equal(call(guardFn, { url: '/', cookie: `${mine}; ${mine}` }).status, 401);
  assert.equal(call(guardFn, { url: '/', cookie: `x=1; ${mine}; y=2` }).passed, true);
});

test('the session key is created once, private and stable across restarts', (t) => {
  const home = tempDir(t);
  const options = { home, env: { XDG_STATE_HOME: join(home, 'state'), LOCALAPPDATA: join(home, 'local') } };
  const first = sessionKey(options);
  assert.equal(first.length, 32);
  assert.deepEqual(sessionKey(options), first);
  const file = join(stateDir(options), 'session.key');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  // A cookie issued before a restart is still valid after it.
  assert.equal(verifyCookie(sessionKey(options), PORT, mintCookie(first, PORT)), true);
  writeFileSync(file, 'short\n');
  assert.throws(() => sessionKey(options), /Session key is invalid/);
});

test('helpers: login URL, cookie parsing and the one-time verifier', () => {
  const url = new URL(loginUrl(PORT, key, instance));
  assert.equal(url.origin, `http://${SITE}`);
  const verify = tokenVerifier(key, PORT, instance);
  const token = url.searchParams.get('t');
  assert.equal(verify(token), true);
  assert.equal(verify(token), false);
  assert.equal(readCookie('a=1; cairn_1=x', 'cairn_1'), 'x');
  assert.equal(readCookie('cairn_10=x', 'cairn_1'), null);
  assert.equal(readCookie(undefined, 'cairn_1'), null);
  assert.throws(() => createGuard({ port: PORT }), TypeError);
  assert.throws(() => createGuard({ port: PORT, key }), TypeError, 'a guard without a run id would accept no tokens');
  assert.throws(() => mintToken(key, PORT, 'short'), TypeError);
});
