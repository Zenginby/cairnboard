import { createHash, randomBytes } from 'node:crypto';
import * as fs from './fsx.mjs';
import { CairnError } from './errors.mjs';
import { checkedPath, filesystemPathKey, hasShortAlias, openForRead, readChecked, safeRelative } from './paths.mjs';
import { lockName, withLock } from './lock.mjs';
import { appendEvent, readEvents } from './events.mjs';
import { SKIPPED_DIRS, refresh, targetRevisions } from './index.mjs';
import { pruneShadow, readShadow, recordShadow, shadowBytes, shadowEntry, withShadow } from './shadow.mjs';
import { pruneHistory, recover, revision, saveHistory } from './store.mjs';
import { parseFile } from './frontmatter.mjs';
import { entityRef, isNoteKey, normalizeId } from './ids.mjs';
import { pathKey, stripHidden } from './text.mjs';
import * as entity from './entity.mjs';
import { validateDate } from './dates.mjs';
import { lineDiff } from './diff.mjs';
import { features } from './config.mjs';
import { checkConfigDrift } from './settings.mjs';

function targetPath(path) {
  const rel = safeRelative(path).replace(/\\/gu, '/');
  return pathKey(rel).split('/').some((part) => SKIPPED_DIRS.has(part)) || hasShortAlias(rel)
    || !/\.md$/iu.test(rel) ? null : rel;
}

function warn(ctx, warning) {
  ctx.warnings ??= [];
  if (!ctx.warnings.includes(warning)) ctx.warnings.push(warning);
}

function reconcileTarget(ctx, path) {
  try {
    const rel = targetPath(path);
    if (rel === null && hasShortAlias(path)) warn(ctx, 'reconcile_path_skipped');
    return rel;
  } catch (error) {
    if (error.code !== 'unsafe_path') throw error;
    warn(ctx, 'reconcile_path_skipped');
    return null;
  }
}

const SHADOW_LIMIT = 256 * 1024;
const PREFIX_LIMIT = 64 * 1024;
const BASELINE_BATCH = 64;

function snapshot(bytes) {
  return { bytes, rev: bytes === null ? null : revision(bytes), size: bytes?.length ?? 0,
    prefix: bytes?.subarray(0, PREFIX_LIMIT) ?? Buffer.alloc(0) };
}

const fileStamp = (stat) => [stat.size, stat.mtimeMs, stat.ctimeMs, String(stat.ino)];

function unchangedStamp(ctx, path, entry) {
  if (!entry?.stamp) return false;
  try {
    const stamp = fileStamp(fs.lstatSync(checkedPath(ctx.root, path)));
    return entry.stamp.every((value, index) => value === stamp[index]);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'unsafe_path'].includes(error.code)) return false;
    throw error;
  }
}

function diskBytes(ctx, path, trackStamp = false) {
  let fd;
  try {
    if (fs.lstatSync(checkedPath(ctx.root, path)).isDirectory()) return snapshot(null);
    fd = openForRead(ctx.root, path);
    const stamp = trackStamp ? fileStamp(fs.fstatSync(fd)) : undefined;
    const hash = createHash('sha256'), buffer = Buffer.alloc(PREFIX_LIMIT);
    const chunks = [], prefix = [];
    let size = 0, prefixSize = 0, count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) {
      const chunk = buffer.subarray(0, count);
      hash.update(chunk);
      size += count;
      if (prefixSize < PREFIX_LIMIT) {
        const part = Buffer.from(chunk.subarray(0, PREFIX_LIMIT - prefixSize));
        prefix.push(part);
        prefixSize += part.length;
      }
      if (size <= SHADOW_LIMIT) chunks.push(Buffer.from(chunk));
      else chunks.length = 0;
    }
    return { bytes: size <= SHADOW_LIMIT ? Buffer.concat(chunks, size) : undefined,
      rev: hash.digest('hex').slice(0, 16), size, prefix: Buffer.concat(prefix, prefixSize),
      ...(stamp ? { stamp } : {}) };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return snapshot(null);
    // A symlink replacement is not a deletion and must never supply external content.
    if (error.code === 'unsafe_path') return undefined;
    if (fs.isFilesystemError(error)) {
      warn(ctx, fs.isPersistentFilesystemError(error) ? 'reconcile_failed' : 'reconcile_path_skipped');
      return undefined;
    }
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function baseline(ctx, paths, indexedBytes, nullHashes) {
  // A concurrent write is recognized by its durable event on the next scan; baseline needs no path locks.
  return withShadow(ctx, (record, shadow) => {
    if (!features(ctx.config).changeTrail || shadow.initialized) return false;
    for (let at = 0; at < paths.length; at += BASELINE_BATCH) {
      const changes = paths.slice(at, at + BASELINE_BATCH).flatMap((path) => {
        if (reconcileTarget(ctx, path) === null) return [];
        const cached = indexedBytes.get(path);
        indexedBytes.delete(path);
        const file = cached ? snapshot(cached) : diskBytes(ctx, path, nullHashes.has(path));
        return file === undefined ? [] : [{ path, bytes: file.bytes, rev: file.rev, size: file.size,
          ...('stamp' in file ? { stamp: file.stamp } : {}) }];
      });
      record(changes, { defer: true });
    }
    record([], { initialize: true });
    return true;
  });
}

const validRevision = (rev) => rev === null || (typeof rev === 'string' && /^[0-9a-f]{16}$/u.test(rev));
const validRevisions = (event) => validRevision(event.rev)
  && (!Object.hasOwn(event, 'before') || validRevision(event.before))
  && (event.targets ?? []).every((target) => validRevision(target.rev)
    && (!Object.hasOwn(target, 'before') || validRevision(target.before)));

function refreshEvents(ctx, state) {
  for (const event of readEvents(ctx, { cursor: state.cursor })) {
    state.events.set(event.seq, event);
    if (!validRevisions(event)) continue;
    if (typeof event.overwrittenBy === 'string') state.gaps.add(event.overwrittenBy);
    for (const target of event.targets ?? []) {
      const key = filesystemPathKey(ctx, target.path);
      if ((state.last.get(key)?.seq ?? 0) < event.seq) {
        state.last.set(key, { seq: event.seq, rev: target.rev, event, previous: state.last.get(key),
          ...(Object.hasOwn(target, 'before') ? { before: target.before } : {}) });
      }
    }
  }
}

function fullPrune(ctx, state) {
  return withShadow(ctx, (record, shadow) => {
    if (!features(ctx.config).changeTrail) return shadow;
    pruneShadow(ctx, shadow);
    // Freeze event append while classifying histories; active writers retain their pending intent.
    withLock(ctx, '_events', () => {
      refreshEvents(ctx, state);
      pruneHistory(ctx, [...state.events.values()].sort((a, b) => a.seq - b.seq), { orphans: true });
    });
    return shadow;
  });
}

function pendingRevisions(ctx) {
  const pending = new Map();
  let names;
  try {
    names = fs.readdirSync(checkedPath(ctx.root, '.cairn/pending'));
  } catch (error) {
    // A fresh data folder has no pending directory until its first write.
    if (error.code === 'ENOENT') return pending;
    throw error;
  }
  for (const name of names) {
    if (!/^t-[0-9a-z]+(?:-\d+)?\.json$/u.test(name)) continue;
    const intent = readRecord(ctx, `.cairn/pending/${name}`);
    if (!intent || intent.tx !== name.slice(0, -5) || !Array.isArray(intent.items)) continue;
    for (const item of intent.items) {
      if (typeof item?.path !== 'string' || (item.after !== null
        && (typeof item.after !== 'string' || !/^[0-9a-f]{16}$/u.test(item.after)))) continue;
      try {
        const path = targetPath(item.path);
        if (!path) continue;
        const key = filesystemPathKey(ctx, path);
        if (!pending.has(key)) pending.set(key, new Set());
        pending.get(key).add(item.after);
      } catch (error) { if (error.code !== 'unsafe_path') throw error; }
    }
  }
  return pending;
}

function reconcileBatch(ctx, paths, state) {
  const names = [...new Set(paths.map(lockName))];
  const lock = (index) => index === names.length ? run()
    : withLock(ctx, names[index], () => lock(index + 1));
  const run = () => withShadow(ctx, (record, shadow) => {
    if (!features(ctx.config).changeTrail || !shadow.initialized) return [];
    const changes = [], seqs = [];
    const pending = pendingRevisions(ctx);
    for (const path of paths) {
      const seq = reconcilePath(ctx, path, state, shadow, changes, pending);
      if (seq !== null) seqs.push(seq);
    }
    if (changes.length) record(changes);
    return seqs;
  });
  return lock(0);
}

function reconcilePath(ctx, path, state, shadow, changes, pending) {
  const entry = shadowEntry(shadow, path);
  const file = diskBytes(ctx, path, state.nullHashes.has(path));
  if (file === undefined) return null;
  const after = file.rev;
  if (pending.get(filesystemPathKey(ctx, path))?.has(after)) return null;
  const change = { path, bytes: file.bytes, rev: file.rev, size: file.size,
    ...('stamp' in file ? { stamp: file.stamp } : {}) };
  if (after === (entry?.rev ?? null)) {
    if ('stamp' in file) changes.push(change);
    return null;
  }
  refreshEvents(ctx, state);
  let own = state.last.get(filesystemPathKey(ctx, path));
  // A retrospective owner event points at the already committed writer that superseded it.
  if (own?.event.overwrittenBy) {
    const retrospective = own;
    own = null;
    for (let node = retrospective.previous; node; node = node.previous) {
      if (node.event.tx === retrospective.event.overwrittenBy && node.rev === after) { own = node; break; }
    }
  }
  if (own && own.rev === after) {
    changes.push(change);
    let gap = own;
    while (gap && gap.event.op !== 'external.change' && Object.hasOwn(gap, 'before')
      && gap.before !== (entry?.rev ?? null) && !state.gaps.has(gap.event.tx)) {
      let previous = gap.previous;
      while (previous?.event.overwrittenBy) previous = previous.previous;
      if (previous && gap.before === previous.rev) { gap = previous; continue; }
      const saved = historyItem(ctx, gap.event, path);
      const preimage = saved && !saved.reason ? beforeBytes(saved) : null;
      const prefix = preimage?.bytes?.subarray(0, PREFIX_LIMIT) ?? file.prefix;
      return emitExternal(ctx, { path, entry,
        before: features(ctx.config).changeContent ? shadowBytes(ctx, path, shadow) : null, after: gap.before,
        prefix, afterTx: gap.event.tx, overwrittenBy: own.event.tx }, state);
    }
    return null;
  }
  const before = features(ctx.config).changeContent ? shadowBytes(ctx, path, shadow) : null;
  const prefix = file.rev === null ? before?.subarray(0, PREFIX_LIMIT) ?? Buffer.alloc(0) : file.prefix;
  const seq = emitExternal(ctx, { path, entry, before, after, prefix }, state);
  changes.push(change);
  return seq;
}

function emitExternal(ctx, { path, entry, before, after, prefix, afterTx = undefined,
  overwrittenBy = undefined }, state) {
  const keepContent = features(ctx.config).changeContent;
  if (!keepContent) before = null;
  const target = normalizeId(parseFile(prefix.toString('utf8')).data?.id) ?? path;
  const tx = `x-${ctx.clock.now().getTime().toString(36)}-${randomBytes(8).toString('hex')}`;
  const item = { path, target, before: before === null ? null : before.toString('utf8'), after,
    ...(!keepContent ? { contentNotKept: true } : {}),
    ...(afterTx ? { afterTx } : {}),
    ...(before !== null && !before.equals(Buffer.from(before.toString('utf8')))
      ? { beforeBytes: before.toString('base64') } : {}),
    ...(entry?.rev && before === null ? { beforeUnavailable: true } : {}) };
  saveHistory(ctx, { tx, op: 'external.change', ...item, items: [item] });
  let seq;
  try {
    seq = appendEvent(ctx, { tx, op: 'external.change', actor: 'owner:external', target, rev: after,
      ...(!keepContent ? { contentNotKept: true } : {}),
      before: entry?.rev ?? null, change: after === null ? 'delete' : entry ? 'modify' : 'create',
      ...(overwrittenBy ? { overwrittenBy } : {}),
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
  return seq;
}

/** @param {*} ctx @param {{ paths?: string[], prune?: boolean }} [options] */
export function reconcileExternal(ctx, { paths, prune = paths === undefined } = {}) {
  if (ctx.mode !== 'write') throw new CairnError('internal', 'Reconciliation requires write mode.');
  checkConfigDrift(ctx);
  if (!features(ctx.config).changeTrail) {
    warn(ctx, 'trail_disabled');
    return { recorded: 0, baseline: false, seqs: [] };
  }
  const requested = paths?.flatMap((path) => {
    try {
      const rel = targetPath(path);
      if (rel !== null) return [rel];
    } catch (error) { if (error.code !== 'unsafe_path') throw error; }
    warn(ctx, 'reconcile_path_skipped');
    return [];
  });
  const state = { cursor: new Map(), events: new Map(), last: new Map(), gaps: new Set() };
  let shadow = prune ? fullPrune(ctx, state) : readShadow(ctx);
  const indexedBytes = new Map();
  let retained = 0;
  refresh(ctx, { onBytes: shadow.initialized ? undefined : (path, bytes) => {
    if (bytes.length <= SHADOW_LIMIT && retained + bytes.length <= BASELINE_BATCH * SHADOW_LIMIT) {
      indexedBytes.set(path, bytes);
      retained += bytes.length;
    }
  } });
  const current = targetRevisions(ctx, { byteSafe: true });
  const nullHashes = new Set([...current].filter(([, hash]) => hash === null).map(([path]) => path));
  state.nullHashes = nullHashes;
  const sorted = (paths) => [...new Set(paths)].map((path) => ({ path, key: filesystemPathKey(ctx, path) }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(({ path }) => path);
  if (!shadow.initialized) {
    if (baseline(ctx, sorted([...current.keys(), ...shadow.entries.keys()]), indexedBytes, nullHashes)) {
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
    const entry = shadowEntry(shadow, path);
    if (hash === null && unchangedStamp(ctx, path, entry)) return false;
    return !current.has(path) || !entry || typeof hash !== 'string'
      || !/^[0-9a-f]{16}$/u.test(hash) || hash !== entry.rev;
  })).flatMap((path) => {
    const rel = reconcileTarget(ctx, path);
    return rel === null ? [] : [rel];
  });
  const seqs = [];
  if (candidates.length) refreshEvents(ctx, state);
  // Bound nested locks even when an entire vault changes; each batch commits its manifest only once.
  const batchSize = 64;
  for (let at = 0; at < candidates.length; at += batchSize) {
    const paths = candidates.slice(at, at + batchSize);
    if (paths.length) seqs.push(...reconcileBatch(ctx, paths, state));
  }
  return { recorded: seqs.length, baseline: false, seqs };
}

export function reconcileBeforeRun(ctx) {
  if (ctx.ephemeral || ctx.mode === 'dry-run') return [];
  try {
    const write = ctx.mode === 'write' ? ctx : { ...ctx, mode: 'write' };
    if (ctx.mode !== 'write') recover(write);
    // Orphan sweeps belong to the server's full scans, not the CLI's write preflight.
    reconcileExternal(write, { prune: false });
    ctx.config = write.config;
    return features(write.config).changeTrail ? [] : ['trail_disabled'];
  } catch (error) {
    if (fs.isPersistentFilesystemError(error)) return ['reconcile_failed'];
    if (fs.isFilesystemError(error) || error.code === 'locked' || error.exit === 6
      || ['EACCES', 'index_unavailable'].includes(error.code)) return ['reconcile_skipped'];
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
  if (!features(ctx.config).changeTrail) {
    warn(ctx, 'trail_disabled');
    return [];
  }
  const cursor = changeSince(since);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new CairnError('validation', 'Invalid --limit. Use an integer from 1 to 200.');
  }
  const path = filterPath(ctx, target);
  const matches = events.filter((event) => (!cursor || (cursor.seq === undefined
    ? Date.parse(event.ts) >= cursor.ts : event.seq > cursor.seq)) && (actor === undefined || event.actor === actor)
    && (target === undefined || event.target === target || event.targets?.some((item) => item.target === target
      || (path !== null && filesystemPathKey(ctx, item.path) === filesystemPathKey(ctx, path))
      || (isNoteKey(target) && entityRef({ type: 'note', id: null, path: item.path }) === target))));
  return (since === undefined ? matches.slice(-limit) : matches.slice(0, limit)).map((event) => ({
    seq: event.seq, ts: event.ts, actor: event.actor, op: event.op,
    ...(event.change === undefined ? {} : { change: event.change }), target: event.target,
    paths: (event.targets ?? []).map(({ path }) => path), rev: validRevision(event.rev) ? event.rev : null,
    ...(event.before === undefined ? {} : { before: validRevision(event.before) ? event.before : null }),
  }));
}

const DIFF_INPUT_BYTES = 256 * 1024;

function readRecord(ctx, rel) {
  let fd, text;
  try {
    fd = openForRead(ctx.root, rel);
    const limit = 2 * 1024 * 1024;
    if (fs.fstatSync(fd).size > limit) return { reason: 'history_too_large' };
    const buffer = Buffer.alloc(limit + 1);
    let length = 0, count;
    while (length < buffer.length && (count = fs.readSync(fd, buffer, length, buffer.length - length, null))) {
      length += count;
    }
    if (length > limit) return { reason: 'history_too_large' };
    text = buffer.toString('utf8', 0, length);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  let saved;
  try { saved = JSON.parse(text); } catch { return null; }
  return saved;
}

function historyItem(ctx, event, path) {
  if (typeof event.tx !== 'string' || !/^[tx]-[0-9a-z]+(?:-[0-9a-z]+)*$/u.test(event.tx)) return null;
  const saved = readRecord(ctx, `.cairn/history/${event.tx}.json`);
  if (saved?.reason === 'history_too_large') return saved;
  if (saved?.tx !== event.tx) return null;
  const items = saved.items ?? [saved];
  return Array.isArray(items) ? items.find((item) => typeof item?.path === 'string'
    && !hasShortAlias(item.path)
    && filesystemPathKey(ctx, item.path) === filesystemPathKey(ctx, path)) ?? null : null;
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
  try { return diffForEvent(ctx, event, events); } catch (error) {
    if (['unsafe_path', 'validation'].includes(error.code) || fs.isFilesystemError(error)) {
      return { diff: null, reason: 'diff_unavailable' };
    }
    throw error;
  }
}

function diffForEvent(ctx, event, events) {
  event = event.tx ? event : events.find(({ seq }) => seq === event.seq);
  if (event?.contentNotKept) return { diff: null, reason: 'content_not_kept' };
  const path = event?.targets?.[0]?.path;
  if (!path || !targetPath(path)) return { diff: null, reason: 'history_pruned' };
  if (!validRevisions(event)) return { diff: null, reason: 'diff_unavailable' };
  const saved = historyItem(ctx, event, path);
  if (!saved) return { diff: null, reason: 'history_pruned' };
  if (saved.reason) return { diff: null, reason: saved.reason };
  if (saved.contentNotKept) return { diff: null, reason: 'content_not_kept' };
  const before = beforeBytes(saved);
  if (before.reason) return { diff: null, reason: before.reason };
  const rev = event.targets[0].rev;
  /** @type {{ bytes?: Buffer, reason?: string }|null} */
  let after = rev === null ? { bytes: Buffer.alloc(0) } : null;
  if (!after && saved.afterTx) {
    const priorWrite = historyItem(ctx, { tx: saved.afterTx }, path);
    if (priorWrite?.reason) return { diff: null, reason: priorWrite.reason };
    const candidate = priorWrite && beforeBytes(priorWrite);
    if (candidate?.bytes && revision(candidate.bytes) === rev) after = candidate;
  }
  const next = events.find((item) => item.seq > event.seq && validRevisions(item)
    && item.targets?.some((target) => filesystemPathKey(ctx, target.path) === filesystemPathKey(ctx, path)));
  const following = next && historyItem(ctx, next, path);
  if (!after && following?.reason) return { diff: null, reason: following.reason };
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
