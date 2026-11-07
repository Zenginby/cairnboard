import { basename } from 'node:path';
import { CairnError } from './errors.mjs';
import { parseFile, setFields, sectionRange, appendToSection } from './frontmatter.mjs';
import { readCanonical, physicalPatch, destination, isRawPath } from './schema.mjs';
import { ensureFresh, journalEntries } from './index.mjs';
import { write } from './store.mjs';
import { localDate, validateDate, resolve, list as entityList } from './entity.mjs';

const invalid = (message) => new CairnError('validation', message);
const types = ['decision', 'discovery', 'pitfall', 'lesson'];
const line = (value) => typeof value === 'string' && value.trim() && !/[\r\n]/u.test(value);

export function addEntry(ctx, { date = localDate(ctx), title, label, entries }, opts = {}) {
  validateDate(date);
  if (!line(title) || (label !== undefined && !line(label)) || !Array.isArray(entries)) throw invalid('Invalid journal entry.');
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
    const patch = physicalPatch(ctx.schema, file.data, data.date === undefined ? { date } : {});
    if (data.date !== undefined && data.date !== date) throw invalid('Journal date does not match its path.');
    if (Object.keys(patch).length) text = setFields(text, patch);
    // An empty new job still needs a heading; an existing empty job needs no additional bytes.
    if (!lines.length && sectionRange(text, heading)) return text;
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
