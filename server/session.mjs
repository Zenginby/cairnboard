// Session key, one-time login tokens and session cookies for the local server.
// The key lives in the OS state folder (never the data folder) and survives restarts, so cookies stay valid.
// Tokens and cookies are HMACs over their purpose, the server port and an expiry: no server-side session table.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from '../core/roots.mjs';

export const TOKEN_TTL_MS = 60_000;
export const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
const KEY_FILE = 'session.key';
const KEY_BYTES = 32;

export const cookieName = (port) => `cairn_${port}`;

/** Reads the session key, creating it (0600, atomically) on first use. */
export function sessionKey(options = {}) {
  const dir = stateDir(options);
  const file = join(dir, KEY_FILE);
  const read = () => {
    const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64url');
    if (key.length !== KEY_BYTES) throw new Error('Session key is invalid; delete it and run cairn open again.');
    return key;
  };
  try { return read(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temp = join(dir, `.session-${randomBytes(8).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, randomBytes(KEY_BYTES).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
    // link() fails if the key already exists, so when two processes race the first key wins and both read it.
    // rename() would let the second silently replace a key the first process may already be using.
    try { linkSync(temp, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally {
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return read();
}

const mac = (key, ...parts) => createHmac('sha256', key).update(parts.join('|')).digest('base64url');

function equal(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function sign(key, purpose, port, expires) {
  const nonce = randomBytes(16).toString('base64url');
  return `${nonce}.${expires}.${mac(key, 'cairn-v1', purpose, port, nonce, expires)}`;
}

function verify(key, purpose, port, value, now) {
  if (typeof value !== 'string' || value.length > 200) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [nonce, expiresText, signature] = parts;
  if (!/^[A-Za-z0-9_-]{22}$/u.test(nonce) || !/^[0-9]{1,15}$/u.test(expiresText)) return null;
  const expires = Number(expiresText);
  if (!equal(signature, mac(key, 'cairn-v1', purpose, port, nonce, expires))) return null;
  if (expires <= now) return null;
  return { nonce, expires };
}

// Tokens are bound to one server run (a random id in server.json): a token that reached the wrong process, e.g.
// through a stale record whose pid was reused, is useless to any later Cairnboard server. Cookies are not bound to
// a run, so they survive restarts.
const INSTANCE = /^[A-Za-z0-9_-]{16,64}$/u;
const tokenPurpose = (instance) => {
  if (typeof instance !== 'string' || !INSTANCE.test(instance)) throw new TypeError('A server instance id is required.');
  return `token:${instance}`;
};

export const newInstanceId = () => randomBytes(16).toString('base64url');

export function mintToken(key, port, instance, now = Date.now()) {
  return sign(key, tokenPurpose(instance), port, now + TOKEN_TTL_MS);
}

export function mintCookie(key, port, now = Date.now()) {
  return sign(key, 'cookie', port, now + COOKIE_MAX_AGE_S * 1000);
}

export function verifyCookie(key, port, value, now = Date.now()) {
  return verify(key, 'cookie', port, value, now) !== null;
}

/** One-time use: remembers spent nonces until they expire; a restart gets a new instance id, so none carry over. */
export function tokenVerifier(key, port, instance) {
  const purpose = tokenPurpose(instance);
  const spent = new Map();
  return (value, now = Date.now()) => {
    for (const [nonce, expires] of spent) if (expires <= now) spent.delete(nonce);
    const token = verify(key, purpose, port, value, now);
    if (!token || spent.has(token.nonce)) return false;
    spent.set(token.nonce, token.expires);
    return true;
  };
}

/**
 * The anti-forgery token for one form: bound to the session cookie, so another session's token fails, and to the
 * form's name, so a token read from one page does not open another form's write.
 */
export function csrfToken(key, port, cookie, form = 'settings') {
  if (typeof cookie !== 'string' || !cookie) throw new TypeError('A session cookie is required.');
  if (typeof form !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/u.test(form)) throw new TypeError('Invalid form name.');
  return mac(key, 'cairn-v1', 'csrf', form, port, cookie);
}

export function verifyCsrf(key, port, cookie, token, form = 'settings') {
  if (typeof cookie !== 'string' || !cookie || typeof token !== 'string' || token.length > 100) return false;
  return equal(token, csrfToken(key, port, cookie, form));
}

/** Value of one cookie from a Cookie header, or null. Duplicate names are treated as absent. */
export function readCookie(header, name) {
  if (typeof header !== 'string') return null;
  const values = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : null;
}

// Browsers keep cookies per host name, never per port, and treat every port of a host as the same site. On a fixed
// name (127.0.0.1, or even cairnboard.localhost) another local account could serve a page on another port of that
// name and receive our cookie. The site name therefore carries a label derived from the private key: nobody without
// the key can build a link to it. *.localhost always resolves to the loopback (browsers and the macOS resolver).
export const SITE_DOMAIN = 'cairnboard.localhost';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function siteHost(key) {
  const digest = createHmac('sha256', key).update('cairn-v1|site-name').digest();
  let label = '';
  for (let i = 0; i < 26; i += 1) label += BASE32[digest[i] & 31];
  return `${label}.${SITE_DOMAIN}`;
}

export function siteOrigin(key, port) {
  return `http://${siteHost(key)}:${port}`;
}

export function loginUrl(port, key, instance) {
  return `${siteOrigin(key, port)}/auth?t=${mintToken(key, port, instance)}`;
}
