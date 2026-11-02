import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import * as fs from './fsx.mjs';
import { checkedPath, openForRead, readChecked } from './paths.mjs';
import { parseFile } from './frontmatter.mjs';
import { classify, fingerprint } from './schema.mjs';
import { foldTr, pathKey } from './text.mjs';
import { revision } from './store.mjs';
import { checkRuntime } from './runtime.mjs';
import { extract } from './extract.mjs';
import { linkTarget, parseLinks, parseJournal } from './links.mjs';

await checkRuntime();

const SCHEMA_VERSION = 2;
const MAX_SIZE = 5 * 1024 * 1024;
const SKIPPED_DIRS = new Set(['.cairn', '.git', 'node_modules']);
const fresh = new WeakMap();
const handles = new Map();
const nameKey = (name) => pathKey(name).replace(/\.md$/u, '');
const fileName = (path) => nameKey(path).split('/').at(-1);
const signature = (ctx) => `${ctx.indexPath}:${fingerprint(ctx.schema)}`;
const emptyResult = () => ({ added: 0, updated: 0, removed: 0, skipped: [] });

// The cache may be busy, locked, corrupt, unwritable or unopenable; then queries read the files. Anything else is a
// bug and must surface instead of silently turning every query into a full scan.
const UNAVAILABLE_SQLITE = new Set([5, 6, 8, 10, 11, 13, 14, 26]);
const UNAVAILABLE_FS = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EBUSY', 'unsafe_path']);
function unavailable(error) {
  return error?.indexUnavailable === true || UNAVAILABLE_SQLITE.has(error?.errcode & 255) || UNAVAILABLE_FS.has(error?.code);
}

function warn(ctx, warning = 'index_unavailable') {
  ctx.warnings ??= [];
  if (!ctx.warnings.includes(warning)) ctx.warnings.push(warning);
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const TABLES = ['meta', 'files', 'links', 'catalog', 'journal_entries', 'fts', 'targets'];

function createSchema(db, schema) {
  transaction(db, () => createTables(db, schema));
}

// A schema or version change empties the cache inside one write transaction. Other processes keep using the same
// file (SQLite re-prepares their statements); replacing a file someone has open is what corrupts databases.
function resetSchema(db, schema) {
  transaction(db, () => {
    for (const name of TABLES) db.exec(`DROP TABLE IF EXISTS ${name}`);
    createTables(db, schema);
  });
}

function createTables(db, schema) {
  {
    db.exec(`
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE files(path TEXT PRIMARY KEY, type TEXT, kind TEXT, id TEXT,
        mtime_ms REAL, ctime_ms REAL, size INTEGER, ino INTEGER, hash TEXT, title TEXT,
        data_json TEXT, acc_done INTEGER, acc_total INTEGER, error TEXT);
      CREATE TABLE links(src_path TEXT, field TEXT, expr TEXT, target_name TEXT,
        target_path TEXT, status TEXT, heading TEXT, line INTEGER);
      CREATE INDEX links_name ON links(target_name);
      CREATE INDEX links_target ON links(target_path);
      CREATE INDEX links_source ON links(src_path);
      CREATE TABLE catalog(target_name TEXT, line INTEGER);
      CREATE TABLE journal_entries(path TEXT, date TEXT, heading TEXT, label TEXT, type TEXT,
        line INTEGER, text TEXT, links_json TEXT, processed INTEGER);
      CREATE INDEX journal_path ON journal_entries(path);
      CREATE VIRTUAL TABLE fts USING fts5(path UNINDEXED, title, body, tokenize='unicode61');
      CREATE TABLE targets(path TEXT PRIMARY KEY, name TEXT, mtime_ms REAL, ctime_ms REAL,
        size INTEGER, ino INTEGER, hash TEXT);
      CREATE INDEX targets_name ON targets(name);
    `);
    const insert = db.prepare('INSERT INTO meta VALUES (?, ?)');
    insert.run('schema_version', String(SCHEMA_VERSION));
    insert.run('schema_fp', fingerprint(schema));
    // A new generation tells contexts that were fresh against an earlier cache to refresh.
    insert.run('generation', randomBytes(8).toString('hex'));
  }
}

function generation(db) {
  return db.prepare("SELECT value FROM meta WHERE key = 'generation'").get()?.value ?? '';
}

function indexLocation(ctx) {
  const path = resolve(ctx.indexPath);
  const missing = [];
  let parent = dirname(path);
  while (!fs.existsSync(parent)) {
    missing.unshift(basename(parent));
    parent = dirname(parent);
  }
  // Check the existing ancestor before mkdir can follow a misplaced symlink.
  checkedPath(parent, '.index-probe');
  for (const part of missing) {
    const next = checkedPath(parent, part);
    fs.mkdirSync(next, { mode: 0o700 });
    parent = next;
  }
  fs.chmodSync(parent, 0o700);
  return checkedPath(parent, basename(path));
}

function connect(path, ctx) {
  const db = new DatabaseSync(path, { timeout: ctx.indexTimeoutMs ?? 5000 });
  let closed = false;
  const index = { db, close() {
    if (closed) return;
    db.close();
    closed = true;
    handles.get(path)?.delete(index);
    if (!handles.get(path)?.size) handles.delete(path);
  } };
  if (!handles.has(path)) handles.set(path, new Set());
  handles.get(path).add(index);
  return index;
}

function rebuild(ctx, path) {
  for (const index of [...(handles.get(path) ?? [])]) index.close();
  const temp = `${path}.${randomBytes(8).toString('hex')}`;
  let index;
  try {
    index = connect(temp, ctx);
    index.db.exec('PRAGMA journal_mode=WAL');
    createSchema(index.db, ctx.schema);
    index.close();
    fs.chmodSync(temp, 0o600);
    // Both database handles are closed; the replacement never unlinks an open database.
    fs.rename(temp, path);
  } finally {
    index?.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(temp + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return connect(path, ctx);
}

export function openIndex(ctx) {
  const path = indexLocation(ctx);
  const existed = fs.existsSync(path);
  let index;
  let replace = false;
  try {
    index = connect(path, ctx);
    index.db.exec('PRAGMA journal_mode=WAL');
    if (!existed) {
      createSchema(index.db, ctx.schema);
      fs.chmodSync(path, 0o600);
    } else {
      const check = index.db.prepare('PRAGMA quick_check').all();
      replace = check.some((row) => row.quick_check !== 'ok');
      if (!replace) {
        const meta = index.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
        const values = meta ? Object.fromEntries(index.db.prepare('SELECT key, value FROM meta').all().map((row) => [row.key, row.value])) : {};
        if (values.schema_version !== String(SCHEMA_VERSION) || values.schema_fp !== fingerprint(ctx.schema)) {
          resetSchema(index.db, ctx.schema);
        }
      }
    }
  } catch (error) {
    index?.close();
    index = undefined;
    // Only a database SQLite cannot read at all is replaced; busy, locked and I/O failures never are.
    if (![11, 26].includes(error.errcode & 255) && !['SQLITE_CORRUPT', 'SQLITE_NOTADB'].includes(error.code)) throw error;
    replace = true;
  }
  if (!replace) return index;
  index?.close();
  fresh.delete(ctx);
  try {
    return rebuild(ctx, path);
  } catch (error) {
    warn(ctx);
    error.indexUnavailable = true;
    throw error;
  }
}

function inventory(ctx, skipped) {
  const found = [];
  checkedPath(ctx.root, '.index-probe');
  function walk(dir, prefix, quiet = false) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const path = prefix + entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) {
        // Never link targets, and large enough (objects, packages) to make every refresh slow.
        continue;
      } else if (entry.isSymbolicLink()) {
        skipped.push({ path, reason: 'symlink' });
      } else if (entry.isDirectory()) {
        // Other metadata folders (.obsidian) still supply target names, without diagnostics for their files.
        const internal = quiet || entry.name.startsWith('.');
        walk(checkedPath(ctx.root, path), `${path}/`, internal);
      } else if (!entry.isFile() || !/\.md$/iu.test(entry.name)) {
        if (!quiet) skipped.push({ path, reason: 'not-markdown' });
      } else {
        try {
          const classification = classify(ctx.schema, path, null);
          const stat = fs.lstatSync(abs);
          if (stat.isSymbolicLink() || !stat.isFile()) {
            skipped.push({ path, reason: 'symlink' });
            continue;
          }
          found.push({ path, name: fileName(path), mtime_ms: stat.mtimeMs, ctime_ms: stat.ctimeMs,
            size: stat.size, ino: stat.ino, ignored: !!classification.ignored });
        } catch (error) {
          if (error.code !== 'unsafe_path') throw error;
          skipped.push({ path, reason: 'unsafe-path' });
        }
      }
    }
  }
  walk(ctx.root, '');
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

function readSource(ctx, item) {
  const fd = openForRead(ctx.root, item.path);
  try {
    // The size that decides is the opened file's, not the inventory's: the file may have changed in between.
    if (fs.fstatSync(fd).size <= MAX_SIZE) return { text: fs.readFileSync(fd, 'utf8'), large: false };
    // Oversized pages contribute at most a bounded frontmatter block, never their body.
    const buffer = Buffer.alloc(64 * 1024);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const prefix = buffer.toString('utf8', 0, length);
    const file = parseFile(prefix);
    const text = file.hasFrontmatter && !file.error ? prefix.slice(0, file.bodyStart) : '';
    const digest = createHash('sha256');
    let position = 0;
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, position))) {
      digest.update(buffer.subarray(0, count));
      position += count;
    }
    return { text, large: true, hash: digest.digest('hex').slice(0, 16) };
  } finally {
    fs.closeSync(fd);
  }
}

function sourceData(ctx, item, source) {
  const row = extract(ctx.schema, item.path, source.text);
  const file = parseFile(source.text);
  if (source.large && row) {
    row.body = null;
    row.error = 'too-large';
  }
  return { row, links: parseLinks(source.text, { frontmatter: file.error ? null : row?.data ?? file.data,
    frontmatterText: file.error ? source.text.slice(file.yamlStart, file.yamlEnd) : null }),
  entries: row?.type === 'journal' ? parseJournal(source.text, ctx.schema.entryTypes) : [] };
}

const sameStat = (a, b) => b && ['mtime_ms', 'ctime_ms', 'size', 'ino'].every((key) => a[key] === b[key]);

function collect(ctx, previous = new Map(), verify = false) {
  const skipped = [];
  const items = inventory(ctx, skipped);
  const changes = [];
  for (const item of items) {
    if (item.size > MAX_SIZE && !item.ignored) {
      skipped.push({ path: item.path, reason: 'too-large' });
      warn(ctx, 'too-large');
    }
    const before = previous.get(item.path);
    if (!verify && sameStat(item, before)) continue;
    if (item.ignored && pathKey(item.path) !== pathKey(ctx.schema.catalog ?? '')) {
      changes.push({ item, hash: null, data: null });
      continue;
    }
    let source;
    try {
      source = readSource(ctx, item);
    } catch (error) {
      // Removed or replaced since the inventory: the next refresh sees its new state.
      if (!['ENOENT', 'unsafe_path', 'not_found'].includes(error.code)) throw error;
      skipped.push({ path: item.path, reason: 'changed' });
      continue;
    }
    const hash = source.hash ?? revision(source.text);
    if (before?.hash === hash) {
      changes.push({ item, hash, data: undefined });
      continue;
    }
    let data;
    try {
      data = sourceData(ctx, item, source);
    } catch {
      // Untrusted content (cyclic YAML aliases and the like) must not stop every other file from being indexed.
      skipped.push({ path: item.path, reason: 'unreadable' });
      warn(ctx, 'unreadable');
      data = null;
    }
    changes.push({ item, hash, data });
  }
  return { items, changes, skipped };
}

function removeSource(db, path) {
  db.prepare('DELETE FROM files WHERE path = ?').run(path);
  db.prepare('DELETE FROM fts WHERE path = ?').run(path);
  db.prepare('DELETE FROM links WHERE src_path = ?').run(path);
  db.prepare('DELETE FROM journal_entries WHERE path = ?').run(path);
}

function saveSource(db, ctx, item, hash, data) {
  if (data === undefined) {
    db.prepare('UPDATE files SET mtime_ms = ?, ctime_ms = ?, size = ?, ino = ? WHERE path = ?')
      .run(item.mtime_ms, item.ctime_ms, item.size, item.ino, item.path);
    return;
  }
  removeSource(db, item.path);
  if (pathKey(item.path) === pathKey(ctx.schema.catalog ?? '')) {
    db.exec('DELETE FROM catalog');
    const insert = db.prepare('INSERT INTO catalog VALUES (?, ?)');
    for (const link of data?.links ?? []) insert.run(nameKey(link.targetName), link.line);
  }
  if (!data?.row) return;
  const row = data.row;
  db.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.path, row.type, row.kind, row.id, item.mtime_ms, item.ctime_ms, item.size, item.ino, hash,
      row.title, JSON.stringify(row.data), row.acceptance.done, row.acceptance.total, row.error);
  db.prepare('INSERT INTO fts VALUES (?, ?, ?)').run(row.path, foldTr(row.title), foldTr(row.body ?? ''));
  const linkInsert = db.prepare('INSERT INTO links VALUES (?, ?, ?, ?, NULL, ?, ?, ?)');
  for (const link of data.links) linkInsert.run(row.path, link.field, link.expr, nameKey(link.targetName), 'unresolved', link.heading, link.line);
  const entryInsert = db.prepare('INSERT INTO journal_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const date = row.data.date ?? basename(row.path, '.md');
  for (const entry of data.entries) entryInsert.run(row.path, String(date), entry.heading, entry.label,
    entry.type, entry.line, entry.text, JSON.stringify(entry.links), Number(entry.processed));
}

function resolver(paths) {
  const names = new Map();
  const full = new Map();
  for (const path of paths) {
    for (const [map, key] of [[names, fileName(path)], [full, nameKey(path)]]) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(path);
    }
  }
  return (name) => {
    const key = nameKey(name);
    const candidates = (key.includes('/') ? full : names).get(key) ?? [];
    return { target_path: candidates.length === 1 ? candidates[0] : null,
      status: candidates.length === 1 ? 'resolved' : candidates.length ? 'ambiguous' : 'unresolved',
      ...(candidates.length > 1 ? { candidates: [...candidates].sort() } : {}) };
  };
}

function resolveLinks(db, affected, changedSources) {
  const resolveTarget = resolver(db.prepare('SELECT path FROM targets').all().map((item) => item.path));
  const update = db.prepare('UPDATE links SET target_path = ?, status = ? WHERE rowid = ?');
  const pending = new Map();
  for (const name of affected) {
    for (const link of db.prepare('SELECT rowid, target_name FROM links WHERE target_name = ?').all(name)) pending.set(link.rowid, link);
  }
  for (const path of changedSources) {
    for (const link of db.prepare('SELECT rowid, target_name FROM links WHERE src_path = ?').all(path)) pending.set(link.rowid, link);
  }
  for (const link of pending.values()) {
    const result = resolveTarget(link.target_name);
    update.run(result.target_path, result.status, link.rowid);
  }
}

// The stamp ties freshness to this cache's generation, so a cache rebuilt by another process is noticed.
const stamp = (ctx, db) => `${signature(ctx)}#${generation(db)}`;

export function refresh(ctx, { verify = false } = {}) {
  let index;
  fresh.delete(ctx);
  try {
    index = openIndex(ctx);
    const db = index.db;
    // Walking and reading files happens outside the write lock; only applying the result holds it.
    const previous = new Map(db.prepare('SELECT * FROM targets').all().map((item) => [item.path, item]));
    const collected = collect(ctx, previous, verify);
    const result = transaction(db, () => {
      const current = new Set(db.prepare('SELECT path FROM targets').all().map((item) => item.path));
      const result = { ...emptyResult(), skipped: collected.skipped };
      const existing = new Set(db.prepare('SELECT path FROM files').all().map((row) => row.path));
      const present = new Set(collected.items.map((item) => item.path));
      const affected = new Set();
      const changedSources = new Set();
      function affect(path) { affected.add(fileName(path)); affected.add(nameKey(path)); }
      for (const path of current) {
        if (present.has(path)) continue;
        removeSource(db, path);
        db.prepare('DELETE FROM targets WHERE path = ?').run(path);
        if (pathKey(path) === pathKey(ctx.schema.catalog ?? '')) db.exec('DELETE FROM catalog');
        if (existing.has(path)) result.removed++;
        affect(path);
      }
      const targetInsert = db.prepare('INSERT OR REPLACE INTO targets VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const { item, hash, data } of collected.changes) {
        targetInsert.run(item.path, item.name, item.mtime_ms, item.ctime_ms, item.size, item.ino, hash);
        if (!current.has(item.path)) affect(item.path);
        saveSource(db, ctx, item, hash, data);
        if (data !== undefined) {
          changedSources.add(item.path);
          if (data?.row) result[existing.has(item.path) ? 'updated' : 'added']++;
          else if (existing.has(item.path)) result.removed++;
        }
      }
      resolveLinks(db, affected, changedSources);
      fresh.set(ctx, stamp(ctx, db));
      return result;
    });
    return result;
  } catch (error) {
    fresh.delete(ctx);
    if (!unavailable(error)) throw error;
    warn(ctx);
    return emptyResult();
  } finally {
    index?.close();
  }
}

export function ensureFresh(ctx) {
  let index;
  try {
    index = openIndex(ctx);
    if (fresh.get(ctx) === stamp(ctx, index.db)) return true;
  } catch (error) {
    if (!unavailable(error)) throw error;
    warn(ctx);
    return false;
  } finally {
    index?.close();
  }
  refresh(ctx);
  return fresh.has(ctx);
}

// Hooks deliberately refresh metadata too: other processes may have changed link targets.
export function indexPath(ctx, path) {
  try { refresh(ctx); } catch { fresh.delete(ctx); warn(ctx); }
}

export function dropPath(ctx, path) {
  try { refresh(ctx); } catch { fresh.delete(ctx); warn(ctx); }
}

function rowFrom(ctx, item) {
  const data = JSON.parse(item.data_json);
  const classification = classify(ctx.schema, item.path, data);
  return { path: item.path, type: item.type, kind: item.kind, id: item.id, ref: item.id ?? `@${item.path.replace(/\.md$/iu, '')}`,
    title: item.title, data, body: null, acceptance: { done: item.acc_done, total: item.acc_total }, error: item.error,
    ...(classification.unknownKind === undefined ? {} : { unknownKind: classification.unknownKind }) };
}

function snapshot(ctx) {
  const collected = collect(ctx);
  const resolveTarget = resolver(collected.items.map((item) => item.path));
  const result = { rows: [], links: [], entries: [] };
  for (const { item, data } of collected.changes) {
    if (!data?.row) continue;
    result.rows.push(data.row);
    result.links.push(...data.links.map((link) => ({ ...link, src_path: item.path, ...resolveTarget(link.targetName) })));
    result.entries.push(...data.entries.map((entry) => ({ ...entry, path: item.path,
      date: String(data.row.data.date ?? basename(item.path, '.md')) })));
  }
  return result;
}

function query(ctx, indexed, fallback) {
  let index;
  try {
    if (ensureFresh(ctx)) {
      index = openIndex(ctx);
      // Another process may have rebuilt the cache since the freshness check.
      if (fresh.get(ctx) !== stamp(ctx, index.db)) {
        index.close();
        index = undefined;
        if (!ensureFresh(ctx)) return fallback(snapshot(ctx));
        index = openIndex(ctx);
      }
      return indexed(index.db);
    }
  } catch (error) {
    fresh.delete(ctx);
    if (!unavailable(error)) throw error;
    warn(ctx);
  } finally {
    index?.close();
  }
  return fallback(snapshot(ctx));
}

export function findById(ctx, id) {
  return query(ctx, (db) => db.prepare('SELECT path FROM files WHERE id = ? ORDER BY path').all(id).map((row) => row.path),
    (data) => data.rows.filter((row) => row.id === id).map((row) => row.path).sort());
}

export function rows(ctx, type, { kind } = {}) {
  const matches = (row) => (type === undefined || row.type === type) && (kind === undefined || row.kind === kind);
  return query(ctx, (db) => db.prepare('SELECT * FROM files ORDER BY path').all().map((row) => rowFrom(ctx, row)).filter(matches),
    (data) => data.rows.filter(matches).map((row) => ({ ...row, body: null })));
}

export function backlinks(ctx, path) {
  return query(ctx, (db) => db.prepare(`SELECT DISTINCT src_path, line, field FROM links
    WHERE target_path = ? AND EXISTS (SELECT 1 FROM files WHERE path = ?) ORDER BY src_path, line`).all(path, path).map((row) => ({ ...row })),
  (data) => data.rows.some((row) => row.path === path) ? data.links.filter((link) => link.target_path === path)
    .filter((link, at, links) => links.findIndex((other) => other.src_path === link.src_path && other.line === link.line && other.field === link.field) === at)
    .map(({ src_path, line, field }) => ({ src_path, line, field })) : []);
}

export function outlinks(ctx, path) {
  return query(ctx, (db) => {
    const resolveTarget = resolver(db.prepare('SELECT path FROM targets').all().map((item) => item.path));
    return db.prepare('SELECT * FROM links WHERE src_path = ? ORDER BY line, rowid').all(path).map((link) => ({
      field: link.field, expr: link.expr, targetName: linkTarget(link.expr).targetName, heading: link.heading, line: link.line,
      ...resolveTarget(link.target_name),
    }));
  }, (data) => data.links.filter((link) => link.src_path === path).map(({ src_path, ...link }) => link));
}

export function journalEntries(ctx, { type, unprocessed = false, since } = {}) {
  const matches = (entry) => (type === undefined || entry.type === type)
    && (!unprocessed || (['discovery', 'pitfall', 'lesson'].includes(entry.type) && !entry.processed))
    && (since === undefined || entry.date >= since);
  return query(ctx, (db) => db.prepare('SELECT * FROM journal_entries ORDER BY date, path, line').all().map((entry) => {
    const { links_json, processed, ...rest } = entry;
    return { ...rest, links: JSON.parse(links_json), processed: !!processed };
  }).filter(matches), (data) => data.entries.filter(matches).sort((a, b) => a.date.localeCompare(b.date) || a.path.localeCompare(b.path) || a.line - b.line));
}

export function search(ctx, q, { type, limit = 20 } = {}) {
  const terms = foldTr(q).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!terms.length) return [];
  limit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 20;
  const match = terms.map((term) => `"${term}"`).join(' AND ');
  return query(ctx, (db) => db.prepare(`SELECT files.path, files.type, files.id, files.title, snippet(fts, 2, '', '', '…', 24) AS snippet
    FROM fts JOIN files ON files.path = fts.path WHERE fts MATCH ? AND (? IS NULL OR type = ?)
    ORDER BY rank, files.path LIMIT ?`).all(match, type ?? null, type ?? null, limit)
    .map((row) => ({ ...row, ref: row.id ?? `@${row.path.replace(/\.md$/iu, '')}` })), (data) => data.rows.filter((row) => {
    const words = new Set(foldTr(`${row.title}\n${row.body ?? ''}`).match(/[\p{L}\p{N}]+/gu));
    return (type === undefined || row.type === type) && terms.every((term) => words.has(term));
  }).slice(0, limit).map(({ path, type, id, ref, title, body }) => ({ path, type, id, ref, title, snippet: foldTr(body ?? '').slice(0, 160) })));
}
