import { stripHidden, oneLine } from '../core/text.mjs';
import { CairnError } from '../core/errors.mjs';
import { keyBetween } from '../core/position.mjs';

export const actorPattern = /^[a-z0-9][a-z0-9._-]{0,31}$/u;

export function clean(value, { raw = false } = {}) {
  if (typeof value === 'string') return raw ? value : stripHidden(value).text;
  if (Array.isArray(value)) return value.map((item) => clean(item, { raw }));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [clean(key, { raw }), clean(item, { raw })]));
  return value;
}

function iso(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/u.exec(value);
  if (!match) return false;
  const [year, month, day] = match[1].split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && day >= 1 && day <= (days[month - 1] ?? 0);
}

function position(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]+$/u.test(value)) return false;
  try { keyBetween(value, null); return true; } catch { return false; }
}

function count(value) {
  return value && Number.isSafeInteger(value.done) && Number.isSafeInteger(value.total)
    && value.done >= 0 && value.total >= value.done;
}

const dateFields = ['created', 'updated', 'claimed', 'lease', 'done', 'date', 'sourceDate', 'valid_from', 'valid_until', 'deletedAt'];
const kinds = {
  note: ['note', 'concept', 'tool', 'query', 'overview'], research: ['source', 'review', 'analysis'],
  project: ['project'], journal: ['journal'],
};

function valid(field, value, type, columns) {
  if (dateFields.includes(field)) return iso(value);
  switch (field) {
    case 'status': return ['active', 'paused', 'archived'].includes(value);
    case 'tone': return Number.isInteger(value) && value >= 1 && value <= 8;
    case 'column': return typeof value === 'string' && columns.some((column) => (column.key ?? column) === value);
    case 'position': return position(value);
    case 'priority': return ['urgent', 'important', 'low'].includes(value);
    case 'pinned': return typeof value === 'boolean';
    case 'kind': return (kinds[type] ?? []).includes(value);
    case 'assignee': return typeof value === 'string' && actorPattern.test(value);
    default: return false;
  }
}

function bounded(text, maxBytes, warnings) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  warnings.push('truncated');
  let bytes = 0, end = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char);
    if (bytes > maxBytes) break;
    end += char.length;
  }
  return text.slice(0, end);
}

export function toJson(entity, { raw = false, maxBytes = 65536, columns = [], warnings = [] } = {}) {
  const meta = {}, content = {};
  for (const [field, value] of Object.entries(entity.data ?? {})) {
    if (field === 'id' || field === 'title') continue;
    if (valid(field, value, entity.type, columns)) meta[field] = value;
    else Object.defineProperty(content, field, { value, enumerable: true, configurable: true, writable: true });
  }
  // The classifier's kind wins over an unrecognised raw value (a page with `tur: pano` is a note of kind note).
  if (entity.kind !== undefined && entity.kind !== null && !Object.hasOwn(meta, 'kind')
    && valid('kind', entity.kind, entity.type, columns)) meta.kind = entity.kind;
  if (count(entity.acceptance)) meta.acceptance = { done: entity.acceptance.done, total: entity.acceptance.total };
  content.title = entity.title ?? '';
  if (typeof entity.body === 'string') content.body = bounded(clean(entity.body, { raw }), maxBytes, warnings);
  if (typeof entity.snippet === 'string') content.snippet = bounded(clean(entity.snippet, { raw }), maxBytes, warnings);
  // A cleaned selector would point at no file; fall back to the stable id, or say the selector needs --raw.
  let ref = entity.ref ?? null;
  if (!raw && typeof ref === 'string' && stripHidden(ref).removed) {
    warnings.push('hidden_in_path');
    if (entity.id) ref = entity.id;
  }
  return clean({ id: entity.id ?? null, type: entity.type, ref, path: entity.path ?? null,
    revision: entity.revision ?? null, meta, content }, { raw });
}

export function compact(entity, opts = {}) {
  const item = toJson(entity, opts);
  const assignee = item.meta.assignee ?? (typeof item.content.assignee === 'string' ? item.content.assignee : '-');
  const fields = entity.type === 'card' ? [item.ref, opts.column ?? item.meta.column ?? '-', item.meta.priority ?? '-',
    assignee, `${item.meta.acceptance?.done ?? 0}/${item.meta.acceptance?.total ?? 0}`, item.content.title]
    : [item.content.title || item.ref || item.content.snippet || '',
      ...(entity.type === 'research' && typeof item.content.category === 'string' ? [item.content.category] : [])];
  return fields.map((value) => oneLine(clean(String(value), opts))).join('\t');
}

export function human(data) {
  if (data && Array.isArray(data.items)) return data.items.map((item) => typeof item === 'string' ? item
    : oneLine(item.content?.title || item.content?.text || item.ref || item.path || JSON.stringify(item))
      + (item.type === 'research' && typeof item.content?.category === 'string'
        ? `\t${oneLine(item.content.category)}` : '')).join('\n');
  if (data?.content) {
    // A card's one-line status fields, each on its own labelled line, before the body.
    const statusFields = data.type === 'card' ? ['now', 'next', 'needs'] : data.type === 'research' ? ['category'] : [];
    const status = statusFields.filter((field) => typeof data.content[field] === 'string')
      .map((field) => `${field}: ${oneLine(data.content[field])}`);
    return [oneLine(data.content.title ?? ''), JSON.stringify(data.meta), ...status,
      data.content.body ?? data.content.snippet ?? ''].join('\n');
  }
  return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

export function okEnvelope(data, warnings = [], opts = {}) {
  return clean({ v: 1, ok: true, data, warnings: [...new Set(warnings)] }, opts);
}

export function errorEnvelope(error, warnings = [], opts = {}) {
  const known = error instanceof CairnError;
  const code = known ? error.code : 'internal';
  const message = oneLine(clean(known ? error.message : 'An internal error occurred.'));
  const current = known ? error.details.current : undefined;
  const rules = known ? error.details.rules : undefined;
  return { v: 1, ok: false, error: { code, message,
    ...(current === undefined ? {} : { current: clean(current, opts) }),
    ...(rules === undefined ? {} : { rules: clean(rules, opts) }) }, warnings: [...new Set(warnings)] };
}
