import { createHash } from 'node:crypto';
import * as fs from './fsx.mjs';
import { CairnError } from './errors.mjs';
import { checkedPath, openForRead, readChecked, safeRelative } from './paths.mjs';
import { withLock } from './lock.mjs';
import { revision } from './store.mjs';
import { pathKey } from './text.mjs';
import { ensureDataIgnore } from './roots.mjs';

const directory = '.cairn/shadow';
const manifestPath = `${directory}/manifest.json`;
const blobLimit = 256 * 1024;
const budget = 64 * 1024 * 1024;
const skipped = new Set(['.cairn', '.git', 'node_modules']);
const invalid = () => new CairnError('validation', 'Invalid shadow manifest.');

function targetPath(path) {
  let rel;
  try { rel = safeRelative(path).replace(/\\/gu, '/'); } catch { throw invalid(); }
  if (pathKey(rel).split('/').some((part) => skipped.has(part))) throw invalid();
  return rel;
}

export function readShadow(ctx) {
  const text = readChecked(ctx.root, manifestPath, 'utf8');
  if (text === null) return { initialized: false, entries: new Map() };
  let data;
  try { data = JSON.parse(text); } catch { throw invalid(); }
  if (data?.v !== 1 || typeof data.initialized !== 'boolean' || !data.entries
    || typeof data.entries !== 'object' || Array.isArray(data.entries)) throw invalid();
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
    entries.set(path, { rev: entry.rev, blob: entry.blob,
      ...(entry.size === undefined ? {} : { size: entry.size }),
      ...(entry.hash === undefined ? {} : { hash: entry.hash }) });
  }
  return { initialized: data.initialized, entries };
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

export function shadowBytes(ctx, path, shadow = readShadow(ctx)) {
  const entry = shadow.entries.get(targetPath(path));
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

function record(ctx, shadow, changes, { initialize = false } = {}) {
  ensureDataIgnore(ctx.root);
  upgrade(ctx, shadow);
  const items = changes.map(({ path, bytes }) => {
    if (bytes !== null && !Buffer.isBuffer(bytes)) throw invalid();
    return { path: targetPath(path), bytes };
  });
  // Replacements release their budget before new blobs are considered; shared blobs count only once.
  const released = new Set();
  for (const { path } of items) {
    const entry = shadow.entries.get(path);
    if (entry?.blob) released.add(entry.hash);
    shadow.entries.delete(path);
  }
  const names = new Map([...shadow.entries.values()].filter((entry) => entry.blob)
    .map((entry) => [entry.hash, entry.size]));
  let used = [...names.values()].reduce((total, size) => total + size, 0);
  for (const rel of [directory, `${directory}/blobs`]) {
    fs.mkdirSync(checkedPath(ctx.root, rel), { recursive: true, mode: 0o700 });
  }
  for (const { path, bytes } of items) {
    if (bytes === null) continue;
    const hash = createHash('sha256').update(bytes).digest('hex');
    const blob = bytes.length <= blobLimit && (names.has(hash) || used + bytes.length <= (ctx.shadowBudget ?? budget));
    if (blob && !names.has(hash)) {
      writeBlob(ctx, hash, bytes);
      names.set(hash, bytes.length);
      used += bytes.length;
    }
    shadow.entries.set(path, { rev: revision(bytes), blob, size: bytes.length, ...(blob ? { hash } : {}) });
  }
  fs.writeFileAtomic(checkedPath(ctx.root, manifestPath), JSON.stringify({
    v: 1, initialized: shadow.initialized || initialize, entries: Object.fromEntries(shadow.entries),
  }));
  shadow.initialized ||= initialize;
  for (const name of initialize ? blobNames(ctx) : released) {
    if (names.has(name)) continue;
    try { fs.unlinkSync(checkedPath(ctx.root, `${directory}/blobs/${name}`)); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

// Reconciliation keeps this lock through event append and manifest replacement: paths -> shadow -> events.
export function withShadow(ctx, fn) {
  return withLock(ctx, '_shadow', () => {
    const shadow = readShadow(ctx);
    return fn((changes, options) => record(ctx, shadow, changes, options), shadow);
  });
}

export function recordShadow(ctx, changes, options = {}) {
  return withShadow(ctx, (record) => record(changes, options));
}
