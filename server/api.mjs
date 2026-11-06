import { CairnError } from '../core/errors.mjs';
import { normalizeId } from '../core/ids.mjs';
import { createRenderPool } from './render-pool.mjs';
import { boardView, showView } from '../cli/views.mjs';
import { okEnvelope, errorEnvelope } from '../cli/output.mjs';
import { homeResult, renderView } from './read.mjs';

function send(req, res, status, envelope) {
  const body = JSON.stringify(envelope);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function createApi({ open, events, render = createRenderPool().render }) {
  return async (req, res, path) => {
    if (!path?.startsWith('/api/') && !req.url.split('?')[0].startsWith('/api/')) return false;
    if (events?.handle(req, res, path)) return true;
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
      if (path === '/api/home') {
        send(req, res, 200, homeResult(ctx));
        return true;
      } else if (path === '/api/board') view = boardView(ctx);
      else {
        const type = match[1] === 'cards' ? 'card' : 'note', id = normalizeId(match[2]);
        phase = 'lookup';
        view = showView(ctx, type, id);
        phase = 'render';
        await renderView(ctx, view, render);
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
