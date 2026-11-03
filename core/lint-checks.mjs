import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import * as fs from './fsx.mjs';
import { openForRead, readChecked, safeRelative } from './paths.mjs';
import { codeFile, repoRoot } from './code-drift.mjs';
import { analyzePage, extractClaims, normalizeForEvidence, unsupported } from './evidence.mjs';
import { localDate, validateDate } from './dates.mjs';
import { classify, isRawPath } from './schema.mjs';
import { linkTarget } from './links.mjs';
import { resolver } from './index.mjs';
import { empty, filenameDefault, filenameOk, missingRequired } from './rules.mjs';
import { pathKey, stripHidden } from './text.mjs';
import { wakeupSection } from './wiki.mjs';

const EXCERPT_MAX = 200;
const PAGE_TYPES = ['note', 'research', 'project'];
const DAY = 86_400_000;
export const LESSONS = ['discovery', 'pitfall', 'lesson'];
export const LESSON_DAYS = 30;
// A source page that still waits to be read into the wiki (`processed: false`).
export const isUnprocessedSource = (data) => data?.processed === false || data?.processed === 'false';

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
  digests: new Map(db.prepare('SELECT * FROM raw_digests').all().map((row) => [row.path, row])), newDigests: new Map(), raw: new Map(), rawNorm: new Map() };
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

// The data-folder path a `raw` field names, or null when it is no safe path under a source root.
function rawRel(ctx, raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const rel = safeRelative(raw.trim()).replace(/\\/gu, '/');
    return isRawPath(ctx.schema, rel) ? rel : null;
  } catch {
    return null;
  }
}

const RAW_TEXT_MAX = 8 * 1024 * 1024;

/**
 * The normalised text of a raw source for evidence checks, or null when it cannot be compared: not a safe regular
 * file, larger than 8 MiB, or binary (a NUL byte in the first 8 KiB). Read once per run.
 */
function rawNormalized(ctx, view, raw) {
  const rel = rawRel(ctx, raw);
  if (rel === null) return null;
  if (view.rawNorm.has(rel)) return view.rawNorm.get(rel);
  let fd;
  let text = null;
  try {
    fd = openForRead(ctx.root, rel);
    const stat = fs.fstatSync(fd);
    if (stat.isFile() && stat.size <= RAW_TEXT_MAX) {
      const buffer = fs.readFileSync(fd);
      if (!buffer.subarray(0, 8192).includes(0)) text = normalizeForEvidence(buffer.toString('utf8'));
    }
  } catch (error) {
    if (!MISSING.has(error.code)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  view.rawNorm.set(rel, text);
  return text;
}

/**
 * The file a research page's `raw` field points at: { missing: true } when it is no readable regular file under
 * `sourceRoots`, else { sha256 } (null unless `hash`). A digest is recomputed only when the file's stat changed since
 * the cached one, or with `verify`.
 */
function rawFile(ctx, view, raw, { hash: wanted, verify }) {
  const rel = rawRel(ctx, raw);
  if (rel === null) return { missing: true };
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

const fieldNames = (schema, field) => [...new Set([field, schema.fields?.[field] ?? field])];
const PROJECT_ID = /^p-[0-9a-hjkmnp-tv-z]{6}$/u;
const SOURCED_KINDS = ['concept', 'tool', 'query', 'overview'];
const MAX_CLAIMS = 200;
const MAX_CODE_PATHS = 200;
const firstString = (value) => typeof value === 'string' ? value : Array.isArray(value) ? value.map(firstString).find((item) => item !== undefined) : undefined;

// The research page a link names; a name shared with a raw file or another page still counts when exactly one research page has it.
function researchTarget(view, byPath, link) {
  const paths = link.target_path ? [link.target_path] : view.resolve(link.target_name).candidates ?? [];
  const research = paths.filter((path) => byPath.get(path)?.type === 'research');
  return research.length === 1 ? research[0] : null;
}

// Wiki spec §13: the raw files a page is checked against, and the quotes and numbers they do not contain.
function evidenceFindings(ctx, view) {
  const byPath = new Map(view.files.map((file) => [file.path, file]));
  const sourceFields = fieldNames(ctx.schema, 'sources');
  const out = [];
  for (const file of view.files) {
    const research = file.type === 'research';
    if (file.badEncoding || file.error || !(research || (file.type === 'note' && SOURCED_KINDS.includes(file.kind)))) continue;
    if (research && rawNormalizedPlain(file.data.raw)) continue;
    const links = research ? [] : view.links.filter((link) => link.src_path === file.path)
      .map((link) => ({ ...link, target_path: researchTarget(view, byPath, link) })).filter((link) => link.target_path);
    if (!research && !links.length) continue;
    const text = readChecked(ctx.root, file.path, 'utf8');
    if (text === null) continue;
    const { claimText, sources } = analyzePage(text);
    const raws = research ? [file.data.raw] : [...new Set(links.filter((link) => link.field === null ? sources.has(link.line) : sourceFields.includes(link.field))
      .map((link) => byPath.get(link.target_path).data.raw))];
    const haystacks = raws.map((raw) => rawNormalized(ctx, view, raw)).filter((item) => item !== null);
    if (!haystacks.length) continue;
    for (const claim of unsupported(extractClaims(claimText, MAX_CLAIMS), haystacks)) {
      out.push(finding('evidence_missing', file.path, { line: claim.line, target: claim.kind, excerpt: clip(claim.value, 80) }));
    }
  }
  return out;
}
const rawNormalizedPlain = (raw) => typeof raw !== 'string' || !raw.trim();

// Wiki spec §14, once per run: the project of a page, its repository on this machine and each named code file.
function codeScan(ctx, view) {
  if (view.code) return view.code;
  const result = { changed: [], missing: [], unlinked: [] };
  const roots = new Map();
  const projectOf = (file) => {
    if (file.type === 'project') return typeof file.data.id === 'string' ? file.data.id : null;
    const value = firstString(file.data.project)?.trim();
    if (!value) return null;
    if (PROJECT_ID.test(value)) return value;
    const hit = view.resolve(linkTarget(value).targetName);
    const project = hit.target_path ? view.files.find((item) => item.path === hit.target_path && item.type === 'project') : null;
    return typeof project?.data.id === 'string' ? project.data.id : null;
  };
  for (const file of pages(view)) {
    const paths = (Array.isArray(file.data.code) ? file.data.code : [file.data.code]).filter((item) => typeof item === 'string' && item.trim())
      .slice(0, MAX_CODE_PATHS);
    if (!paths.length) continue;
    const id = projectOf(file);
    if (!roots.has(id)) roots.set(id, repoRoot(ctx.stateDir, id));
    const root = roots.get(id);
    if (root === null) {
      result.unlinked.push(finding('code_unlinked', file.path, { target: id ?? '' }));
      continue;
    }
    const updated = typeof file.data.updated === 'string' && /^\d{4}-\d{2}-\d{2}/u.test(file.data.updated) ? file.data.updated.slice(0, 10) : null;
    for (const rel of paths) {
      const code = codeFile(root, rel.trim());
      if (code.missing) result.missing.push(finding('code_missing', file.path, { target: rel }));
      else if (updated !== null && code.day > updated) result.changed.push(finding('code_changed', file.path, { target: rel, excerpt: code.day }));
    }
  }
  view.code = result;
  return result;
}

const dayValue = (value) => {
  try {
    validateDate(value);
    return value;
  } catch {
    return null;
  }
};

// Wiki spec §7. Each page's validity: the two dates (null when absent or invalid) and whether it still holds.
function validity(ctx, view) {
  if (view.validity) return view.validity;
  const today = localDate(ctx);
  const succeeded = fieldNames(ctx.schema, 'superseded_by');
  const result = new Map();
  for (const file of view.files.filter((item) => item.type === 'note' || item.type === 'research')) {
    const raw = { from: file.data.valid_from, until: file.data.valid_until };
    const from = empty(raw.from) ? null : dayValue(raw.from);
    const until = empty(raw.until) ? null : dayValue(raw.until);
    const links = view.links.filter((link) => link.src_path === file.path && succeeded.includes(link.field));
    result.set(file.path, { file, raw, from, until, links, superseded: !empty(file.data.superseded_by),
      expired: until !== null && until < today });
  }
  view.validity = result;
  return result;
}

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
    const since = new Date(now - LESSON_DAYS * DAY).toISOString().slice(0, 10);
    return view.entries.filter((entry) => LESSONS.includes(entry.type) && !entry.processed && /^\d{4}-\d{2}-\d{2}$/u.test(entry.date) && entry.date >= since)
      .map((entry) => finding('unprocessed_lesson', entry.path, { line: entry.line, excerpt: entry.text }));
  } },
  { code: 'unprocessed_source', defaultSeverity: 'info', run: (ctx, { view }) => view.files
    .filter((file) => file.type === 'research' && isUnprocessedSource(file.data))
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
  { code: 'superseded_link', defaultSeverity: 'warn', run: (ctx, { view }) => {
    const stale = new Set([...validity(ctx, view).values()].filter((item) => item.superseded || item.expired).map((item) => item.file.path));
    return view.links.filter((link) => link.target_path && stale.has(link.target_path) && link.src_path !== link.target_path)
      .map((link) => finding('superseded_link', link.src_path, { line: link.line, target: linkTarget(link.expr).targetName, excerpt: link.expr }));
  } },
  { code: 'expired', defaultSeverity: 'warn', run: (ctx, { view }) => [...validity(ctx, view).values()].filter((item) => item.expired)
    .map((item) => finding('expired', item.file.path, { excerpt: item.until })) },
  { code: 'superseded_missing', defaultSeverity: 'warn', run: (ctx, { view }) => [...validity(ctx, view).values()].filter((item) => item.superseded)
    .flatMap((item) => {
      if (!item.links.length) return [finding('superseded_missing', item.file.path, { target: firstString(item.file.data.superseded_by) ?? '' })];
      return item.links.filter((link) => link.status === 'unresolved')
        .map((link) => finding('superseded_missing', item.file.path, { line: link.line, target: linkTarget(link.expr).targetName }));
    }) },
  { code: 'invalid_validity', defaultSeverity: 'warn', run: (ctx, { view }) => [...validity(ctx, view).values()].flatMap((item) => {
    const out = [];
    for (const [field, value, day] of [['valid_from', item.raw.from, item.from], ['valid_until', item.raw.until, item.until]]) {
      if (!empty(value) && day === null) out.push(finding('invalid_validity', item.file.path, { target: field, excerpt: firstString(value) ?? '' }));
    }
    if (item.from !== null && item.until !== null && item.from > item.until) {
      out.push(finding('invalid_validity', item.file.path, { target: 'valid_from', excerpt: `${item.from} > ${item.until}` }));
    }
    return out;
  }) },
  { code: 'evidence_missing', defaultSeverity: 'warn', flag: 'evidence', run: (ctx, { view }) => evidenceFindings(ctx, view) },
  { code: 'code_changed', defaultSeverity: 'info', flag: 'code', run: (ctx, { view }) => codeScan(ctx, view).changed },
  { code: 'code_missing', defaultSeverity: 'warn', flag: 'code', run: (ctx, { view }) => codeScan(ctx, view).missing },
  { code: 'code_unlinked', defaultSeverity: 'info', flag: 'code', run: (ctx, { view }) => codeScan(ctx, view).unlinked },
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
