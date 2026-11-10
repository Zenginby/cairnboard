import { CairnError } from '../core/errors.mjs';
import { normalizeId, isNoteKey } from '../core/ids.mjs';
import { createRenderPool } from './render-pool.mjs';
import { boardView, showView } from '../cli/views.mjs';
import { okEnvelope, errorEnvelope } from '../cli/output.mjs';
import { homeResult, renderView, projectMap } from './read.mjs';
import { searchView, WEB_SEARCH_TYPES } from './search.mjs';

// `/api/search?q=&type=&limit=`; an empty or absent `type` searches every type, an invalid `limit` uses the default.
function searchParams(url) {
  const params = new URL(url, 'http://localhost').searchParams;
  const limit = params.get('limit');
  return { q: params.get('q') ?? '', type: params.get('type') || undefined,
    limit: limit === null || !/^\d+$/u.test(limit) ? undefined : Number(limit) };
}

function send(req, res, status, envelope) {
  const body = JSON.stringify(envelope);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function createApi({ open, events, render = createRenderPool().render, live }) {
  return async (req, res, path) => {
    if (!path?.startsWith('/api/') && !req.url.split('?')[0].startsWith('/api/')) return false;
    // Live updates switched off in the settings: the stream does not exist, so an old tab's script gives up on the 404.
    if (path === '/api/events' && live && !(await live())) return false;
    if (events?.handle(req, res, path)) return true;
    let ctx, phase = 'route';
    try {
      let view;
      const match = /^\/api\/(cards|notes)\/([^/]+)$/u.exec(path ?? '');
      if (/%(?:2f|5c)/iu.test(req.url.split('?')[0])
        || (path !== '/api/home' && path !== '/api/board' && path !== '/api/search'
          && (!match || !(normalizeId(match[2]) || (match[1] === 'notes' && isNoteKey(match[2])))))) {
        throw new CairnError('not_found', 'Entity was not found.');
      }
      let search;
      if (path === '/api/search') {
        phase = 'params';
        search = searchParams(req.url);
        if (search.type !== undefined && !WEB_SEARCH_TYPES.includes(search.type)) {
          throw new CairnError('validation', 'Invalid search type.');
        }
      }
      phase = 'open';
      ctx = await open();
      phase = 'view';
      if (path === '/api/home') {
        send(req, res, 200, homeResult(ctx));
        return true;
      } else if (path === '/api/search') {
        send(req, res, 200, okEnvelope(searchView(ctx, search, projectMap(ctx)), ctx.warnings));
        return true;
      } else if (path === '/api/board') view = boardView(ctx);
      else {
        const type = match[1] === 'cards' ? 'card' : 'note', id = normalizeId(match[2]) ?? match[2];
        phase = 'lookup';
        view = showView(ctx, type, id);
        phase = 'render';
        await renderView(ctx, view, render);
      }
      send(req, res, 200, okEnvelope(view.data, [...ctx.warnings, ...(view.warnings ?? [])]));
    } catch (error) {
      const missing = ['route', 'lookup'].includes(phase) && error instanceof CairnError && error.code === 'not_found';
      // Only query-parameter validation (an invalid search type) is the caller's fault; it runs before data is opened.
      const invalid = phase === 'params' && error instanceof CairnError && error.code === 'validation';
      const status = phase === 'open' ? 409 : missing ? 404 : invalid ? 400 : 500;
      const code = status === 409 || invalid ? 'validation' : missing ? 'not_found' : 'internal';
      if (status !== 404 && !invalid) console.error(error);
      const safe = new CairnError(code, code === 'not_found' ? 'Entity was not found.'
        : invalid ? error.message : code === 'validation' ? 'The data directory is not ready.'
        : 'An internal error occurred.');
      send(req, res, status,
        errorEnvelope(safe, ctx?.warnings ?? []));
    }
    return true;
  };
}
