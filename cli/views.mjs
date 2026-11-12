import * as entity from '../core/entity.mjs';
import * as journal from '../core/journal.mjs';
import * as index from '../core/index.mjs';
import { listCards, effectiveColumn } from '../core/card.mjs';
import { normalizeId } from '../core/ids.mjs';
import { toJson, compact, clean } from './output.mjs';
import { oneLine, stripHidden } from '../core/text.mjs';

export function changesView({ changes }) {
  const field = (value) => oneLine(stripHidden(typeof value === 'string' || typeof value === 'number'
    ? String(value) : '').text).slice(0, 200);
  return changes.map((event) => {
    const heading = `${field(event.seq)} ${field(event.ts)} ${field(event.actor ?? 'unknown')} `
      + `${field(event.change ?? event.op)} ${event.paths.map(field).join(', ')}`;
    return heading + (event.diff ? `\n${event.diff}` : event.reason ? `\n(${field(event.reason)})` : '');
  }).join('\n');
}

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

// The project configured as `agents.project`: its id and every ref a card may use for it, or null when the setting is
// missing or names no project.
export function agentProject(ctx) {
  const configured = normalizeId(ctx.config.agents?.project);
  if (!configured) return null;
  let project;
  try { project = entity.resolve(ctx, 'project', configured); } catch { return null; }
  const refs = [project.id, `@${project.path.slice(0, -3)}`, `@${project.path}`].filter((ref) => ref !== null);
  return { id: project.id, refs: new Set(refs) };
}

// Every ref a card may use for a project.
const projectRefs = (project) => [project.id, `@${project.path.slice(0, -3)}`, `@${project.path}`]
  .filter((ref) => ref !== null);

// Web Home only: per project (keyed by path), the cards on the visible columns counted by role, plus the first open
// cards, the doing ones first and then in board order. Hidden (archive) columns are not counted.
const UPCOMING = 4;
function projectCardSummary(ctx, projects, cards) {
  const columns = ctx.config.columns.filter((column) => column.hidden !== true);
  const order = new Map(columns.map((column, index) => [column.key, index]));
  const summary = {};
  const byRef = new Map();
  for (const project of projects) {
    const entry = { total: 0, done: 0, doing: 0, todo: 0, upcoming: [] };
    summary[project.path] = entry;
    for (const ref of projectRefs(project)) byRef.set(ref, entry);
  }
  const open = [];
  for (const card of cards) {
    const entry = byRef.get(card.data.project);
    const column = columns[order.get(effectiveColumn(ctx.config, card).key)];
    if (!entry || !column) continue;
    entry.total += 1;
    entry[column.role] += 1;
    if (column.role !== 'done') open.push({ entry, card, column });
  }
  const rank = (item) => (item.column.role === 'doing' ? 0 : 1) * columns.length + order.get(item.column.key);
  for (const { entry, card, column } of open.sort((a, b) => rank(a) - rank(b))) {
    if (entry.upcoming.length >= UPCOMING) continue;
    entry.upcoming.push({ id: card.id, title: oneLine(stripHidden(card.title ?? '').text).slice(0, 200),
      column: { key: column.key, label: column.label, role: column.role } });
  }
  return summary;
}

// `scope: 'owner'` (web Home only): agent work and the agents project are left out and counted per column instead.
// Without a scope the result is the same as before the setting existed (CLI `home`, `/api/home`).
export function homeView(ctx, opts = {}, { scope } = {}) {
  const all = entity.list(ctx);
  const agents = scope === 'owner' ? agentProject(ctx) : null;
  const isAgentCard = (card) => agents !== null && agents.refs.has(card.data.project);
  const isAgentItem = (item) => agents !== null && (item.id === agents.id
    || (item.type === 'card' && agents.refs.has(item.data.project)));
  const projects = all.filter((item) => item.type === 'project' && !isAgentItem(item)
    && (item.data.status === undefined || item.data.status === 'active')).sort(titleOrder);
  const allCards = listCards(ctx, { includeDone: true }, all.filter((item) => item.type === 'card'));
  // Agent work has its own board: Home lists only the owner's open cards and counts agent cards per visible column.
  const cards = allCards.filter((card) => !isAgentCard(card) && effectiveColumn(ctx.config, card).role !== 'done');
  const agentColumns = agents === null ? null : ctx.config.columns.filter((column) => column.hidden !== true)
    .map(({ key, label, role }) => ({ key, label, role,
      count: allCards.filter((card) => isAgentCard(card) && effectiveColumn(ctx.config, card).key === key).length }))
    .filter((column) => column.count > 0);
  let featuredProject = null;
  const configured = normalizeId(ctx.config.home?.featuredProject);
  if (configured) {
    try { featuredProject = entity.resolve(ctx, 'project', configured).id; } catch {
      // A configured feature is optional; any read failure uses the computed fallback.
    }
    // The agents project is not on the owner's Home, so it cannot be its featured project either.
    if (agents !== null && featuredProject === agents.id) featuredProject = null;
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
    pinned: shape(all.filter((item) => item.data.pinned === true && !isAgentItem(item)).sort(newest)),
    recentNotes: shape(all.filter((item) => item.type === 'note' && item.kind === 'note').sort(newest).slice(0, 10)),
    // Stable sorting preserves listCards' position and path order within each priority.
    openCards: shape(cards.sort((a, b) => (priorities.get(a.data.priority) ?? 3) - (priorities.get(b.data.priority) ?? 3)).slice(0, 50)),
    journal: today ? shape([today])[0] : null,
    projects: shape(projects), featuredProject,
    // Additive: lets the Home page show the journal panel only when some journal entry exists.
    journalCount: all.filter((item) => item.type === 'journal').length,
    // Owner scope only: null when no agents project is configured; otherwise the visible columns holding agent cards.
    ...(scope === 'owner' ? { agents: agentColumns,
      projectCards: projectCardSummary(ctx, projects, allCards.filter((card) => !isAgentCard(card))) } : {}),
  }, warnings, journalEntity: today };
}

// `scope` (web only; the CLI passes none and sees every column and card):
// - `owner`: visible columns, without agent cards;
// - `agents`: visible columns with agent cards only, planning columns left out while empty;
// - `archive`: hidden columns with agent cards only.
// `project` (web only): a set of project refs; only that project's cards are kept.
export function boardView(ctx, opts = {}, { scope, project } = {}) {
  const agents = scope ? agentProject(ctx) : null;
  const isAgentCard = (card) => agents !== null && agents.refs.has(card.data.project);
  const inScope = scope === 'owner' ? (card) => !isAgentCard(card) : scope ? isAgentCard : () => true;
  const keep = project ? (card) => inScope(card) && project.has(card.data.project) : inScope;
  const cards = listCards(ctx, { includeDone: true }).filter(keep);
  const warnings = [];
  const shownColumns = scope === undefined ? ctx.config.columns
    : ctx.config.columns.filter((column) => (column.hidden === true) === (scope === 'archive'));
  const columns = shownColumns.map(({ key, label, role, hidden }) => {
    const items = cards.filter((card) => effectiveColumn(ctx.config, card).key === key);
    // The archive view lists every archived card; everywhere else a done column shows its 50 newest.
    const recent = role === 'done' && scope !== 'archive' ? new Set([...items].sort(newest).slice(0, 50)) : null;
    const shown = result(ctx, recent ? items.filter((item) => recent.has(item)) : items, opts);
    warnings.push(...shown.warnings);
    return { key, label, role, ...(hidden === true ? { hidden } : {}), cards: shown.data.items, total: items.length };
  }).filter((column) => scope !== 'agents' || column.role !== 'todo' || column.total > 0);
  const data = { columns };
  if (scope === 'agents' || scope === 'archive') {
    data.agentProject = agents?.id ?? null;
    const hiddenKeys = new Set(ctx.config.columns.filter((column) => column.hidden === true)
      .map((column) => column.key));
    data.archived = scope === 'agents'
      ? cards.filter((card) => hiddenKeys.has(effectiveColumn(ctx.config, card).key)).length : null;
  }
  return { data, warnings };
}
