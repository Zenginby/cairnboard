import { randomBytes } from 'node:crypto';
import * as fs from './fsx.mjs';
import { features, validate, HOME_PROJECTS_MAX } from './config.mjs';
import { normalizeId } from './ids.mjs';
import { resolve as resolveEntity } from './entity.mjs';
import { CairnError } from './errors.mjs';
import { checkedPath, readChecked } from './paths.mjs';
import { withLock } from './lock.mjs';
import { appendEvent, readEvents } from './events.mjs';
import { clearExternalHistory, revision } from './store.mjs';
import { clearShadowBlobs, shadowStats, withShadow } from './shadow.mjs';

const configPath = '.cairn/config.json';
const statePath = '.cairn/settings-state.json';
const configEvent = (event) => ['config.change', 'config.external'].includes(event.op);
const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validActor = (value) => value === null || typeof value === 'string';

function lastChange(item) {
  return item ? { ts: item.ts, actor: item.actor,
    ...(item.feature === undefined ? { changed: item.changed } : { feature: item.feature }), after: item.after } : null;
}

function validChange(item) {
  if (item === null) return true;
  if (!item || !validTime(item.ts) || !validActor(item.actor)) return false;
  const known = (name) => typeof name === 'string' && Object.hasOwn(features({}), name);
  return item.feature !== undefined ? known(item.feature) && typeof item.after === 'boolean'
    : Array.isArray(item.changed) && item.changed.length > 0 && item.after
      && Object.keys(item.after).length === item.changed.length
      && item.changed.every((name) => known(name) && typeof item.after[name] === 'boolean');
}

const validGap = (gap) => gap === null || (gap && typeof gap.tx === 'string' && gap.tx.length > 0
  && validTime(gap.from) && validTime(gap.to) && validActor(gap.actor));

function writeState(ctx, state) {
  fs.writeFileAtomic(checkedPath(ctx.root, statePath), JSON.stringify(state) + '\n');
}

function readState(ctx) {
  const text = readChecked(ctx.root, statePath, 'utf8');
  if (text !== null) {
    try {
      const state = JSON.parse(text);
      if (state?.v === 1 && (state.rev === null
        || (typeof state.rev === 'string' && /^[0-9a-f]{16}$/u.test(state.rev)))
        && Object.keys(state.features).length === 4 && typeof state.trailPending === 'boolean'
        && validChange(state.lastChange) && validGap(state.gapPending) && validGap(state.lastGap)
        && (state.trailOffSince === undefined || state.trailOffSince === null || validTime(state.trailOffSince))) {
        features({ features: state.features });
        return state;
      }
    } catch { /* Rebuild a malformed state from the durable events once. */ }
    ctx.warnings ??= [];
    if (!ctx.warnings.includes('settings_state_rebuilt')) ctx.warnings.push('settings_state_rebuilt');
  }
  const events = readEvents(ctx), last = events.findLast(configEvent);
  const disabled = events.findLast((item) => (item.op === 'config.change'
    && item.feature === 'changeTrail' && item.after === false)
    || (item.op === 'config.external' && item.after?.changeTrail === false));
  const gap = events.findLast((item) => item.op === 'external.gap' && item.seq > (disabled?.seq ?? 0));
  const state = { v: 1, rev: last?.rev ?? null, features: last?.features ?? features({}),
    lastChange: lastChange(last), trailPending: Boolean(disabled), gapPending: null,
    trailOffSince: last?.features?.changeTrail === false ? disabled?.ts ?? null : null,
    lastGap: gap ? { tx: gap.tx, from: gap.from, to: gap.to, actor: gap.actor } : null };
  writeState(ctx, state);
  return state;
}

function snapshot(ctx) {
  const bytes = readChecked(ctx.root, configPath);
  if (bytes === null) throw new CairnError('not_found', 'Configuration not found.');
  let config;
  try { config = JSON.parse(bytes.toString('utf8')); }
  catch { throw new CairnError('validation', 'Invalid configuration.'); }
  return { bytes, config: validate(config), rev: revision(bytes) };
}

function event(ctx, op, extra) {
  const item = { tx: `s-${ctx.clock.now().getTime().toString(36)}-${randomBytes(8).toString('hex')}`,
    ts: ctx.clock.now().toISOString(), actor: ctx.actor, op, target: configPath, rev: null, ...extra };
  appendEvent(ctx, item);
  return item;
}

function recordConfig(ctx, state, item) {
  if (state.features.changeTrail !== item.features.changeTrail) {
    state.trailPending = true;
    state.trailOffSince = item.features.changeTrail ? null : item.ts;
    if (!item.features.changeTrail) { state.lastGap = null; state.gapPending = null; }
  }
  Object.assign(state, { rev: item.rev, features: item.features, lastChange: lastChange(item) });
  writeState(ctx, state);
}

function locked(ctx, fn) {
  // Reads also audit manual edits; the caller's context mode still governs its other operations.
  const write = ctx.mode === 'write' ? ctx : { ...ctx, mode: 'write' };
  return withLock(write, '_config', () => {
    const disk = snapshot(write);
    write.config = disk.config;
    const result = fn(write, disk, readState(write));
    ctx.config = write.config;
    return result;
  });
}

function syncTrail(ctx, state) {
  if (!state.trailPending) return;
  return withShadow(ctx, (record, shadow) => {
    if (!state.features.changeTrail) {
      if (shadow.disabledSince === undefined) {
        shadow.disabledSince = state.trailOffSince ?? state.lastChange?.ts ?? ctx.clock.now().toISOString();
        record([]);
      }
    } else {
      const from = shadow.disabledSince ?? state.gapPending?.from;
      if (from !== undefined) {
        if (state.lastGap?.from !== from) {
          state.gapPending ??= { tx: `s-gap-${randomBytes(16).toString('hex')}`, from,
            to: ctx.clock.now().toISOString(), actor: ctx.actor };
          writeState(ctx, state);
          // Persist the transaction before appending so recovery uses appendEvent's bounded-tail deduplication.
          const gap = state.gapPending;
          event(ctx, 'external.gap', { ...gap, ts: gap.to });
          state.lastGap = gap;
          state.gapPending = null;
          writeState(ctx, state);
        }
        shadow.initialized = false;
        delete shadow.disabledSince;
        record([]);
      }
    }
    state.trailPending = false;
    writeState(ctx, state);
  }, { configLocked: true });
}

function syncPendingTrail(ctx, state, ignoreError) {
  if (!ignoreError) return syncTrail(ctx, state);
  try { syncTrail(ctx, state); } catch { /* Retry on subsequent read or checkConfigDrift. */ }
}

function drift(ctx, disk, state, { ignoreTrailError = false, skipSync = false } = {}) {
  if (!skipSync) syncPendingTrail(ctx, state, ignoreTrailError);
  if (state.rev === disk.rev) return false;
  const current = features(disk.config);
  const changed = Object.keys(current).filter((name) => state.features[name] !== current[name]);
  if (changed.length) {
    recordConfig(ctx, state, event(ctx, 'config.external', { actor: 'owner:external', rev: disk.rev, changed,
      after: Object.fromEntries(changed.map((name) => [name, current[name]])), features: current }));
    if (!skipSync) syncPendingTrail(ctx, state, ignoreTrailError);
  } else {
    state.rev = disk.rev;
    writeState(ctx, state);
  }
  return changed.length > 0;
}

export function checkConfigDrift(ctx) {
  return locked(ctx, (write, disk, state) => drift(write, disk, state));
}

/** @param {*} ctx @param {{ stats?: boolean }} [options] `stats: false` skips the shadow lock and manifest read. */
export function readSettings(ctx, { stats = true } = {}) {
  return locked(ctx, (write, disk, state) => {
    drift(write, disk, state, { ignoreTrailError: true, skipSync: !stats });
    const last = state.lastChange;
    return { features: features(disk.config), revision: disk.rev,
      shadow: stats ? withLock(write, '_shadow', () => shadowStats(write)) : null,
      trailOffSince: state.features.changeTrail ? null : state.trailOffSince ?? null,
      lastChange: last ? { ts: last.ts, actor: last.actor,
        feature: last.feature ?? last.changed, after: last.after } : null };
  });
}

/** @param {*} ctx
 * @param {{ name: string, value: boolean, expectedRevision: string, actor?: string }} options */
export function setFeature(ctx, { name, value, expectedRevision, actor = ctx.actor }) {
  if (!Object.hasOwn(features({}), name) || typeof value !== 'boolean') {
    throw new CairnError('validation', 'Invalid feature name or value.');
  }
  return withLock(ctx, '_config', () => {
    const disk = snapshot(ctx);
    if (disk.rev !== expectedRevision) throw new CairnError('conflict', 'Configuration changed since it was read.');
    ctx.config = disk.config;
    const state = readState(ctx);
    drift(ctx, disk, state, { ignoreTrailError: true });
    const before = features(disk.config)[name];
    if (before === value) {
      if (state.trailPending && ctx.warnings && !ctx.warnings.includes('trail_sync_pending')) {
        ctx.warnings.push('trail_sync_pending');
      }
      return { changed: false, revision: disk.rev,
        ...(state.trailPending ? { warnings: ['trail_sync_pending'] } : {}) };
    }
    const config = validate({ ...disk.config, features: { ...disk.config.features, [name]: value } });
    const bytes = JSON.stringify(config, null, 2) + '\n';
    fs.writeFileAtomic(checkedPath(ctx.root, configPath), bytes, () => {
      if (!readChecked(ctx.root, configPath)?.equals(disk.bytes)) {
        throw new CairnError('conflict', 'Configuration changed during the write.');
      }
    });
    ctx.config = config;
    const rev = revision(bytes);
    recordConfig(ctx, state, event(ctx, 'config.change',
      { actor, feature: name, before, after: value, rev, features: features(config) }));
    try {
      syncTrail(ctx, state);
    } catch {
      if (ctx.warnings && !ctx.warnings.includes('trail_sync_pending')) ctx.warnings.push('trail_sync_pending');
      return { changed: true, revision: rev, warnings: ['trail_sync_pending'] };
    }
    return { changed: true, revision: rev };
  });
}

export function clearShadow(ctx, { actor = ctx.actor } = {}) {
  return withLock(ctx, '_config', () => {
    const disk = snapshot(ctx);
    ctx.config = disk.config;
    drift(ctx, disk, readState(ctx), { ignoreTrailError: true });
    return withLock(ctx, '_shadow', () => {
      const { blobs, bytes, manifestReset } = clearShadowBlobs(ctx);
      const historyCleared = clearExternalHistory(ctx);
      event(ctx, 'shadow.clear', { actor, blobs, bytes, historyCleared,
        ...(manifestReset ? { manifestReset: true } : {}) });
      return { blobs, bytes };
    });
  });
}

/**
 * Records which listed projects the owner's web Home shows. `listed` are the projects the picker offered, `shown` the
 * ticked ones (a subset); the rest of `listed` is hidden. Hidden ids the picker did not list (a paused or missing
 * project) stay hidden, and projects never listed (new ones) show, so `home.hiddenProjects` is all that is stored.
 * @param {*} ctx @param {{ listed: string[], shown: string[], expectedRevision: string, actor?: string }} options
 */
export function setHomeProjects(ctx, { listed, shown, expectedRevision, actor = ctx.actor }) {
  const ids = (list) => Array.isArray(list) && list.length <= HOME_PROJECTS_MAX
    && list.every((id) => normalizeId(id) !== null) ? [...new Set(list.map(normalizeId))] : null;
  const offered = ids(listed), ticked = ids(shown);
  if (!offered || !ticked || ticked.some((id) => !offered.includes(id))) {
    throw new CairnError('validation', 'Invalid project list.');
  }
  return withLock(ctx, '_config', () => {
    const disk = snapshot(ctx);
    if (disk.rev !== expectedRevision) throw new CairnError('conflict', 'Configuration changed since it was read.');
    ctx.config = disk.config;
    const state = readState(ctx);
    drift(ctx, disk, state, { ignoreTrailError: true });
    const home = disk.config.home && typeof disk.config.home === 'object' && !Array.isArray(disk.config.home)
      ? disk.config.home : {};
    const before = home.hiddenProjects ?? [];
    // Earlier hidden ids keep their order unless now ticked; newly hidden ones go last, so a resend is no change.
    // Ids that are not valid ids or name no project any more (a deleted one) are dropped, so the list cannot fill up.
    const exists = (id) => {
      try { resolveEntity(ctx, 'project', id); return true; } catch { return false; }
    };
    const kept = before.map(normalizeId)
      .filter((id) => id !== null && !ticked.includes(id) && (offered.includes(id) || exists(id)));
    const keptIds = new Set(kept);
    const hidden = [...new Set([...kept, ...offered.filter((id) => !ticked.includes(id) && !keptIds.has(id))])];
    if (JSON.stringify(before) === JSON.stringify(hidden)) return { changed: false, revision: disk.rev };
    if (hidden.length > HOME_PROJECTS_MAX) throw new CairnError('validation', 'Too many hidden projects.');
    const config = validate({ ...disk.config, home: { ...home, hiddenProjects: hidden } });
    const bytes = JSON.stringify(config, null, 2) + '\n';
    fs.writeFileAtomic(checkedPath(ctx.root, configPath), bytes, () => {
      if (!readChecked(ctx.root, configPath)?.equals(disk.bytes)) {
        throw new CairnError('conflict', 'Configuration changed during the write.');
      }
    });
    ctx.config = config;
    const rev = revision(bytes);
    // Not a feature change: the settings state only learns the new revision, so it is not seen as a hand edit.
    // The event stays small: hidden ids are at most 200 of 64 characters, the earlier list only as a count.
    event(ctx, 'config.home', { actor, hiddenBefore: before.length, hidden, rev });
    state.rev = rev;
    writeState(ctx, state);
    return { changed: true, revision: rev };
  });
}
