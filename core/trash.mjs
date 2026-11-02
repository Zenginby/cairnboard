import { basename, dirname, extname, join } from 'node:path';
import * as fs from './fsx.mjs';
import { CairnError } from './errors.mjs';
import { checkedPath, readChecked, safeRelative } from './paths.mjs';
import { uniqueName } from './text.mjs';
import { writeMany } from './store.mjs';

function payloadPath(trashId) {
  if (typeof trashId !== 'string' || /[/\\]/u.test(trashId) || safeRelative(trashId) !== trashId) {
    throw new CairnError('unsafe_path', 'Invalid trash identifier.');
  }
  return `.cairn/trash/${trashId}`;
}

export function move(ctx, tx, path) {
  if (ctx.mode !== 'write') throw new CairnError('internal', 'Trash requires write mode.');
  path = safeRelative(path);
  const before = readChecked(ctx.root, path);
  if (before === null) throw new CairnError('not_found', 'File not found.');
  const payload = payloadPath(`${tx}-${basename(path)}`);
  const sidecar = `${payload}.json`;
  const existing = readChecked(ctx.root, payload);
  if (existing !== null) throw new CairnError('conflict', 'Trash destination already exists.');
  fs.writeFileAtomic(checkedPath(ctx.root, sidecar), JSON.stringify({ path, deletedAt: ctx.clock.now().toISOString() }));
  const from = checkedPath(ctx.root, path);
  const to = checkedPath(ctx.root, payload);
  // The sidecar fsync may take time, so compare again immediately before moving the source.
  const current = readChecked(ctx.root, path);
  if (current === null || !before.equals(current)) throw new CairnError('conflict', 'File changed during deletion.');
  ctx.beforeTrashRename?.();
  fs.rename(from, to);
  return payload.slice('.cairn/trash/'.length);
}

export function list(ctx) {
  let names;
  try {
    names = fs.readdirSync(checkedPath(ctx.root, '.cairn/trash'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return names.filter((name) => name.endsWith('.json')).flatMap((name) => {
    const trashId = name.slice(0, -5);
    // A sidecar is durable before its payload is moved; it is not a restorable item yet.
    if (readChecked(ctx.root, payloadPath(trashId)) === null) return [];
    const text = readChecked(ctx.root, `.cairn/trash/${name}`, 'utf8');
    if (text === null) return [];
    const data = JSON.parse(text);
    safeRelative(data.path);
    return [{ trashId, path: data.path, deletedAt: data.deletedAt }];
  }).sort((a, b) => a.deletedAt.localeCompare(b.deletedAt) || a.trashId.localeCompare(b.trashId));
}

export function restore(ctx, trashId, opts = {}) {
  const payload = payloadPath(trashId);
  const metadata = readChecked(ctx.root, `${payload}.json`, 'utf8');
  const bytes = readChecked(ctx.root, payload);
  if (metadata === null || bytes === null) throw new CairnError('not_found', 'Trash item not found.');
  const { path } = JSON.parse(metadata);
  const rel = safeRelative(path);
  const ext = extname(rel);
  let existing;
  try {
    existing = fs.readdirSync(dirname(rel) === '.' ? ctx.root : checkedPath(ctx.root, dirname(rel))).filter((name) => extname(name) === ext)
      .map((name) => basename(name, ext));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    existing = [];
  }
  const name = uniqueName(existing, basename(rel, ext));
  const destination = join(dirname(rel), `${name}${ext}`);
  const result = writeMany(ctx, { ...opts, op: 'trash.restore', extra: { trashId }, items: [
    { path: destination, expectAbsent: true, createOnly: true, apply: () => bytes },
  ] });
  const { items, ...single } = result;
  return single;
}
