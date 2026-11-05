import * as entity from '../core/entity.mjs';
import * as journal from '../core/journal.mjs';
import * as index from '../core/index.mjs';
import { listCards, effectiveColumn } from '../core/card.mjs';
import { normalizeId } from '../core/ids.mjs';
import { toJson, compact, clean } from './output.mjs';

export function outputOptions(ctx, opts, warnings) {
  return { raw: opts.raw, maxBytes: opts['max-bytes'], columns: ctx.config.columns, warnings };
}

export function result(ctx, items, opts, many = true) {
  const warnings = items.flatMap((item) => [...(item.warnings ?? []),
    ...(item.type === 'card' ? effectiveColumn(ctx.config, item).warnings : [])]);
  const options = outputOptions(ctx, opts, warnings);
  const converted = items.map((item) => opts.compact ? compact(item, { ...options,
    ...(item.type === 'card' ? { column: effectiveColumn(ctx.config, item).key } : {}) }) : toJson(item, options));
  return { data: many || opts.compact ? { items: converted } : converted[0], warnings };
}

// Resolved links of one page plus the pages that link to it; paths and line numbers, bounded in count.
const MAX_LINKS = 500;
const MAX_EXPR = 300;
export function noteLinks(ctx, path, opts) {
  const out = index.outlinks(ctx, path).slice(0, MAX_LINKS).map((link) => ({ expr: clean(link.expr.slice(0, MAX_EXPR), opts),
    target_path: link.target_path ?? null, status: link.status, line: link.line }));
  const back = index.backlinks(ctx, path).slice(0, MAX_LINKS).map(({ src_path, line }) => ({ src_path: clean(src_path, opts), line }));
  return { links: out, backlinks: back };
}

export function showView(ctx, type, ref, opts = {}) {
  const resolved = entity.resolve(ctx, type, ref);
  const shown = result(ctx, [resolved], opts, false);
  if (type === 'note' && !opts.compact) {
    const { links, backlinks } = noteLinks(ctx, resolved.path, opts);
    shown.data.meta = { ...shown.data.meta, backlinks };
    // Link text is page text, so it lives under content like the rest of the page.
    Object.defineProperty(shown.data.content, 'links', { value: links, enumerable: true, configurable: true, writable: true });
  }
  return { ...shown, entity: resolved };
}

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const titles = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const newest = (a, b) => (Date.parse(b.data.updated) || 0) - (Date.parse(a.data.updated) || 0)
  || compare(a.path, b.path);
const titleOrder = (a, b) => titles.compare(a.title, b.title) || compare(a.path, b.path);
const priorities = new Map([['urgent', 0], ['important', 1], ['low', 2]]);

export function homeView(ctx, opts = {}) {
  const all = entity.list(ctx);
  const projects = all.filter((item) => item.type === 'project'
    && (item.data.status === undefined || item.data.status === 'active')).sort(titleOrder);
  const cards = listCards(ctx, {}, all.filter((item) => item.type === 'card'));
  let featuredProject = null;
  const configured = normalizeId(ctx.config.home?.featuredProject);
  if (configured) {
    try { featuredProject = entity.resolve(ctx, 'project', configured).id; } catch {
      // A configured feature is optional; any read failure uses the computed fallback.
    }
  }
  if (featuredProject === null && projects.length) {
    const counts = new Map();
    for (const card of cards) counts.set(card.data.project, (counts.get(card.data.project) ?? 0) + 1);
    const count = (project) => [project.id, `@${project.path.slice(0, -3)}`, `@${project.path}`]
      .filter((ref) => ref !== null).reduce((total, ref) => total + (counts.get(ref) ?? 0), 0);
    featuredProject = [...projects].sort((a, b) => count(b) - count(a) || titleOrder(a, b))[0].id;
  }
  const warnings = [];
  let today = null;
  try { today = journal.show(ctx); } catch (error) {
    if (error?.code !== 'not_found') warnings.push('journal_unreadable');
  }
  const shape = (items) => {
    const shown = result(ctx, items, opts);
    warnings.push(...shown.warnings);
    return shown.data.items;
  };
  return { data: {
    pinned: shape(all.filter((item) => item.data.pinned === true).sort(newest)),
    recentNotes: shape(all.filter((item) => item.type === 'note' && item.kind === 'note').sort(newest).slice(0, 10)),
    // Stable sorting preserves listCards' position and path order within each priority.
    openCards: shape(cards.sort((a, b) => (priorities.get(a.data.priority) ?? 3) - (priorities.get(b.data.priority) ?? 3)).slice(0, 50)),
    journal: today ? shape([today])[0] : null,
    projects: shape(projects), featuredProject,
  }, warnings };
}

export function boardView(ctx, opts = {}) {
  const cards = listCards(ctx, { includeDone: true });
  const warnings = [];
  const columns = ctx.config.columns.map(({ key, label, role }) => {
    const items = cards.filter((card) => effectiveColumn(ctx.config, card).key === key);
    const recent = role === 'done' ? new Set([...items].sort(newest).slice(0, 50)) : null;
    const shown = result(ctx, recent ? items.filter((item) => recent.has(item)) : items, opts);
    warnings.push(...shown.warnings);
    return { key, label, role, cards: shown.data.items, total: items.length };
  });
  return { data: { columns }, warnings };
}
