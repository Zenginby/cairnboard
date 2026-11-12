import { basename } from 'node:path';
import { CairnError } from './errors.mjs';
import { parseFile, setFields, sectionRange, appendToSection } from './frontmatter.mjs';
import { readCanonical, physicalPatch, destination, isRawPath } from './schema.mjs';
import { ensureFresh, journalEntries } from './index.mjs';
import { write } from './store.mjs';
import { localDate, validateDate, resolve, list as entityList } from './entity.mjs';
import { visibleLines } from './links.mjs';

const invalid = (message) => new CairnError('validation', message);
const types = ['decision', 'discovery', 'pitfall', 'lesson'];
const line = (value) => typeof value === 'string' && value.trim() && !/[\r\n]/u.test(value);
const SUMMARY_MAX = 2000;

// A job's project link: one HTML comment line right under its `## title · label` heading. It moves with the section,
// reads as plain Markdown, renders as nothing and leaves the heading and the item lines alone.
const PROJECT_MARK = /^<!--[\t ]*cairn:project[\t ]+([^\s<>]+)[\t ]*-->[\t ]*$/u;
const projectMark = (id) => `<!-- cairn:project ${id} -->`;

// The section's project mark: the first non-blank line after the heading, when it is one.
function markIn(text, range) {
  const eol = text.indexOf('\n', range[0]);
  let at = eol < 0 ? range[1] : eol + 1;
  while (at < range[1]) {
    const end = text.indexOf('\n', at);
    const stop = end < 0 || end > range[1] ? range[1] : end;
    const content = text.slice(at, stop).replace(/\r$/u, '');
    if (content.trim()) {
      const match = content.match(PROJECT_MARK);
      return match ? { id: match[1] } : null;
    }
    at = stop + 1;
  }
  return null;
}

function splitHeading(heading) {
  const parts = heading.split(/\s·\s/u).map((part) => part.trim());
  return parts.length > 1 ? { title: parts.slice(0, -1).join(' · '), label: parts.at(-1) }
    : { title: heading, label: null };
}

/** Each `## ` job of a journal day, in file order, with its project id or null. */
export function sections(text) {
  const found = [];
  let current = null;
  for (const { content } of visibleLines(text)) {
    const heading = content.match(/^##[\t ]+(.*?)[\t ]*$/u);
    if (heading) {
      current = { ...splitHeading(heading[1]), project: null, open: true };
      found.push(current);
      continue;
    }
    if (/^#[\t ]/u.test(content)) { current = null; continue; }
    if (!current?.open || !content.trim()) continue;
    const mark = content.match(PROJECT_MARK);
    if (mark) current.project = mark[1];
    current.open = false;
  }
  return found.map(({ open, ...section }) => section);
}

function projectId(ctx, ref) {
  if (!line(ref)) throw invalid('Invalid journal project.');
  const project = resolve(ctx, 'project', ref.trim());
  if (project.id === null) throw invalid('The project needs an id before a journal job can link to it.');
  return project.id;
}

function summaryValue(summary) {
  if (summary === undefined) return undefined;
  if (typeof summary !== 'string' || /[\r\n]/u.test(summary)) throw invalid('Journal summary must be one line.');
  const value = summary.trim();
  if (value.length > SUMMARY_MAX) throw invalid(`Journal summary must be at most ${SUMMARY_MAX} characters.`);
  return value;
}

export function addEntry(ctx, { date = localDate(ctx), title, label, entries, project, summary }, opts = {}) {
  validateDate(date);
  const summaryText = summaryValue(summary);
  // A summary alone sets the day's summary and adds no job; anything else needs a job title.
  const jobless = title === undefined && summaryText !== undefined && project === undefined
    && label === undefined && Array.isArray(entries) && !entries.length;
  if (!jobless && (!line(title) || (label !== undefined && !line(label)) || !Array.isArray(entries))) {
    throw invalid('Invalid journal entry.');
  }
  const projectRef = project === undefined ? null : projectId(ctx, project);
  const lines = entries.map(({ type, text }) => {
    if ((type !== null && !types.includes(type)) || typeof text !== 'string' || !text.trim()) throw invalid('Invalid journal item.');
    const labels = ctx.schema.entryTypes[type] ?? [];
    const name = labels[ctx.config.language === 'tr' ? 0 : 1] ?? labels[0];
    if (type !== null && !line(name)) throw invalid('Missing journal item label.');
    const body = text.replace(/\r\n|\r/gu, '\n').replace(/\n/gu, '\n  ');
    return `- ${type === null ? '' : `**${name}:** `}${body}`;
  });
  const path = destination(ctx.schema, 'journal', null, date);
  if (isRawPath(ctx.schema, path)) throw invalid('Raw sources cannot be journals.');
  const heading = title + (label === undefined ? '' : ` · ${label}`);
  return write(ctx, { ...opts, path, target: `@${path.slice(0, -3)}`, op: 'journal.add', apply: (before) => {
    let text = before ?? '';
    const file = parseFile(text);
    if (file.error) throw invalid(file.error);
    const data = readCanonical(ctx.schema, file.data);
    const fields = { ...(data.date === undefined ? { date } : {}),
      // An empty summary removes the field (undefined deletes the key); an unchanged one writes nothing.
      ...(summaryText === undefined || (summaryText || undefined) === data.summary ? {}
        : { summary: summaryText || undefined }) };
    const patch = physicalPatch(ctx.schema, file.data, fields);
    if (data.date !== undefined && data.date !== date) throw invalid('Journal date does not match its path.');
    if (Object.keys(patch).length) text = setFields(text, patch);
    if (jobless) return text;
    const range = sectionRange(text, heading);
    if (projectRef !== null) {
      const mark = range ? markIn(text, range) : null;
      if (mark && mark.id !== projectRef) throw invalid('This journal job is linked to another project.');
      if (range && !mark) {
        // Under the heading line of an existing job that has no link yet.
        const eol = text.indexOf('\n', range[0]);
        const newline = parseFile(text).eol;
        text = eol < 0 ? `${text}${newline}${newline}${projectMark(projectRef)}${newline}`
          : `${text.slice(0, eol + 1)}${newline}${projectMark(projectRef)}${newline}${text.slice(eol + 1)}`;
      }
      if (!range) return appendToSection(text, heading, [projectMark(projectRef), '', ...lines]);
    }
    // An empty new job still needs a heading; an existing empty job needs no additional bytes.
    if (!lines.length && range) return text;
    return appendToSection(text, heading, lines.length ? lines : ['']);
  } });
}

export function show(ctx, date = localDate(ctx)) {
  validateDate(date);
  return resolve(ctx, 'journal', `@${destination(ctx.schema, 'journal', null, date).slice(0, -3)}`);
}

/** @param {*} ctx @param {{ month?: string }} [filters] */
export function list(ctx, { month } = {}) {
  if (month !== undefined && (typeof month !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month))) throw invalid('Invalid month.');
  return entityList(ctx, 'journal').filter((item) => month === undefined || String(item.data.date ?? basename(item.path, '.md')).startsWith(`${month}-`));
}

export function entries(ctx, filters = {}) {
  if (filters.since !== undefined) validateDate(filters.since);
  if (filters.type !== undefined && !types.includes(filters.type)) throw invalid('Invalid journal item type.');
  ensureFresh(ctx);
  return journalEntries(ctx, filters);
}
