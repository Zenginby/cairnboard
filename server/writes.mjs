// The one place a POST is accepted (spec §5, §6.2). The guard has already checked Host, the session cookie, Origin
// and Sec-Fetch-Site; this module checks the rest for every route alike: rate, content type, body size, CSRF token
// and repeated fields. A route only validates its own fields and calls the core.
import { CairnError } from '../core/errors.mjs';
import { t } from '../src/i18n/index.mjs';
import { cookieName, csrfToken, readCookie, verifyCsrf } from './session.mjs';

export const BODY_LIMIT = 4096;
const FORM = /^[a-z][a-z0-9-]{0,31}$/u;
const escape = (text) => String(text).replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);

/** A small page without scripts or styles: a title, one message and a link back to where the form lives. */
export function messagePage(res, status, titleKey, messageKey, back, headers = {}) {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escape(t(titleKey))} · ${escape(t('app.name'))}</title></head><body><main>
<h1>${escape(t(titleKey))}</h1>
<p>${escape(t(messageKey))}</p>
<p><a href="${escape(back.href)}">${escape(t(back.label))}</a></p>
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

/** What a core error looks like to the owner; the core's own message is never shown. */
const FAILURES = {
  conflict: { status: 409, title: 'write.conflictTitle', message: 'write.conflict' },
  locked: { status: 503, title: 'write.busyTitle', message: 'write.busy', headers: { 'Retry-After': '1' } },
  validation: { status: 400, title: 'write.badRequestTitle', message: 'write.invalid' },
  not_found: { status: 404, title: 'write.notFoundTitle', message: 'write.notFound' },
};

function checkRoute(route) {
  const { path, form, back, run, bodyLimit = BODY_LIMIT, failure } = route ?? {};
  const exact = typeof path === 'string' && path.startsWith('/');
  // A pattern must cover the whole target, or `/x/../settings` style targets could ride on a partial match.
  const pattern = path instanceof RegExp && path.source.startsWith('^') && path.source.endsWith('$') && !path.global
    && !path.sticky;
  if (!exact && !pattern) throw new TypeError('A write route needs an absolute path or an anchored pattern.');
  if (typeof form !== 'string' || !FORM.test(form)) throw new TypeError('A write route needs a form name.');
  if (typeof run !== 'function') throw new TypeError('A write route needs a run function.');
  if (typeof back?.href !== 'string' || typeof back?.label !== 'string') {
    throw new TypeError('A write route needs a back link.');
  }
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 1) throw new TypeError('A write route needs a body limit.');
  if (failure !== undefined && typeof failure !== 'function') throw new TypeError('failure must be a function.');
  return { path, form, back, run, bodyLimit, failure };
}

/**
 * @param {{ key: Buffer, port: number, now?: () => number, limit?: number, routes: Array<{
 *   path: string | RegExp, form: string, back: { href: string, label: string }, bodyLimit?: number,
 *   run: (input: { values: Record<string, string>, params: Record<string, string> }) => any,
 *   failure?: (error: CairnError) => any }> }} options
 * `run` returns the address to redirect to (303), or `{ status, title, message, headers? }` to refuse with a page;
 * it may be async and may throw a CairnError. `failure` may map a CairnError to such a page before the defaults.
 */
export function createWrites({ key, port, routes, now = Date.now, limit = 5 }) {
  const table = routes.map(checkRoute);
  const name = cookieName(port);
  const hits = new Map();

  /** The route for an exact request target (no query string, no encoding tricks) and its path parameters. */
  function find(target) {
    if (typeof target !== 'string') return null;
    for (const route of table) {
      if (typeof route.path === 'string') {
        if (route.path === target) return { route, params: {} };
      } else {
        const match = route.path.exec(target);
        if (match) return { route, params: { ...match.groups } };
      }
    }
    return null;
  }

  /** Per-session write rate: at most `limit` requests in any second, over every route together. */
  function limited(session) {
    const time = now();
    const recent = (hits.get(session) ?? []).filter((at) => at > time - 1000);
    const over = recent.length >= limit;
    if (!over) recent.push(time);
    hits.set(session, recent);
    if (hits.size > 256) for (const [other, times] of hits) if (times.at(-1) <= time - 1000) hits.delete(other);
    return over;
  }

  async function handle(req, res) {
    const found = req.method === 'POST' ? find(req.url) : null;
    if (!found) return false;
    const { route, params } = found;
    const page = ({ status, title, message, headers }) => messagePage(res, status, title, message, route.back, headers);
    const cookie = readCookie(req.headers.cookie, name);
    if (limited(cookie ?? '')) {
      return page({ status: 429, title: 'write.rateTitle', message: 'write.rate', headers: { 'Retry-After': '1' } });
    }
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/x-www-form-urlencoded') {
      return page({ status: 415, title: 'write.badRequestTitle', message: 'write.badType' });
    }
    const body = await readBody(req, route.bodyLimit);
    if (body === false) return true;
    if (body === null) {
      return page({ status: 413, title: 'write.badRequestTitle', message: 'write.tooLarge',
        headers: { Connection: 'close' } });
    }
    const all = fields(body);
    if (!all) return page({ status: 400, title: 'write.badRequestTitle', message: 'write.badRequest' });
    if (!verifyCsrf(key, port, cookie, all.csrf, route.form)) {
      return page({ status: 403, title: 'write.forbiddenTitle', message: 'write.forbidden' });
    }
    const { csrf: _csrf, ...values } = all;
    let result;
    try {
      result = await route.run({ values, params });
    } catch (error) {
      const known = error instanceof CairnError ? route.failure?.(error) ?? FAILURES[error.code] : null;
      if (known) return page(known);
      console.error(error);
      return page({ status: 500, title: 'write.errorTitle', message: 'write.error' });
    }
    const failed = () => page({ status: 500, title: 'write.errorTitle', message: 'write.error' });
    if (typeof result !== 'string') {
      if (Number.isSafeInteger(result?.status) && typeof result.title === 'string'
        && typeof result.message === 'string') return page(result);
      console.error(new TypeError('A write route returned neither an address nor a page.'));
      return failed();
    }
    // Only a path on this site: `//host`, a scheme or a line break would send the owner elsewhere.
    if (!/^\/(?![/\\])[^\r\n]*$/u.test(result)) {
      console.error(new TypeError('A write route returned an address outside this site.'));
      return failed();
    }
    res.writeHead(303, { Location: result, 'Content-Length': 0 });
    res.end();
    return true;
  }

  /** The token a page puts in the hidden `csrf` field of `form`; empty without a session. */
  function token(cookieHeader, form) {
    const session = readCookie(cookieHeader ?? undefined, name);
    return session ? csrfToken(key, port, session, form) : '';
  }

  return { handle, writable: (target) => find(target) !== null, token };
}
