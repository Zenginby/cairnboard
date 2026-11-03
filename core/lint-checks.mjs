import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import * as fs from './fsx.mjs';
import { openForRead, readChecked, safeRelative } from './paths.mjs';
import { classify, isRawPath } from './schema.mjs';
import { linkTarget } from './links.mjs';
import { resolver } from './index.mjs';
import { filenameDefault, filenameOk, missingRequired } from './rules.mjs';
import { pathKey, stripHidden } from './text.mjs';
import { wakeupSection } from './wiki.mjs';

const EXCERPT_MAX = 200;
const PAGE_TYPES = ['note', 'research', 'project'];
const DAY = 86_400_000;
const LESSONS = ['discovery', 'pitfall', 'lesson'];

// Page text in a finding is cleaned of hidden characters and bounded; it only ever lands in `target` and `content`.
export const clip = (value, max = EXCERPT_MAX) => stripHidden(String(value)).text.replace(/\s+/gu, ' ').trim().slice(0, max);

function finding(code, path, { line, target, candidates, excerpt } = {}) {
  return { code, path: clip(path, 1024), ...(line === undefined ? {} : { line }),
    ...(target === undefined ? {} : { target: clip(target) }), ...(candidates ? { candidates: candidates.map((item) => clip(item, 1024)) } : {}),
    ...(excerpt === undefined ? {} : { content: { excerpt: clip(excerpt) } }) };
}

/** Everything the checks read from the index, loaded in one pass: { files, links, catalog, entries, targets, digests }. */
export function loadView(ctx, db) {
  const files = db.prepare(`SELECT path, type, kind, title, data_json, error, untitled, conflicts, bad_encoding FROM files ORDER BY path`).all()
    .map((row) => {
      const data = JSON.parse(row.data_json);
      return { path: row.path, type: row.type, kind: row.kind, title: row.title, data, error: row.error,
        badEncoding: !!row.bad_encoding, untitled: !!row.untitled, conflicts: row.conflicts ? JSON.parse(row.conflicts) : [],
        unknownKind: row.kind === 'note' && Object.hasOwn(data, 'kind') ? classify(ctx.schema, row.path, data).unknownKind : undefined };
    });
  const targets = db.prepare('SELECT path FROM targets ORDER BY path').all().map((row) => row.path);
  return { files, targets, resolve: resolver(targets), links: db.prepare(`SELECT src_path, field, expr, target_name, target_path, status, line
    FROM links ORDER BY src_path, line, rowid`).all(), catalog: db.prepare('SELECT target_name, line FROM catalog ORDER BY line').all(),
  entries: db.prepare('SELECT path, date, type, line, text, processed FROM journal_entries ORDER BY date, path, line').all(),
  digests: new Map(db.prepare('SELECT * FROM raw_digests').all().map((row) => [row.path, row])), newDigests: new Map(), raw: new Map() };
}

const pages = (view) => view.files.filter((file) => PAGE_TYPES.includes(file.type));
const sameFile = (a, b) => b && a.mtime_ms === b.mtime_ms && a.ctime_ms === b.ctime_ms && a.size === b.size && a.ino === b.ino;

function hash(fd) {
  const digest = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  let count;
  while ((count = fs.readSync(fd, buffer, 0, buffer.length, position))) {
    digest.update(buffer.subarray(0, count));
    position += count;
  }
  return digest.digest('hex');
}

const MISSING = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP', 'EACCES', 'EPERM', 'unsafe_path']);

/**
 * The file a research page's `raw` field points at: { missing: true } when it is no readable regular file under
 * `sourceRoots`, else { sha256 } (null unless `hash`). A digest is recomputed only when the file's stat changed since
 * the cached one, or with `verify`.
 */
function rawFile(ctx, view, raw, { hash: wanted, verify }) {
  if (typeof raw !== 'string' || !raw.trim()) return { missing: true };
  let rel;
  try {
    rel = safeRelative(raw.trim()).replace(/\\/gu, '/');
  } catch {
    return { missing: true };
  }
  if (!isRawPath(ctx.schema, rel)) return { missing: true };
  const memo = view.raw.get(`${rel}\0${wanted}\0${verify}`);
  if (memo) return memo;
  let fd;
  let result;
  try {
    fd = openForRead(ctx.root, rel);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) result = { missing: true };
    else if (!wanted) result = { sha256: null };
    else {
      const now = { path: rel, mtime_ms: stat.mtimeMs, ctime_ms: stat.ctimeMs, size: stat.size, ino: String(stat.ino) };
      const cached = view.newDigests.get(rel) ?? view.digests.get(rel);
      if (!verify && sameFile(now, cached)) result = { sha256: cached.sha256 };
      else {
        result = { sha256: hash(fd) };
        view.newDigests.set(rel, { ...now, sha256: result.sha256 });
      }
    }
  } catch (error) {
    if (!MISSING.has(error.code)) throw error;
    result = { missing: true };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  view.raw.set(`${rel}\0${wanted}\0${verify}`, result);
  return result;
}

const rawPages = (view) => view.files.filter((file) => file.type === 'research' && file.data.raw !== undefined && file.data.raw !== null);
const dateOf = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/u.test(value) ? Date.parse(`${value.slice(0, 10)}T00:00:00Z`) : NaN;

/** Wiki spec §9. `run(ctx, opts)` returns findings without severity; `opts` carries the loaded `view` and the settings. */
export const CHECKS = [
  { code: 'orphan', defaultSeverity: 'warn', run: (ctx, { view }) => {
    const linked = new Set(view.links.filter((link) => link.target_path && link.target_path !== link.src_path).map((link) => link.target_path));
    return pages(view).filter((file) => file.kind !== 'note' && file.kind !== 'overview' && !linked.has(file.path))
      .map((file) => finding('orphan', file.path));
  } },
  { code: 'broken_link', defaultSeverity: 'warn', run: (ctx, { view }) => view.links.filter((link) => link.status === 'unresolved')
    .map((link) => finding('broken_link', link.src_path, { line: link.line, target: linkTarget(link.expr).targetName, excerpt: link.expr })) },
  { code: 'ambiguous_link', defaultSeverity: 'warn', run: (ctx, { view }) => view.links.filter((link) => link.status === 'ambiguous')
    .map((link) => finding('ambiguous_link', link.src_path, { line: link.line, target: linkTarget(link.expr).targetName,
      candidates: view.resolve(link.target_name).candidates ?? [], excerpt: link.expr })) },
  { code: 'missing_page', defaultSeverity: 'info', run: (ctx, { view }) => {
    const names = new Map();
    for (const link of view.links.filter((item) => item.status === 'unresolved')) {
      if (!names.has(link.target_name)) names.set(link.target_name, []);
      names.get(link.target_name).push(link);
    }
    return [...names.values()].filter((links) => new Set(links.map((link) => link.src_path)).size >= 2)
      .map(([first]) => finding('missing_page', first.src_path, { line: first.line, target: linkTarget(first.expr).targetName }));
  } },
  { code: 'missing_frontmatter', defaultSeverity: 'warn', run: (ctx, { view }) => view.files.filter((file) => !file.error)
    .flatMap((file) => missingRequired(ctx.schema, file).map((field) => finding('missing_frontmatter', file.path, { target: field }))) },
  { code: 'invalid_frontmatter', defaultSeverity: 'warn', run: (ctx, { view }) => view.files.filter((file) => file.error === 'invalid_frontmatter')
    .map((file) => finding('invalid_frontmatter', file.path)) },
  { code: 'unknown_kind', defaultSeverity: 'info', run: (ctx, { view }) => view.files.filter((file) => file.unknownKind !== undefined)
    .map((file) => finding('unknown_kind', file.path, { excerpt: file.unknownKind })) },
  { code: 'invalid_encoding', defaultSeverity: 'info', run: (ctx, { view }) => view.files.filter((file) => file.badEncoding)
    .map((file) => finding('invalid_encoding', file.path)) },
  { code: 'unclassified', defaultSeverity: 'info', run: (ctx, { view }) => {
    const indexed = new Set(view.files.map((file) => file.path));
    return view.targets.filter((path) => !indexed.has(path) && !path.split('/').some((part) => part.startsWith('.'))
      && classify(ctx.schema, path, null).unclassified).map((path) => finding('unclassified', path));
  } },
  { code: 'alias_conflict', defaultSeverity: 'error', run: (ctx, { view }) => view.files
    .flatMap((file) => file.conflicts.map((field) => finding('alias_conflict', file.path, { target: field }))) },
  { code: 'stale', defaultSeverity: 'info', run: (ctx, { view, now, staleDays }) => staleDays <= 0 ? [] : pages(view)
    .filter((file) => (now - dateOf(file.data.updated)) / DAY > staleDays).map((file) => finding('stale', file.path, { excerpt: file.data.updated })) },
  { code: 'unprocessed_lesson', defaultSeverity: 'info', run: (ctx, { view, now }) => {
    const since = new Date(now - 30 * DAY).toISOString().slice(0, 10);
    return view.entries.filter((entry) => LESSONS.includes(entry.type) && !entry.processed && /^\d{4}-\d{2}-\d{2}$/u.test(entry.date) && entry.date >= since)
      .map((entry) => finding('unprocessed_lesson', entry.path, { line: entry.line, excerpt: entry.text }));
  } },
  { code: 'unprocessed_source', defaultSeverity: 'info', run: (ctx, { view }) => view.files
    .filter((file) => file.type === 'research' && (file.data.processed === false || file.data.processed === 'false'))
    .map((file) => finding('unprocessed_source', file.path)) },
  { code: 'raw_missing', defaultSeverity: 'error', run: (ctx, { view }) => rawPages(view)
    .filter((file) => rawFile(ctx, view, file.data.raw, { hash: false }).missing)
    .map((file) => finding('raw_missing', file.path, { excerpt: file.data.raw })) },
  { code: 'raw_changed', defaultSeverity: 'error', run: (ctx, { view, verify }) => rawPages(view)
    .filter((file) => typeof file.data.raw_sha256 === 'string' && file.data.raw_sha256.trim())
    .filter((file) => {
      const raw = rawFile(ctx, view, file.data.raw, { hash: true, verify });
      return !raw.missing && raw.sha256 !== file.data.raw_sha256.trim().toLowerCase().replace(/^sha256:/u, '');
    }).map((file) => finding('raw_changed', file.path, { excerpt: file.data.raw })) },
  { code: 'wakeup_budget', defaultSeverity: 'warn', run: (ctx, { view }) => view.files.filter((file) => file.kind === 'overview').flatMap((file) => {
    const text = readChecked(ctx.root, file.path, 'utf8');
    const section = text === null ? null : wakeupSection(text);
    return section && section.words > 350 ? [finding('wakeup_budget', file.path, { line: section.line, excerpt: `${section.heading} (${section.words} words)` })] : [];
  }) },
  { code: 'overview_multiple', defaultSeverity: 'warn', run: (ctx, { view }) => {
    const overviews = view.files.filter((file) => file.kind === 'overview').map((file) => file.path);
    return overviews.slice(1).map((path) => finding('overview_multiple', path, { candidates: overviews }));
  } },
  { code: 'index_mismatch', defaultSeverity: 'info', run: (ctx, { view }) => {
    const catalog = ctx.schema.catalog && view.targets.find((path) => pathKey(path) === pathKey(ctx.schema.catalog));
    if (!catalog) return [];
    const listed = new Set();
    const result = [];
    for (const link of view.catalog) {
      const target = view.resolve(link.target_name);
      if (target.status === 'unresolved') result.push(finding('index_mismatch', catalog, { line: link.line, target: link.target_name }));
      for (const path of target.candidates ?? [target.target_path]) listed.add(path);
    }
    for (const file of pages(view)) if (!listed.has(file.path)) result.push(finding('index_mismatch', file.path));
    return result;
  } },
  { code: 'filename', defaultSeverity: 'off', defaultFor: (ctx) => filenameDefault(ctx.schema), run: (ctx, { view }) => view.files
    .filter((file) => file.type !== 'card' && !filenameOk(file.path)).map((file) => finding('filename', file.path, { excerpt: basename(file.path) })) },
];
