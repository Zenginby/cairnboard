// Card forms use the same write checks as Settings; only card fields are validated here.
import { addCard, moveCard, checkCard, commentCard } from '../core/card.mjs';
import * as entity from '../core/entity.mjs';
import { acceptanceItems } from '../core/frontmatter.mjs';
import * as project from '../core/project.mjs';
import { CairnError } from '../core/errors.mjs';
import { stripHidden } from '../core/text.mjs';
import { createWrites } from './writes.mjs';

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
      if (!['', 'urgent', 'important', 'low'].includes(values.priority ?? '')) return bad('card.invalidPriority');
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
  const cardPath = '/cards/(?<id>c-[0-9a-hjkmnp-tv-z]{6})';
  const back = ({ id }) => ({ href: `/cards/${id}`, label: 'card.backToCard' });
  const failure = (error) => error.code === 'conflict'
    ? { status: 409, title: 'card.conflictTitle', message: 'card.conflict' }
    // An agent holds the card: the core refuses edits, moves and checks until it releases or its lease ends.
    : error.code === 'claimed' ? { status: 409, title: 'card.claimedTitle', message: 'card.claimed' }
      : error.code === 'validation' ? bad('card.invalidWrite') : undefined;
  // Browsers submit every line break as CRLF; the file keeps the line endings it already has.
  const lines = (text) => text.replace(/\r\n/gu, '\n');
  const actions = [
    { suffix: '', fields: ['title', 'priority', 'project', 'body', 'revision'],
      // A 5 MiB document can expand threefold in a URL-encoded form, plus the other fields and CSRF token.
      bodyLimit: 3 * 5 * 1024 * 1024 + 4096,
      validate(values) {
        const title = values.title.trim();
        if (!title || title.length > 200 || /[\t\r\n\u0085]/u.test(values.title)
          || stripHidden(values.title).removed > 0) return bad('card.invalidTitle');
        if (!['', 'urgent', 'important', 'low'].includes(values.priority)) return bad('card.invalidPriority');
        if (!/^[0-9a-f]{16}$/iu.test(values.revision)) return bad('card.invalidRevision');
        if (Buffer.byteLength(lines(values.body)) > 5 * 1024 * 1024) return bad('card.invalidBody');
      },
      change(ctx, id, values, selected, current) {
        const body = current.body.includes('\r\n') ? lines(values.body).replace(/\n/gu, '\r\n') : lines(values.body);
        entity.update(ctx, 'card', id, { title: values.title.trim(), priority: values.priority || undefined,
          project: selected || undefined }, { body, ifRevision: values.revision });
      } },
    { suffix: '/move', fields: ['column'], change(ctx, id, values) {
      moveCard(ctx, id, { column: values.column });
    } },
    { suffix: '/check', fields: ['n', 'checked'], validate(values) {
      if (!/^[1-9][0-9]*$/u.test(values.n) || !Number.isSafeInteger(Number(values.n))) return bad('card.invalidItem');
      if (!['on', 'off'].includes(values.checked)) return bad('card.invalidChecked');
    }, change(ctx, id, values) {
      checkCard(ctx, id, Number(values.n), { uncheck: values.checked === 'off' });
    } },
    { suffix: '/comment', fields: ['text'], bodyLimit: 3 * 4 * 2000 + 4096, validate(values) {
      if (!values.text.trim() || lines(values.text).length > 2000) return bad('card.invalidComment');
    }, change(ctx, id, values) { commentCard(ctx, id, lines(values.text)); } },
  ];
  for (const action of actions) routes.push({
    path: new RegExp(`^${cardPath}${action.suffix}$`, 'u'), form: 'card', back, failure,
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
      // Check existence and read-only validation before acquiring a write context.
      const current = entity.resolve(ctx, 'card', id);
      if (action.suffix === '/move' && !ctx.config.columns.some(({ key }) => key === values.column)) {
        return bad('card.invalidColumn');
      }
      if (action.suffix === '/check' && Number(values.n) > acceptanceItems(current.body).length) {
        return bad('card.invalidItem');
      }
      let selected = '';
      if (action.suffix === '' && values.project) {
        try {
          const resolved = project.resolve(ctx, values.project);
          selected = resolved.id ?? resolved.ref;
        } catch (error) {
          if (error instanceof CairnError && ['not_found', 'validation'].includes(error.code)) {
            return bad('card.invalidProject');
          }
          throw error;
        }
      }
      action.change(openWrite(), id, values, selected, current);
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
      try { card = entity.resolve(ctx, 'card', id); } catch (error) {
        if (error instanceof CairnError && error.code === 'not_found') return { state: 'notFound', csrf };
        throw error;
      }
      if (!card.id) return { state: 'notFound', csrf };
    }
    // A project file without a status counts as active, as everywhere else.
    const active = ({ data }) => data.status === undefined || data.status === 'active';
    const projects = project.list(ctx).filter((item) => active(item) || item.id === card?.data.project
      || item.ref === card?.data.project);
    return { state: 'ready', csrf, columns: ctx.config.columns, projects, card };
  }

  return { routes, view };
}
