import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CSP, createGuard } from '../server/guard.mjs';
import { stateDir } from '../core/roots.mjs';
import {
  cookieName, loginUrl, mintCookie, mintToken, readCookie, sessionKey, tokenVerifier, verifyCookie, TOKEN_TTL_MS,
} from '../server/session.mjs';
import { tempDir } from './support/env.mjs';

const PORT = 4330;
const key = Buffer.alloc(32, 7);

/** Runs the guard against a fake request and records what it answered. */
function call(guardFn, { url = '/', host = `127.0.0.1:${PORT}`, method = 'GET', cookie } = {}) {
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
  const token = mintToken(key, PORT, now);
  const response = call(guardFn, { url: `/auth?t=${token}` });
  assert.equal(response.status, 303);
  return response.headers['set-cookie'].split(';')[0];
}

test('security headers are on every answer, including refusals', () => {
  const guardFn = createGuard({ port: PORT, key });
  for (const options of [{}, { host: 'evil.test' }, { host: `localhost:${PORT}` }, { method: 'POST' }, { url: '/auth?t=x' }]) {
    const { headers } = call(guardFn, options);
    assert.equal(headers['content-security-policy'], CSP);
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['referrer-policy'], 'no-referrer');
    assert.equal(headers['cache-control'], 'no-store');
  }
});

test('only 127.0.0.1:<port> is served; localhost is redirected before any cookie check', () => {
  const guardFn = createGuard({ port: PORT, key });
  for (const host of ['evil.test', `evil.test:${PORT}`, '127.0.0.1', `127.0.0.1:${PORT + 1}`, `[::1]:${PORT}`,
    `LOCALHOST:${PORT}`, `127.0.0.1:${PORT}.evil.test`, '', null]) {
    assert.equal(call(guardFn, { host }).status, 421, String(host));
  }
  const redirect = call(guardFn, { host: `localhost:${PORT}`, url: '/cards/c-1?x=1' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, `http://127.0.0.1:${PORT}/cards/c-1?x=1`);
  // A scheme-relative request target cannot turn the redirect into another host.
  const odd = call(guardFn, { host: `localhost:${PORT}`, url: '//evil.test/x' });
  assert.equal(new URL(odd.headers.location).host, `127.0.0.1:${PORT}`);
});

test('without a cookie every page, reads included, gets the sign-in page; built assets stay public', () => {
  const guardFn = createGuard({ port: PORT, key });
  for (const url of ['/', '/cards/c-1', '/api/board', '/404.html', '/auth']) {
    const response = call(guardFn, { url });
    assert.equal(response.status, 401, url);
    assert.match(response.body, /cairn open/);
    assert.doesNotMatch(response.body, /<script|<style|style=/);
  }
  assert.equal(call(guardFn, { url: '/_astro/index.abc.js' }).passed, true);
  assert.equal(call(guardFn, { url: '/_astro/../api/board' }).status, 401);
});

test('a token signs the browser in once, sets a strict cookie and clears the address bar', () => {
  let now = 1_800_000_000_000;
  const guardFn = createGuard({ port: PORT, key, now: () => now });
  const token = mintToken(key, PORT, now);
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
  const guardFn = createGuard({ port: PORT, key, now: () => now });
  const expired = mintToken(key, PORT, now - TOKEN_TTL_MS - 1);
  const otherPort = mintToken(key, PORT + 1, now);
  const otherKey = mintToken(Buffer.alloc(32, 8), PORT, now);
  const [nonce, expires, mac] = mintToken(key, PORT, now).split('.');
  const extended = `${nonce}.${Number(expires) + 3_600_000}.${mac}`;
  for (const token of [expired, otherPort, otherKey, extended, '', 'a.b.c', `${'x'.repeat(300)}`]) {
    assert.equal(call(guardFn, { url: `/auth?t=${encodeURIComponent(token)}` }).status, 401, token.slice(0, 20));
  }
  // A cookie minted for the token purpose, or the token itself as a cookie, is not a session.
  assert.equal(call(guardFn, { url: '/', cookie: `${cookieName(PORT)}=${mintToken(key, PORT, now)}` }).status, 401);
});

test('a cookie is bound to its port and name; duplicates and copies fail closed', () => {
  const now = 1_800_000_000_000;
  const guardFn = createGuard({ port: PORT, key, now: () => now });
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
  const url = new URL(loginUrl(PORT, key));
  assert.equal(url.origin, `http://127.0.0.1:${PORT}`);
  const verify = tokenVerifier(key, PORT);
  const token = url.searchParams.get('t');
  assert.equal(verify(token), true);
  assert.equal(verify(token), false);
  assert.equal(readCookie('a=1; cairn_1=x', 'cairn_1'), 'x');
  assert.equal(readCookie('cairn_10=x', 'cairn_1'), null);
  assert.equal(readCookie(undefined, 'cairn_1'), null);
  assert.throws(() => createGuard({ port: PORT }), TypeError);
});
