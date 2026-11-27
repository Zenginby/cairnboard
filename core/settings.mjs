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
import { foldTr, oneLine, stripHidden } from './text.mjs';

export const LANGUAGES = Object.freeze(['tr', 'en']);
/** Limits the guarded writer enforces; `validate` stays looser, so a hand-written file still loads. */
export const CONFIG_LIMITS = Object.freeze({ labelMax: 40, leaseMin: 5, leaseMax: 1440 });
const configPath = '.cairn/config.json';
const statePath = '.cairn/settings-state.json';
const configEvent = (event) => ['config.change', 'config.external'].includes(event.op);
const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validActor = (value) => value === null || typeof value === 'string';
const digestPattern = /^[0-9a-f]{16}$/u;
const plain = (value) => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
// The audited field names, sorted: events, the pending record and the stored digests all use exactly these.
const FIELD_NAMES = Object.freeze(['columns.hidden', 'columns.label', 'columns.order', 'home.hiddenProjects',
  'language', 'leaseMinutes']);
const ROLES = ['todo', 'doing', 'done'];

/** A 16-digit digest per audited field name; values never leave this module, only the names of changed fields do. */
function digests(config) {
  const { columns, home } = config;
  const views = {
    'columns.hidden': columns.filter((column) => column.hidden === true).map((column) => column.key).sort(),
    'columns.label': columns.map((column) => [column.key, column.label]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
    'columns.order': columns.map((column) => column.key),
    'home.hiddenProjects': home && typeof home === 'object' && !Array.isArray(home) ? home.hiddenProjects ?? [] : [],
    language: config.language,
    leaseMinutes: config.leaseMinutes,
  };
  return Object.fromEntries(FIELD_NAMES.map((name) => [name, revision(JSON.stringify(views[name]))]));
}

const validDigests = (value) => plain(value) && Object.values(value)
  .every((digest) => typeof digest === 'string' && digestPattern.test(digest));

const validPending = (item) => item === undefined || item === null || (plain(item)
  && typeof item.tx === 'string' && item.tx.length > 0 && validTime(item.ts) && validActor(item.actor)
  && Array.isArray(item.fields) && item.fields.length > 0
  && item.fields.every((name) => typeof name === 'string' && name.length > 0)
  && typeof item.rev === 'string' && digestPattern.test(item.rev) && validDigests(item.digests));

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
        && (state.trailOffSince === undefined || state.trailOffSince === null || validTime(state.trailOffSince))
        && (state.fields === undefined || validDigests(state.fields)) && validPending(state.pending)) {
        features({ features: state.features });
        return state;
      }
    } catch { /* Rebuild a malformed state from the durable events once. */ }
    ctx.warnings ??= [];
    if (!ctx.warnings.includes('settings_state_rebuilt')) ctx.warnings.push('settings_state_rebuilt');
  }
  // `rev` and `features` come from the last configuration event of any shape; `lastChange` only from one that names
  // a feature. Field digests cannot be rebuilt from events (they carry no values): `drift` baselines them from disk.
  const events = readEvents(ctx), last = events.findLast(configEvent);
  // The revision also follows the retired `config.language` and `config.home` events, so a folder written by an
  // earlier version still proves which file content was last recorded.
  const lastRevision = events.findLast((item) => configEvent(item)
    || ['config.language', 'config.home'].includes(item.op));
  const lastFeature = events.findLast((item) => (item.op === 'config.change' && item.feature !== undefined)
    || (item.op === 'config.external' && Array.isArray(item.changed) && item.changed.length > 0));
  const disabled = events.findLast((item) => (item.op === 'config.change'
    && item.feature === 'changeTrail' && item.after === false)
    || (item.op === 'config.external' && item.after?.changeTrail === false));
  const gap = events.findLast((item) => item.op === 'external.gap' && item.seq > (disabled?.seq ?? 0));
  const state = { v: 1, rev: lastRevision?.rev ?? null, features: last?.features ?? features({}),
    lastChange: lastChange(lastFeature), trailPending: Boolean(disabled), gapPending: null,
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

/** Finishes or drops the intent record of a `setConfig` write that did not reach its last step. */
function recoverPending(ctx, disk, state) {
  const { pending } = state;
  if (!pending) return;
  const now = digests(disk.config);
  // The write is on disk when the file is exactly the one it produced, or when each field it changed still holds the
  // value it wrote (a hand edit of other fields may have followed). A write that never landed holds the old values.
  const landed = disk.rev === pending.rev || pending.fields.every((name) => now[name] === pending.digests[name]);
  if (landed) {
    // `appendEvent` only deduplicates within the newest 64 KB, so this rare path looks through the whole log.
    if (!readEvents(ctx).some((item) => item.tx === pending.tx)) {
      event(ctx, 'config.change', { tx: pending.tx, ts: pending.ts, actor: pending.actor, rev: pending.rev,
        fields: pending.fields, features: state.features });
    }
    if (disk.rev === pending.rev) state.rev = pending.rev;
    // Only the written fields move on; anything else that differs is reported by the comparison in `drift`.
    state.fields = { ...state.fields,
      ...Object.fromEntries(pending.fields.map((name) => [name, pending.digests[name]])) };
  }
  delete state.pending;
  writeState(ctx, state);
}

function drift(ctx, disk, state, { ignoreTrailError = false, skipSync = false } = {}) {
  recoverPending(ctx, disk, state);
  const now = digests(disk.config);
  // A field name with no stored digest (a state written before this field was audited) is baselined silently.
  // That is only safe while the file is provably the one last recorded (`state.rev` is the revision of the last
  // configuration event, or the stored one) or no configuration event exists yet. Otherwise a hand edit or an
  // interrupted write may hide in the gap, and the event below names every field as possibly changed.
  const missing = FIELD_NAMES.filter((name) => state.fields?.[name] === undefined);
  const unknown = missing.length > 0 && state.rev !== null && state.rev !== disk.rev;
  if (missing.length) {
    state.fields = { ...state.fields, ...Object.fromEntries(missing.map((name) => [name, now[name]])) };
    if (!unknown) writeState(ctx, state);
  }
  if (!skipSync) syncPendingTrail(ctx, state, ignoreTrailError);
  if (state.rev === disk.rev) return false;
  const current = features(disk.config);
  const changed = Object.keys(current).filter((name) => state.features[name] !== current[name]);
  const fields = unknown ? [...FIELD_NAMES] : FIELD_NAMES.filter((name) => state.fields[name] !== now[name]);
  if (!changed.length && !fields.length) {
    state.rev = disk.rev;
    writeState(ctx, state);
    return false;
  }
  // One event for the whole hand edit: feature values as before, other fields by name only.
  const item = event(ctx, 'config.external', { actor: 'owner:external', rev: disk.rev,
    ...(changed.length ? { changed, after: Object.fromEntries(changed.map((name) => [name, current[name]])) } : {}),
    ...(fields.length ? { fields } : {}), ...(unknown ? { unknown: true } : {}), features: current });
  state.fields = { ...state.fields, ...now };
  if (changed.length) {
    recordConfig(ctx, state, item);
    if (!skipSync) syncPendingTrail(ctx, state, ignoreTrailError);
  } else {
    // `lastChange` keeps describing the last feature change.
    state.rev = disk.rev;
    writeState(ctx, state);
  }
  return true;
}

export function checkConfigDrift(ctx) {
  return locked(ctx, (write, disk, state) => drift(write, disk, state));
}

/** @param {*} ctx @param {{ stats?: boolean }} [options] `stats: false` skips the shadow lock and manifest read. */
export function readSettings(ctx, { stats = true } = {}) {
  return locked(ctx, (write, disk, state) => {
    drift(write, disk, state, { ignoreTrailError: true, skipSync: !stats });
    const last = state.lastChange;
    return { features: features(disk.config), language: disk.config.language,
      leaseMinutes: disk.config.leaseMinutes,
      columns: disk.config.columns
        .map(({ key, label, role, hidden }) => ({ key, label, role, hidden: hidden === true })),
      revision: disk.rev,
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

const refuse = (field, reason) => new CairnError('validation', `Invalid setting: ${field}`,
  reason ? { field, reason } : { field });

function parseColumns(input) {
  const bad = () => refuse('columns');
  // Every value is read once into a snapshot, which is then validated and used; getters cannot change it afterwards.
  const own = (value) => {
    if (!plain(value) || Reflect.ownKeys(value).some((name) => typeof name !== 'string')) throw bad();
    return Object.entries(value);
  };
  const top = new Map(own(input));
  if (!top.size || [...top.keys()].some((name) => !['labels', 'hidden', 'order', 'move'].includes(name))
    || (top.has('order') && top.has('move'))) throw bad();
  const pairs = (map, type) => {
    const entries = own(map);
    if (entries.some(([, value]) => typeof value !== type)) throw bad();
    return entries;
  };
  const value = {};
  if (top.has('labels')) value.labels = pairs(top.get('labels'), 'string');
  if (top.has('hidden')) value.hidden = pairs(top.get('hidden'), 'boolean');
  if (top.has('order')) {
    const order = top.get('order');
    if (!Array.isArray(order)) throw bad();
    value.order = [...order];
    if (value.order.some((key) => typeof key !== 'string')) throw bad();
  }
  if (top.has('move')) {
    const move = new Map(own(top.get('move')));
    const key = move.get('key'), by = move.get('by');
    if (move.size !== 2 || typeof key !== 'string' || ![-1, 1].includes(by)) throw bad();
    value.move = { key, by };
  }
  return value;
}

// Keys and roles never change here; each column object is copied by spread, so unknown properties and their order stay.
function applyColumns(config, { labels = [], hidden = [], order, move }) {
  let columns = config.columns.map((column) => ({ ...column }));
  const at = (key, field) => {
    const index = columns.findIndex((column) => column.key === key);
    if (index < 0) throw refuse(field, 'column_unknown');
    return index;
  };
  const renamed = [];
  for (const [key, input] of labels) {
    const index = at(key, 'columns.label');
    const raw = input.normalize('NFC'), label = raw.trim();
    // Rules bind only a label that really changes: an older label that breaks them does not block other writes.
    if (label === columns[index].label) continue;
    if (!label) throw refuse('columns.label', 'label_empty');
    // Checked before trimming, so a hidden or line-breaking character is refused rather than silently dropped.
    if (stripHidden(raw).removed > 0 || oneLine(raw) !== raw) throw refuse('columns.label', 'label_chars');
    if ([...label].length > CONFIG_LIMITS.labelMax) throw refuse('columns.label', 'label_long');
    columns[index].label = label;
    renamed.push(index);
  }
  for (const index of renamed) {
    const folded = foldTr(columns[index].label);
    if (columns.some((column, other) => other !== index && foldTr(column.label) === folded)) {
      throw refuse('columns.label', 'label_duplicate');
    }
  }
  for (const [key, value] of hidden) {
    const index = at(key, 'columns.hidden');
    if (value) columns[index].hidden = true;
    else delete columns[index].hidden;
  }
  if (order) {
    if (order.length !== columns.length || new Set(order).size !== order.length
      || order.some((key) => !columns.some((column) => column.key === key))) {
      throw refuse('columns.order', 'order_mismatch');
    }
    columns = order.map((key) => columns.find((column) => column.key === key));
  }
  if (move) {
    const index = at(move.key, 'columns.order'), target = index + move.by;
    if (target < 0 || target >= columns.length) throw refuse('columns.order', 'move_edge');
    [columns[index], columns[target]] = [columns[target], columns[index]];
  }
  return { ...config, columns };
}

function parseHomeProjects(input) {
  const invalid = () => new CairnError('validation', 'Invalid project list.', { field: 'home.hiddenProjects' });
  if (!plain(input) || Reflect.ownKeys(input).some((name) => !['listed', 'shown'].includes(/** @type {*} */ (name)))) {
    throw invalid();
  }
  const ids = (list) => Array.isArray(list) && list.length <= HOME_PROJECTS_MAX
    && list.every((id) => normalizeId(id) !== null) ? [...new Set(list.map(normalizeId))] : null;
  const offered = ids(input.listed), ticked = ids(input.shown);
  if (!offered || !ticked || ticked.some((id) => !offered.includes(id))) throw invalid();
  return { offered, ticked };
}

// `offered` are the projects the picker listed, `ticked` the shown ones; the rest of `offered` is hidden. Hidden ids
// the picker did not list stay hidden and projects never listed show, so `home.hiddenProjects` is all that is stored.
function applyHomeProjects(ctx, config, { offered, ticked }) {
  const home = config.home && typeof config.home === 'object' && !Array.isArray(config.home) ? config.home : {};
  const before = home.hiddenProjects ?? [];
  // Earlier hidden ids keep their order unless now ticked; newly hidden ones go last, so a resend is no change.
  // Ids that are not valid ids or name no project any more (a deleted one) are dropped, so the list cannot fill up.
  // A preview has no context to look projects up with and keeps every valid id.
  const exists = (id) => {
    if (!ctx) return true;
    try { resolveEntity(ctx, 'project', id); return true; } catch { return false; }
  };
  const kept = before.map(normalizeId)
    .filter((id) => id !== null && !ticked.includes(id) && (offered.includes(id) || exists(id)));
  const keptIds = new Set(kept);
  const hidden = [...new Set([...kept, ...offered.filter((id) => !ticked.includes(id) && !keptIds.has(id))])];
  if (JSON.stringify(before) === JSON.stringify(hidden)) return config;
  if (hidden.length > HOME_PROJECTS_MAX) {
    throw new CairnError('validation', 'Too many hidden projects.', { field: 'home.hiddenProjects' });
  }
  return { ...config, home: { ...home, hiddenProjects: hidden } };
}

// The only fields `setConfig` writes. `parse` is pure and runs outside the lock; `apply` runs under it and returns a
// new configuration without touching its input.
const FIELDS = Object.freeze({
  language: Object.freeze({
    parse(input) {
      if (!LANGUAGES.includes(input)) {
        throw new CairnError('validation', 'Invalid language. Use tr or en.', { field: 'language' });
      }
      return input;
    },
    apply: (ctx, config, language) => ({ ...config, language }),
  }),
  leaseMinutes: Object.freeze({
    parse(input) {
      if (!Number.isInteger(input) || input < CONFIG_LIMITS.leaseMin || input > CONFIG_LIMITS.leaseMax) {
        throw refuse('leaseMinutes', 'lease_range');
      }
      return input;
    },
    apply: (ctx, config, leaseMinutes) => ({ ...config, leaseMinutes }),
  }),
  columns: Object.freeze({ parse: parseColumns, apply: (ctx, config, value) => applyColumns(config, value) }),
  homeProjects: Object.freeze({ parse: parseHomeProjects, apply: applyHomeProjects }),
});

function parseChanges(changes) {
  if (!plain(changes)) throw refuse('changes');
  const names = Reflect.ownKeys(changes);
  if (!names.length || names.some((name) => !Object.hasOwn(FIELDS, name))) throw refuse('changes');
  return Object.keys(FIELDS).filter((name) => Object.hasOwn(changes, name))
    .map((name) => [name, FIELDS[name].parse(changes[name])]);
}

function applyChanges(ctx, config, parsed) {
  let next = config;
  for (const [name, value] of parsed) next = FIELDS[name].apply(ctx, next, value);
  const before = digests(config), after = digests(next);
  const fields = FIELD_NAMES.filter((name) => before[name] !== after[name]);
  const visibility = ['columns.hidden', 'columns.order'].find((name) => fields.includes(name));
  // A write that changes visibility or order must leave the first column of every role visible: new, claimed and
  // finished cards then never land in the archive. Other writes pass, so a hand-written breach blocks nothing else.
  if (visibility && ROLES.some((role) => next.columns.find((column) => column.role === role)?.hidden === true)) {
    throw refuse(visibility, 'role_first_hidden');
  }
  return { config: next, fields };
}

/**
 * What a `setConfig` call with these changes would store, without a lock or a file read: the next configuration and
 * the sorted names of the fields that differ. Throws the same `validation` errors as the writer. With no context it
 * cannot look projects up, so a `homeProjects` preview keeps hidden ids the writer would drop as deleted.
 * @param {*} config @param {*} changes @returns {{ config: *, fields: string[] }}
 */
export function previewConfig(config, changes) {
  return applyChanges(null, config, parseChanges(changes));
}

/**
 * The one guarded writer for `language`, `leaseMinutes`, `columns` (labels, hidden flags, order) and `homeProjects`.
 * The event names the changed fields and never carries a value. An intent record is stored before the file is
 * replaced, so a write whose event could not be appended is completed by the next locked read or write.
 * @param {*} ctx @param {{ changes: *, expectedRevision: string, actor?: string }} options
 * @returns {{ changed: boolean, revision: string, fields: string[] }}
 */
export function setConfig(ctx, { changes, expectedRevision, actor = ctx.actor }) {
  const parsed = parseChanges(changes);
  return withLock(ctx, '_config', () => {
    const disk = snapshot(ctx);
    if (disk.rev !== expectedRevision) throw new CairnError('conflict', 'Configuration changed since it was read.');
    ctx.config = disk.config;
    const state = readState(ctx);
    drift(ctx, disk, state, { ignoreTrailError: true });
    const planned = applyChanges(ctx, disk.config, parsed);
    if (!planned.fields.length) return { changed: false, revision: disk.rev, fields: [] };
    const config = validate(planned.config);
    const bytes = JSON.stringify(config, null, 2) + '\n';
    const rev = revision(bytes), next = digests(config);
    const pending = { tx: `s-${ctx.clock.now().getTime().toString(36)}-${randomBytes(8).toString('hex')}`,
      ts: ctx.clock.now().toISOString(), actor, fields: planned.fields, rev, digests: next };
    state.pending = pending;
    writeState(ctx, state);
    try {
      fs.writeFileAtomic(checkedPath(ctx.root, configPath), bytes, () => {
        if (!readChecked(ctx.root, configPath)?.equals(disk.bytes)) {
          throw new CairnError('conflict', 'Configuration changed during the write.');
        }
      });
    } catch (error) {
      if (error.code === 'conflict') {
        delete state.pending;
        writeState(ctx, state);
      }
      throw error;
    }
    ctx.config = config;
    event(ctx, 'config.change', { tx: pending.tx, ts: pending.ts, actor, rev, fields: planned.fields,
      features: features(config) });
    // Not a feature change: `lastChange` keeps describing the last feature change.
    state.rev = rev;
    state.fields = { ...state.fields, ...next };
    delete state.pending;
    writeState(ctx, state);
    return { changed: true, revision: rev, fields: planned.fields };
  });
}

/**
 * Records which listed projects the owner's web Home shows. `listed` are the projects the picker offered, `shown` the
 * ticked ones (a subset); the rest of `listed` is hidden. A thin wrapper over `setConfig`.
 * @param {*} ctx @param {{ listed: string[], shown: string[], expectedRevision: string, actor?: string }} options
 */
export function setHomeProjects(ctx, { listed, shown, expectedRevision, actor = ctx.actor }) {
  const { changed, revision: rev } = setConfig(ctx, { changes: { homeProjects: { listed, shown } },
    expectedRevision, actor });
  return { changed, revision: rev };
}

/**
 * Sets the data folder's `language`. It is not interface-only: journal labels, the Turkish write rules and the wiki
 * sort order read it too. A thin wrapper over `setConfig`.
 * @param {*} ctx @param {{ language: string, expectedRevision: string, actor?: string }} options
 */
export function setLanguage(ctx, { language, expectedRevision, actor = ctx.actor }) {
  const { changed, revision: rev } = setConfig(ctx, { changes: { language }, expectedRevision, actor });
  return { changed, revision: rev };
}
