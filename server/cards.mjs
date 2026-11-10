// Card creation uses the same write checks as Settings; only card fields are validated here.
import { addCard } from '../core/card.mjs';
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
  const writes = createWrites({ key, port, routes });

  /** What the form page shows; `state` is 'notReady' when the data folder cannot be opened yet. */
  function view(cookieHeader) {
    const csrf = writes.token(cookieHeader, 'card');
    let ctx;
    try { ctx = open(); } catch (error) {
      if (notReady(error)) return { state: 'notReady', csrf };
      throw error;
    }
    // A project file without a status counts as active, as everywhere else.
    const active = ({ data }) => data.status === undefined || data.status === 'active';
    return { state: 'ready', csrf, columns: ctx.config.columns, projects: project.list(ctx).filter(active) };
  }

  return { routes, view };
}
