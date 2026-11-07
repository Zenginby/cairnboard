import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import * as fs from './fsx.mjs';
import { CairnError } from './errors.mjs';
import { newId, normalizeId, isNoteKey, slugify, uniqueName, pathKey } from './ids.mjs';
import { checkedPath, safeRelative } from './paths.mjs';
import { parseFile, setFields, replaceBody } from './frontmatter.mjs';
import { classify, readCanonical, physicalPatch, destination, isRawPath } from './schema.mjs';
import { extract } from './extract.mjs';
import { dayOf, localDate, validateDate } from './dates.mjs';

import { ensureFresh, rows, findById } from './index.mjs';
import { readFile, revision, write } from './store.mjs';
import { retryWhileLocked, withLock } from './lock.mjs';
import { keyBetween } from './position.mjs';
import { assertRules, checkPage, ruleWarnings } from './check.mjs';

/** @typedef {{ type: string, kind: string|null, id: string|null, ref: string, path: string,
 * revision: string, title: string, data: object, acceptance: { done: number, total: number }, warnings: string[] }} Summary */
/** @typedef {Summary & { body: string }} Entity */

const prefixes = { project: 'p', note: 'n', research: 'r', card: 'c' };
export { dayOf, localDate, validateDate };
const invalid = (message) => new CairnError('validation', message);
const missing = () => new CairnError('not_found', 'Entity was not found.');

// Only a valid, unexpired lease protects a claim (5 minutes of clock tolerance). A finished card or a hand-typed
// `assignee:` without a lease protects nothing, so it can never lock other actors out for good.
export function liveClaim(ctx, data) {
  const { assignee, lease } = data ?? {};
  if (!assignee || typeof lease !== 'string' || !Number.isFinite(Date.parse(lease))) return null;
  return ctx.clock.now().getTime() > Date.parse(lease) + 5 * 60 * 1000 ? null : { assignee, lease };
}

// Every card write by another actor must respect a live claim, whichever command it comes through.
export function requireCardOwner(ctx, data) {
  const claim = liveClaim(ctx, data);
  const colon = typeof ctx.actor === 'string' ? ctx.actor.indexOf(':') : -1;
  if (claim && claim.assignee !== ctx.actor?.slice(colon + 1)) {
    throw new CairnError('claimed', 'Card is claimed by another actor.', { current: claim });
  }
}

export function validatePriority(priority) {
  if (!['urgent', 'important', 'low'].includes(priority)) throw invalid('Invalid card priority.');
}

export function validate(type, fields) {
  if (typeof fields.title !== 'string' || !fields.title.trim()) throw invalid('Title is required.');
  if (type === 'project') {
    if (fields.status !== undefined && !['active', 'paused', 'archived'].includes(fields.status)) throw invalid('Invalid project status.');
    if (fields.tone !== undefined && (!Number.isInteger(fields.tone) || fields.tone < 1 || fields.tone > 8)) throw invalid('Invalid project tone.');
    if (fields.kind !== undefined && fields.kind !== 'project') throw invalid('Invalid project kind.');
  }
  if (type === 'note') {
    if (!['note', 'concept', 'tool', 'query', 'overview'].includes(fields.kind)) throw invalid('Invalid note kind.');
    if (fields.pinned !== undefined && typeof fields.pinned !== 'boolean') throw invalid('Invalid pinned value.');
  }
  if (type === 'research') {
    if (!['source', 'review', 'analysis'].includes(fields.kind)) throw invalid('Invalid research kind.');
    if (fields.date !== undefined) validateDate(fields.date);
  }
  if (type === 'card' && fields.priority !== undefined) validatePriority(fields.priority);
  for (const field of ['valid_from', 'valid_until']) {
    if (fields[field] !== undefined) validateDate(fields[field]);
  }
}

function refPath(ref) {
  return safeRelative(`${ref.slice(1).replace(/\.md$/iu, '')}.md`).replace(/\\/gu, '/');
}

function duplicate(ctx, id) {
  return id !== null && findById(ctx, id).length > 1;
}

function summary(ctx, item, rev, duplicated = duplicate(ctx, item.id)) {
  return {
    type: item.type, kind: item.kind ?? null, id: item.id, ref: item.ref, path: item.path,
    revision: rev, title: item.title, data: item.data, acceptance: item.acceptance,
    warnings: duplicated ? ['duplicate_id'] : [],
  };
}

function fromText(ctx, type, path, text) {
  const item = extract(ctx.schema, path, text);
  if (!item || item.type !== type) throw missing();
  return { ...summary(ctx, item, revision(text)), body: item.body };
}

export function resolve(ctx, type, ref) {
  const notFound = () => type === 'project'
    ? new CairnError('not_found', 'Project was not found. Enter a project id or name.') : missing();
  if (typeof ref !== 'string') throw notFound();
  ensureFresh(ctx);
  let path, file;
  if (type === 'note' && isNoteKey(ref)) {
    const matches = rows(ctx, 'note').filter((row) => row.id === null && row.ref === ref);
    if (matches.length === 1) path = matches[0].path;
  } else if (ref.startsWith('@')) path = refPath(ref);
  else {
    const id = normalizeId(ref);
    path = (id ? findById(ctx, id) : []).find((path) => {
      const candidate = readFile(ctx, path);
      if (!candidate || classify(ctx.schema, path, parseFile(candidate.text).data).entity !== type) return false;
      file = candidate;
      return true;
    });
    if (!path && type === 'project') {
      const name = ref.toLowerCase();
      const matches = list(ctx, 'project').filter((item) => [item.title, ...(Array.isArray(item.data.aliases) ? item.data.aliases : [])]
        .some((value) => typeof value === 'string' && value.toLowerCase() === name));
      if (matches.length > 1) throw new CairnError('validation',
        `Ambiguous project name. Matching projects: ${matches.map((item) => item.id ?? item.ref).join(', ')}. Use a project id.`);
      path = matches[0]?.path;
    }
  }
  if (!path) throw notFound();
  file ??= readFile(ctx, path);
  if (!file) throw notFound();
  return fromText(ctx, type, path, file.text);
}

// Omitting type returns all entity summaries from one index snapshot.
export function list(ctx, type, filters = {}) {
  ensureFresh(ctx);
  const kind = type === 'note' && !filters.all ? filters.kind ?? 'note' : undefined;
  // One pass over every row finds duplicate ids without a query per entity.
  const all = rows(ctx);
  const seen = new Map();
  for (const item of all) if (item.id !== null) seen.set(item.id, (seen.get(item.id) ?? 0) + 1);
  return all.filter((item) => (type === undefined || item.type === type) && (kind === undefined || item.kind === kind))
    .map((item) => summary(ctx, item, item.revision, seen.get(item.id) > 1));
}

function freshId(ctx, type) {
  let id;
  do { id = newId(prefixes[type]); } while (findById(ctx, id).length);
  return id;
}

function checkOverview(ctx, type, kind, path) {
  if (type === 'note' && kind === 'overview' && rows(ctx, 'note', { kind: 'overview' }).some((item) => item.path !== path)) {
    throw invalid('Only one overview page is allowed.');
  }
}

export function directoryLock(ctx, folder, opts, fn) {
  if (opts.dryRun === true || ctx.mode === 'dry-run') return fn();
  if (ctx.mode !== 'write') throw new CairnError('internal', 'Mutations require write mode.');
  const name = 'd-' + createHash('sha1').update(pathKey(folder)).digest('hex').slice(0, 16);
  // Contending creators must choose their names after the previous creator has committed.
  return retryWhileLocked((state) => withLock(ctx, name, () => { state.entered = true; return fn(); }));
}

export function names(ctx, folder) {
  try {
    return fs.readdirSync(folder === '.' ? ctx.root : checkedPath(ctx.root, folder))
      .filter((name) => /\.md$/iu.test(name)).map((name) => name.slice(0, -3));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [];
  }
}

export function create(ctx, type, fields, body = '', opts = {}) {
  if (!Object.hasOwn(prefixes, type)) throw invalid('Unsupported entity type.');
  if (typeof body !== 'string') throw invalid('Body must be text.');
  return directoryLock(ctx, createFolder(ctx, type, fields), opts, () => {
    const { path, text, entity, warnings, data } = draft(ctx, type, fields, body);
    const result = write(ctx, { ...opts, path, target: data.id, op: `${type}.create`, expectAbsent: true, apply: () => text });
    return { ...result, warnings: [...result.warnings, ...warnings], entity };
  });
}

/** The folder a new entity of this type and kind lands in; `create` and `draft` callers lock it while choosing names. */
export function createFolder(ctx, type, fields) {
  const kind = fields.kind ?? (type === 'note' ? 'note' : type === 'research' ? 'source' : null);
  return dirname(destination(ctx.schema, type, kind, slugify(fields.title)));
}

/**
 * A new entity's file without writing it: `{ path, text, entity, warnings, data }`. Callers hold the directory lock
 * (`directoryLock(ctx, createFolder(...))`) so the chosen name stays free until their write.
 */
export function draft(ctx, type, fields, body = '') {
  if (!Object.hasOwn(prefixes, type)) throw invalid('Unsupported entity type.');
  if (typeof body !== 'string') throw invalid('Body must be text.');
  const kind = fields.kind ?? (type === 'note' ? 'note' : type === 'research' ? 'source' : null);
  const slug = slugify(fields.title);
  const initial = destination(ctx.schema, type, kind, slug);
  const folder = dirname(initial);
  ensureFresh(ctx);
  const now = ctx.clock.now().toISOString();
  const defaults = type === 'project' ? { status: 'active', tone: rows(ctx, 'project').length % 8 + 1 }
    : type === 'note' ? { kind: 'note', pinned: false, tags: [] }
    : type === 'card' ? { column: ctx.config.columns[0].key, position: keyBetween(null, null), tags: [] }
    : { kind: 'source', date: localDate(ctx) };
  const data = { ...defaults, ...fields, id: freshId(ctx, type), created: now, updated: now };
  validate(type, data);
  checkOverview(ctx, type, data.kind);
  const fixed = type === 'note' && /\.md$/iu.test(ctx.schema.kindFolders[data.kind] ?? '');
  const path = fixed ? initial : destination(ctx.schema, type, data.kind, uniqueName(names(ctx, folder), slug));
  if (isRawPath(ctx.schema, path)) throw invalid('Raw sources cannot be entities.');
  if (fixed && readFile(ctx, path)) throw invalid('The page already exists.');
  const text = replaceBody(setFields('', physicalPatch(ctx.schema, {}, data)), body);
  const { body: ignored, ...entity } = fromText(ctx, type, path, text);
  const warnings = enforce(ctx, type, path, text);
  return { path, text, entity, warnings, data };
}

// Notes and research obey the write rules (wiki spec §10): an `error` rule refuses the write, a `warn` rule is reported.
function enforce(ctx, type, path, text) {
  if (type !== 'note' && type !== 'research') return [];
  const { errors, warnings } = checkPage(ctx, { path, text, lenient: true });
  assertRules(errors);
  return ruleWarnings(warnings);
}

function writable(ctx, entity) {
  if (isRawPath(ctx.schema, entity.path)) throw invalid('Raw sources cannot be entities.');
  if (duplicate(ctx, entity.id)) throw new CairnError('duplicate_id', 'Entity id is duplicated.');
}

function checkRawRef(ctx, ref) {
  if (typeof ref === 'string' && ref.startsWith('@') && isRawPath(ctx.schema, refPath(ref))) {
    throw invalid('Raw sources cannot be entities.');
  }
}

export function update(ctx, type, ref, patch, opts = {}) {
  if (Object.hasOwn(patch, 'id') || Object.hasOwn(patch, 'created')) throw invalid('Id and creation time are fixed.');
  checkRawRef(ctx, ref);
  const entity = resolve(ctx, type, ref);
  writable(ctx, entity);
  const { body, ...options } = opts;
  if (body !== undefined && typeof body !== 'string') throw invalid('Body must be text.');
  let warnings = [];
  const result = write(ctx, { ...options, path: entity.path, target: entity.ref, op: `${type}.update`, apply: (text) => {
    if (text === null) throw missing();
    const current = fromText(ctx, type, entity.path, text);
    writable(ctx, current);
    if (type === 'card') requireCardOwner(ctx, current.data);
    const file = parseFile(text);
    const data = readCanonical(ctx.schema, file.data);
    const changes = { ...patch, ...(current.id === null ? { id: freshId(ctx, type) } : {}), updated: ctx.clock.now().toISOString() };
    const kind = current.kind ?? (type === 'research' ? 'source' : undefined);
    const merged = { ...data, title: current.title, ...(kind === undefined ? {} : { kind }), ...changes };
    validate(type, merged);
    checkOverview(ctx, type, merged.kind, entity.path);
    let updated = setFields(text, physicalPatch(ctx.schema, file.data, changes));
    if (body !== undefined) updated = replaceBody(updated, body);
    warnings = enforce(ctx, type, entity.path, updated);
    return updated;
  } });
  return { ...result, warnings: [...result.warnings, ...warnings] };
}

export function remove(ctx, type, ref, opts = {}) {
  checkRawRef(ctx, ref);
  const entity = resolve(ctx, type, ref);
  writable(ctx, entity);
  return write(ctx, { ...opts, path: entity.path, target: entity.ref, op: `${type}.delete`, apply: (text) => {
    if (text === null) throw missing();
    const current = fromText(ctx, type, entity.path, text);
    writable(ctx, current);
    if (type === 'card') requireCardOwner(ctx, current.data);
    physicalPatch(ctx.schema, parseFile(text).data, {});
    return null;
  } });
}
