// Card creation uses the same write checks as Settings; only card fields are validated here.
import { addCard } from '../core/card.mjs';
import * as project from '../core/project.mjs';
import { CairnError } from '../core/errors.mjs';
import { createWrites } from './writes.mjs';

const bad = (message) => ({ status: 400, title: 'write.badRequestTitle', message });

/** `openWrite` supplies the web:owner actor, just as the CLI supplies its write context. */
export function createCards({ key, port, open, openWrite }) {
  const routes = [{ path: '/cards', form: 'card', back: { href: '/board', label: 'card.back' },
    run({ values }) {
      if (Object.keys(values).some((name) => !['title', 'column', 'project', 'priority'].includes(name))) {
        return bad('card.invalidFields');
      }
      const title = values.title?.trim();
      if (!title || title.length > 200 || /[\r\n\u2028\u2029]/u.test(values.title)) {
        return bad('card.invalidTitle');
      }
      if (!['', 'urgent', 'important', 'low'].includes(values.priority ?? '')) return bad('card.invalidPriority');
      const ctx = open();
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

  function view(cookieHeader) {
    const ctx = open();
    return { csrf: writes.token(cookieHeader, 'card'), columns: ctx.config.columns,
      projects: project.list(ctx).filter((item) => item.data.status === 'active') };
  }

  return { routes, view };
}
