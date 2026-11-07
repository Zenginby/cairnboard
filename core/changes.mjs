import { randomBytes } from 'node:crypto';
import * as fs from './fsx.mjs';
import { CairnError } from './errors.mjs';
import { checkedPath, readChecked, safeRelative } from './paths.mjs';
import { lockName, withLock } from './lock.mjs';
import { appendEvent, readEvents } from './events.mjs';
import { SKIPPED_DIRS, refresh, targetRevisions } from './index.mjs';
import { readShadow, recordShadow, shadowBytes, withShadow } from './shadow.mjs';
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

function baseline(ctx, paths, indexedBytes) {
  // A concurrent write is recognized by its durable event on the next scan; baseline needs no path locks.
  const changes = paths.flatMap((path) => {
    const bytes = indexedBytes.get(path) ?? diskBytes(ctx, path);
    return bytes === undefined ? [] : [{ path, bytes }];
  });
  return withShadow(ctx, (record, shadow) => {
    if (shadow.initialized) return false;
    record(changes, { initialize: true });
    return true;
  });
}

function refreshEvents(ctx, state) {
  for (const event of readEvents(ctx, { cursor: state.cursor })) {
    state.events.set(event.seq, event);
    for (const target of event.targets ?? []) {
      if ((state.last.get(target.path)?.seq ?? 0) < event.seq) {
        state.last.set(target.path, { seq: event.seq, rev: target.rev });
      }
    }
  }
}

function reconcileBatch(ctx, paths, state) {
  const names = [...new Set(paths.map(lockName))];
  const lock = (index) => index === names.length ? run()
    : withLock(ctx, names[index], () => lock(index + 1));
  const run = () => withShadow(ctx, (record, shadow) => {
    const changes = [], seqs = [];
    for (const path of paths) {
      const seq = reconcilePath(ctx, path, state, shadow, changes);
      if (seq !== null) seqs.push(seq);
    }
    if (changes.length) record(changes);
    return seqs;
  });
  return lock(0);
}

function reconcilePath(ctx, path, state, shadow, changes) {
  const entry = shadow.entries.get(path);
  const bytes = diskBytes(ctx, path);
  if (bytes === undefined) return null;
  const after = bytes === null ? null : revision(bytes);
  if (after === (entry?.rev ?? null)) return null;
  refreshEvents(ctx, state);
  const own = state.last.get(path);
  if (own && own.rev === after) {
    changes.push({ path, bytes });
    return null;
  }
  const before = shadowBytes(ctx, path, shadow);
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
    refreshEvents(ctx, state);
    if (![...state.events.values()].some((event) => event.tx === tx)) {
      fs.unlinkSync(checkedPath(ctx.root, `.cairn/history/${tx}.json`));
    }
    throw error;
  }
  refreshEvents(ctx, state);
  pruneHistory(ctx, [...state.events.values()].sort((a, b) => a.seq - b.seq));
  changes.push({ path, bytes });
  return seq;
}

/** @param {*} ctx @param {{ paths?: string[] }} [options] */
export function reconcileExternal(ctx, { paths } = {}) {
  if (ctx.mode !== 'write') throw new CairnError('internal', 'Reconciliation requires write mode.');
  const requested = paths?.map(targetPath).filter((path) => path !== null);
  let shadow = readShadow(ctx);
  const indexedBytes = new Map();
  refresh(ctx, { onBytes: shadow.initialized ? undefined : (path, bytes) => indexedBytes.set(path, bytes) });
  const current = targetRevisions(ctx, { byteSafe: true });
  const sorted = (paths) => [...new Set(paths)].map((path) => ({ path, key: pathKey(path) }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(({ path }) => path);
  if (!shadow.initialized) {
    if (baseline(ctx, sorted([...current.keys(), ...shadow.entries.keys()]), indexedBytes)) {
      return { recorded: 0, baseline: true, seqs: [] };
    }
    shadow = readShadow(ctx);
  }
  if ([...shadow.entries.values()].some((entry) => entry.size === undefined)) {
    recordShadow(ctx, []);
    shadow = readShadow(ctx);
  }
  const allPaths = requested ?? [...new Set([...current.keys(), ...shadow.entries.keys()])];
  const candidates = sorted(allPaths.filter((path) => {
    const hash = current.get(path);
    return !current.has(path) || !shadow.entries.has(path) || typeof hash !== 'string'
      || !/^[0-9a-f]{16}$/u.test(hash) || hash !== shadow.entries.get(path).rev;
  }));
  const state = { cursor: new Map(), events: new Map(), last: new Map() };
  const seqs = [];
  if (candidates.length) refreshEvents(ctx, state);
  // Bound nested locks even when an entire vault changes; each batch commits its manifest only once.
  const batchSize = 64;
  for (let at = 0; at < candidates.length; at += batchSize) {
    const paths = candidates.slice(at, at + batchSize).filter((path) => targetPath(path));
    if (paths.length) seqs.push(...reconcileBatch(ctx, paths, state));
  }
  return { recorded: seqs.length, baseline: false, seqs };
}
