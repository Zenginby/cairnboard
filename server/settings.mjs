// The Settings page's data and its two write routes (spec §6). The shared checks of every write (rate, content type,
// body size, CSRF token) live in writes.mjs; a route here checks only its own fields.
import { CairnError } from '../core/errors.mjs';
import { features } from '../core/config.mjs';
import { clearShadow, readSettings, setFeature } from '../core/settings.mjs';
import { cookieName, csrfToken, readCookie } from './session.mjs';
import { BODY_LIMIT, createWrites } from './writes.mjs';

export { BODY_LIMIT };
export const FEATURES = Object.freeze(['changeTrail', 'changeContent', 'liveUpdates', 'mentions']);
const REVISION = /^[0-9a-f]{16}$/u;
const BACK = Object.freeze({ href: '/settings', label: 'settings.back' });
const BAD = Object.freeze({ status: 400, title: 'write.badRequestTitle', message: 'write.badRequest' });

const only = (values, names) => Object.keys(values).every((name) => names.includes(name));

/** Settings wording for the core errors a settings write can meet; anything else falls to the shared pages. */
function failure(error) {
  if (error.code === 'conflict') return { status: 409, title: 'settings.conflictTitle', message: 'settings.conflict' };
  if (error.code === 'locked') {
    return { status: 503, title: 'settings.busyTitle', message: 'settings.busy', headers: { 'Retry-After': '1' } };
  }
  if (error.code === 'validation' || error.code === 'format_too_new' || error.code === 'not_found') {
    return { status: 409, title: 'settings.invalidTitle', message: 'settings.invalidWrite' };
  }
  return null;
}

/**
 * @param {{ key: Buffer, port: number, open: () => any, openWrite: () => any,
 *   now?: () => number, limit?: number }} options
 * `open` returns a read context, `openWrite` a write context acting as the web owner; both may throw.
 * `routes` goes into the server's write table; `handle` serves them alone (tests, or a server with no other writes).
 */
export function createSettings({ key, port, open, openWrite, now = Date.now, limit = 5 }) {
  const name = cookieName(port);
  const routes = [
    { path: '/settings/feature', form: 'settings', back: BACK, failure,
      run({ values }) {
        if (!only(values, ['name', 'value', 'revision']) || Object.keys(values).length !== 3
          || !FEATURES.includes(values.name) || !['on', 'off'].includes(values.value)
          || !REVISION.test(values.revision)) return BAD;
        setFeature(openWrite(), { name: values.name, value: values.value === 'on',
          expectedRevision: values.revision, actor: 'web:owner' });
        return `/settings?saved=${values.name}`;
      } },
    { path: '/settings/clear-shadow', form: 'settings', back: BACK, failure,
      run({ values }) {
        if (!only(values, ['confirm']) || values.confirm !== 'yes') {
          return { ...BAD, message: 'settings.confirmMissing' };
        }
        clearShadow(openWrite(), { actor: 'web:owner' });
        return '/settings?saved=shadow';
      } },
  ];
  const { handle } = createWrites({ key, port, routes, now, limit });

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

  return { handle, routes, view, liveUpdates };
}
