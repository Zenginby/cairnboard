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

function relativePath(value) {
  try {
    return safeRelative(value).replace(/\\/gu, '/');
  } catch {
    throw invalid();
  }
}

export function resolveSchema(config) {
  const schema = config.schema === undefined ? PRESETS.default : config.schema;
  if (!object(schema)) throw invalid();
  if (!Number.isInteger(schema.schemaVersion)) throw invalid();
  if (schema.schemaVersion > 1) throw new CairnError('format_too_new', 'Schema requires a newer format.');
  if (schema.schemaVersion !== 1 || !object(schema.roots) || !object(schema.kindFolders)
    || !object(schema.fields) || !object(schema.values) || !object(schema.entryTypes)
    || !Array.isArray(schema.ignore) || !Array.isArray(schema.sourceRoots)) throw invalid();
  const physical = new Set();
  for (const [field, name] of Object.entries(schema.fields)) {
    if (!field || typeof name !== 'string' || !name || physical.has(name)) throw invalid();
    physical.add(name);
  }
  for (const aliases of Object.values(schema.values)) {
    if (!object(aliases) || Object.values(aliases).some((value) => typeof value !== 'string')) throw invalid();
  }
  for (const source of schema.sourceRoots) relativePath(source);
  for (const [entity, root] of Object.entries(schema.roots)) {
    if (!entities.includes(entity) || !object(root) || !paths(root.path).length
      || (root.flat !== undefined && typeof root.flat !== 'boolean')) throw invalid();
    for (const path of paths(root.path)) {
      if (isRawPath(schema, relativePath(path))) throw invalid();
    }
  }
  for (const [kind, path] of Object.entries(schema.kindFolders)) {
    if (!noteKinds.includes(kind) || isRawPath(schema, relativePath(path))) throw invalid();
  }
  if (schema.ignore.some((pattern) => typeof pattern !== 'string' || !pattern)) throw invalid();
  if (schema.catalog !== null && schema.catalog !== undefined) relativePath(schema.catalog);
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

function matches(rel, pattern) {
  pattern = pathKey(pattern);
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] !== '*') {
      source += pattern[index].replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    } else if (pattern[index + 1] === '*') {
      index++;
      if (pattern[index + 1] === '/') {
        source += '(?:.*/)?';
        index++;
      } else source += '.*';
    } else source += '[^/]*';
  }
  return new RegExp(`^${source}$`, 'u').test(rel);
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
  return Object.fromEntries(Object.entries(patch).map(([field, value]) => {
    const physical = own(schema.fields, field) ?? field;
    const name = Object.hasOwn(data, field) ? field : physical;
    const aliases = own(schema.values, field) ?? {};
    const reverse = Object.fromEntries(Object.keys(aliases).sort().reverse().map((alias) => [aliases[alias], alias]));
    return [name, name === physical ? mappedValue(reverse, value) : value];
  }));
}

export function classify(schema, rel, data) {
  rel = pathKey(relativePath(rel));
  if ((schema.catalog && rel === pathKey(relativePath(schema.catalog)))
    || schema.ignore.some((pattern) => matches(rel, pattern))) return { ignored: true };
  if (!rel.endsWith('.md')) return { unclassified: true };
  const fields = readCanonical(schema, data);
  if (Object.hasOwn(fields, 'kind')) {
    const kind = fields.kind;
    if (noteKinds.includes(kind)) return { entity: 'note', kind };
    if (researchKinds.includes(kind)) return { entity: 'research', kind };
    if (['project', 'journal'].includes(kind)) return { entity: kind, kind };
    return { entity: 'note', kind: 'note', unknownKind: String(kind) };
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
  return best?.result ?? (rel.includes('/') ? { unclassified: true } : { entity: 'note', kind: 'note' });
}

export function destination(schema, entity, kind, slug) {
  if (typeof slug !== 'string' || !slug || /[/\\]/u.test(slug) || !entities.includes(entity)) throw invalid();
  relativePath(slug);
  const folder = entity === 'note' ? own(schema.kindFolders, kind) : null;
  const root = paths(schema.roots[entity]?.path)[0];
  if (!root) throw invalid();
  // A note root that holds the wiki's kind folders is the wiki itself; quick notes then sit at the data root.
  const wikiRoot = Object.values(schema.kindFolders).some((path) => under(pathKey(relativePath(path)), pathKey(relativePath(root))));
  const base = folder ?? (entity === 'note' && (kind === 'note' || kind == null) && wikiRoot ? '' : root);
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
