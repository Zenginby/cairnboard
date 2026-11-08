// The Settings page's data and its two write endpoints (spec §6). The guard has already checked Host, the session
// cookie, Origin and Sec-Fetch-Site; this module checks the rest: rate, content type, body size, CSRF token, fields.
import { CairnError } from '../core/errors.mjs';
import { features } from '../core/config.mjs';
import { clearShadow, readSettings, setFeature } from '../core/settings.mjs';
import { t } from '../src/i18n/index.mjs';
import { cookieName, csrfToken, readCookie, verifyCsrf } from './session.mjs';

export const BODY_LIMIT = 4096;
export const FEATURES = Object.freeze(['changeTrail', 'changeContent', 'liveUpdates', 'mentions']);
const REVISION = /^[0-9a-f]{16}$/u;

function page(res, status, titleKey, messageKey, headers = {}) {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${t(titleKey)} · ${t('app.name')}</title></head><body><main>
<h1>${t(titleKey)}</h1>
<p>${t(messageKey)}</p>
<p><a href="/settings">${t('settings.back')}</a></p>
</main></body></html>
`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
    ...headers });
  res.end(body);
  return true;
}

/** Reads at most `limit` bytes. Resolves null when the body is larger (reading stops), false when the client left. */
function readBody(req, limit) {
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > limit) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const finish = (value, error) => {
      req.off('data', onData).off('end', onEnd).off('error', onError).off('close', onClose);
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) { req.pause(); finish(null); } else chunks.push(chunk);
    };
    const onEnd = () => finish(Buffer.concat(chunks));
    const onError = (error) => finish(undefined, error);
    const onClose = () => finish(false);
    req.on('data', onData).on('end', onEnd).on('error', onError).on('close', onClose);
  });
}

/** Form fields as an object, or null when a name repeats. */
function fields(body) {
  const result = {};
  for (const [name, value] of new URLSearchParams(body.toString('utf8'))) {
    if (Object.hasOwn(result, name)) return null;
    result[name] = value;
  }
  return result;
}

const only = (values, names) => Object.keys(values).every((name) => names.includes(name));

/**
 * @param {{ key: Buffer, port: number, open: () => any, openWrite: () => any,
 *   now?: () => number, limit?: number }} options
 * `open` returns a read context, `openWrite` a write context acting as the web owner; both may throw.
 */
export function createSettings({ key, port, open, openWrite, now = Date.now, limit = 5 }) {
  const name = cookieName(port);
  const hits = new Map();

  /** Per-session write rate: at most `limit` requests in any second. */
  function limited(session) {
    const time = now();
    const recent = (hits.get(session) ?? []).filter((at) => at > time - 1000);
    const over = recent.length >= limit;
    if (!over) recent.push(time);
    hits.set(session, recent);
    if (hits.size > 256) for (const [other, times] of hits) if (times.at(-1) <= time - 1000) hits.delete(other);
    return over;
  }

  /** Maps a core error to the page that answers it; unknown errors are logged and become a plain 500. */
  function failure(res, error) {
    if (error instanceof CairnError) {
      if (error.code === 'conflict') return page(res, 409, 'settings.conflictTitle', 'settings.conflict');
      if (error.code === 'locked') return page(res, 503, 'settings.busyTitle', 'settings.busy', { 'Retry-After': '1' });
      if (error.code === 'validation' || error.code === 'format_too_new' || error.code === 'not_found') {
        return page(res, 409, 'settings.invalidTitle', 'settings.invalidWrite');
      }
    }
    console.error(error);
    return page(res, 500, 'settings.errorTitle', 'settings.error');
  }

  async function handle(req, res, path) {
    if (req.method !== 'POST' || (path !== '/settings/feature' && path !== '/settings/clear-shadow')) return false;
    const cookie = readCookie(req.headers.cookie, name);
    if (limited(cookie ?? '')) return page(res, 429, 'settings.rateTitle', 'settings.rate', { 'Retry-After': '1' });
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/x-www-form-urlencoded') {
      return page(res, 415, 'settings.badRequestTitle', 'settings.badType');
    }
    const body = await readBody(req, BODY_LIMIT);
    if (body === false) return true;
    if (body === null) return page(res, 413, 'settings.badRequestTitle', 'settings.tooLarge', { Connection: 'close' });
    const values = fields(body);
    const bad = () => page(res, 400, 'settings.badRequestTitle', 'settings.badRequest');
    if (!values) return bad();
    if (!verifyCsrf(key, port, cookie, values.csrf)) {
      return page(res, 403, 'settings.forbiddenTitle', 'settings.forbidden');
    }
    const { csrf: _csrf, ...rest } = values;
    let saved;
    try {
      if (path === '/settings/feature') {
        if (!only(rest, ['name', 'value', 'revision']) || Object.keys(rest).length !== 3
          || !FEATURES.includes(rest.name) || !['on', 'off'].includes(rest.value) || !REVISION.test(rest.revision)) {
          return bad();
        }
        setFeature(openWrite(), { name: rest.name, value: rest.value === 'on', expectedRevision: rest.revision,
          actor: 'web:owner' });
        saved = rest.name;
      } else {
        if (!only(rest, ['confirm']) || rest.confirm !== 'yes') {
          return page(res, 400, 'settings.badRequestTitle', 'settings.confirmMissing');
        }
        clearShadow(openWrite(), { actor: 'web:owner' });
        saved = 'shadow';
      }
    } catch (error) {
      return failure(res, error);
    }
    res.writeHead(303, { Location: `/settings?saved=${saved}`, 'Content-Length': 0 });
    res.end();
    return true;
  }

  /** What the Settings page shows. `cookie` is the request's Cookie header; the token only ever goes to its owner. */
  function view(cookieHeader) {
    const session = readCookie(cookieHeader ?? undefined, name);
    const csrf = session ? csrfToken(key, port, session) : '';
    const invalid = (error) => ({ state: 'invalid', detail: error.message, csrf });
    let settings;
    try {
      settings = readSettings(open());
    } catch (error) {
      if (error instanceof CairnError) {
        if (error.code === 'locked') return { state: 'busy', csrf };
        const badConfig = error.code === 'validation' && /^Invalid configuration/u.test(error.message);
        if (error.code === 'format_too_new' || badConfig) return invalid(error);
        if (error.code === 'validation' || error.code === 'not_found') return { state: 'notReady', csrf };
      }
      console.error(error);
      return { state: 'error', csrf };
    }
    return { state: 'ready', csrf, ...settings };
  }

  /** Whether pages load the live-update script; unreadable settings keep the default (on). */
  function liveUpdates() {
    try { return features(open().config).liveUpdates; } catch { return true; }
  }

  return { handle, view, liveUpdates };
}
