import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lockName, withLock } from '../core/lock.mjs';
import { pathKey } from '../core/text.mjs';
import { __setFsHooks } from '../core/fsx.mjs';
import { CairnError } from '../core/errors.mjs';
import { fixedClock, tempData, tempHome } from './support/env.mjs';

function fixture(t) {
  const root = realpathSync(tempData());
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.cairn', 'locks'), { recursive: true });
  return { root, config: {}, clock: fixedClock('2026-11-01T12:00:00Z'), actor: null,
    mode: 'write', host: 'acme', pid: process.pid, instance: 'instance-a' };
}

const file = (ctx, name = 'd-cards') => join(ctx.root, '.cairn', 'locks', `${name}.lock`);
const owner = (ctx, patch = {}) => ({ host: ctx.host, pid: ctx.pid, instance: 'instance-old',
  ts: ctx.clock.now().toISOString(), ...patch });
const seed = (ctx, patch) => writeFileSync(file(ctx), JSON.stringify(owner(ctx, patch)));

test('file lock names hash the normalized path and directory locks use their supplied name', (t) => {
  const ctx = fixture(t);
  const rel = 'Cards\\İş.md';
  assert.equal(lockName(rel), 'f-' + createHash('sha1').update(pathKey(rel)).digest('hex').slice(0, 16));
  assert.equal(lockName(rel), lockName('cards/İş.md'.normalize('NFD')));
  assert.match(lockName(rel), /^f-[0-9a-f]{16}$/u);
  assert.equal(withLock(ctx, 'd-cards', () => {
    assert.deepEqual(JSON.parse(readFileSync(file(ctx), 'utf8')), owner(ctx, { instance: ctx.instance }));
    return 42;
  }), 42);
  assert.deepEqual(readdirSync(join(ctx.root, '.cairn', 'locks')), []);
});

test('nested acquisition is locked with the current owner and exceptions release the lock', (t) => {
  const ctx = fixture(t);
  assert.throws(() => withLock(ctx, 'd-cards', () => {
    assert.throws(() => withLock(ctx, 'd-cards', () => assert.fail()), (error) => {
      assert.ok(error instanceof CairnError);
      assert.equal(error.code, 'locked');
      assert.deepEqual(error.details.current, { host: ctx.host, pid: ctx.pid, since: ctx.clock.now().toISOString() });
      return true;
    });
    throw new Error('callback failed');
  }), /callback failed/u);
  assert.equal(existsSync(file(ctx)), false);
});

test('a dead local pid is reclaimed by renaming the stale lock', (t) => {
  const ctx = fixture(t);
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  seed(ctx, { pid: child.pid });
  withLock(ctx, 'd-cards', () => assert.equal(JSON.parse(readFileSync(file(ctx), 'utf8')).instance, ctx.instance));
  const names = readdirSync(join(ctx.root, '.cairn', 'locks'));
  assert.equal(names.length, 1);
  assert.match(names[0], /^d-cards\.stale-[0-9a-f]+$/u);
  assert.equal(JSON.parse(readFileSync(join(ctx.root, '.cairn', 'locks', names[0]), 'utf8')).pid, child.pid);
});

test('a dead reclaim guard and its dead lock are both recovered', (t) => {
  const ctx = fixture(t);
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  seed(ctx, { pid: child.pid });
  const guard = join(ctx.root, '.cairn', 'locks', 'd-cards.reclaim');
  writeFileSync(guard, JSON.stringify(owner(ctx, { pid: child.pid })));
  assert.equal(withLock(ctx, 'd-cards', () => 42), 42);
  assert.equal(existsSync(file(ctx)), false);
  assert.equal(existsSync(guard), false);
  assert.equal(readdirSync(join(ctx.root, '.cairn', 'locks')).length, 2);
});

test('remote reclaim guards follow the seven minute tolerance', (t) => {
  const ctx = fixture(t);
  seed(ctx, { host: 'zorblax', ts: '2026-11-01T11:52:00Z' });
  const guard = join(ctx.root, '.cairn', 'locks', 'd-cards.reclaim');
  for (const ts of ['2026-11-01T11:57:00Z', '2026-11-01T11:53:00Z']) {
    writeFileSync(guard, JSON.stringify(owner(ctx, { host: 'zorblax', ts })));
    assert.throws(() => withLock(ctx, 'd-cards', () => assert.fail()), { code: 'locked' });
  }
  writeFileSync(guard, JSON.stringify(owner(ctx, { host: 'zorblax', ts: '2026-11-01T11:52:00Z' })));
  assert.equal(withLock(ctx, 'd-cards', () => 42), 42);
  assert.equal(existsSync(guard), false);
});

test('a live local pid stays locked even after an hour', (t) => {
  const ctx = fixture(t);
  seed(ctx, { ts: '2026-11-01T11:00:00Z' });
  assert.throws(() => withLock(ctx, 'd-cards', () => assert.fail()), { code: 'locked' });
});

test('EPERM is treated as a live pid and unexpected pid errors propagate', (t) => {
  const ctx = fixture(t);
  seed(ctx);
  const kill = process.kill;
  try {
    process.kill = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
    assert.throws(() => withLock(ctx, 'd-cards', () => assert.fail()), { code: 'locked' });
    process.kill = () => { throw Object.assign(new Error('failed'), { code: 'EIO' }); };
    assert.throws(() => withLock(ctx, 'd-cards', () => assert.fail()), { code: 'EIO' });
  } finally {
    process.kill = kill;
  }
});

test('remote owners get two minutes plus five minutes of clock tolerance', (t) => {
  const ctx = fixture(t);
  for (const ts of ['2026-11-01T11:57:00Z', '2026-11-01T11:53:00Z', '2026-11-01T12:01:00Z']) {
    seed(ctx, { host: 'zorblax', ts });
    assert.throws(() => withLock(ctx, 'd-cards', () => assert.fail()), { code: 'locked' });
  }
  seed(ctx, { host: 'zorblax', ts: '2026-11-01T11:52:00Z' });
  withLock(ctx, 'd-cards', () => assert.ok(existsSync(file(ctx))));
  assert.equal(existsSync(file(ctx)), false);
});

test('release preserves a lock replaced with a different instance', (t) => {
  const ctx = fixture(t);
  withLock(ctx, 'd-cards', () => seed(ctx, { instance: 'instance-b' }));
  assert.equal(JSON.parse(readFileSync(file(ctx), 'utf8')).instance, 'instance-b');
});

test('recent malformed or incomplete locks fail closed', (t) => {
  const ctx = fixture(t);
  for (const text of ['', '{', 'null', '{}', JSON.stringify(owner(ctx, { pid: 0, ts: 'invalid' }))]) {
    writeFileSync(file(ctx), text);
    utimesSync(file(ctx), ctx.clock.now(), ctx.clock.now());
    assert.throws(() => withLock(ctx, 'd-cards', () => assert.fail()), { code: 'locked' });
    assert.equal(readFileSync(file(ctx), 'utf8'), text);
  }
});

test('empty and malformed locks become stale only after two minutes', (t) => {
  const ctx = fixture(t);
  const now = ctx.clock.now().getTime() / 1000;
  for (const text of ['', '{']) {
    writeFileSync(file(ctx), text);
    utimesSync(file(ctx), now - 120, now - 120);
    assert.throws(() => withLock(ctx, 'd-cards', () => assert.fail()), { code: 'locked' });
    utimesSync(file(ctx), now - 180, now - 180);
    assert.equal(withLock(ctx, 'd-cards', () => 42), 42);
    assert.equal(existsSync(file(ctx)), false);
  }
});

test('non-write modes and unsafe names never acquire a lock or run the callback', (t) => {
  const ctx = fixture(t);
  for (const mode of ['read', 'dry-run', 'inspect']) {
    assert.throws(() => withLock({ ...ctx, mode }, 'd-cards', () => assert.fail()), TypeError);
  }
  for (const name of ['../outside', 'a/b', 'a\\b', '']) {
    assert.throws(() => withLock(ctx, name, () => assert.fail()));
  }
  assert.deepEqual(readdirSync(join(ctx.root, '.cairn', 'locks')), []);
});

test('lock directories and leaves cannot redirect through symlinks', (t) => {
  const ctx = fixture(t);
  writeFileSync(join(ctx.root, 'outside'), 'unchanged');
  symlinkSync(join(ctx.root, 'outside'), file(ctx));
  assert.throws(() => withLock(ctx, 'd-cards', () => assert.fail()), { code: 'unsafe_path' });
  assert.equal(readFileSync(join(ctx.root, 'outside'), 'utf8'), 'unchanged');
});

test('lock paths support spaces and decomposed Unicode in the data root', (t) => {
  const ctx = fixture(t);
  ctx.root = join(ctx.root, 'İş Notları'.normalize('NFD'));
  mkdirSync(ctx.root);
  const name = lockName('cards/İş.md');
  withLock(ctx, name, () => assert.ok(existsSync(file(ctx, name))));
  assert.deepEqual(readdirSync(join(ctx.root, '.cairn', 'locks')), []);
});

test('failed stale renames preserve the original lock and release the reclaim guard', (t) => {
  const ctx = fixture(t);
  seed(ctx, { host: 'zorblax', ts: '2026-11-01T11:52:00Z' });
  const before = readFileSync(file(ctx), 'utf8');
  t.after(() => __setFsHooks({}));
  __setFsHooks({ rename() { throw new Error('rename failed'); } });
  assert.throws(() => withLock(ctx, 'd-cards', () => assert.fail()), /rename failed/u);
  assert.equal(readFileSync(file(ctx), 'utf8'), before);
  assert.deepEqual(readdirSync(join(ctx.root, '.cairn', 'locks')), ['d-cards.lock']);
});

test('two processes reclaiming a stale lock admit only one owner', { timeout: 15000 }, async (t) => {
  const ctx = fixture(t);
  const home = tempHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  seed(ctx, { host: 'zorblax', ts: '2026-11-01T11:52:00Z' });
  const release = join(ctx.root, 'release');
  const move = join(ctx.root, 'move');
  const script = `
    import { existsSync, renameSync } from 'node:fs';
    import { withLock } from ${JSON.stringify(new URL('../core/lock.mjs', import.meta.url).href)};
    import { fixedClock } from ${JSON.stringify(new URL('../core/clock.mjs', import.meta.url).href)};
    import { __setFsHooks } from ${JSON.stringify(new URL('../core/fsx.mjs', import.meta.url).href)};
    const ctx = JSON.parse(process.env.LOCK_CTX);
    ctx.pid = process.pid;
    ctx.instance = String(process.pid);
    ctx.clock = fixedClock('2026-11-01T12:00:00Z');
    if (process.env.PAUSE) __setFsHooks({ rename(from, to) {
      process.send('moving');
      while (!existsSync(process.env.MOVE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      renameSync(from, to);
    } });
    process.once('message', () => {
      try {
        withLock(ctx, 'd-cards', () => {
          process.send('won');
          while (!existsSync(process.env.RELEASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        });
      } catch (error) { process.send(error.code ?? error.message); }
      process.disconnect();
    });
    process.send('ready');
  `;
  const children = [0, 1].map((index) => spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: home, USERPROFILE: home, LOCK_CTX: JSON.stringify(ctx), RELEASE: release,
      PAUSE: index === 0 ? 'yes' : '', MOVE: move },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  }));
  t.after(() => children.forEach((child) => child.kill()));
  const exits = children.map((child) => once(child, 'exit'));
  await Promise.all(children.map((child) => once(child, 'message')));
  const moving = once(children[0], 'message');
  children[0].send('go');
  assert.equal((await moving)[0], 'moving');
  const loser = once(children[1], 'message');
  children[1].send('go');
  assert.equal((await loser)[0], 'locked');
  const winner = once(children[0], 'message');
  writeFileSync(move, '');
  assert.equal((await winner)[0], 'won');
  writeFileSync(release, '');
  for (const [code] of await Promise.all(exits)) assert.equal(code, 0);
});
