import { createHash } from 'node:crypto';
import { CairnError } from './errors.mjs';
import { safeRelative } from './paths.mjs';
import { pathKey } from './text.mjs';
import { PRESETS } from './presets.mjs';

const invalid = () => new CairnError('validation', 'Invalid schema.');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key) ? value[key] : undefined;
const paths = (value) => Array.isArray(value) ? value : [value];
const under = (rel, root) => rel.startsWith(`${root}/`);
const noteKinds = ['note', 'concept', 'tool', 'query', 'overview'];
const researchKinds = ['source', 'review', 'analysis'];
const entities = ['note', 'research', 'project', 'journal', 'card'];

const forbidden = new Set(['__proto__', 'constructor', 'prototype']);

function relativePath(value) {
  try {
    return safeRelative(value).replace(/\\/gu, '/');
  } catch {
    throw invalid();
  }
}

// Content may live neither in raw sources nor in dot folders (.cairn, .git, .obsidian).
function contentPath(schema, value) {
  const rel = relativePath(value);
  if (isRawPath(schema, rel) || rel.split('/').some((part) => part.startsWith('.'))) throw invalid();
  return rel;
}

export function resolveSchema(config) {
  const schema = config.schema === undefined ? PRESETS.default : config.schema;
  if (!object(schema)) throw invalid();
  if (!Number.isInteger(schema.schemaVersion)) throw invalid();
  if (schema.schemaVersion > 1) throw new CairnError('format_too_new', 'Schema requires a newer format.');
  if (schema.schemaVersion !== 1 || !object(schema.roots) || !object(schema.kindFolders)
    || !object(schema.fields) || !object(schema.values) || !object(schema.entryTypes)
    || !Array.isArray(schema.ignore) || !Array.isArray(schema.sourceRoots)) throw invalid();
  // A physical name may not be another field's canonical or physical name, or both would be written to one key.
  const physical = new Set();
  for (const [field, name] of Object.entries(schema.fields)) {
    if (!field || forbidden.has(field) || typeof name !== 'string' || !name || forbidden.has(name) || physical.has(name)
      || (name !== field && Object.hasOwn(schema.fields, name))) throw invalid();
    physical.add(name);
  }
  for (const [field, aliases] of Object.entries(schema.values)) {
    if (forbidden.has(field) || !object(aliases) || Object.keys(aliases).some((alias) => forbidden.has(alias))
      || Object.values(aliases).some((value) => typeof value !== 'string')) throw invalid();
  }
  for (const source of schema.sourceRoots) relativePath(source);
  for (const [entity, root] of Object.entries(schema.roots)) {
    if (!entities.includes(entity) || !object(root) || !paths(root.path).length
      || (root.flat !== undefined && typeof root.flat !== 'boolean')) throw invalid();
    for (const path of paths(root.path)) contentPath(schema, path);
  }
  for (const [kind, path] of Object.entries(schema.kindFolders)) {
    if (!noteKinds.includes(kind)) throw invalid();
    contentPath(schema, path);
  }
  if (schema.ignore.some((pattern) => typeof pattern !== 'string' || !pattern || pattern.length > 256)) throw invalid();
  if (schema.catalog !== null && schema.catalog !== undefined
    && !pathKey(contentPath(schema, schema.catalog)).endsWith('.md')) throw invalid();
  if (schema.quickNotes !== undefined && schema.quickNotes !== '') contentPath(schema, schema.quickNotes);
  for (const labels of Object.values(schema.entryTypes)) {
    if (!Array.isArray(labels) || labels.some((label) => typeof label !== 'string')) throw invalid();
  }
  return structuredClone(schema);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return object(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
}

export function fingerprint(schema) {
  return createHash('sha256').update(JSON.stringify(canonical(schema))).digest('hex').slice(0, 16);
}

// '*' matches within one path segment, '**' across segments and '**/' also matches nothing. Dynamic programming keeps
// matching linear in pattern × path length whatever the pattern (no regex backtracking).
function matches(rel, pattern) {
  const tokens = [];
  pattern = [...pathKey(pattern)];
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] !== '*') tokens.push(pattern[index]);
    else if (pattern[index + 1] !== '*') tokens.push('*');
    else if (pattern[index + 2] === '/') {
      tokens.push('**/');
      index += 2;
    } else {
      tokens.push('**');
      index++;
    }
  }
  // col[i]: tokens[0..i) match the path read so far; reach[i]: they matched some earlier prefix (for '**/').
  let col = [true];
  for (const token of tokens) col.push(col.at(-1) && token.startsWith('*'));
  let reach = [...col];
  for (const char of rel) {
    const next = [false];
    for (const [index, token] of tokens.entries()) {
      if (token === '**') next.push(next[index] || col[index + 1]);
      else if (token === '*') next.push(next[index] || (char !== '/' && col[index + 1]));
      else if (token === '**/') next.push(next[index] || (char === '/' && reach[index]));
      else next.push(col[index] && token === char);
    }
    reach = reach.map((value, index) => value || next[index]);
    col = next;
  }
  return col[tokens.length];
}

function mappedValue(aliases, value) {
  if (Array.isArray(value)) return value.map((item) => mappedValue(aliases, item));
  return typeof value === 'string' && Object.hasOwn(aliases, value) ? aliases[value] : value;
}

export function readCanonical(schema, data) {
  data ??= {};
  const physical = new Set(Object.values(schema.fields));
  const result = Object.fromEntries(Object.entries(data).filter(([key]) => !physical.has(key)));
  for (const [field, name] of Object.entries(schema.fields)) {
    if (Object.hasOwn(data, field)) result[field] = data[field];
    else if (Object.hasOwn(data, name)) result[field] = data[name];
  }
  for (const [field, aliases] of Object.entries(schema.values)) {
    if (Object.hasOwn(result, field)) result[field] = mappedValue(aliases, result[field]);
  }
  return result;
}

export function physicalPatch(schema, data, patch) {
  data ??= {};
  for (const [field, name] of Object.entries(schema.fields)) {
    if (field !== name && Object.hasOwn(data, field) && Object.hasOwn(data, name)) {
      throw new CairnError('validation', 'Frontmatter contains both field names.', { reason: 'alias_conflict', field });
    }
  }
  const result = {};
  for (const [field, value] of Object.entries(patch)) {
    const physical = own(schema.fields, field) ?? field;
    const name = Object.hasOwn(data, field) ? field : physical;
    const aliases = own(schema.values, field) ?? {};
    const reverse = Object.fromEntries(Object.keys(aliases).sort().reverse().map((alias) => [aliases[alias], alias]));
    if (Object.hasOwn(result, name)) {
      throw new CairnError('validation', 'Two fields map to one frontmatter key.', { reason: 'alias_conflict', field });
    }
    result[name] = name === physical ? mappedValue(reverse, value) : value;
  }
  return result;
}

export function classify(schema, rel, data) {
  rel = pathKey(relativePath(rel));
  // Raw sources are never entities (wiki spec §2), whatever their frontmatter says.
  if ((schema.catalog && rel === pathKey(relativePath(schema.catalog))) || isRawPath(schema, rel)
    || schema.ignore.some((pattern) => matches(rel, pattern))) return { ignored: true };
  if (!rel.endsWith('.md')) return { unclassified: true };
  const fields = readCanonical(schema, data);
  if (Object.hasOwn(fields, 'kind')) {
    const kind = fields.kind;
    if (noteKinds.includes(kind)) return { entity: 'note', kind };
    if (researchKinds.includes(kind)) return { entity: 'research', kind };
    if (['project', 'journal'].includes(kind)) return { entity: kind, kind };
    return { entity: 'note', kind: 'note', unknownKind: typeof kind === 'string' ? kind : JSON.stringify(kind) ?? 'undefined' };
  }
  let best = null;
  for (const [entity, root] of Object.entries(schema.roots)) {
    for (const path of paths(root.path)) {
      const key = pathKey(relativePath(path));
      if (!under(rel, key) || (best && best.length >= key.length)) continue;
      const nested = (root.flat ?? entity !== 'note') && rel.slice(key.length + 1).includes('/');
      best = { length: key.length, result: nested ? { entity: 'note', kind: 'note' }
        : { entity, kind: entity === 'note' ? 'note' : null } };
    }
  }
  for (const [kind, path] of Object.entries(schema.kindFolders)) {
    const key = pathKey(relativePath(path));
    const match = key.endsWith('.md') ? rel === key : under(rel, key);
    if (match && (!best || key.length >= best.length)) best = { length: key.length, result: { entity: 'note', kind } };
  }
  return best?.result ?? { entity: 'note', kind: 'note' };
}

export function destination(schema, entity, kind, slug) {
  if (typeof slug !== 'string' || !slug || /[/\\]/u.test(slug) || !entities.includes(entity)) throw invalid();
  relativePath(slug);
  const folder = entity === 'note' ? own(schema.kindFolders, kind) : null;
  const root = paths(schema.roots[entity]?.path)[0];
  if (!root) throw invalid();
  // Quick notes go where the schema says (`quickNotes`, '' is the data root), else into the first note root.
  const quick = entity === 'note' && (kind === 'note' || kind == null) && schema.quickNotes !== undefined;
  const base = folder ?? (quick ? schema.quickNotes : root);
  const rel = relativePath(folder && pathKey(folder).endsWith('.md') ? folder : `${base ? `${base}/` : ''}${slug}.md`);
  if (isRawPath(schema, rel)) throw invalid();
  return rel;
}

export function isRawPath(schema, rel) {
  rel = pathKey(relativePath(rel));
  return ['raw', ...schema.sourceRoots].some((root) => {
    const key = pathKey(relativePath(root));
    return rel === key || under(rel, key);
  });
}
