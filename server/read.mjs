import { basename } from 'node:path';
import { validateDate } from '../core/dates.mjs';
import * as index from '../core/index.mjs';
import { safeRelative } from '../core/paths.mjs';
import { stripHidden, oneLine, pathKey } from '../core/text.mjs';
import { CairnError } from '../core/errors.mjs';
import { normalizeId, isNoteKey } from '../core/ids.mjs';
import * as journal from '../core/journal.mjs';
import * as entity from '../core/entity.mjs';
import { effectiveColumn } from '../core/card.mjs';
import { parseFile } from '../core/frontmatter.mjs';
import { extractProjectLinks } from '../core/project-links.mjs';
import { readFile } from '../core/store.mjs';
import { homeView, boardView, showView, projectsView, projectSummary, result, agentProject } from '../cli/views.mjs';
import { okEnvelope } from '../cli/output.mjs';
import { createRenderPool } from './render-pool.mjs';
import { searchView } from './search.mjs';
import { hasToolSnapshots, mergeTools, readToolSnapshots } from '../core/tools.mjs';
import { uiLanguage } from '../src/i18n/index.mjs';

function journalDate(row) {
  for (const date of [row.data.date, basename(row.path, '.md')]) {
    try { validateDate(date); return date; } catch { /* Try the filename before giving up. */ }
  }
  return null;
}

function renderBody(ctx, { path, body }, render, options) {
  // Use the same full body that supplied the response's revision and bounded content.
  if (Buffer.byteLength(body) > 5 * 1024 * 1024) return { html: null, tooLarge: true };
  const rows = new Map(index.rows(ctx).map((row) => [row.path, row]));
  const links = new Map();
  for (const link of index.outlinks(ctx, path)) {
    const key = JSON.stringify([stripHidden(link.targetName).text, stripHidden(link.heading ?? '').text]);
    const row = link.status === 'resolved' ? rows.get(link.target_path) : null;
    const id = row && (row.type === 'journal' ? journalDate(row) : row.type === 'note' ? row.ref : row.id);
    const resolved = id ? { type: row.type, id } : null;
    // Cleaning must not turn distinct or ambiguous targets into a guessed destination.
    if (links.has(key) && JSON.stringify(links.get(key)) !== JSON.stringify(resolved)) links.set(key, null);
    else if (!links.has(key)) links.set(key, resolved);
  }
  return render(body, [...links], options);
}

// Rendering runs in a worker with a time limit, so one slow page never holds up other requests.
const RENDER_WARNINGS = [['tooLarge', 'too_large'], ['timedOut', 'render_timeout'], ['failed', 'render_failed']];

export async function renderView(ctx, view, render, options) {
  const rendered = await renderBody(ctx, view.entity, render, options);
  view.data.content.html = rendered.html;
  for (const [flag, warning] of RENDER_WARNINGS) if (rendered[flag]) view.warnings.push(warning);
  return rendered;
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

export function projectMap(ctx) {
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

// Project cover extras: the project's open cards on the owner board (with their column), the count of done cards and
// its newest notes. Hidden (archive) columns and the agents project's cards are left out, as on the owner board.
const COVER_NOTES = 8;
function projectCover(ctx, view, projects) {
  const self = projects.get(`@${view.entity.path}`) ?? null;
  const refs = new Set([...projects].filter(([, value]) => value === self).map(([ref]) => ref));
  const board = boardView(ctx, {}, { scope: 'owner', project: refs });
  view.warnings.push(...board.warnings);
  view.data.tone = self?.tone ?? 1;
  view.data.openCards = board.data.columns.filter((column) => column.role !== 'done').flatMap((column) => column.cards
    .map((card) => ({ ...card, column: { key: column.key, label: column.label, role: column.role } })));
  view.data.doneCount = board.data.columns.filter((column) => column.role === 'done')
    .reduce((sum, column) => sum + column.total, 0);
  const notes = index.rows(ctx, 'note').filter((row) => refs.has(row.data.project))
    .sort((a, b) => (Date.parse(b.data.updated) || 0) - (Date.parse(a.data.updated) || 0)
      || (a.path < b.path ? -1 : 1));
  view.data.notes = notes.slice(0, COVER_NOTES)
    .map((row) => ({ ref: row.id ?? row.ref, title: row.title, updated: row.data.updated ?? null }));
  view.data.notesTotal = notes.length;
  view.data.summary = projectSummary(ctx, { id: view.entity.id ?? null, path: view.entity.path });
  const { jobs, jobsTotal } = projectJobs(ctx, refs);
  view.data.jobs = jobs;
  view.data.jobsTotal = jobsTotal;
  view.data.links = extractProjectLinks(view.entity.body);
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
    const ref = type === 'note' && isNoteKey(id) ? id : normalizeId(id);
    if (!ref) throw missing();
    const ctx = await openRead();
    let view;
    // Only the lookup decides "not found"; a not_found raised later is an internal failure, as in the API.
    try { view = showView(ctx, type, ref); } catch (error) {
      if (error instanceof CairnError && error.code === 'not_found') throw missing();
      throw error;
    }
    const rendered = await renderView(ctx, view, render, type === 'research' ? { headings: true } : undefined);
    const projects = projectMap(ctx);
    if (type === 'project') {
      projectCover(ctx, view, projects);
      return okEnvelope(view.data, [...ctx.warnings, ...view.warnings]);
    }
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
    } else if (type === 'note') {
      const rows = new Map(index.rows(ctx).map((row) => [row.path, row]));
      view.data.meta.backlinks = view.data.meta.backlinks.map((link) => {
        const row = rows.get(link.src_path);
        return row ? { ...link, type: row.type,
          id: row.type === 'journal' ? journalDate(row) : row.id, title: row.title,
          ...(row.type === 'note' ? { ref: row.ref } : {}) } : link;
      });
    } else if (type === 'research') {
      view.data.content.tags = normalizeTags(view.data.content.tags);
      // Heading ids and the list come from the render pipeline; sanitized HTML is never rewritten here.
      view.data.toc = Array.isArray(rendered.toc) ? rendered.toc : [];
    }
    return okEnvelope(view.data, [...ctx.warnings, ...view.warnings]);
  };
  return {
    /** @param {{ scope?: 'owner' | 'owner-archive' | 'agents' | 'archive', project?: string }} [options] */
    async board({ scope, project } = {}) {
      const ctx = await openRead();
      const projects = projectMap(ctx);
      // An unknown project ref is not an error for the reader: the whole board is shown.
      const chosen = typeof project === 'string' ? projects.get(project) ?? null : null;
      const refs = chosen ? new Set([...projects].filter(([, value]) => value === chosen).map(([ref]) => ref)) : null;
      const view = boardView(ctx, {}, { scope, project: refs });
      joinProjects(view, projects);
      if (chosen) view.data.project = chosen;
      return okEnvelope(view.data, [...ctx.warnings, ...view.warnings]);
    },
    card(id) { return document('card', id); },
    /** @param {{ q: string, type?: string, limit?: number }} params */
    async search({ q, type, limit }) {
      const ctx = await openRead();
      return okEnvelope(searchView(ctx, { q, type, limit }, projectMap(ctx)), ctx.warnings);
    },
    note(id) { return document('note', id); },
    /** @param {{ project?: string }} [query] */
    async notes(query) { return notesResult(await openRead(), query); },
    async pinnedNotes() { return pinnedNotesResult(await openRead()); },
    project(id) { return document('project', id); },
    research(id) { return document('research', id); },
    async researchList() { return researchListResult(await openRead()); },
    async tools() {
      const ctx = await openRead();
      const { snapshots, warnings } = readToolSnapshots(ctx);
      const machines = snapshots.map(({ machine, scannedAt, tools }) => ({ machine, scannedAt, count: tools.length }));
      return okEnvelope({ machines, items: mergeTools(snapshots) }, [...ctx.warnings, ...warnings]);
    },
    /** The shell shows a Tools tab only when a snapshot file exists; any read failure just hides it. */
    async hasTools() {
      try { return hasToolSnapshots(await openRead()); } catch { return false; }
    },
    async journalMonth(query) { return journalMonthResult(await openRead(), query); },
    async journalDay(date) { return journalDayResult(await openRead(), date, render); },
    async projects() {
      const ctx = await openRead();
      const view = projectsView(ctx);
      return okEnvelope(view.data, [...ctx.warnings, ...view.warnings]);
    },
    async home() {
      let ctx;
      try { ctx = await open(); } catch (error) { throw new DataNotReadyError(error); }
      const view = homeView(ctx, {}, { scope: 'owner' });
      if (view.journalEntity) {
        await renderView(ctx, { entity: view.journalEntity, data: view.data.journal, warnings: view.warnings }, render);
      }
      const research = homeResearch(ctx);
      view.warnings.push(...research.warnings);
      Object.assign(view.data, homeOverview(ctx, view.journalEntity), { research: research.research });
      return homeResult(ctx, view);
    },
  };
}

// Home uses the first visible doing/todo column's key, so review columns and translated labels never select cards.
// `today` is the journal entity Home already read: when it is the newest day its body is reused, not read again.
export function homeOverview(ctx, today = null) {
  const board = boardView(ctx, {}, { scope: 'owner' }).data.columns;
  const doingKey = board.find((column) => column.role === 'doing')?.key;
  const nextKey = board.find((column) => column.role === 'todo')?.key;
  const inProgress = board.find((column) => column.key === doingKey)?.cards ?? [];
  const upNext = board.find((column) => column.key === nextKey)?.total ?? 0;
  const days = index.rows(ctx, 'journal').map((row) => ({ row, date: journalDate(row) }))
    .filter((day) => day.date !== null).sort((a, b) => b.date.localeCompare(a.date));
  const latest = days[0];
  const now = entity.localDate(ctx);
  const month = (latest?.date ?? now).slice(0, 7);
  const latestBody = !latest ? null : today && today.path === latest.row.path && typeof today.body === 'string'
    ? today.body : journal.show(ctx, latest.date).body;
  const latestDay = latest ? { date: latest.date,
    jobs: journal.sections(latestBody).map((job) => stripHidden(job.title).text) } : null;
  return { today: now, inProgress, upNext, latestDay,
    journalCount: new Set(days.map((day) => day.date)).size,
    calendar: { today: now, month, latest: latest?.date ?? null,
      days: [...new Set(days.filter((day) => day.date.startsWith(`${month}-`)).map((day) => day.date))] },
    distribution: board.map(({ key, label, role, total }) => ({ key, label, role, total })) };
}

// ---- Journal screens (/journal, /journal/<date>): read-only views over the journal days. ----

const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const JOURNAL_ITEMS = 3;

// Plain one-line text of a Markdown item, for the day preview.
export function plainItem(text) {
  const clean = stripHidden(text).text
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/gu, '$2').replace(/\[\[([^\]]*)\]\]/gu, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1').replace(/(\*\*|__|`|\*)/gu, '');
  return oneLine(clean).slice(0, 200);
}

const EXCERPT_SCAN_LIMIT = 4096;
const TABLE_SEPARATOR_ROW = /^[ \t]*\|?(?:[ \t]*:?-{1,}:?[ \t]*\|)+[ \t]*(?::?-{1,}:?[ \t]*)?\|?[ \t]*$/u;

// Plain one-line excerpt of a Markdown note body, for the pinned-notes rail.
export function pinnedExcerpt(text, max = PINNED_EXCERPT) {
  const sample = typeof text === 'string' ? text.slice(0, EXCERPT_SCAN_LIMIT) : '';
  const stripped = stripHidden(sample).text
    .replace(/!\[([^\[\]\r\n]*)\]\([^)\r\n]*\)/gu, '$1')
    .replace(/\[\[([^\[\]|\r\n]*)\|([^\[\]\r\n]*)\]\]/gu, '$2')
    .replace(/\[\[([^\[\]\r\n]*)\]\]/gu, '$1')
    .replace(/\[([^\[\]\r\n]*)\]\([^)\r\n]*\)/gu, '$1')
    .replace(/^ {0,3}(?:`{3,}|~{3,})[^\r\n]*$/gmu, '')
    .replace(/^ {0,3}(?:[-*_][ \t]*){3,}$/gmu, '')
    .replace(/^ {0,3}(?:>[ \t]?)+/gmu, '')
    .replace(/^ {0,3}#{1,6}[ \t]+/gmu, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gmu, '');
  const withoutTables = stripped.split(/\r?\n/u).map((line) => {
    if (TABLE_SEPARATOR_ROW.test(line)) return '';
    if (!line.includes('|')) return line;
    return line.split('|').map((cell) => cell.trim()).filter(Boolean).join(' · ');
  }).join('\n');
  const clean = withoutTables
    .replace(/(\*\*|__|~~|`|\*)/gu, '')
    .replace(/(?<!\p{L})_|_(?!\p{L})/gu, '');
  const line = oneLine(clean).replace(/ +/gu, ' ').trim();
  return Array.from(line).slice(0, max).join('');
}

// The jobs' own lines, split like core `sections()` (headings inside fences are not jobs; a `# ` heading ends a job).
function jobLines(body) {
  const jobs = [];
  let current = null;
  let fence = null;
  for (const content of body.split(/\r?\n/u)) {
    const marker = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      current?.push(content);
      continue;
    }
    if (marker && (marker[1][0] === '~' || !marker[2].includes('`'))) {
      fence = marker[1];
      current?.push(content);
      continue;
    }
    if (/^##[\t ]+/u.test(content)) { current = []; jobs.push(current); continue; }
    if (/^#[\t ]/u.test(content)) { current = null; continue; }
    current?.push(content);
  }
  return jobs;
}

// Without the project mark line (a comment that renders as nothing); the first items as plain text.
function jobParts(lines) {
  const kept = [];
  let marked = false;
  for (const content of lines) {
    if (!marked && content.trim()) {
      marked = true;
      if (/^<!--[\t ]*cairn:project[\t ]/u.test(content)) continue;
    }
    kept.push(content);
  }
  const items = [];
  let fence = false;
  for (const content of kept) {
    if (/^ {0,3}(`{3,}|~{3,})/u.test(content)) { fence = !fence; continue; }
    if (fence || !content.trim()) continue;
    const bullet = content.match(/^[-*+][\t ]+(.*)$/u);
    if (bullet) items.push(bullet[1]);
    else if (/^\s/u.test(content) && items.length) items[items.length - 1] += ` ${content.trim()}`;
    else items.push(content.trim());
  }
  return { markdown: kept.join('\n').trim(), items: items.map(plainItem).filter(Boolean) };
}

const isoDay = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  try { validateDate(value); return value; } catch { return null; }
};

// Every recorded journal day, oldest first: its summary and its jobs (title, label, project, items).
function journalDays(ctx, projects) {
  const found = new Map();
  const warnings = [];
  for (const item of entity.list(ctx, 'journal')) {
    const date = isoDay(String(item.data.date ?? basename(item.path, '.md')));
    if (date === null || found.has(date)) continue;
    const file = readFile(ctx, item.path);
    const parsed = file ? parseFile(file.text) : { error: 'missing' };
    if (parsed.error) { warnings.push('journal_unreadable'); continue; }
    const lines = jobLines(parsed.body);
    const sections = journal.sections(parsed.body);
    const aligned = lines.length === sections.length;
    const summary = typeof item.data.summary === 'string' ? oneLine(stripHidden(item.data.summary).text) : '';
    const jobs = sections.map((section, order) => {
      const parts = aligned ? jobParts(lines[order]) : { markdown: '', items: [] };
      return { id: `job-${order + 1}`, title: oneLine(stripHidden(section.title).text),
        label: section.label === null ? null : oneLine(stripHidden(section.label).text),
        project: projects.get(section.project) ?? null, items: parts.items, markdown: parts.markdown };
    });
    found.set(date, { date, path: item.path, summary, jobs });
  }
  return { days: [...found.values()].sort((a, b) => (a.date < b.date ? -1 : 1)), warnings: [...new Set(warnings)] };
}

const shiftMonth = (month, offset) => {
  const at = Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1 + offset;
  return `${String(Math.floor(at / 12)).padStart(4, '0')}-${String(at % 12 + 1).padStart(2, '0')}`;
};

/**
 * The month view: `month` (YYYY-MM), `project` (a project id) and `day` (YYYY-MM-DD) come from the URL and are
 * ignored when they do not fit (an unknown project, a day outside the month or with nothing to show).
 * @param {*} ctx @param {{ month?: string, project?: string, day?: string }} [query]
 */
export function journalMonthResult(ctx, { month, project, day } = {}) {
  const projects = projectMap(ctx);
  const { days, warnings } = journalDays(ctx, projects);
  const chips = [];
  for (const record of days) {
    for (const { project: linked } of record.jobs) {
      if (linked && !chips.some((chip) => chip.id === linked.id)) chips.push(linked);
    }
  }
  chips.sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base', numeric: true }));
  const active = chips.find((chip) => chip.id === project)?.id ?? '';
  const shown = typeof month === 'string' && MONTH.test(month) ? month
    : days.length ? days.at(-1).date.slice(0, 7) : entity.localDate(ctx).slice(0, 7);
  const count = (record) => record.jobs.filter((job) => !active || job.project?.id === active).length;
  const inMonth = days.filter((record) => record.date.startsWith(`${shown}-`));
  const cells = inMonth.map((record) => ({ date: record.date, count: count(record) })).filter((cell) => cell.count > 0);
  const chosen = isoDay(day) && inMonth.find((record) => record.date === day);
  const jobsOf = (record) => record.jobs.filter((job) => !active || job.project?.id === active).map((job) => ({
    id: job.id, title: job.title, label: job.label, project: job.project,
    items: job.items.slice(0, JOURNAL_ITEMS), moreItems: Math.max(0, job.items.length - JOURNAL_ITEMS) }));
  return okEnvelope({
    month: shown, previousMonth: shiftMonth(shown, -1), nextMonth: shiftMonth(shown, 1),
    projects: chips, project: active, recorded: days.length,
    days: cells, list: [...cells].reverse(),
    selected: chosen ? { date: chosen.date, summary: active ? '' : chosen.summary, jobs: jobsOf(chosen) } : null,
  }, [...ctx.warnings, ...warnings]);
}

/**
 * One day's full log: the summary, each job with its items rendered through the same sanitized Markdown worker as
 * the other read pages, and the previous and next recorded days. A malformed or unrecorded date is not found.
 * @param {*} ctx @param {string} date @param {*} render
 */
export async function journalDayResult(ctx, date, render) {
  const projects = projectMap(ctx);
  const { days, warnings } = journalDays(ctx, projects);
  const at = isoDay(date) ? days.findIndex((record) => record.date === date) : -1;
  if (at < 0) throw new EntityNotFoundError();
  const record = days[at];
  const own = [...warnings];
  const jobs = [];
  for (const job of record.jobs) {
    let html = null;
    if (job.markdown) {
      const rendered = await renderBody(ctx, { path: record.path, body: job.markdown }, render);
      html = rendered.html;
      for (const [flag, code] of RENDER_WARNINGS) if (rendered[flag]) own.push(code);
    }
    jobs.push({ id: job.id, title: job.title, label: job.label, project: job.project, html, items: job.items });
  }
  return okEnvelope({ date, summary: record.summary, jobs, previous: days[at - 1]?.date ?? null,
    next: days[at + 1]?.date ?? null }, [...ctx.warnings, ...new Set(own)]);
}

const COVER_JOBS = 8;
const cleanLine = (value) => oneLine(stripHidden(typeof value === 'string' ? value : '').text).slice(0, 200);

function projectJobs(ctx, refs) {
  if (!refs.size) return { jobs: [], jobsTotal: 0 };
  const days = index.rows(ctx, 'journal')
    .map((row) => ({ row, date: journalDate(row) }))
    .filter((item) => item.date !== null)
    .sort((a, b) => b.date.localeCompare(a.date) || (a.row.path < b.row.path ? -1 : a.row.path > b.row.path ? 1 : 0));
  const matched = [];
  for (const { row, date } of days) {
    const file = readFile(ctx, row.path);
    if (!file) continue;
    const parsed = parseFile(file.text);
    if (parsed.error) continue;
    for (const section of journal.sections(parsed.body).reverse()) {
      if (!section.project || !refs.has(section.project)) continue;
      const label = section.label === null ? null : cleanLine(section.label) || null;
      matched.push({ title: cleanLine(section.title), label, date });
    }
  }
  return { jobs: matched.slice(0, COVER_JOBS), jobsTotal: matched.length };
}

// ---- Research screens (/research, /research/<id>): read-only views over research records. ----

function normalizeTags(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return list.map((tag) => cleanLine(tag)).filter(Boolean);
}

function researchSortTime(item) {
  const iso = item.meta?.date;
  if (typeof iso !== 'string') return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * All research records sorted newest-to-oldest by `date` (undated last), joined with project tone metadata and
 * never carrying record bodies.
 * @param {*} ctx
 */
export function researchListResult(ctx) {
  const titles = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
  const projects = projectMap(ctx);
  const { data, warnings } = result(ctx, entity.list(ctx, 'research'), {}, true);
  const items = data.items
    .map((item) => {
      const category = typeof item.content.category === 'string' ? cleanLine(item.content.category) : '';
      const source = typeof item.content.source === 'string' ? cleanLine(item.content.source) : '';
      return {
        id: item.id,
        ref: item.ref,
        path: item.path,
        meta: item.meta,
        content: {
          title: item.content.title ?? '',
          category: category || null,
          project: typeof item.content.project === 'string' ? item.content.project : null,
          source: source || null,
          tags: normalizeTags(item.content.tags),
        },
        project: projects.get(item.content.project) ?? null,
      };
    })
    .sort((a, b) => {
      const ta = researchSortTime(a);
      const tb = researchSortTime(b);
      if (ta !== null && tb !== null && ta !== tb) return tb - ta;
      if ((ta !== null) !== (tb !== null)) return tb !== null ? 1 : -1;
      return titles.compare(a.content.title, b.content.title)
        || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    });
  return okEnvelope({ items }, [...ctx.warnings, ...warnings]);
}

const HOME_RESEARCH = 5;

function homeResearch(ctx) {
  const { data, warnings } = researchListResult(ctx);
  return {
    research: {
      total: data.items.length,
      items: data.items.slice(0, HOME_RESEARCH).map((item) => ({
        id: item.id ?? null,
        title: item.content.title ?? '',
        date: item.meta?.date ?? null,
        kind: item.meta?.kind ?? null,
        category: item.content.category ?? null,
        project: item.project ? { title: item.project.title, tone: item.project.tone } : null,
      })),
    },
    warnings,
  };
}

// ---- Notes list (/notes): read-only index across every note kind, excluding agent notes. ----

function noteRoots(schema) {
  const configured = schema?.roots?.note?.path;
  const list = Array.isArray(configured) ? configured : configured ? [configured] : [];
  return list
    .map((entry) => {
      try {
        const parts = safeRelative(entry).replace(/\\/gu, '/').split('/').filter(Boolean);
        return parts.length ? { parts, keys: parts.map(pathKey) } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.keys.join('/').length - a.keys.join('/').length);
}

function noteTopic(roots, notePath) {
  let parts;
  try {
    parts = safeRelative(notePath).replace(/\\/gu, '/').split('/').filter(Boolean);
  } catch {
    return null;
  }
  const keys = parts.map(pathKey);
  const root = roots.find((candidate) => parts.length > candidate.parts.length
    && candidate.keys.every((segment, at) => keys[at] === segment));
  if (!root || parts.length <= root.parts.length + 1) return null;
  return oneLine(stripHidden(parts[root.parts.length]).text) || null;
}

const PINNED_LIMIT = 30;
const PINNED_EXCERPT = 160;

function listOwnerNotes(ctx) {
  const projects = projectMap(ctx);
  const agents = agentProject(ctx);
  const isAgentNote = (item) => agents !== null && (agents.refs.has(item.data?.project)
    || (agents.id !== null && projects.get(item.data?.project)?.id === agents.id));
  return { projects, rawNotes: entity.list(ctx, 'note', { all: true }).filter((item) => !isAgentNote(item)) };
}

/**
 * Up to 30 pinned owner notes across all note kinds, leaving out notes linked to the agents project, newest
 * `updated` first, each with a plain-text excerpt of at most 160 characters for the pinned-notes rail.
 * @param {*} ctx
 */
export function pinnedNotesResult(ctx) {
  const { projects, rawNotes } = listOwnerNotes(ctx);
  const pinned = rawNotes.filter((item) => item.data?.pinned === true).sort((a, b) => {
    const updatedOrder = (Date.parse(b.data?.updated) || 0) - (Date.parse(a.data?.updated) || 0);
    if (updatedOrder !== 0) return updatedOrder;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  }).slice(0, PINNED_LIMIT);
  const { data, warnings } = result(ctx, pinned, {}, true);
  const items = data.items.map((item, at) => {
    const linked = projects.get(item.content.project) ?? null;
    const raw = pinned[at];
    const file = raw ? readFile(ctx, raw.path) : null;
    const body = item.content.body ?? (file && Buffer.byteLength(file.text) <= 5 * 1024 * 1024
      ? parseFile(file.text).body : '');
    return {
      ref: item.ref,
      title: item.content.title ?? '',
      kind: item.meta.kind ?? 'note',
      revision: item.revision,
      project: linked ? { id: linked.id, title: linked.title, tone: linked.tone } : null,
      excerpt: pinnedExcerpt(body),
    };
  });
  return okEnvelope({ items }, [...ctx.warnings, ...warnings]);
}

/**
 * Every owner note across all note kinds, leaving out notes linked to the agents project. Pinned notes come first,
 * then unpinned notes grouped by folder topic under the schema's notes root (locale order, unassigned last),
 * newest `updated` first within each group.
 * @param {*} ctx @param {{ project?: string }} [query]
 */
export function notesResult(ctx, { project } = {}) {
  const { projects, rawNotes } = listOwnerNotes(ctx);
  const { data, warnings } = result(ctx, rawNotes, {}, true);
  const roots = noteRoots(ctx.schema);
  const collator = new Intl.Collator(uiLanguage(), { sensitivity: 'base', numeric: true });
  const chips = [];
  const entries = data.items.map((item, at) => {
    const raw = rawNotes[at];
    const linked = projects.get(item.content.project) ?? null;
    if (linked?.id && !chips.some((chip) => chip.id === linked.id)) chips.push(linked);
    return {
      path: raw.path,
      note: {
        ref: item.ref,
        title: item.content.title ?? '',
        kind: item.meta.kind ?? 'note',
        pinned: item.meta.pinned === true,
        topic: noteTopic(roots, raw.path),
        project: linked ? { id: linked.id, title: linked.title, tone: linked.tone } : null,
        updated: item.meta.updated ?? null,
      },
    };
  });
  chips.sort((a, b) => collator.compare(a.title, b.title));
  const active = chips.find((chip) => chip.id === project)?.id ?? '';
  const visible = entries.filter((entry) => !active || entry.note.project?.id === active);
  visible.sort((a, b) => {
    if (a.note.pinned !== b.note.pinned) return a.note.pinned ? -1 : 1;
    if (!a.note.pinned) {
      const ta = a.note.topic;
      const tb = b.note.topic;
      if (ta !== tb) {
        if (ta === null) return 1;
        if (tb === null) return -1;
        const topicOrder = collator.compare(ta, tb) || (ta < tb ? -1 : 1);
        if (topicOrder !== 0) return topicOrder;
      }
    }
    const updatedOrder = (Date.parse(b.note.updated) || 0) - (Date.parse(a.note.updated) || 0);
    if (updatedOrder !== 0) return updatedOrder;
    return collator.compare(a.note.title, b.note.title) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  });
  return okEnvelope({
    items: visible.map((entry) => entry.note),
    projects: chips,
    project: active,
  }, [...ctx.warnings, ...warnings]);
}
