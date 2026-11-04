import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import * as fs from './fsx.mjs';
import { CairnError } from './errors.mjs';
import { checkedPath, readChecked, safeRelative } from './paths.mjs';
import { lockName, withLock } from './lock.mjs';
import { appendEvent, readEvents } from './events.mjs';
import { pathKey } from './text.mjs';
import { isRawPath, resolveSchema } from './schema.mjs';
import { move } from './trash.mjs';

/** @typedef {{ ifRevision?: string, dryRun?: boolean }} MutationOptions */
/** @typedef {{ path: string, revision: string|null, seq: number|null, dryRun: boolean, warnings: string[] }} MutationResult */

const invalid = (message) => new CairnError('validation', message);
const pendingPath = (tx) => `.cairn/pending/${safeRelative(tx)}.json`;
const historyPath = (tx, pending = false) => `.cairn/history/${safeRelative(tx)}${pending ? '.pending' : ''}.json`;
const rev = (bytes) => bytes === null ? null : revision(bytes);
const json = (ctx, rel) => {
  const text = readChecked(ctx.root, rel, 'utf8');
  return text === null ? null : JSON.parse(text);
};

export function revision(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function readFile(ctx, rel) {
  const bytes = readChecked(ctx.root, rel);
  return bytes === null ? null : { text: bytes.toString('utf8'), revision: revision(bytes) };
}

function conflict(current) {
  return new CairnError('conflict', 'File changed since it was read.', { current: { revision: current } });
}

function remove(ctx, rel) {
  try {
    fs.unlinkSync(checkedPath(ctx.root, rel));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function syncDir(ctx, rel) {
  fs.syncDirectory(rel === '.' ? ctx.root : checkedPath(ctx.root, rel));
}

function mkdir(ctx, rel) {
  let parent = '.';
  // Logical paths use `/`; the platform separator is accepted too.
  for (const part of rel.split(/[\\/]/u)) {
    if (part === '.') continue;
    const child = parent === '.' ? part : join(parent, part);
    try {
      fs.mkdirSync(checkedPath(ctx.root, child), { mode: 0o700 });
      // A new directory entry is durable only once its parent is synced.
      syncDir(ctx, parent);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    parent = child;
  }
}

function save(ctx, rel, data) {
  fs.writeFileAtomic(checkedPath(ctx.root, rel), JSON.stringify(data));
}

function locks(ctx, items, fn) {
  const paths = [...items].sort((a, b) => pathKey(a.path) < pathKey(b.path) ? -1 : pathKey(a.path) > pathKey(b.path) ? 1 : 0);
  const next = (index) => index === paths.length ? fn() : withLock(ctx, lockName(paths[index].path), () => next(index + 1));
  return next(0);
}

function tempPath(path, tx) {
  return join(dirname(path), `.${basename(path)}.${tx}.tmp`);
}

function createTemp(ctx, rel, bytes) {
  const fd = fs.openSync(checkedPath(ctx.root, rel), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // No directory flush here: the flush after the rename makes the final name durable, and a lost temp is rolled back.
}

function cas(ctx, item, expected = item.before) {
  const current = rev(readChecked(ctx.root, item.path));
  if (current !== expected) throw conflict(current);
}

function retry(action, check) {
  for (let attempt = 0; ; attempt++) {
    check();
    try {
      return action();
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === 9) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(200, 10 * (attempt + 1) ** 2));
    }
  }
}

const TX = /^t-[0-9a-z]+(?:-\d+)?$/u;
const isTrashPair = (trash) => trash && typeof trash.payload === 'string' && /^\.cairn\/trash\/[^/\\]+$/u.test(trash.payload)
  && trash.sidecar === `${trash.payload}.json`;

// Paths in results, intents and events always use `/`, whatever the platform separator.
const logical = (rel) => safeRelative(rel).replace(/\\/gu, '/');

function targetPath(path) {
  const rel = typeof path === 'string' ? logical(path) : null;
  if (!rel || pathKey(rel).split('/')[0] === '.cairn') throw invalid('Invalid transaction target.');
  return rel;
}

// Intents and history live in the data folder and are untrusted: every path they name must be the one this module
// would have derived, so recovery and undo never delete or overwrite anything else.
function checkIntent(intent) {
  if (!intent || typeof intent !== 'object' || typeof intent.tx !== 'string' || !TX.test(intent.tx)
    || !Array.isArray(intent.items) || !intent.items.length) throw invalid('Invalid pending transaction.');
  for (const [index, item] of intent.items.entries()) {
    const path = targetPath(item.path);
    if (item.temp !== undefined && item.temp !== tempPath(path, intent.tx)) throw invalid('Invalid pending transaction.');
    if (item.trash !== undefined) {
      const trashTx = intent.items.length === 1 ? intent.tx : `${intent.tx}-${index}`;
      if (item.trashTx !== undefined && item.trashTx !== trashTx) throw invalid('Invalid pending transaction.');
      if (!isTrashPair(item.trash) || item.trash.payload !== `.cairn/trash/${trashTx}-${basename(path)}`) {
        throw invalid('Invalid pending transaction.');
      }
    }
  }
  if (intent.undo !== undefined && !TX.test(intent.undo?.historyTx ?? '')) throw invalid('Invalid pending transaction.');
  if (intent.cleanup !== undefined && (!Array.isArray(intent.cleanup) || !intent.cleanup.every(isTrashPair))) {
    throw invalid('Invalid pending transaction.');
  }
  return intent;
}

function eventFor(intent, external = false) {
  return { ...intent.extra, tx: external ? `${intent.tx}-external` : intent.tx, op: external ? 'external.change' : intent.op,
    target: intent.target, rev: intent.after, targets: intent.items.map(({ path, target, after }) => ({ path, target, rev: after })),
    actor: external ? 'system:recovery' : intent.actor, ts: intent.ts };
}

function recordEvent(ctx, intent, external = false, recovering = true) {
  const event = eventFor(intent, external);
  // A pending transaction may outlive the bounded tail used by appendEvent's fast deduplication; a fresh one cannot.
  if (!recovering) return appendEvent(ctx, event);
  return readEvents(ctx).find(({ tx }) => tx === event.tx)?.seq ?? appendEvent(ctx, event);
}

function validateEvent(event) {
  const reserved = ['v', 'seq', 'tx', 'op', 'target', 'targets', 'rev', 'actor', 'ts'];
  if (!event.op || typeof event.op !== 'string' || typeof event.target !== 'string' || !event.target
    || (event.actor !== null && typeof event.actor !== 'string')
    || !Number.isFinite(Date.parse(event.ts)) || Number(event.ts.slice(0, 4)) < 2000 || Number(event.ts.slice(0, 4)) > 2100) {
    throw invalid('Invalid transaction event.');
  }
  const line = JSON.stringify({ v: 1, seq: Number.MAX_SAFE_INTEGER, ...event }, (key, value) => {
    if (['title', 'body', 'text', 'content'].includes(key)) throw invalid('Event content keys are forbidden.');
    return value;
  });
  if (Buffer.byteLength(line + '\n') > 16 * 1024) throw invalid('Event exceeds 16 KB.');
  return reserved;
}

function pendingHistory(intent, index) {
  return historyPath(intent.items.length === 1 ? intent.tx : `${intent.tx}-${index}`, true);
}

function historyItem(ctx, intent, index) {
  const pending = json(ctx, pendingHistory(intent, index));
  if (pending) return pending.items?.[index] ?? pending;
  const committed = json(ctx, historyPath(intent.tx));
  return committed?.items?.[index] ?? (index === 0 ? committed : null);
}

function finishHistory(ctx, intent) {
  if (intent.undo || readChecked(ctx.root, historyPath(intent.tx)) !== null) return;
  // Without every pre-image the transaction still completes; it just cannot be undone.
  const items = intent.items.map((_, index) => historyItem(ctx, intent, index));
  if (items.some((item) => !item)) return;
  if (intent.items.length === 1) {
    fs.rename(checkedPath(ctx.root, pendingHistory(intent, 0)), checkedPath(ctx.root, historyPath(intent.tx)));
  } else {
    save(ctx, historyPath(intent.tx), { tx: intent.tx, op: intent.op, ...items[0], items });
  }
  syncDir(ctx, '.cairn/history');
}

function pruneHistory(ctx) {
  const names = new Set(fs.readdirSync(checkedPath(ctx.root, '.cairn/history')));
  // An intent still pending (another process crashed after its event) needs its history to complete.
  for (const name of fs.readdirSync(checkedPath(ctx.root, '.cairn/pending'))) names.delete(name);
  const committed = readEvents(ctx).map(({ tx }) => tx).filter((tx) => names.has(`${tx}.json`));
  for (const tx of committed.slice(0, -50)) remove(ctx, historyPath(tx));
}

function cleanup(ctx, intent, completed) {
  for (const item of intent.items) {
    if (item.temp) remove(ctx, item.temp);
    if (!completed && item.trash && readChecked(ctx.root, item.trash.payload) === null) remove(ctx, item.trash.sidecar);
  }
  for (const index of intent.items.keys()) remove(ctx, pendingHistory(intent, index));
  if (completed) {
    for (const trash of intent.cleanup ?? []) {
      remove(ctx, trash.payload);
      remove(ctx, trash.sidecar);
    }
    if (intent.undo) remove(ctx, historyPath(intent.undo.historyTx));
  }
  // A lost history deletion only leaves a file for pruning; a lost trash deletion would bring a restored item back
  // into the trash list, and a returning intent would replay a finished rollback over later changes.
  if (intent.cleanup?.length || intent.items.some((item) => item.trash)) syncDir(ctx, '.cairn/trash');
  remove(ctx, pendingPath(intent.tx));
  syncDir(ctx, '.cairn/pending');
}

function complete(ctx, intent, recovering = true) {
  // A writer that died before its directory flush may have left a rename that a power loss would still undo.
  if (recovering) {
    for (const dir of new Set(intent.items.map((item) => dirname(item.path)))) syncDir(ctx, dir);
    if (intent.items.some((item) => item.trash)) syncDir(ctx, '.cairn/trash');
  }
  for (const item of intent.items) {
    if (item.trash && readChecked(ctx.root, item.trash.sidecar) === null) {
      save(ctx, item.trash.sidecar, { path: item.path, deletedAt: intent.ts });
    }
  }
  finishHistory(ctx, intent);
  const seq = recordEvent(ctx, intent, false, recovering);
  cleanup(ctx, intent, true);
  pruneHistory(ctx);
  return seq;
}

function undoRecord(ctx, options) {
  if (options.op !== 'undo') return null;
  const tx = options.extra?.undid;
  if (typeof tx !== 'string' || /[/\\]/u.test(tx)) throw invalid('Invalid undo transaction.');
  const record = json(ctx, historyPath(tx));
  if (!record || readEvents(ctx).at(-1)?.tx !== tx) throw new CairnError('nothing_to_undo', 'There is no operation to undo.');
  if (record.tx !== tx || !TX.test(tx)) throw invalid('Invalid history record.');
  const items = (record.items ?? [record]).map((item, index, all) => {
    const payload = `.cairn/trash/${record.tx}${all.length === 1 ? '' : `-${index}`}-${basename(targetPath(item.path))}`;
    if (item.trash !== undefined && (!isTrashPair(item.trash) || item.trash.payload !== payload)) {
      throw invalid('Invalid history record.');
    }
    if (item.trash || item.before === null || item.after !== null) return item;
    return { ...item, trash: { payload, sidecar: `${payload}.json` } };
  });
  return { ...record, items };
}

function applyMutation(item, before) {
  let input = before;
  if (before !== null) {
    try {
      input = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(before);
    } catch {
      // Byte mutations can still replace or delete an invalid UTF-8 pre-image.
      input = Buffer.from(before);
    }
  }
  const badEncoding = () => new CairnError('bad_encoding', 'Cannot edit this file as text; convert it to UTF-8 first.');
  let after;
  try {
    after = item.apply(input);
  } catch (error) {
    if (Buffer.isBuffer(input)) throw badEncoding();
    throw error;
  }
  if (Buffer.isBuffer(input) && typeof after === 'string') throw badEncoding();
  return after;
}

function prepare(ctx, options, items, tx) {
  const undo = undoRecord(ctx, options);
  if (undo && undo.items.length !== items.length) throw invalid('Undo targets do not match history.');
  const schema = ctx.schema ?? resolveSchema(ctx.config ?? {});
  const staged = items.map((item, index) => {
    const original = undo?.items[index];
    if (original && (original.path !== item.path)) throw invalid('Undo targets do not match history.');
    if (isRawPath(schema, item.path) && !item.createOnly && !(original?.before === null)) {
      throw invalid('Raw sources require createOnly.');
    }
    const before = readChecked(ctx.root, item.path);
    const beforeRev = rev(before);
    if ((index === 0 && options.ifRevision !== undefined && options.ifRevision !== beforeRev)
      || ((item.expectAbsent || item.createOnly) && before !== null)
      || (original && beforeRev !== original.after)) throw conflict(beforeRev);
    const after = applyMutation(item, before);
    if (after !== null && typeof after !== 'string' && !Buffer.isBuffer(after)) throw invalid('Mutation must return text, bytes or null.');
    const bytes = after === null ? null : Buffer.from(after);
    if (original && rev(bytes) !== rev(historyBytes(original))) throw invalid('Undo content does not match history.');
    const trashTx = items.length === 1 ? tx : `${tx}-${index}`;
    const payload = `.cairn/trash/${trashTx}-${basename(item.path)}`;
    return { path: item.path, target: item.target ?? item.path, before: beforeRev, after: rev(bytes), bytes,
      saved: { path: item.path, target: item.target ?? item.path, before: before === null ? null : before.toString('utf8'),
        ...(before !== null && !before.equals(Buffer.from(before.toString('utf8'))) ? { beforeBytes: before.toString('base64') } : {}),
        after: rev(bytes) },
      ...(bytes !== null ? { temp: tempPath(item.path, tx) } : before !== null ? { trashTx, trash: { payload, sidecar: `${payload}.json` } } : {}) };
  });
  const first = staged[0];
  const intent = { tx, op: options.op, path: first.path, target: first.target, actor: ctx.actor ?? null,
    ts: ctx.clock.now().toISOString(), extra: options.extra ?? {}, before: first.before, after: first.after,
    items: staged.map(({ bytes, saved, ...item }) => item), ...(first.trash ? { trash: first.trash } : {}) };
  if (undo) {
    intent.undo = { historyTx: undo.tx };
    intent.cleanup = undo.items.flatMap((item) => item.trash ? [item.trash] : []);
  }
  if (options.op === 'trash.restore') {
    const id = options.extra?.trashId;
    if (typeof id !== 'string' || /[/\\]/u.test(id) || safeRelative(id) !== id) throw invalid('Invalid trash identifier.');
    const payload = `.cairn/trash/${id}`;
    if (staged.length !== 1 || rev(readChecked(ctx.root, payload)) !== first.after) throw invalid('Trash payload does not match restored content.');
    intent.cleanup = [{ payload, sidecar: `${payload}.json` }];
  }
  const reserved = validateEvent(eventFor(intent));
  if (reserved.some((key) => Object.hasOwn(intent.extra, key))) throw invalid('Reserved event field.');
  const history = { tx, op: intent.op, ...first.saved, ...(first.trash ? { trash: first.trash } : {}),
    items: staged.map(({ saved, trash }) => ({ ...saved, ...(trash ? { trash } : {}) })) };
  return { staged, intent, history };
}

function historyBytes(item) {
  return item.before === null ? null : item.beforeBytes ? Buffer.from(item.beforeBytes, 'base64') : Buffer.from(item.before);
}

function resultFor(intent, dryRun, seq = null) {
  return { path: intent.path, revision: intent.after, seq, dryRun, warnings: [],
    items: intent.items.map(({ path, after }) => ({ path, revision: after })) };
}

export function writeMany(ctx, options) {
  const dryRun = options.dryRun === true || ctx.mode === 'dry-run';
  if (!dryRun && ctx.mode !== 'write') throw new CairnError('internal', 'Mutations require write mode.');
  if (!Array.isArray(options.items) || options.items.length === 0) throw invalid('At least one target is required.');
  const seen = new Set();
  const items = options.items.map((item) => {
    const path = logical(item.path);
    if (pathKey(path).split('/')[0] === '.cairn' || seen.has(pathKey(path))) throw invalid('Invalid or duplicate mutation target.');
    seen.add(pathKey(path));
    return { ...item, path };
  });
  const tx = `t-${ctx.clock.now().getTime().toString(36)}${randomBytes(3).toString('hex')}`;
  if (dryRun) return resultFor(prepare(ctx, options, items, tx).intent, true);
  return locks(ctx, items, () => {
    const { staged, intent, history } = prepare(ctx, options, items, tx);
    ctx.faults?.('after-check');
    for (const dir of ['.cairn/pending', '.cairn/history', '.cairn/trash']) mkdir(ctx, dir);
    save(ctx, pendingPath(tx), intent);
    for (const index of intent.items.keys()) {
      save(ctx, pendingHistory(intent, index), intent.items.length === 1 ? history
        : { tx, op: intent.op, ...history.items[index] });
    }
    try {
      for (const item of staged) {
        if (item.bytes !== null) {
          mkdir(ctx, dirname(item.path));
          createTemp(ctx, item.temp, item.bytes);
        }
      }
      for (const item of intent.items) {
        ctx.faults?.('before-rename');
        if (item.temp) retry(() => fs.rename(checkedPath(ctx.root, item.temp), checkedPath(ctx.root, item.path)), () => cas(ctx, item));
        else if (item.trash) retry(() => move({ ...ctx, beforeTrashRename: () => cas(ctx, item) }, item.trashTx, item.path), () => cas(ctx, item));
        else cas(ctx, item);
        syncDir(ctx, dirname(item.path));
        if (item.trash) syncDir(ctx, '.cairn/trash');
      }
    } catch (error) {
      // A conflict is handled now; crashes and I/O failures retain their durable intention for recovery.
      if (error.code === 'conflict') rollback(ctx, intent, false);
      throw error;
    }
    ctx.faults?.('after-rename');
    const seq = complete(ctx, intent, false);
    const result = resultFor(intent, false, seq);
    ctx.afterCommit?.(result);
    return result;
  });
}

export function write(ctx, options) {
  const { path, target, apply, expectAbsent, ...rest } = options;
  const { items, ...result } = writeMany(ctx, { ...rest, items: [{ path, target, apply, expectAbsent }] });
  return result;
}

function rollback(ctx, intent, external) {
  intent.phase = 'rollback';
  intent.external ||= external;
  save(ctx, pendingPath(intent.tx), intent);
  for (const [index, item] of intent.items.entries()) {
    const current = rev(readChecked(ctx.root, item.path));
    if (current === item.before && item.trash && rev(readChecked(ctx.root, item.trash.payload)) === item.before) {
      remove(ctx, item.trash.payload);
      remove(ctx, item.trash.sidecar);
    }
    if (current !== item.after || current === item.before) continue;
    if (item.before !== null) {
      const saved = historyItem(ctx, intent, index);
      const preimage = saved && historyBytes(saved);
      if (preimage === null || preimage === undefined || revision(preimage) !== item.before) {
        throw invalid('Recovery preimage is missing.');
      }
      fs.writeFileAtomic(checkedPath(ctx.root, item.path), preimage, () => cas(ctx, item, item.after));
      if (item.trash) {
        remove(ctx, item.trash.payload);
        remove(ctx, item.trash.sidecar);
      }
    } else if (current !== null) {
      retry(() => move({ ...ctx, beforeTrashRename: () => cas(ctx, item, item.after) }, `${intent.tx}-rollback-${index}`, item.path), () => cas(ctx, item, item.after));
      syncDir(ctx, dirname(item.path));
      syncDir(ctx, '.cairn/trash');
    }
  }
  if (intent.external) recordEvent(ctx, intent, true);
  remove(ctx, historyPath(intent.tx));
  cleanup(ctx, intent, false);
}

export function recover(ctx) {
  const result = { completed: 0, rolledBack: 0, external: 0, skipped: 0 };
  if (ctx.mode !== 'write') return result;
  let names;
  try {
    names = fs.readdirSync(checkedPath(ctx.root, '.cairn/pending')).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return result;
    throw error;
  }
  for (const name of names) {
    let intent;
    try {
      intent = json(ctx, `.cairn/pending/${name}`);
      if (!intent) continue;
      intent.items ??= [{ path: intent.path, target: intent.target, before: intent.before, after: intent.after,
        ...(intent.after !== null ? { temp: tempPath(targetPath(intent.path), intent.tx) } : {}),
        ...(intent.trash ? { trash: intent.trash, trashTx: intent.tx } : {}) }];
      checkIntent(intent);
      if (name !== `${intent.tx}.json`) throw invalid('Invalid pending transaction.');
    } catch (error) {
      if (!(error instanceof CairnError) && !(error instanceof SyntaxError)) throw error;
      // Left in place for a person to inspect; it never blocks other recoveries or writes.
      ctx.warnings?.push('invalid_pending');
      result.skipped++;
      continue;
    }
    try {
      locks(ctx, intent.items, () => {
        if (readChecked(ctx.root, pendingPath(intent.tx)) === null) return;
        const current = intent.items.map((item) => rev(readChecked(ctx.root, item.path)));
        const after = intent.items.every((item, index) => current[index] === item.after
          && (!item.trash || rev(readChecked(ctx.root, item.trash.payload)) === item.before));
        const hasPreimages = intent.items.every((_, index) => historyItem(ctx, intent, index) !== null);
        const hasEvent = readEvents(ctx).some(({ tx }) => tx === intent.tx);
        // A durable event means the transaction committed: later changes by others are not ours to roll back.
        if (hasEvent || (after && intent.phase !== 'rollback' && hasPreimages)) {
          const seq = complete(ctx, intent);
          ctx.afterCommit?.(resultFor(intent, false, seq));
          // Committed, but a target has changed since: keep that change and say so in the log.
          const changed = intent.items.some((item, index) => current[index] !== item.after);
          if (changed) recordEvent(ctx, intent, true);
          result[changed ? 'external' : 'completed']++;
        } else {
          const external = intent.external || intent.items.some((item, index) => current[index] !== item.before && current[index] !== item.after);
          rollback(ctx, intent, external);
          result[external ? 'external' : 'rolledBack']++;
        }
      });
    } catch (error) {
      if (error.code !== 'locked') throw error;
      result.skipped++;
    }
  }
  return result;
}
