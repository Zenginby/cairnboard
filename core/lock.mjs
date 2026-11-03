import { createHash, randomBytes } from 'node:crypto';
import * as fs from './fsx.mjs';
import { CairnError } from './errors.mjs';
import { checkedPath, readChecked, safeRelative } from './paths.mjs';
import { pathKey } from './text.mjs';

/**
 * @typedef {'after-check'|'before-rename'|'after-rename'|'after-event'} FaultPoint
 * @typedef {object} Ctx
 * @property {string} root
 * @property {object} config
 * @property {{ now: () => Date }} clock
 * @property {string|null} actor
 * @property {'read'|'dry-run'|'write'|'inspect'} mode
 * @property {string} host
 * @property {number} pid
 * @property {string} instance Random identifier for this process.
 * @property {(point: FaultPoint) => void} [faults]
 */

export function lockName(rel) {
  return 'f-' + createHash('sha1').update(pathKey(rel)).digest('hex').slice(0, 16);
}

function readOwner(ctx, rel) {
  const text = readChecked(ctx.root, rel, 'utf8');
  if (text === null) return undefined;
  let owner = null;
  try {
    owner = JSON.parse(text);
  } catch {
    // Malformed owners fall back to the mtime rule.
  }
  const stat = fs.lstatSync(checkedPath(ctx.root, rel), { throwIfNoEntry: false });
  return stat && { owner, mtime: stat.mtimeMs };
}

function stale(ctx, { owner, mtime }) {
  if (!owner || typeof owner.host !== 'string' || !Number.isInteger(owner.pid)
    // process.kill rejects pids outside the signed 32-bit range.
    || owner.pid < 1 || owner.pid > 2 ** 31 - 1
    || typeof owner.instance !== 'string' || typeof owner.ts !== 'string' || !Number.isFinite(Date.parse(owner.ts))) {
    return ctx.clock.now().getTime() - mtime > 2 * 60 * 1000;
  }
  if (owner.host !== ctx.host) return ctx.clock.now().getTime() - Date.parse(owner.ts) > 7 * 60 * 1000;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    if (error.code === 'EPERM') return false;
    throw error;
  }
}

function locked(snapshot) {
  const owner = snapshot?.owner;
  return new CairnError('locked', 'Lock is held by another operation.', {
    current: { host: owner?.host ?? null, pid: owner?.pid ?? null, since: owner?.ts ?? null },
  });
}

function create(ctx, rel) {
  const path = checkedPath(ctx.root, rel);
  let fd;
  try {
    fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  try {
    // No fsync: a lock only matters to live processes, and after a power loss every lock is stale anyway.
    fs.writeFileSync(fd, JSON.stringify({ host: ctx.host, pid: ctx.pid, instance: ctx.instance, ts: ctx.clock.now().toISOString() }));
  } catch (error) {
    fs.unlinkSync(checkedPath(ctx.root, rel));
    throw error;
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function release(ctx, rel) {
  if (readOwner(ctx, rel)?.owner?.instance === ctx.instance) fs.unlinkSync(checkedPath(ctx.root, rel));
}

function acquire(ctx, rel) {
  const base = rel.endsWith('.lock') ? rel.slice(0, -5) : rel;
  while (!create(ctx, rel)) {
    const owner = readOwner(ctx, rel);
    if (owner === undefined) continue;
    if (!stale(ctx, owner)) throw locked(owner);
    // Guard recovery also needs serialization so contenders cannot move a new guard.
    const guard = `${base}.reclaim`;
    acquire(ctx, guard);
    let acquired = false;
    try {
      const current = readOwner(ctx, rel);
      if (current !== undefined) {
        if (!stale(ctx, current)) throw locked(current);
        const moved = `${base}.stale-${randomBytes(8).toString('hex')}`;
        try {
          fs.rename(checkedPath(ctx.root, rel), checkedPath(ctx.root, moved));
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
      }
      acquired = create(ctx, rel);
      if (!acquired) throw locked(readOwner(ctx, rel));
    } finally {
      release(ctx, guard);
    }
    if (acquired) break;
  }
}

export function withLock(ctx, name, fn) {
  if (ctx.mode !== 'write') throw new TypeError('Locks require write mode.');
  if (typeof name !== 'string' || !name || /[/\\]/u.test(name)) throw new TypeError('Invalid lock name.');
  safeRelative(`${name}.lock`);
  for (const rel of ['.cairn', '.cairn/locks']) fs.mkdirSync(checkedPath(ctx.root, rel), { recursive: true, mode: 0o700 });
  const rel = `.cairn/locks/${name}.lock`;
  acquire(ctx, rel);
  try {
    return fn();
  } finally {
    release(ctx, rel);
  }
}

// Contenders wait on a time budget, not a try count: one fsync-heavy write can outlast any fixed count under load.
const LOCK_WAIT_MS = 5000;

export function retryWhileLocked(fn, { budgetMs = LOCK_WAIT_MS } = {}) {
  const start = performance.now();
  for (let attempt = 0; ; attempt++) {
    const state = { entered: false };
    try {
      return fn(state);
    } catch (error) {
      if (state.entered || error.code !== 'locked' || performance.now() - start >= budgetMs) throw error;
      // Jitter keeps contenders from waking in lockstep.
      const step = Math.min(200, 20 * (attempt + 1));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, step / 2 + Math.random() * step / 2);
    }
  }
}
