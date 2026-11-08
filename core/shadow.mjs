import { createHash } from 'node:crypto';
import * as fs from './fsx.mjs';
import { CairnError } from './errors.mjs';
import { checkedPath, filesystemPathKey, hasShortAlias, openForRead, readChecked, safeRelative } from './paths.mjs';
import { withLock } from './lock.mjs';
import { revision } from './store.mjs';
import { pathKey } from './text.mjs';
import { ensureDataIgnore } from './roots.mjs';
import { features, loadConfig } from './config.mjs';

const directory = '.cairn/shadow';
const manifestPath = `${directory}/manifest.json`;
const blobLimit = 256 * 1024;
const budget = 64 * 1024 * 1024;
const skipped = new Set(['.cairn', '.git', 'node_modules']);
const invalid = () => new CairnError('validation', 'Invalid shadow manifest.');
const indexes = new WeakMap();

function indexed(ctx, shadow) {
  indexes.set(shadow, { key: (path) => filesystemPathKey(ctx, path),
    paths: new Map([...shadow.entries.keys()].map((path) => [filesystemPathKey(ctx, path), path])) });
  return shadow;
}

function targetPath(path) {
  let rel;
  try { rel = safeRelative(path).replace(/\\/gu, '/'); } catch { throw invalid(); }
  if (pathKey(rel).split('/').some((part) => skipped.has(part)) || hasShortAlias(rel)) throw invalid();
  return rel;
}

export function shadowEntry(shadow, path) {
  const index = indexes.get(shadow);
  return shadow.entries.get(path) ?? shadow.entries.get(index.paths.get(index.key(path)));
}

export function readShadow(ctx) {
  const text = readChecked(ctx.root, manifestPath, 'utf8');
  if (text === null) return indexed(ctx, { initialized: false, entries: new Map() });
  let data;
  try { data = JSON.parse(text); } catch { throw invalid(); }
  if (data?.v !== 1 || typeof data.initialized !== 'boolean' || !data.entries
    || typeof data.entries !== 'object' || Array.isArray(data.entries)) throw invalid();
  if (data.disabledSince !== undefined && (typeof data.disabledSince !== 'string'
    || !Number.isFinite(Date.parse(data.disabledSince)))) throw invalid();
  const entries = new Map();
  for (const [path, entry] of Object.entries(data.entries)) {
    if (targetPath(path) !== path || !entry || typeof entry.blob !== 'boolean'
      || (entry.rev !== null && (typeof entry.rev !== 'string' || !/^[0-9a-f]{16}$/u.test(entry.rev)))
      || (entry.blob && entry.rev === null)) throw invalid();
    // Old v1 manifests lack size/hash; record upgrades them once under the shadow lock.
    if (entry.size !== undefined || entry.hash !== undefined) {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0
        || (entry.blob && (entry.size > blobLimit || typeof entry.hash !== 'string'
          || !/^[0-9a-f]{64}$/u.test(entry.hash) || !entry.hash.startsWith(entry.rev)))
        || (!entry.blob && entry.hash !== undefined)) throw invalid();
    }
    if (entry.stamp !== undefined && (!Array.isArray(entry.stamp) || entry.stamp.length !== 4
      || !entry.stamp.slice(0, 3).every((value) => typeof value === 'number' && Number.isFinite(value))
      || typeof entry.stamp[3] !== 'string')) throw invalid();
    entries.set(path, { rev: entry.rev, blob: entry.blob,
      ...(entry.stamp === undefined ? {} : { stamp: entry.stamp }),
      ...(entry.size === undefined ? {} : { size: entry.size }),
      ...(entry.hash === undefined ? {} : { hash: entry.hash }) });
  }
  return indexed(ctx, { initialized: data.initialized, entries,
    ...(data.disabledSince === undefined ? {} : { disabledSince: data.disabledSince }) });
}

function blobNames(ctx) {
  try {
    return fs.readdirSync(checkedPath(ctx.root, `${directory}/blobs`))
      .filter((name) => /^[0-9a-f]{64}$/u.test(name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function blobSize(ctx, name) {
  const fd = openForRead(ctx.root, `${directory}/blobs/${name}`);
  try { return fs.fstatSync(fd).size; } finally { fs.closeSync(fd); }
}

export function shadowStats(ctx) {
  const names = blobNames(ctx);
  return { blobs: names.length, bytes: names.reduce((total, name) => total + blobSize(ctx, name), 0) };
}

// Caller holds the shadow lock; unpublish the blobs before deleting any of them.
export function clearShadowBlobs(ctx, shadow) {
  const blobs = blobNames(ctx).map((name) => ({ name, size: blobSize(ctx, name) }));
  upgrade(ctx, shadow);
  for (const entry of shadow.entries.values()) {
    entry.blob = false;
    delete entry.hash;
  }
  record(ctx, shadow, []);
  for (const { name } of blobs) fs.unlinkSync(checkedPath(ctx.root, `${directory}/blobs/${name}`));
  return { blobs: blobs.length, bytes: blobs.reduce((total, { size }) => total + size, 0) };
}

export function shadowBytes(ctx, path, shadow = readShadow(ctx)) {
  const entry = shadowEntry(shadow, targetPath(path));
  if (!entry?.blob) return null;
  const names = entry.hash ? [entry.hash] : blobNames(ctx).filter((name) => name.startsWith(entry.rev));
  for (const name of names) {
    let fd;
    try {
      fd = openForRead(ctx.root, `${directory}/blobs/${name}`);
      if (fs.fstatSync(fd).size > blobLimit) throw invalid();
      const buffer = Buffer.alloc(blobLimit + 1);
      let length = 0, count;
      while (length < buffer.length && (count = fs.readSync(fd, buffer, length, buffer.length - length, null))) {
        length += count;
      }
      if (length > blobLimit) throw invalid();
      const bytes = buffer.subarray(0, length);
      if (createHash('sha256').update(bytes).digest('hex') === name) return bytes;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return null;
}

function upgrade(ctx, shadow) {
  if (![...shadow.entries.values()].some((entry) => entry.size === undefined)) return;
  const names = new Map(blobNames(ctx).map((name) => [name.slice(0, 16), name]));
  for (const entry of shadow.entries.values()) {
    if (entry.size !== undefined) continue;
    entry.size = 0;
    if (!entry.blob) continue;
    const hash = names.get(entry.rev);
    try {
      if (!hash) { entry.blob = false; continue; }
      entry.size = blobSize(ctx, hash);
      if (entry.size > blobLimit) throw invalid();
      entry.hash = hash;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      entry.blob = false;
    }
  }
}

function writeBlob(ctx, hash, bytes) {
  const path = checkedPath(ctx.root, `${directory}/blobs/${hash}`);
  let fd;
  try {
    fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // An unreferenced blob may be incomplete after a crash. Replace it without exposing a partial overwrite.
    fs.writeFileAtomic(path, bytes, undefined, { durable: false });
    return;
  }
  try {
    // New immutable blobs need no rename or flush; the durable manifest publishes them after this write.
    fs.writeFileSync(fd, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

function record(ctx, shadow, changes, { initialize = false, defer = false } = {}) {
  ensureDataIgnore(ctx.root);
  upgrade(ctx, shadow);
  const { paths, key } = indexes.get(shadow);
  const items = changes.map(({ path, bytes, rev, size, stamp }) => {
    if (bytes === undefined) {
      if (typeof rev !== 'string' || !/^[0-9a-f]{16}$/u.test(rev)
        || !Number.isSafeInteger(size) || size <= blobLimit) throw invalid();
    } else if (bytes !== null && !Buffer.isBuffer(bytes)) throw invalid();
    const rel = targetPath(path);
    return { path: shadow.entries.has(rel) ? rel : paths.get(key(rel)) ?? rel, bytes, rev, size, stamp };
  });
  // Replacements release their budget before new blobs are considered; shared blobs count only once.
  const released = new Set();
  for (const { path } of items) {
    const entry = shadow.entries.get(path);
    if (entry?.blob) released.add(entry.hash);
    shadow.entries.delete(path);
    paths.delete(key(path));
  }
  const names = new Map([...shadow.entries.values()].filter((entry) => entry.blob)
    .map((entry) => [entry.hash, entry.size]));
  let used = [...names.values()].reduce((total, size) => total + size, 0);
  for (const rel of [directory, `${directory}/blobs`]) {
    fs.mkdirSync(checkedPath(ctx.root, rel), { recursive: true, mode: 0o700 });
  }
  for (const { path, bytes, rev, size, stamp } of items) {
    if (bytes === null) continue;
    paths.set(key(path), path);
    if (bytes === undefined) {
      shadow.entries.set(path, { rev, blob: false, size, ...(stamp ? { stamp } : {}) });
      continue;
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    const blob = features(ctx.config).changeContent && bytes.length <= blobLimit
      && (names.has(hash) || used + bytes.length <= (ctx.shadowBudget ?? budget));
    if (blob && !names.has(hash)) {
      writeBlob(ctx, hash, bytes);
      names.set(hash, bytes.length);
      used += bytes.length;
    }
    shadow.entries.set(path, { rev: revision(bytes), blob, size: bytes.length, ...(blob ? { hash } : {}),
      ...(stamp ? { stamp } : {}) });
  }
  if (defer) return;
  fs.writeFileAtomic(checkedPath(ctx.root, manifestPath), JSON.stringify({
    v: 1, initialized: shadow.initialized || initialize, entries: Object.fromEntries(shadow.entries),
    ...(shadow.disabledSince === undefined ? {} : { disabledSince: shadow.disabledSince }),
  }));
  shadow.initialized ||= initialize;
  for (const name of initialize ? blobNames(ctx) : released) {
    if (names.has(name)) continue;
    try { fs.unlinkSync(checkedPath(ctx.root, `${directory}/blobs/${name}`)); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export function pruneShadow(ctx, shadow) {
  const hashes = new Set(), legacy = new Set();
  for (const entry of shadow.entries.values()) {
    if (!entry.blob) continue;
    if (entry.hash) hashes.add(entry.hash);
    else legacy.add(entry.rev);
  }
  for (const name of blobNames(ctx)) {
    if (!hashes.has(name) && !legacy.has(name.slice(0, 16))) {
      try { fs.unlinkSync(checkedPath(ctx.root, `${directory}/blobs/${name}`)); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}

// Reconciliation keeps these locks through event append and manifest replacement: paths -> config -> shadow -> events.
export function withShadow(ctx, fn, { configLocked = false } = {}) {
  const run = () => withLock(ctx, '_shadow', () => {
    const shadow = readShadow(ctx);
    return fn((changes, options) => record(ctx, shadow, changes, options), shadow);
  });
  if (configLocked) return run();
  return withLock(ctx, '_config', () => {
    ctx.config = loadConfig(ctx.root);
    return run();
  });
}

export function recordShadow(ctx, changes, options = {}) {
  return withShadow(ctx, (record) => record(changes, options));
}
