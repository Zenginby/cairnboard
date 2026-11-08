import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readdirSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { reconcileExternal } from '../core/changes.mjs';
import { readEvents } from '../core/events.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { runCli } from './support/cli.mjs';
import { changesView } from '../cli/views.mjs';
import { changeDiff } from '../core/changes.mjs';
import { __setFsHooks } from '../core/fsx.mjs';

function fixture(t) {
  const home = tempDir(t), data = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(data, { home, env: {}, clock });
  mkdirSync(join(data, 'notes'));
  const ctx = openContext({ mode: 'write', dataDir: data, home, env: {}, clock });
  const put = (name, bytes) => writeFileSync(join(data, `notes/${name}.md`), bytes);
  const run = (args = []) => runCli(['changes', ...args, '--json'], { home, data, clock });
  return { home, data, clock, ctx, put, run };
}

test('--since 0 lists changes in order and ISO --since filters timestamps', async (t) => {
  const f = fixture(t);
  f.put('a', 'before');
  reconcileExternal(f.ctx);
  f.put('a', 'owner');
  const result = await f.run(['--since', '0']);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.json.data.changes.length, 1);
  assert.equal(result.json.data.changes[0].actor, 'owner:external');
  assert.equal(result.json.data.cursor, 1);
  assert.equal((await f.run(['--since', '2026-11-01T12:00:00Z'])).json.data.changes.length, 1);
  assert.equal((await f.run(['--since', '2026-11-02T00:00:00Z'])).json.data.changes.length, 0);
});

test('--target accepts id and path, --actor filters, and --diff shows the owner line', async (t) => {
  const f = fixture(t);
  f.put('a', '---\nid: n-abc123\n---\noriginal\n');
  reconcileExternal(f.ctx);
  f.put('a', '---\nid: n-abc123\n---\nowner line\n');
  for (const ref of ['n-abc123', 'notes/a.md', '@notes/a']) {
    const result = await f.run(['--target', ref, '--actor', 'owner:external', '--diff']);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.json.data.changes.length, 1);
    assert.match(result.json.data.changes[0].diff, /-original\n\+owner line/u);
  }
  assert.equal((await f.run(['--actor', 'cli:other'])).json.data.changes.length, 0);
});

test('diff reports too_large and binary', async (t) => {
  const f = fixture(t);
  f.put('large', 'small');
  f.put('binary', 'text');
  reconcileExternal(f.ctx);
  f.put('large', 'x'.repeat(256 * 1024 + 1));
  f.put('binary', Buffer.from([0xff, 0x00]));
  const result = await f.run(['--diff']);
  assert.equal(result.code, 0, result.stdout);
  const changes = result.json.data.changes;
  assert.equal(changes.find(({ target }) => target === 'notes/large.md').reason, 'too_large');
  assert.equal(changes.find(({ target }) => target === 'notes/binary.md').reason, 'binary');
});

test('binary preimages use their original byte size', async (t) => {
  const f = fixture(t);
  f.put('a', Buffer.alloc(140 * 1024, 0xff));
  reconcileExternal(f.ctx);
  f.put('a', 'valid now');
  const result = await f.run(['--diff']);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.json.data.changes[0].reason, 'binary');
});

test('diff of pruned history says history_pruned', async (t) => {
  const f = fixture(t);
  reconcileExternal(f.ctx);
  f.put('a', 'owner');
  reconcileExternal(f.ctx);
  const [event] = readEvents(f.ctx);
  unlinkSync(join(f.data, `.cairn/history/${event.tx}.json`));
  const result = await f.run(['--diff']);
  assert.equal(result.json.data.changes[0].reason, 'history_pruned');
});

test('hidden characters stripped from diff even with --raw', async (t) => {
  const f = fixture(t);
  f.put('a', 'before\u200b\n');
  reconcileExternal(f.ctx);
  f.put('a', 'after\u202e\n');
  const result = await f.run(['--diff', '--raw']);
  assert.equal(result.code, 0, result.stdout);
  assert.doesNotMatch(result.json.data.changes[0].diff, /[\u200b\u202e]/u);
});

test('invalid --since is validation (exit 5)', async (t) => {
  const f = fixture(t);
  for (const since of ['nope', '-1', '1.5', '2026-02-30T00:00:00Z', '9007199254740992']) {
    const result = await f.run(['--since=' + since]);
    assert.equal(result.code, 5, result.stdout);
  }
  for (const limit of ['0', '201', 'nope']) assert.equal((await f.run(['--limit', limit])).code, 5);
});

test('changes works when reconcile cannot lock', async (t) => {
  const f = fixture(t);
  f.put('a', 'before');
  reconcileExternal(f.ctx);
  f.put('a', 'owner');
  // runCli yields while loading; hold the lock until the command has completed.
  const path = join(f.data, '.cairn/locks/_shadow.lock');
  writeFileSync(path, JSON.stringify({ host: f.ctx.host, pid: f.ctx.pid, instance: 'held',
    ts: f.clock.now().toISOString() }));
  const result = await f.run();
  unlinkSync(path);
  assert.equal(result.code, 0, result.stdout);
  assert.ok(result.json.warnings.includes('reconcile_skipped'));
});

test('changes and context work with a read-only lock directory', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async (t) => {
  const f = fixture(t);
  f.put('a', 'before');
  reconcileExternal(f.ctx);
  f.put('a', 'owner');
  const locks = join(f.data, '.cairn/locks');
  chmodSync(locks, 0o500);
  try {
    for (const command of ['changes', 'context']) {
      const result = await runCli([command, '--json'], { home: f.home, data: f.data, clock: f.clock });
      assert.equal(result.code, 0, result.stdout);
      assert.ok(result.json.warnings.includes('reconcile_skipped'));
    }
  } finally { chmodSync(locks, 0o700); }
});

test('diff reconstructs an intermediate version from the next history preimage', async (t) => {
  const f = fixture(t);
  f.put('a', 'first\n');
  reconcileExternal(f.ctx);
  f.put('a', 'second\n');
  reconcileExternal(f.ctx);
  f.put('a', 'third\n');
  reconcileExternal(f.ctx);
  const result = await f.run(['--since', '0', '--diff']);
  assert.match(result.json.data.changes[0].diff, /-first\n\+second/u);
  assert.match(result.json.data.changes[1].diff, /-second\n\+third/u);
});

test('ephemeral changes and context do not create metadata', async (t) => {
  const home = tempDir(t), data = tempDir(t);
  writeFileSync(join(data, 'a.md'), '# Read only');
  for (const name of ['changes', 'context']) {
    const result = await runCli([name, '--preset', 'default', '--json'], { home, data });
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(readdirSync(data), ['a.md']);
  }
});

test('changes output is one line per field', () => {
  const field = 'bad\nfield\r\u202e' + 'x'.repeat(300);
  const value = changesView({ changes: [{ seq: 1, ts: field, actor: field, op: field,
    paths: [field], diff: '@@ safe diff @@\n+body\n' }] });
  const [heading, ...diff] = value.split('\n');
  assert.ok(heading.length <= 1 + 4 * 201);
  assert.doesNotMatch(heading, /[\r\u202e]/u);
  assert.equal(diff.join('\n'), '@@ safe diff @@\n+body\n');
  assert.doesNotThrow(() => changesView({ changes: [{ seq: 1, ts: {}, actor: { toString: 5 },
    op: null, paths: ['a.md'] }] }));
});

test('oversized history record is reported not read', (t) => {
  const f = fixture(t);
  reconcileExternal(f.ctx);
  f.put('a', 'owner');
  reconcileExternal(f.ctx);
  const [event] = readEvents(f.ctx);
  const path = join(f.data, `.cairn/history/${event.tx}.json`);
  truncateSync(path, 2 * 1024 * 1024 + 1);
  t.after(() => __setFsHooks());
  __setFsHooks({ readFileSync() { throw new Error('oversized record was read'); } });
  assert.deepEqual(changeDiff(f.ctx, event, [event]), { diff: null, reason: 'history_too_large' });
});

test('8.3 short name rejected', { skip: process.platform !== 'win32' }, (t) => {
  const f = fixture(t);
  f.put('SECRET~1', 'secret');
  const event = { tx: 'x-short', seq: 1, rev: 'a', targets: [{ path: 'notes/SECRET~1.md', rev: 'a' }] };
  writeFileSync(join(f.data, '.cairn/history/x-short.json'), JSON.stringify({ tx: event.tx,
    path: event.targets[0].path, before: null, after: 'a' }));
  t.after(() => __setFsHooks());
  __setFsHooks({ afterCheck(path) {
    if (path.endsWith('SECRET~1.md')) throw new Error('short alias was used for a read');
  } });
  assert.deepEqual(changeDiff(f.ctx, event, [event]), { diff: null, reason: 'history_pruned' });
});

test('diff isolates corrupt revisions and unsafe paths to their own records', async (t) => {
  const f = fixture(t);
  f.put('a', 'before\n');
  reconcileExternal(f.ctx);
  f.put('a', 'after\n');
  reconcileExternal(f.ctx);
  const [good] = readEvents(f.ctx);
  const bad = [
    { ...good, seq: 2, before: 'invalid' },
    { ...good, seq: 3, rev: 'ABCDEF0123456789' },
    { ...good, seq: 4, targets: [{ ...good.targets[0], rev: {} }] },
    { ...good, seq: 5, targets: [{ ...good.targets[0], path: '../outside.md' }] },
  ];
  writeFileSync(join(f.data, '.cairn/events/2026-11.jsonl'), [good, ...bad].map(JSON.stringify).join('\n') + '\n');
  const result = await f.run(['--diff']);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.json.data.changes.length, 5);
  assert.match(result.json.data.changes[0].diff, /-before\n\+after/u);
  for (const change of result.json.data.changes.slice(1)) {
    assert.equal(change.diff, null);
    assert.equal(change.reason, 'diff_unavailable');
  }
});
