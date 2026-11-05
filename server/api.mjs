import { basename } from 'node:path';
import { CairnError } from '../core/errors.mjs';
import { normalizeId } from '../core/ids.mjs';
import { validateDate } from '../core/dates.mjs';
import * as index from '../core/index.mjs';
import { stripHidden } from '../core/text.mjs';
import { renderMarkdown } from '../core/render.mjs';
import { homeView, boardView, showView } from '../cli/views.mjs';
import { okEnvelope, errorEnvelope } from '../cli/output.mjs';

function send(req, res, status, envelope) {
  const body = JSON.stringify(envelope);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(req.method === 'HEAD' ? undefined : body);
}

function journalDate(row) {
  for (const date of [row.data.date, basename(row.path, '.md')]) {
    try { validateDate(date); return date; } catch { /* Try the filename before giving up. */ }
  }
  return null;
}

function renderBody(ctx, { path, body }) {
  // Use the same full body that supplied the response's revision and bounded content.
  if (Buffer.byteLength(body) > 5 * 1024 * 1024) return { html: null, tooLarge: true };
  const rows = new Map(index.rows(ctx).map((row) => [row.path, row]));
  const links = new Map();
  for (const link of index.outlinks(ctx, path)) {
    const key = JSON.stringify([stripHidden(link.targetName).text, stripHidden(link.heading ?? '').text]);
    const row = link.status === 'resolved' ? rows.get(link.target_path) : null;
    const id = row && (row.type === 'journal' ? journalDate(row) : row.id);
    const resolved = id ? { type: row.type, id } : null;
    // Cleaning must not turn distinct or ambiguous targets into a guessed destination.
    if (links.has(key) && JSON.stringify(links.get(key)) !== JSON.stringify(resolved)) links.set(key, null);
    else if (!links.has(key)) links.set(key, resolved);
  }
  return renderMarkdown(body, { resolveLink: ({ targetName, heading }) =>
    links.get(JSON.stringify([targetName, heading ?? ''])) ?? null });
}

export function createApi({ open }) {
  return async (req, res, path) => {
    if (!path?.startsWith('/api/') && !req.url.split('?')[0].startsWith('/api/')) return false;
    let ctx, phase = 'route';
    try {
      let view;
      const match = /^\/api\/(cards|notes)\/([^/]+)$/u.exec(path ?? '');
      if (/%(?:2f|5c)/iu.test(req.url.split('?')[0])
        || (path !== '/api/home' && path !== '/api/board' && (!match || !normalizeId(match[2])))) {
        throw new CairnError('not_found', 'Entity was not found.');
      }
      phase = 'open';
      ctx = await open();
      phase = 'view';
      if (path === '/api/home') view = homeView(ctx);
      else if (path === '/api/board') view = boardView(ctx);
      else {
        const type = match[1] === 'cards' ? 'card' : 'note', id = normalizeId(match[2]);
        phase = 'lookup';
        view = showView(ctx, type, id);
        phase = 'render';
        const rendered = renderBody(ctx, view.entity);
        view.data.content.html = rendered.html;
        if (rendered.tooLarge) view.warnings.push('too_large');
      }
      send(req, res, 200, okEnvelope(view.data, [...ctx.warnings, ...(view.warnings ?? [])]));
    } catch (error) {
      const missing = ['route', 'lookup'].includes(phase) && error instanceof CairnError && error.code === 'not_found';
      const status = phase === 'open' ? 409 : missing ? 404 : 500;
      const code = status === 409 ? 'validation' : missing ? 'not_found' : 'internal';
      if (status !== 404) console.error(error);
      const safe = new CairnError(code, code === 'not_found' ? 'Entity was not found.'
        : code === 'validation' ? 'The data directory is not ready.' : 'An internal error occurred.');
      send(req, res, status,
        errorEnvelope(safe, ctx?.warnings ?? []));
    }
    return true;
  };
}
