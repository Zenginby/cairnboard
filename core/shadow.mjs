import { createHash } from 'node:crypto';
import * as fs from './fsx.mjs';
import { CairnError } from './errors.mjs';
import { checkedPath, openForRead, readChecked, safeRelative } from './paths.mjs';
import { withLock } from './lock.mjs';
import { revision } from './store.mjs';
import { pathKey } from './text.mjs';

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
    entries.set(path, { rev: entry.rev, blob: entry.blob });
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

export function shadowBytes(ctx, path) {
  const entry = readShadow(ctx).entries.get(targetPath(path));
  if (!entry?.blob) return null;
  // The manifest stores the public short revision; blob names retain the full SHA-256 digest.
  for (const name of blobNames(ctx).filter((name) => name.startsWith(entry.rev))) {
    if (blobSize(ctx, name) > blobLimit) throw invalid();
    const bytes = readChecked(ctx.root, `${directory}/blobs/${name}`);
    if (bytes !== null && createHash('sha256').update(bytes).digest('hex') === name) return bytes;
  }
  return null;
}

function record(ctx, changes, { initialize = false } = {}) {
  const shadow = readShadow(ctx);
  const items = changes.map(({ path, bytes }) => {
    if (bytes !== null && !Buffer.isBuffer(bytes)) throw invalid();
    return { path: targetPath(path), bytes };
  });
  // Replacements release their budget before new blobs are considered; shared blobs count only once.
  for (const { path } of items) shadow.entries.delete(path);
  const retained = new Set([...shadow.entries.values()].filter((entry) => entry.blob).map((entry) => entry.rev));
  const names = new Set(blobNames(ctx).filter((name) => retained.has(name.slice(0, 16))));
  let used = [...names].reduce((total, name) => total + blobSize(ctx, name), 0);
  for (const rel of [directory, `${directory}/blobs`]) {
    fs.mkdirSync(checkedPath(ctx.root, rel), { recursive: true, mode: 0o700 });
  }
  for (const { path, bytes } of items) {
    if (bytes === null) continue;
    const hash = createHash('sha256').update(bytes).digest('hex');
    const blob = bytes.length <= blobLimit && (names.has(hash) || used + bytes.length <= (ctx.shadowBudget ?? budget));
    if (blob && !names.has(hash)) {
      fs.writeFileAtomic(checkedPath(ctx.root, `${directory}/blobs/${hash}`), bytes);
      names.add(hash);
      used += bytes.length;
    }
    shadow.entries.set(path, { rev: revision(bytes), blob });
  }
  fs.writeFileAtomic(checkedPath(ctx.root, manifestPath), JSON.stringify({
    v: 1, initialized: shadow.initialized || initialize, entries: Object.fromEntries(shadow.entries),
  }));
  const referenced = new Set([...shadow.entries.values()].filter((entry) => entry.blob).map((entry) => entry.rev));
  for (const name of blobNames(ctx)) {
    if (!referenced.has(name.slice(0, 16))) fs.unlinkSync(checkedPath(ctx.root, `${directory}/blobs/${name}`));
  }
}

// Reconciliation keeps this lock through event append and manifest replacement: paths -> shadow -> events.
export function withShadow(ctx, fn) {
  return withLock(ctx, '_shadow', () => fn((changes, options) => record(ctx, changes, options)));
}

export function recordShadow(ctx, changes, options = {}) {
  return withShadow(ctx, (record) => record(changes, options));
}
