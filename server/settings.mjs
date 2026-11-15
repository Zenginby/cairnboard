// The Settings page's data and its write routes (spec §6). The shared checks of every write (rate, content type,
// body size, CSRF token) live in writes.mjs; a route here checks only its own fields.
import { CairnError } from '../core/errors.mjs';
import { features } from '../core/config.mjs';
import { clearShadow, LANGUAGES, previewConfig, readSettings, setConfig, setFeature, setHomeProjects,
  setLanguage } from '../core/settings.mjs';
import { HOME_PROJECTS_MAX } from '../core/config.mjs';
import { normalizeId } from '../core/ids.mjs';
import { cookieName, csrfToken, readCookie } from './session.mjs';
import { BODY_LIMIT, createWrites } from './writes.mjs';
import { useLanguage } from '../src/i18n/index.mjs';

export { BODY_LIMIT };
export const FEATURES = Object.freeze(['changeTrail', 'changeContent', 'liveUpdates', 'mentions']);
const REVISION = /^[0-9a-f]{16}$/u;
const BACK = Object.freeze({ href: '/settings', label: 'settings.back' });
const HOME = Object.freeze({ href: '/', label: 'error.home' });
// The Home project picker sends `listed:<id>=1` for every project it offers and `project:<id>=on` for each ticked one
// (the form layer refuses repeated names, so each project has its own field names).
const PROJECT_FIELD = /^(listed|project):(.+)$/u;
const BAD = Object.freeze({ status: 400, title: 'write.badRequestTitle', message: 'write.badRequest' });

const only = (values, names) => Object.keys(values).every((name) => names.includes(name));
/** Exactly these fields, no more and no fewer. */
const exactly = (values, names) => Object.keys(values).length === names.length && only(values, names);
// One pattern for every column action. A hand-written key longer than 64 characters cannot be edited from the web.
const COLUMN_PATH = /^\/settings\/board\/columns\/(?<key>[a-z][a-z0-9-]{0,63})\/(?<action>label|hidden|up|down)$/u;
const COLUMN_KEY = /^[a-z][a-z0-9-]{0,63}$/u;
const MINUTES = /^[1-9][0-9]{0,3}$/u;
// A submitted label longer than this is refused as a malformed request; the core's own limit is far lower.
const LABEL_FIELD_MAX = 200;
const BOARD_SAVED = '/settings?saved=board#settings-board';
const refused = (message) => Object.freeze({ status: 400, title: 'write.badRequestTitle', message });
// The core's fixed reason codes for a refused board write. Only these keys ever reach the page; the core's message
// and the submitted value never do.
const BOARD_REASONS = Object.freeze({
  label_empty: refused('settings.board.labelEmpty'),
  label_long: refused('settings.board.labelLong'),
  label_chars: refused('settings.board.labelChars'),
  label_duplicate: refused('settings.board.labelDuplicate'),
  role_first_hidden: refused('settings.board.roleFirstHidden'),
  lease_range: refused('settings.board.leaseRange'),
  column_unknown: BAD,
  move_edge: BAD,
  order_mismatch: BAD,
});

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

/** A board write's refusal: a known reason code first, then the settings wording above. */
function boardFailure(error) {
  const reason = error.code === 'validation' ? error.details?.reason : undefined;
  if (typeof reason === 'string' && Object.hasOwn(BOARD_REASONS, reason)) return BOARD_REASONS[reason];
  return failure(error);
}

/** What one column action asks of the core, or null when its fields are not exactly the expected ones. */
function columnChange(key, action, values) {
  if (action === 'label') {
    if (!exactly(values, ['label', 'revision']) || [...values.label].length > LABEL_FIELD_MAX) return null;
    return { labels: { [key]: values.label } };
  }
  if (action === 'hidden') {
    if (!exactly(values, ['value', 'revision']) || !['on', 'off'].includes(values.value)) return null;
    return { hidden: { [key]: values.value === 'on' } };
  }
  if (!exactly(values, ['revision'])) return null;
  return { move: { key, by: action === 'up' ? -1 : 1 } };
}

/** Whether the writer would accept these column changes on `config`; only its own refusals count as no. */
function allowed(config, columns) {
  try {
    previewConfig(config, { columns });
    return true;
  } catch (error) {
    if (error instanceof CairnError && error.code === 'validation') return false;
    throw error;
  }
}

/** The Board card's rows: each column with the actions the writer would accept right now. */
function boardColumns(config, columns) {
  return columns.map((column) => {
    const editable = COLUMN_KEY.test(column.key);
    const can = (change) => editable && allowed(config, change);
    return { ...column, editable,
      canToggle: can({ hidden: { [column.key]: !column.hidden } }),
      canUp: can({ move: { key: column.key, by: -1 } }),
      canDown: can({ move: { key: column.key, by: 1 } }) };
  });
}

/**
 * @param {{ key: Buffer, port: number, open: () => any, openWrite: () => any,
 *   now?: () => number, limit?: number, switchLanguage?: (language: string) => void }} options
 * `switchLanguage` moves the running interface to a saved language; the default sets it for the whole process.
 * `open` returns a read context, `openWrite` a write context acting as the web owner; both may throw.
 * `routes` goes into the server's write table; `handle` serves them alone (tests, or a server with no other writes).
 */
export function createSettings({ key, port, open, openWrite, now = Date.now, limit = 5,
  switchLanguage = useLanguage }) {
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
    { path: '/settings/language', form: 'settings', back: BACK, failure,
      run({ values }) {
        if (!only(values, ['language', 'revision']) || Object.keys(values).length !== 2
          || !LANGUAGES.includes(values.language) || !REVISION.test(values.revision)) return BAD;
        setLanguage(openWrite(), { language: values.language, expectedRevision: values.revision,
          actor: 'web:owner' });
        // Pages, write messages and the built app read the language from the process on every request, so the
        // next page is already in it. Also after an unchanged save: a CLI or hand edit may have left the running
        // interface behind the file.
        switchLanguage(values.language);
        return '/settings?saved=language';
      } },
    { path: '/settings/home-projects', form: 'home-projects', back: HOME, failure, bodyLimit: 16384,
      run({ values }) {
        const { revision, ...fields } = values;
        const listed = [], shown = [];
        for (const [field, value] of Object.entries(fields)) {
          const match = PROJECT_FIELD.exec(field);
          if (!match || normalizeId(match[2]) === null) return BAD;
          if (match[1] === 'listed' && value === '1') listed.push(match[2]);
          else if (match[1] === 'project' && value === 'on') shown.push(match[2]);
          else return BAD;
        }
        if (typeof revision !== 'string' || !REVISION.test(revision) || listed.length > HOME_PROJECTS_MAX
          || shown.some((id) => !listed.includes(id))) return BAD;
        setHomeProjects(openWrite(), { listed, shown, expectedRevision: revision, actor: 'web:owner' });
        return '/?saved=projects';
      } },
    { path: '/settings/clear-shadow', form: 'settings', back: BACK, failure,
      run({ values }) {
        if (!only(values, ['confirm']) || values.confirm !== 'yes') {
          return { ...BAD, message: 'settings.confirmMissing' };
        }
        clearShadow(openWrite(), { actor: 'web:owner' });
        return '/settings?saved=shadow';
      } },
    // The Board card: one small form per value, so a refused or conflicting save loses at most that one value.
    { path: COLUMN_PATH, form: 'settings', back: BACK, failure: boardFailure,
      run({ values, params }) {
        const columns = columnChange(params.key, params.action, values);
        if (!columns || !REVISION.test(values.revision)) return BAD;
        setConfig(openWrite(), { changes: { columns }, expectedRevision: values.revision, actor: 'web:owner' });
        return BOARD_SAVED;
      } },
    { path: '/settings/board/lease', form: 'settings', back: BACK, failure: boardFailure,
      run({ values }) {
        if (!exactly(values, ['minutes', 'revision']) || !REVISION.test(values.revision)) return BAD;
        if (!MINUTES.test(values.minutes)) return BOARD_REASONS.lease_range;
        setConfig(openWrite(), { changes: { leaseMinutes: Number(values.minutes) }, expectedRevision: values.revision,
          actor: 'web:owner' });
        return BOARD_SAVED;
      } },
  ];
  const { handle } = createWrites({ key, port, routes, now, limit });

  /** What the Settings page shows. `cookie` is the request's Cookie header; the token only ever goes to its owner. */
  function view(cookieHeader) {
    const session = readCookie(cookieHeader ?? undefined, name);
    const csrf = session ? csrfToken(key, port, session) : '';
    const invalid = (error) => ({ state: 'invalid', detail: error.message, csrf });
    let settings, columns;
    try {
      const ctx = open();
      settings = readSettings(ctx);
      // `readSettings` leaves the configuration it read in `ctx.config`, the one `settings.revision` names.
      columns = boardColumns(ctx.config, settings.columns);
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
    // `columns`: `{ key, label, role, hidden, editable, canToggle, canUp, canDown }` per column, in board order; a
    // form is drawn only for an action whose flag is true. `leaseMinutes` comes with the rest of `settings`.
    return { state: 'ready', csrf, ...settings, columns };
  }

  /** What the Home project picker needs to post: the CSRF token for this cookie and the config revision, or null. */
  function homeForm(cookieHeader) {
    const session = readCookie(cookieHeader ?? undefined, name);
    if (!session) return null;
    try {
      return { csrf: csrfToken(key, port, session, 'home-projects'),
        revision: readSettings(open(), { stats: false }).revision };
    } catch { return null; }
  }

  /** Whether pages load the live-update script; unreadable settings keep the default (on). */
  function liveUpdates() {
    try { return features(open().config).liveUpdates; } catch { return true; }
  }

  return { handle, routes, view, homeForm, liveUpdates };
}
