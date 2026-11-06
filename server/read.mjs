import { basename } from 'node:path';
import { validateDate } from '../core/dates.mjs';
import * as index from '../core/index.mjs';
import { stripHidden } from '../core/text.mjs';
import { homeView } from '../cli/views.mjs';
import { okEnvelope } from '../cli/output.mjs';
import { createRenderPool } from './render-pool.mjs';

function journalDate(row) {
  for (const date of [row.data.date, basename(row.path, '.md')]) {
    try { validateDate(date); return date; } catch { /* Try the filename before giving up. */ }
  }
  return null;
}

function renderBody(ctx, { path, body }, render) {
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
  return render(body, [...links]);
}

// Rendering runs in a worker with a time limit, so one slow page never holds up other requests.
const RENDER_WARNINGS = [['tooLarge', 'too_large'], ['timedOut', 'render_timeout'], ['failed', 'render_failed']];

export async function renderView(ctx, view, render) {
  const rendered = await renderBody(ctx, view.entity, render);
  view.data.content.html = rendered.html;
  for (const [flag, warning] of RENDER_WARNINGS) if (rendered[flag]) view.warnings.push(warning);
}

export class DataNotReadyError extends Error {
  constructor(cause) {
    super('The data directory is not ready.', { cause });
    this.code = 'data_not_ready';
  }
}

export function homeResult(ctx, view = homeView(ctx)) {
  return okEnvelope(view.data, [...ctx.warnings, ...(view.warnings ?? [])]);
}

export function createRead({ open, render = createRenderPool().render }) {
  return {
    async home() {
      let ctx;
      try { ctx = await open(); } catch (error) { throw new DataNotReadyError(error); }
      const view = homeView(ctx);
      if (view.journalEntity) {
        await renderView(ctx, { entity: view.journalEntity, data: view.data.journal, warnings: view.warnings }, render);
      }
      return homeResult(ctx, view);
    },
  };
}
