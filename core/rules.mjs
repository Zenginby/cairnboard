import { basename } from 'node:path';
import { fingerprint } from './schema.mjs';
import { PRESETS } from './presets.mjs';

// Every code `config.lint` may set (wiki spec §9), including the ones evidence and code checks add later.
export const LINT_CODES = Object.freeze([
  'orphan', 'broken_link', 'ambiguous_link', 'missing_page', 'missing_frontmatter', 'invalid_frontmatter', 'unknown_kind',
  'invalid_encoding', 'alias_conflict', 'stale', 'unprocessed_lesson', 'unprocessed_source',
  'raw_missing', 'raw_changed',
  'wakeup_budget', 'overview_multiple', 'superseded_link', 'expired', 'superseded_missing',
  'invalid_validity', 'evidence_missing', 'code_changed', 'code_missing', 'code_unlinked', 'index_mismatch', 'filename',
]);
export const SEVERITIES = Object.freeze(['error', 'warn', 'info', 'off']);

const FILENAME = /^[a-z0-9-]+\.md$/u;
const JOURNAL_DAY = /^\d{4}-\d{2}-\d{2}\.md$/u;

/** Canonical field names a page of this type and kind must carry (wiki spec §10). */
export function requiredFields(schema, type, kind) {
  if (type === 'journal') return ['date'];
  if (type === 'card' || !['note', 'research', 'project'].includes(type)) return [];
  const fields = ['title'];
  if (type === 'note' && ['concept', 'tool', 'query'].includes(kind)) fields.push('tags', 'updated');
  if (type === 'research' && kind === 'source') fields.push('raw', 'sourceDate');
  return fields;
}

export const empty = (value) => value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);

/**
 * Required fields a page lacks. `data` is canonical frontmatter; the title also counts when the body has a heading
 * (`untitled` false), and a journal's date also counts when its file is named `YYYY-MM-DD.md`.
 */
export function missingRequired(schema, { type, kind, path, data, untitled }) {
  return requiredFields(schema, type, kind).filter((field) => {
    if (field === 'title') return untitled !== false && empty(data?.title);
    if (field === 'date' && JOURNAL_DAY.test(basename(path))) return false;
    return empty(data?.[field]);
  });
}

export const filenameOk = (path) => FILENAME.test(basename(path));

// `filename` is a house rule of the owner's template: informational there, off everywhere else.
export function filenameDefault(schema) {
  return fingerprint(schema) === fingerprint(PRESETS['tr-wiki']) ? 'info' : 'off';
}

// The write rules of wiki spec §10 and the severities `config.rules` may set for them.
export const RULE_NAMES = Object.freeze(['required', 'sources', 'links', 'filename']);
export const RULE_SEVERITIES = Object.freeze(['error', 'warn', 'off']);

export const SOURCE_HEADING = /^ {0,3}##[ \t]+(?:sources|kaynaklar)[ \t]*(?:#+[ \t]*)?$/u;

// A `## Sources` (`## Kaynaklar`) heading outside code fences.
export function hasSourcesSection(body) {
  let fence = null;
  for (const line of body.split(/\r?\n/u)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker && (marker[1][0] === '~' || !marker[2].includes('`'))) {
      fence = marker[1];
      continue;
    }
    if (SOURCE_HEADING.test(line.toLocaleLowerCase('tr'))) return true;
  }
  return false;
}

export const turkish = (ctx) => ctx.config?.language === 'tr' || fingerprint(ctx.schema) === fingerprint(PRESETS['tr-wiki']);

/** Severity of one rule: `config.rules[name]`, else its default (§10). */
export function ruleSeverity(ctx, name) {
  return ctx.config?.rules?.[name] ?? (name === 'filename' ? filenameDefault(ctx.schema) : 'warn');
}
