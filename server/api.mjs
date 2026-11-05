import { CairnError } from '../core/errors.mjs';
import { resolve } from '../core/entity.mjs';
import { normalizeId } from '../core/ids.mjs';
import { parseFile } from '../core/frontmatter.mjs';
import { readFile } from '../core/store.mjs';
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

function renderBody(ctx, path) {
  const file = readFile(ctx, path);
  if (!file) throw new CairnError('not_found', 'Entity was not found.');
  // Skip index resolution as well as parsing for files that cannot be rendered.
  if (Buffer.byteLength(file.text) > 5 * 1024 * 1024) return { html: null, tooLarge: true };
  const body = parseFile(file.text).body;
  const rows = new Map(index.rows(ctx).map((row) => [row.path, row]));
  const links = new Map();
  for (const link of index.outlinks(ctx, path)) {
    const key = JSON.stringify([stripHidden(link.targetName).text, stripHidden(link.heading ?? '').text]);
    const row = link.status === 'resolved' ? rows.get(link.target_path) : null;
    const resolved = row ? { type: row.type, id: row.type === 'journal' ? row.data.date ?? row.id : row.id } : null;
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
    let ctx;
    try {
      let view;
      const match = /^\/api\/(cards|notes)\/([^/]+)$/u.exec(path ?? '');
      if (/%(?:2f|5c)/iu.test(req.url.split('?')[0])
        || (path !== '/api/home' && path !== '/api/board' && (!match || !normalizeId(match[2])))) {
        throw new CairnError('not_found', 'Entity was not found.');
      }
      ctx = await open();
      if (path === '/api/home') view = homeView(ctx);
      else if (path === '/api/board') view = boardView(ctx);
      else {
        const type = match[1] === 'cards' ? 'card' : 'note', id = normalizeId(match[2]);
        view = showView(ctx, type, id);
        // The JSON path is cleaned for display; file access needs the original path.
        const rendered = renderBody(ctx, resolve(ctx, type, id).path);
        view.data.content.html = rendered.html;
        if (rendered.tooLarge) view.warnings.push('too_large');
      }
      send(req, res, 200, okEnvelope(view.data, [...ctx.warnings, ...(view.warnings ?? [])]));
    } catch (error) {
      const code = error instanceof CairnError && ['not_found', 'validation'].includes(error.code) ? error.code : 'internal';
      if (code === 'internal') console.error(error);
      const safe = new CairnError(code, code === 'not_found' ? 'Entity was not found.'
        : code === 'validation' ? 'The data directory is not ready.' : 'An internal error occurred.');
      send(req, res, code === 'not_found' ? 404 : code === 'validation' ? 409 : 500,
        errorEnvelope(safe, ctx?.warnings ?? []));
    }
    return true;
  };
}
