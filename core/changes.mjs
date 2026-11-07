import { randomBytes } from 'node:crypto';
import * as fs from './fsx.mjs';
import { CairnError } from './errors.mjs';
import { checkedPath, openForRead, readChecked, safeRelative } from './paths.mjs';
import { lockName, withLock } from './lock.mjs';
import { appendEvent, readEvents } from './events.mjs';
import { SKIPPED_DIRS, refresh, targetRevisions } from './index.mjs';
import { readShadow, recordShadow, shadowBytes, withShadow } from './shadow.mjs';
import { pruneHistory, recover, revision, saveHistory } from './store.mjs';
import { parseFile } from './frontmatter.mjs';
import { entityRef, isNoteKey, normalizeId } from './ids.mjs';
import { pathKey, stripHidden } from './text.mjs';
import * as entity from './entity.mjs';
import { validateDate } from './dates.mjs';
import { lineDiff } from './diff.mjs';

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

export function reconcileBeforeRun(ctx) {
  if (ctx.ephemeral || ctx.mode === 'dry-run') return [];
  try {
    const write = ctx.mode === 'write' ? ctx : { ...ctx, mode: 'write' };
    if (ctx.mode !== 'write') recover(write);
    reconcileExternal(write);
    return [];
  } catch (error) {
    if (error.code === 'locked' || error.exit === 6
      || ['EACCES', 'EROFS', 'index_unavailable'].includes(error.code)) return ['reconcile_skipped'];
    if (['unsafe_path', 'validation'].includes(error.code)) {
      try { readShadow(ctx); } catch (shadowError) {
        // An unusable shadow must not turn its best-effort write hook into a hard mutation failure.
        if (shadowError instanceof CairnError && ['unsafe_path', 'validation'].includes(shadowError.code)) {
          return ['reconcile_skipped'];
        }
      }
    }
    throw error;
  }
}

export function changeSince(since) {
  if (since === undefined) return null;
  if (typeof since === 'number' || (typeof since === 'string' && /^\d+$/u.test(since))) {
    const seq = Number(since);
    if (Number.isSafeInteger(seq) && seq >= 0) return { seq };
  } else if (typeof since === 'string'
    && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u
      .test(since)) {
    validateDate(since.slice(0, 10));
    const ts = Date.parse(since);
    if (Number.isFinite(ts)) return { ts };
  }
  throw new CairnError('validation', 'Invalid --since. Use a nonnegative sequence or ISO timestamp.');
}

function filterPath(ctx, ref) {
  if (ref === undefined) return null;
  if (ref.startsWith('@') || ref.includes('/') || /\.md$/iu.test(ref)) {
    const path = ref.replace(/^@/u, '');
    return targetPath(/\.md$/iu.test(path) ? path : `${path}.md`);
  }
  for (const type of ['note', 'card', 'project', 'research']) {
    try { return entity.resolve(ctx, type, ref).path; } catch (error) {
      if (error.code !== 'not_found') throw error;
    }
  }
  return null;
}

/** @param {*} ctx @param {{ since?: number|string, target?: string, actor?: string, limit?: number }} [options]
 * @param {any[]} [events] */
export function listChanges(ctx, { since, target, actor, limit = 20 } = {}, events = readEvents(ctx)) {
  const cursor = changeSince(since);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new CairnError('validation', 'Invalid --limit. Use an integer from 1 to 200.');
  }
  const path = filterPath(ctx, target);
  const matches = events.filter((event) => (!cursor || (cursor.seq === undefined
    ? Date.parse(event.ts) >= cursor.ts : event.seq > cursor.seq)) && (actor === undefined || event.actor === actor)
    && (target === undefined || event.target === target || event.targets?.some((item) => item.target === target
      || (path !== null && item.path === path)
      || (isNoteKey(target) && entityRef({ type: 'note', id: null, path: item.path }) === target))));
  return (since === undefined ? matches.slice(-limit) : matches.slice(0, limit)).map((event) => ({
    seq: event.seq, ts: event.ts, actor: event.actor, op: event.op,
    ...(event.change === undefined ? {} : { change: event.change }), target: event.target,
    paths: (event.targets ?? []).map(({ path }) => path), rev: event.rev,
    ...(event.before === undefined ? {} : { before: event.before }),
  }));
}

const DIFF_INPUT_BYTES = 256 * 1024;

function historyItem(ctx, event, path) {
  if (typeof event.tx !== 'string' || !/^[tx]-[0-9a-z]+(?:-[0-9a-z]+)*$/u.test(event.tx)) return null;
  const text = readChecked(ctx.root, `.cairn/history/${event.tx}.json`, 'utf8');
  if (text === null) return null;
  let saved;
  try { saved = JSON.parse(text); } catch { return null; }
  if (saved?.tx !== event.tx) return null;
  const items = saved.items ?? [saved];
  return Array.isArray(items) ? items.find((item) => item?.path === path) ?? null : null;
}

function beforeBytes(item) {
  if (item.beforeUnavailable) return { reason: 'before_unavailable' };
  if (item.before === null) return { bytes: Buffer.alloc(0) };
  if (typeof item.before !== 'string') return { reason: 'before_unavailable' };
  if (item.beforeBytes !== undefined) {
    if (typeof item.beforeBytes !== 'string'
      || item.beforeBytes.length > Math.ceil(DIFF_INPUT_BYTES / 3) * 4) return { reason: 'too_large' };
    const bytes = Buffer.from(item.beforeBytes, 'base64');
    return bytes.length > DIFF_INPUT_BYTES ? { reason: 'too_large' } : { bytes };
  }
  return Buffer.byteLength(item.before) > DIFF_INPUT_BYTES
    ? { reason: 'too_large' } : { bytes: Buffer.from(item.before) };
}

function afterBytes(ctx, path) {
  let fd;
  try {
    fd = openForRead(ctx.root, path);
    if (fs.fstatSync(fd).size > DIFF_INPUT_BYTES) return { reason: 'too_large' };
    const buffer = Buffer.alloc(DIFF_INPUT_BYTES + 1);
    let length = 0, count;
    while (length < buffer.length && (count = fs.readSync(fd, buffer, length, buffer.length - length, null))) {
      length += count;
    }
    return length > DIFF_INPUT_BYTES ? { reason: 'too_large' } : { bytes: buffer.subarray(0, length) };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'unsafe_path'].includes(error.code)) {
      return { reason: 'after_unavailable' };
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function changeDiff(ctx, event, events = readEvents(ctx)) {
  event = event.tx ? event : events.find(({ seq }) => seq === event.seq);
  const path = event?.targets?.[0]?.path;
  if (!path || !targetPath(path)) return { diff: null, reason: 'history_pruned' };
  const saved = historyItem(ctx, event, path);
  if (!saved) return { diff: null, reason: 'history_pruned' };
  const before = beforeBytes(saved);
  if (before.reason) return { diff: null, reason: before.reason };
  const rev = event.targets[0].rev;
  /** @type {{ bytes?: Buffer, reason?: string }|null} */
  let after = rev === null ? { bytes: Buffer.alloc(0) } : null;
  const next = events.find((item) => item.seq > event.seq && item.targets?.some((target) => target.path === path));
  const following = next && historyItem(ctx, next, path);
  if (!after && following) {
    const candidate = beforeBytes(following);
    if (candidate.bytes && revision(candidate.bytes) === rev) after = candidate;
  }
  after ??= afterBytes(ctx, path);
  if (after.reason) return { diff: null, reason: after.reason };
  if (rev !== null && revision(after.bytes) !== rev) return { diff: null, reason: 'after_unavailable' };
  const texts = [];
  for (const bytes of [before.bytes, after.bytes]) {
    if (bytes.includes(0)) return { diff: null, reason: 'binary' };
    try { texts.push(stripHidden(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)).text); }
    catch { return { diff: null, reason: 'binary' }; }
  }
  const result = lineDiff(texts[0], texts[1]);
  return { diff: result.hunks, truncated: result.truncated };
}
