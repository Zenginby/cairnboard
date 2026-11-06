import { basename } from 'node:path';
import { validateDate } from '../core/dates.mjs';
import * as index from '../core/index.mjs';
import { stripHidden } from '../core/text.mjs';
import { CairnError } from '../core/errors.mjs';
import { normalizeId } from '../core/ids.mjs';
import { effectiveColumn } from '../core/card.mjs';
import { homeView, boardView, showView } from '../cli/views.mjs';
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

export class EntityNotFoundError extends Error {
  constructor() {
    super('Entity was not found.');
    this.code = 'entity_not_found';
  }
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

function projectMap(ctx) {
  const titles = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
  const projects = index.rows(ctx, 'project').sort((a, b) => titles.compare(a.title, b.title)
    || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const refs = new Map();
  for (const [order, row] of projects.entries()) {
    const tone = Number.isInteger(row.data.tone) && row.data.tone >= 1 && row.data.tone <= 8 ? row.data.tone : order % 8 + 1;
    const project = { id: row.id, title: row.title, tone };
    for (const ref of [row.id, `@${row.path.slice(0, -3)}`, `@${row.path}`]) if (ref) refs.set(ref, project);
  }
  return refs;
}

function joinProjects(view, projects) {
  for (const column of view.data.columns) {
    for (const card of column.cards) card.project = projects.get(card.content.project) ?? null;
  }
}

export function createRead({ open, render = createRenderPool().render }) {
  const openRead = async () => {
    try { return await open(); } catch (error) { throw new DataNotReadyError(error); }
  };
  const document = async (type, id) => {
    const missing = () => new EntityNotFoundError();
    if (!normalizeId(id)) throw missing();
    const ctx = await openRead();
    let view;
    // Only the lookup decides "not found"; a not_found raised later is an internal failure, as in the API.
    try { view = showView(ctx, type, normalizeId(id)); } catch (error) {
      if (error instanceof CairnError && error.code === 'not_found') throw missing();
      throw error;
    }
    await renderView(ctx, view, render);
    const projects = projectMap(ctx);
    const project = projects.get(view.data.content.project) ?? null;
    view.data.project = project;
    if (type === 'card') {
      const { key, label, role } = effectiveColumn(ctx.config, view.entity);
      view.data.column = { key, label, role };
      const board = boardView(ctx);
      view.warnings.push(...board.warnings);
      view.data.relatedCards = project ? board.data.columns.filter((column) => column.role !== 'done')
        .flatMap((column) => column.cards).filter((card) => card.id && card.id !== view.data.id
          && projects.get(card.content.project) === project).slice(0, 8) : [];
    } else {
      const rows = new Map(index.rows(ctx).map((row) => [row.path, row]));
      view.data.meta.backlinks = view.data.meta.backlinks.map((link) => {
        const row = rows.get(link.src_path);
        return row ? { ...link, type: row.type, id: row.type === 'journal' ? journalDate(row) : row.id, title: row.title } : link;
      });
    }
    return okEnvelope(view.data, [...ctx.warnings, ...view.warnings]);
  };
  return {
    async board() {
      const ctx = await openRead();
      const view = boardView(ctx);
      joinProjects(view, projectMap(ctx));
      return okEnvelope(view.data, [...ctx.warnings, ...view.warnings]);
    },
    card(id) { return document('card', id); },
    note(id) { return document('note', id); },
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
