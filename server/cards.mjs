// Card forms use the same write checks as Settings; only card fields are validated here.
import { createHash } from 'node:crypto';
import { addCard, moveCard, checkCard, commentCard, archiveColumn } from '../core/card.mjs';
import * as entity from '../core/entity.mjs';
import { acceptanceItems } from '../core/frontmatter.mjs';
import * as project from '../core/project.mjs';
import { CairnError } from '../core/errors.mjs';
import { stripHidden } from '../core/text.mjs';
import { createWrites } from './writes.mjs';

const PRIORITIES = ['', 'urgent', 'important', 'low'];
/** A front matter value as a form field carries it; a missing one is the empty choice. */
const stored = (value) => (value === undefined || value === null ? '' : String(value));
/** Names an Acceptance item by its text, so a check request can say which item the owner clicked. */
const mark = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const bad = (message) => ({ status: 400, title: 'write.badRequestTitle', message });
const NOT_READY = Object.freeze({ status: 409, title: 'state.notReadyTitle', message: 'card.notReady' });
/** The data folder is missing, not initialised or newer than this version: nothing a form field can fix. */
const notReady = (error) => error instanceof CairnError
  && ['validation', 'not_found', 'format_too_new'].includes(error.code);

/** `openWrite` supplies the web:owner actor, just as the CLI supplies its write context. */
export function createCards({ key, port, open, openWrite }) {
  const routes = [{ path: '/cards', form: 'card', back: { href: '/board', label: 'card.back' },
    run({ values }) {
      if (Object.keys(values).some((name) => !['title', 'column', 'project', 'priority'].includes(name))) {
        return bad('card.invalidFields');
      }
      // One visible line: no line breaks or tabs, and none of the invisible characters the core strips elsewhere.
      const title = values.title?.trim();
      if (!title || title.length > 200 || /[\t\r\n\u0085]/u.test(values.title)
        || stripHidden(values.title).removed > 0) return bad('card.invalidTitle');
      if (!PRIORITIES.includes(values.priority ?? '')) return bad('card.invalidPriority');
      let ctx;
      try { ctx = open(); } catch (error) {
        if (notReady(error)) return NOT_READY;
        throw error;
      }
      if (!ctx.config.columns.some(({ key }) => key === values.column)) return bad('card.invalidColumn');
      const fields = { title, column: values.column };
      if (values.project) {
        try {
          const resolved = project.resolve(ctx, values.project);
          fields.project = resolved.id ?? resolved.ref;
        } catch (error) {
          if (error instanceof CairnError && ['not_found', 'validation'].includes(error.code)) {
            return bad('card.invalidProject');
          }
          throw error;
        }
      }
      if (values.priority) fields.priority = values.priority;
      const changed = addCard(openWrite(), fields, '', {});
      return `/board#card-${changed.entity.id}`;
    } }];
  const ID = 'c-[0-9a-hjkmnp-tv-z]{6}';
  const back = ({ id }) => ({ href: `/cards/${id}`, label: 'card.backToCard' });
  const CONFLICT = Object.freeze({ status: 409, title: 'card.conflictTitle', message: 'card.conflict' });
  const failure = (error) => error.code === 'conflict' ? CONFLICT
    // An agent holds the card: the core refuses edits, moves and checks until it releases or its lease ends.
    : error.code === 'claimed' ? { status: 409, title: 'card.claimedTitle', message: 'card.claimed' }
      // The file itself needs repair (a copied card, front matter the core will not rewrite).
      : ['duplicate_id', 'unsupported_frontmatter'].includes(error.code)
        ? { status: 409, title: 'card.blockedTitle', message: 'card.blocked' }
        : error.code === 'validation' ? bad('card.invalidWrite') : undefined;
  // Browsers submit every line break as CRLF; the file keeps the line endings it already has.
  const lines = (text) => text.replace(/\r\n/gu, '\n');
  const MAX_BODY = 5 * 1024 * 1024;

  // Each action checks its fields, then plans against the card as it is now: `plan` returns a refusal page,
  // nothing when the card is already as asked, or the write to run with a write context.
  const actions = [
    { suffix: '', fields: ['title', 'priority', 'project', 'body', 'revision'],
      // A URL-encoded form spends three bytes on most non-ASCII bytes and six on a line break.
      bodyLimit: 4 * MAX_BODY + 4096,
      validate(values) {
        const title = values.title.trim();
        if (!title || title.length > 200 || /[\t\r\n\u0085]/u.test(values.title)
          || stripHidden(values.title).removed > 0) return bad('card.invalidTitle');
        if (!/^[0-9a-f]{16}$/iu.test(values.revision)) return bad('card.invalidRevision');
        if (Buffer.byteLength(lines(values.body)) > MAX_BODY) return bad('card.invalidBody');
      },
      // Only what the owner changed is written: an untouched title stays in the heading or file name it came
      // from, and an untouched project or priority keeps the value the file has, valid or not.
      plan(ctx, current, values) {
        const patch = {};
        const title = values.title.trim();
        if (title !== current.title) patch.title = title;
        if (values.priority !== stored(current.data.priority)) {
          if (!PRIORITIES.includes(values.priority)) return bad('card.invalidPriority');
          patch.priority = values.priority || undefined;
        }
        if (values.project !== stored(current.data.project)) {
          patch.project = undefined;
          if (values.project) {
            try {
              const resolved = project.resolve(ctx, values.project);
              patch.project = resolved.id ?? resolved.ref;
            } catch (error) {
              if (error instanceof CairnError && ['not_found', 'validation'].includes(error.code)) {
                return bad('card.invalidProject');
              }
              throw error;
            }
          }
        }
        const text = lines(values.body);
        const same = text === lines(current.body);
        if (same && !Object.keys(patch).length) return null;
        const body = same ? {} : { body: current.body.includes('\r\n') ? text.replace(/\n/gu, '\r\n') : text };
        return (write) => entity.update(write, 'card', current.id, patch, { ...body, ifRevision: values.revision });
      } },
    { suffix: '/move', fields: ['column'], plan(ctx, current, values) {
      if (!ctx.config.columns.some(({ key }) => key === values.column)) return bad('card.invalidColumn');
      return (write) => moveCard(write, current.id, { column: values.column });
    } },
    // Board buttons: a done card goes to the archive column, an archived one back to the first visible done column.
    // Both return to the board they were pressed on.
    { suffix: '/archive', fields: [], next: () => '/board', plan(ctx, current) {
      const target = archiveColumn(ctx.config);
      const column = ctx.config.columns.find(({ key }) => key === current.data.column);
      if (!target || column?.role !== 'done') return bad('card.invalidColumn');
      if (column.key === target.key) return null;
      return (write) => moveCard(write, current.id, { column: target.key });
    } },
    { suffix: '/restore', fields: [], next: () => '/board?archive', plan(ctx, current) {
      const column = ctx.config.columns.find(({ key }) => key === current.data.column);
      const target = ctx.config.columns.find((item) => item.role === 'done' && item.hidden !== true);
      if (!target || column?.hidden !== true) return bad('card.invalidColumn');
      return (write) => moveCard(write, current.id, { column: target.key });
    } },
    { suffix: '/check', fields: ['n', 'checked', 'mark'], validate(values) {
      if (!/^[1-9][0-9]{0,5}$/u.test(values.n)) return bad('card.invalidItem');
      if (!['on', 'off'].includes(values.checked)) return bad('card.invalidChecked');
      if (!/^[0-9a-f]{16}$/u.test(values.mark)) return bad('card.invalidItem');
    }, plan(ctx, current, values) {
      const item = acceptanceItems(current.body)[Number(values.n) - 1];
      // The number only means something for the list the owner saw; `mark` names the item that was clicked.
      if (!item || mark(item.text) !== values.mark) return CONFLICT;
      if (item.checked === (values.checked === 'on')) return null;
      // The revision ties the write to the file just read, so the number cannot shift in between.
      return (write) => checkCard(write, current.id, Number(values.n), { uncheck: values.checked === 'off' },
        { ifRevision: current.revision });
    } },
    { suffix: '/comment', fields: ['text'], bodyLimit: 4 * 4 * 2000 + 4096, validate(values) {
      const text = lines(values.text).trim();
      if (!text || text.length > 2000) return bad('card.invalidComment');
    }, plan(ctx, current, values) {
      return (write) => commentCard(write, current.id, lines(values.text).trim());
    } },
  ];
  for (const action of actions) routes.push({
    path: new RegExp(`^/cards/(?<id>${ID})${action.suffix}$`, 'u'), form: 'card', back, failure,
    ...(action.bodyLimit ? { bodyLimit: action.bodyLimit } : {}),
    run({ values, params: { id } }) {
      if (Object.keys(values).length !== action.fields.length
        || action.fields.some((name) => !Object.hasOwn(values, name))) return bad('card.invalidFields');
      const invalid = action.validate?.(values);
      if (invalid) return invalid;
      let ctx;
      try { ctx = open(); } catch (error) {
        if (notReady(error)) return NOT_READY;
        throw error;
      }
      // Existence and every read-only check come before a write context is opened.
      const plan = action.plan(ctx, entity.resolve(ctx, 'card', id), values);
      if (plan && typeof plan !== 'function') return plan;
      if (plan) plan(openWrite());
      if (action.next) return action.next(id);
      return `/cards/${id}${action.suffix === '/comment' ? '#comments' : ''}`;
    },
  });
  const writes = createWrites({ key, port, routes });

  /** What the form page shows; `state` is 'notReady' when the data folder cannot be opened yet. */
  function view(cookieHeader, id) {
    const csrf = writes.token(cookieHeader, 'card');
    let ctx;
    try { ctx = open(); } catch (error) {
      if (notReady(error)) return { state: 'notReady', csrf };
      throw error;
    }
    let card;
    if (id !== undefined) {
      // Only a card id opens the forms: the write routes accept nothing else.
      if (typeof id !== 'string' || !new RegExp(`^${ID}$`, 'u').test(id)) return { state: 'notFound', csrf };
      try { card = entity.resolve(ctx, 'card', id); } catch (error) {
        if (error instanceof CairnError && error.code === 'not_found') return { state: 'notFound', csrf };
        throw error;
      }
      if (!card.id) return { state: 'notFound', csrf };
    }
    // A project file without a status counts as active, as everywhere else.
    const active = ({ data }) => data.status === undefined || data.status === 'active';
    const chosen = stored(card?.data.project);
    const projects = project.list(ctx).filter((item) => active(item) || item.id === chosen || item.ref === chosen);
    const items = card ? acceptanceItems(card.body).map((item, index) => ({ n: index + 1, text: item.text,
      checked: item.checked, mark: mark(item.text) })) : [];
    return { state: 'ready', csrf, columns: ctx.config.columns, projects, card, items,
      project: chosen, priority: stored(card?.data.priority) };
  }

  return { routes, view };
}
