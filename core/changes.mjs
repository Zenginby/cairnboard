import { randomBytes } from 'node:crypto';
import * as fs from './fsx.mjs';
import { CairnError } from './errors.mjs';
import { checkedPath, readChecked, safeRelative } from './paths.mjs';
import { lockName, withLock } from './lock.mjs';
import { appendEvent, readEvents } from './events.mjs';
import { SKIPPED_DIRS, refresh, targetRevisions } from './index.mjs';
import { readShadow, shadowBytes, withShadow } from './shadow.mjs';
import { pruneHistory, revision, saveHistory } from './store.mjs';
import { parseFile } from './frontmatter.mjs';
import { normalizeId } from './ids.mjs';
import { pathKey } from './text.mjs';

function targetPath(path) {
  const rel = safeRelative(path).replace(/\\/gu, '/');
  return pathKey(rel).split('/').some((part) => SKIPPED_DIRS.has(part)) || !/\.md$/iu.test(rel) ? null : rel;
}

function diskBytes(ctx, path) {
  try {
    return readChecked(ctx.root, path);
  } catch (error) {
    // A symlink replacement is not a deletion and must never supply external content.
    if (error.code === 'unsafe_path') return undefined;
    throw error;
  }
}

function baseline(ctx, paths) {
  // Read one path at a time so a large first scan does not nest thousands of locks on the JS stack.
  // A write between this snapshot and the manifest commit is recognized by its durable event on the next scan.
  const changes = paths.flatMap((path) => withLock(ctx, lockName(path), () => {
    const bytes = diskBytes(ctx, path);
    return bytes === undefined ? [] : [{ path, bytes }];
  }));
  return withShadow(ctx, (record) => {
    if (readShadow(ctx).initialized) return false;
    record(changes, { initialize: true });
    return true;
  });
}

function reconcilePath(ctx, path) {
  return withLock(ctx, lockName(path), () => withShadow(ctx, (record) => {
    const entry = readShadow(ctx).entries.get(path);
    const bytes = diskBytes(ctx, path);
    if (bytes === undefined) return null;
    const after = bytes === null ? null : revision(bytes);
    if (after === (entry?.rev ?? null)) return null;
    const last = readEvents(ctx).findLast((event) => event.targets?.some((target) => target.path === path));
    const own = last?.targets.find((target) => target.path === path);
    if (own && own.rev === after) {
      record([{ path, bytes }]);
      return null;
    }
    const before = shadowBytes(ctx, path);
    const target = normalizeId(parseFile((bytes ?? before ?? Buffer.alloc(0)).toString('utf8')).data?.id) ?? path;
    const tx = `x-${ctx.clock.now().getTime().toString(36)}-${randomBytes(8).toString('hex')}`;
    const item = { path, target, before: before === null ? null : before.toString('utf8'), after,
      ...(before !== null && !before.equals(Buffer.from(before.toString('utf8')))
        ? { beforeBytes: before.toString('base64') } : {}),
      ...(entry?.rev && before === null ? { beforeUnavailable: true } : {}) };
    saveHistory(ctx, { tx, op: 'external.change', ...item, items: [item] });
    let seq;
    try {
      seq = appendEvent(ctx, { tx, op: 'external.change', actor: 'owner:external', target, rev: after,
        before: entry?.rev ?? null, change: after === null ? 'delete' : entry ? 'modify' : 'create',
        targets: [{ path, target, rev: after }] });
    } catch (error) {
      // appendEvent can fail after the durable append (for example at the recovery fault point).
      if (!readEvents(ctx).some((event) => event.tx === tx)) {
        fs.unlinkSync(checkedPath(ctx.root, `.cairn/history/${tx}.json`));
      }
      throw error;
    }
    pruneHistory(ctx);
    record([{ path, bytes }]);
    return seq;
  }));
}

/** @param {*} ctx @param {{ paths?: string[] }} [options] */
export function reconcileExternal(ctx, { paths } = {}) {
  if (ctx.mode !== 'write') throw new CairnError('internal', 'Reconciliation requires write mode.');
  const requested = paths?.map(targetPath).filter((path) => path !== null);
  refresh(ctx);
  const current = targetRevisions(ctx);
  let shadow = readShadow(ctx);
  const sorted = (paths) => [...new Set(paths)].sort((a, b) =>
    pathKey(a) < pathKey(b) ? -1 : pathKey(a) > pathKey(b) ? 1 : 0);
  if (!shadow.initialized) {
    if (baseline(ctx, sorted([...current.keys(), ...shadow.entries.keys()]))) {
      return { recorded: 0, baseline: true, seqs: [] };
    }
    shadow = readShadow(ctx);
  }
  const candidates = sorted(requested ?? [...current.keys(), ...shadow.entries.keys()]);
  const seqs = [];
  for (const path of candidates) {
    if (!targetPath(path)) continue;
    // An invalid UTF-8 file can share a decoded index hash with valid text; disk bytes always decide.
    const seq = reconcilePath(ctx, path);
    if (seq !== null) seqs.push(seq);
  }
  return { recorded: seqs.length, baseline: false, seqs };
}
