import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, openSync as fsOpen, readFileSync, readdirSync, renameSync,
  symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { recover, revision, write, writeMany } from '../core/store.mjs';
import { readEvents } from '../core/events.mjs';
import { refresh, targetRevisions } from '../core/index.mjs';
import { readShadow, recordShadow, shadowBytes } from '../core/shadow.mjs';
import { reconcileExternal } from '../core/changes.mjs';
import { __setFsHooks } from '../core/fsx.mjs';
import { lockName, withLock } from '../core/lock.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { runCli } from './support/cli.mjs';

function fixture(t) {
  const root = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(root, { home, env: {}, clock });
  const ctx = openContext({ mode: 'write', dataDir: root, home, env: {}, clock, actor: 'agent:acme' });
  const put = (path, bytes) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  return { ctx, home, put };
}

const history = (ctx, event) => JSON.parse(readFileSync(join(ctx.root, `.cairn/history/${event.tx}.json`), 'utf8'));

test('targets.hash matches revision for UTF-8 bytes', (t) => {
  const { ctx, put } = fixture(t);
  for (const [path, bytes] of [['notes/a.md', Buffer.from('\ufeff# A\r\n🙂\r\n')],
    ['notes/large.md', Buffer.alloc(5 * 1024 * 1024 + 1, 97)]]) {
    put(path, bytes);
    refresh(ctx);
    assert.equal(targetRevisions(ctx).get(path), revision(bytes));
  }
});

test('targets.hash retains existing binary and ignored-file semantics', (t) => {
  const { ctx, put } = fixture(t), bytes = Buffer.from([0xff, 0xfe, 0x0a]);
  put('notes/binary.md', bytes);
  put('.obsidian/template.md', '# Template');
  refresh(ctx);
  const targets = targetRevisions(ctx);
  assert.notEqual(targets.get('notes/binary.md'), revision(bytes));
  assert.equal(targets.get('notes/binary.md'), revision(bytes.toString('utf8')));
  assert.equal(targets.get('.obsidian/template.md'), null);
});

test('first reconcile is a silent baseline', (t) => {
  const { ctx, put } = fixture(t);
  for (let i = 0; i < 100; i++) put(`notes/${i}.md`, `# Note ${i}`);
  assert.deepEqual(reconcileExternal(ctx, { paths: ['notes/0.md'] }),
    { recorded: 0, baseline: true, seqs: [] });
  assert.equal(readEvents(ctx).length, 0);
  assert.equal(readShadow(ctx).entries.size, 100);
  assert.equal(readShadow(ctx).initialized, true);
});

test('owner edit records event and history', (t) => {
  const { ctx, put } = fixture(t);
  const before = '---\nid: n-abc123\n---\n# Before\r\n';
  const after = '---\nid: n-abc123\n---\n# After\r\n';
  put('notes/a.md', before);
  reconcileExternal(ctx);
  put('notes/a.md', after);
  const result = reconcileExternal(ctx);
  const [event] = readEvents(ctx);
  assert.deepEqual(result, { recorded: 1, baseline: false, seqs: [event.seq] });
  assert.equal(event.op, 'external.change');
  assert.equal(event.actor, 'owner:external');
  assert.equal(event.change, 'modify');
  assert.equal(event.target, 'n-abc123');
  assert.equal(event.before, revision(before));
  assert.equal(event.rev, revision(after));
  assert.match(event.tx, /^x-/u);
  assert.deepEqual(event.targets, [{ path: 'notes/a.md', target: 'n-abc123', rev: revision(after) }]);
  const saved = history(ctx, event);
  assert.equal(saved.tx, event.tx);
  assert.equal(saved.op, event.op);
  assert.equal(saved.before, before);
  assert.equal(saved.after, revision(after));
  assert.equal(saved.items[0].before, before);
  assert.deepEqual(shadowBytes(ctx, 'notes/a.md'), Buffer.from(after));
});

test('create and delete', (t) => {
  const { ctx, put } = fixture(t);
  put('notes/old.md', 'old');
  reconcileExternal(ctx);
  put('notes/new.md', 'new');
  unlinkSync(join(ctx.root, 'notes/old.md'));
  assert.equal(reconcileExternal(ctx).recorded, 2);
  const events = readEvents(ctx);
  const created = events.find((event) => event.change === 'create');
  const deleted = events.find((event) => event.change === 'delete');
  assert.equal(created.before, null);
  assert.equal(created.rev, revision('new'));
  assert.equal(deleted.before, revision('old'));
  assert.equal(deleted.rev, null);
  assert.equal(history(ctx, created).before, null);
  assert.equal(history(ctx, deleted).before, 'old');
  assert.equal(readShadow(ctx).entries.has('notes/old.md'), false);
});

test('own write is never external', async (t) => {
  const { ctx, home } = fixture(t);
  reconcileExternal(ctx);
  const options = { home, data: ctx.root, clock: ctx.clock };
  const added = await runCli(['note', 'add', '--title', 'Own', '--actor', 'acme', '--json'], options);
  assert.equal(added.code, 0, added.stdout);
  const updated = await runCli(['note', 'update', added.json.data.ref,
    '--title', 'Updated', '--actor', 'acme', '--json'], options);
  assert.equal(updated.code, 0, updated.stdout);
  assert.equal(reconcileExternal(ctx).recorded, 0);
  assert.equal(readEvents(ctx).filter(({ op }) => op === 'external.change').length, 0);
});

test('a durable own event repairs a failed shadow write', (t) => {
  const { ctx } = fixture(t);
  reconcileExternal(ctx);
  t.after(() => __setFsHooks());
  __setFsHooks({ rename(from, to) {
    if (to === join(ctx.root, '.cairn/shadow/manifest.json')) throw new Error('shadow failed');
    renameSync(from, to);
  } });
  const result = write(ctx, { op: 'note.write', path: 'notes/a.md', apply: () => 'own' });
  assert.ok(result.warnings.includes('shadow_write_failed'));
  __setFsHooks();
  assert.equal(reconcileExternal(ctx).recorded, 0);
  assert.deepEqual(shadowBytes(ctx, 'notes/a.md'), Buffer.from('own'));
  assert.equal(readEvents(ctx).length, 1);
});

test('own multi-target writes use each target revision', (t) => {
  const { ctx } = fixture(t);
  reconcileExternal(ctx);
  t.after(() => __setFsHooks());
  __setFsHooks({ rename(from, to) {
    if (to === join(ctx.root, '.cairn/shadow/manifest.json')) throw new Error('shadow failed');
    renameSync(from, to);
  } });
  writeMany(ctx, { op: 'pair.write', items: [
    { path: 'notes/a.md', apply: () => 'first' }, { path: 'notes/b.md', apply: () => 'second' },
  ] });
  __setFsHooks();
  assert.equal(reconcileExternal(ctx).recorded, 0);
  assert.deepEqual(shadowBytes(ctx, 'notes/a.md'), Buffer.from('first'));
  assert.deepEqual(shadowBytes(ctx, 'notes/b.md'), Buffer.from('second'));
});

test('second reconcile is idempotent', (t) => {
  const { ctx, put } = fixture(t);
  put('notes/a.md', 'before');
  reconcileExternal(ctx);
  put('notes/a.md', 'after');
  assert.equal(reconcileExternal(ctx).recorded, 1);
  assert.deepEqual(reconcileExternal(ctx), { recorded: 0, baseline: false, seqs: [] });
  assert.equal(readEvents(ctx).length, 1);
});

test('event has no content keys', (t) => {
  const { ctx, put } = fixture(t);
  reconcileExternal(ctx);
  put('notes/a.md', '# Private\nbody: secret\ntext: secret\n');
  reconcileExternal(ctx);
  const text = JSON.stringify(readEvents(ctx));
  assert.doesNotMatch(text, /"(?:title|body|text|content)"\s*:/u);
  assert.equal(text.includes('secret'), false);
});

test('symlink replacing a note is ignored', (t) => {
  const { ctx, put } = fixture(t);
  put('notes/a.md', 'before');
  reconcileExternal(ctx);
  const other = tempDir(t);
  writeFileSync(join(other, 'other.md'), 'outside');
  unlinkSync(join(ctx.root, 'notes/a.md'));
  symlinkSync(join(other, 'other.md'), join(ctx.root, 'notes/a.md'));
  assert.equal(reconcileExternal(ctx).recorded, 0);
  assert.equal(readEvents(ctx).length, 0);
  assert.deepEqual(shadowBytes(ctx, 'notes/a.md'), Buffer.from('before'));
});

test('external history capped at 200, undo history keeps 50', (t) => {
  const { ctx, put } = fixture(t);
  for (let i = 0; i < 201; i++) put(`notes/${i}.md`, 'before');
  reconcileExternal(ctx);
  for (let i = 0; i < 51; i++) write(ctx, { op: 'note.write', path: 'notes/own.md', apply: () => String(i) });
  for (let i = 0; i < 201; i++) put(`notes/${i}.md`, 'after');
  assert.equal(reconcileExternal(ctx).recorded, 201);
  const count = () => {
    const records = readdirSync(join(ctx.root, '.cairn/history')).map((name) =>
      JSON.parse(readFileSync(join(ctx.root, '.cairn/history', name), 'utf8')));
    assert.equal(records.filter(({ op }) => op === 'external.change').length, 200);
    assert.equal(records.filter(({ op }) => op !== 'external.change').length, 50);
  };
  count();
  write(ctx, { op: 'note.write', path: 'notes/own.md', apply: () => 'last' });
  count();
});

test('undo after owner edit is refused', async (t) => {
  const { ctx, home, put } = fixture(t);
  ctx.actor = 'cli:acme';
  write(ctx, { op: 'note.write', path: 'notes/a.md', apply: () => 'own' });
  reconcileExternal(ctx);
  put('notes/a.md', 'owner');
  reconcileExternal(ctx);
  const result = await runCli(['undo', '--actor', 'acme', '--json'],
    { home, data: ctx.root, clock: ctx.clock });
  assert.equal(result.code, 4, result.stdout);
  assert.match(result.json.error.message, /another actor/u);
  assert.equal(result.json.error.current.actor, 'owner:external');
});

test('paths limits reconciliation and reserved directories are excluded', (t) => {
  const { ctx, put } = fixture(t);
  reconcileExternal(ctx);
  put('notes/a.md', 'a');
  put('notes/b.md', 'b');
  for (const dir of ['.cairn', '.git', 'node_modules']) put(`${dir}/hidden.md`, 'secret');
  assert.equal(reconcileExternal(ctx, { paths: ['notes/a.md', 'notes/a.md'] }).recorded, 1);
  assert.equal(readShadow(ctx).entries.has('notes/b.md'), false);
  assert.equal(reconcileExternal(ctx).recorded, 1);
  assert.deepEqual([...readShadow(ctx).entries.keys()].sort(), ['notes/a.md', 'notes/b.md']);
  assert.throws(() => reconcileExternal(ctx, { paths: ['../outside.md'] }), { code: 'unsafe_path' });
});

test('previous binary bytes and unavailable preimages are preserved explicitly', (t) => {
  const { ctx, put } = fixture(t), before = Buffer.from([0xff, 0xfe]);
  put('notes/binary.md', before);
  put('notes/large.md', Buffer.alloc(256 * 1024 + 1, 97));
  reconcileExternal(ctx);
  put('notes/binary.md', Buffer.from([0xff]));
  put('notes/large.md', 'small');
  assert.equal(reconcileExternal(ctx).recorded, 2);
  const events = readEvents(ctx);
  const binary = history(ctx, events.find(({ target }) => target === 'notes/binary.md'));
  assert.deepEqual(Buffer.from(binary.beforeBytes, 'base64'), before);
  const large = history(ctx, events.find(({ target }) => target === 'notes/large.md'));
  assert.equal(large.before, null);
  assert.equal(large.beforeUnavailable, true);
  assert.equal(reconcileExternal(ctx).recorded, 0);
});

test('invalid UTF-8 cannot hide behind an unchanged decoded index hash', (t) => {
  const { ctx, put } = fixture(t);
  put('notes/a.md', '\ufffd');
  reconcileExternal(ctx);
  put('notes/a.md', Buffer.from([0xff]));
  assert.equal(reconcileExternal(ctx).recorded, 1);
  assert.equal(readEvents(ctx)[0].rev, revision(Buffer.from([0xff])));
  assert.equal(history(ctx, readEvents(ctx)[0]).before, '\ufffd');
});

test('latest event for the path wins, including a different actor', (t) => {
  const { ctx, put } = fixture(t);
  write(ctx, { op: 'note.write', path: 'notes/a.md', apply: () => 'first' });
  reconcileExternal(ctx);
  put('notes/a.md', 'owner');
  reconcileExternal(ctx);
  // Returning to an older own revision must not hide a new external edit.
  put('notes/a.md', 'first');
  assert.equal(reconcileExternal(ctx).recorded, 1);
  // A failed shadow update after an external event must not duplicate that event either.
  recordShadow(ctx, [{ path: 'notes/a.md', bytes: Buffer.from('owner') }]);
  assert.equal(reconcileExternal(ctx).recorded, 0);
});

test('reconciliation rechecks disk under path lock and respects shadow and event locks', (t) => {
  const { ctx, put } = fixture(t);
  put('notes/a.md', 'before');
  reconcileExternal(ctx);
  put('notes/a.md', 'after');
  for (const name of [lockName('notes/a.md'), '_shadow', '_events']) {
    withLock(ctx, name, () => assert.throws(() => reconcileExternal(ctx), { code: 'locked' }));
    assert.equal(readEvents(ctx).length, 0);
    assert.deepEqual(shadowBytes(ctx, 'notes/a.md'), Buffer.from('before'));
  }
  t.after(() => __setFsHooks());
  let swapped = false;
  __setFsHooks({ afterCheck(path) {
    if (!swapped && path === join(ctx.root, `.cairn/locks/${lockName('notes/a.md')}.lock`)) {
      swapped = true;
      put('notes/a.md', 'latest');
    }
  } });
  ctx.faults = (point) => {
    if (point === 'after-event') {
      for (const name of [lockName('notes/a.md'), '_shadow', '_events']) {
        assert.ok(readdirSync(join(ctx.root, '.cairn/locks')).includes(`${name}.lock`));
      }
    }
  };
  assert.equal(reconcileExternal(ctx).recorded, 1);
  assert.equal(readEvents(ctx)[0].rev, revision('latest'));
});

test('a durable external event repairs its shadow without duplicate history', (t) => {
  const { ctx, put } = fixture(t);
  put('notes/a.md', 'before');
  reconcileExternal(ctx);
  put('notes/a.md', 'after');
  ctx.faults = (point) => { if (point === 'after-event') throw new Error('crashed'); };
  assert.throws(() => reconcileExternal(ctx), /crashed/u);
  delete ctx.faults;
  assert.equal(reconcileExternal(ctx).recorded, 0);
  const [event] = readEvents(ctx);
  assert.equal(history(ctx, event).before, 'before');
  assert.equal(readdirSync(join(ctx.root, '.cairn/history')).length, 1);
  assert.deepEqual(shadowBytes(ctx, 'notes/a.md'), Buffer.from('after'));
});

test('recovery never snapshots an owner edit made after its commit', (t) => {
  const { ctx, put } = fixture(t);
  put('notes/a.md', 'before');
  reconcileExternal(ctx);
  ctx.faults = (point) => { if (point === 'after-rename') throw new Error('crashed'); };
  assert.throws(() => write(ctx, { op: 'note.write', path: 'notes/a.md', apply: () => 'own' }), /crashed/u);
  ctx.faults = (point) => { if (point === 'after-event') put('notes/a.md', 'owner'); };
  assert.equal(recover(ctx).completed, 1);
  delete ctx.faults;
  assert.deepEqual(shadowBytes(ctx, 'notes/a.md'), Buffer.from('before'));
  assert.equal(reconcileExternal(ctx).recorded, 1);
  assert.equal(readEvents(ctx).at(-1).actor, 'owner:external');
});

test('reconciliation requires write mode', (t) => {
  const { ctx } = fixture(t);
  for (const mode of ['read', 'dry-run', 'inspect']) {
    assert.throws(() => reconcileExternal({ ...ctx, mode }), { code: 'internal' });
  }
});

test('unchanged targets do not acquire path or shadow locks or read note bytes', (t) => {
  const { ctx, put } = fixture(t);
  for (let i = 0; i < 20; i++) put(`notes/${i}.md`, `note ${i}`);
  reconcileExternal(ctx);
  const opened = [], checked = [];
  t.after(() => __setFsHooks());
  __setFsHooks({ openSync(path, ...args) {
    opened.push(String(path));
    return fsOpen(path, ...args);
  }, afterCheck(path) { checked.push(path); } });
  assert.equal(reconcileExternal(ctx).recorded, 0);
  assert.equal(opened.filter((path) => path.endsWith('.lock') || path.endsWith('.md')).length, 0);
  assert.equal(checked.filter((path) => path.endsWith('manifest.json')).length, 1);
});

test('baseline reuses indexed bytes without path locks or blob flushes', (t) => {
  const { ctx, put } = fixture(t);
  for (let i = 0; i < 5; i++) put(`notes/${i}.md`, `note ${i}`);
  const opened = [], flushed = [];
  t.after(() => __setFsHooks());
  __setFsHooks({ openSync(path, ...args) {
    opened.push(String(path));
    return fsOpen(path, ...args);
  }, syncDirectory(path) { flushed.push(path); } });
  assert.equal(reconcileExternal(ctx).baseline, true);
  assert.equal(opened.filter((path) => path.endsWith('.md')).length, 5);
  assert.equal(opened.some((path) => /[/\\]f-[^/\\]+\.lock$/u.test(path)), false);
  assert.equal(flushed.includes(join(ctx.root, '.cairn/shadow/blobs')), false);
  assert.ok(flushed.includes(join(ctx.root, '.cairn/shadow')));
});

test('lost non-durable blob degrades to beforeUnavailable', (t) => {
  const { ctx, put } = fixture(t);
  put('notes/a.md', 'before');
  reconcileExternal(ctx);
  const dir = join(ctx.root, '.cairn/shadow/blobs');
  for (const name of readdirSync(dir)) unlinkSync(join(dir, name));
  put('notes/a.md', 'after');
  assert.equal(reconcileExternal(ctx).recorded, 1);
  const saved = history(ctx, readEvents(ctx)[0]);
  assert.equal(saved.before, null);
  assert.equal(saved.beforeUnavailable, true);
});

test('candidate filtering retains invalid UTF-8 with the same decoded hash and byte length', (t) => {
  const { ctx, put } = fixture(t);
  put('notes/a.md', '\ufffd');
  reconcileExternal(ctx);
  put('notes/a.md', Buffer.from([0xf0, 0x90, 0x80]));
  assert.equal(reconcileExternal(ctx).recorded, 1);
  assert.equal(targetRevisions(ctx, { byteSafe: true }).get('notes/a.md'), null);
});

test('a write after the event snapshot is recognized from its appended tail', (t) => {
  const { ctx, put } = fixture(t);
  put('notes/a.md', 'before-a');
  put('notes/b.md', 'before-b');
  reconcileExternal(ctx);
  put('notes/a.md', 'owner-a');
  put('notes/b.md', 'owner-b');
  let written = false;
  t.after(() => __setFsHooks());
  __setFsHooks({ afterCheck(path) {
    if (!written && path === join(ctx.root, `.cairn/locks/${lockName('notes/b.md')}.lock`)) {
      written = true;
      write(ctx, { op: 'note.write', path: 'notes/b.md', apply: () => 'own-b' });
    }
  }, rename(from, to) {
    if (written && to === join(ctx.root, '.cairn/shadow/manifest.json')) throw new Error('shadow failed');
    renameSync(from, to);
  } });
  // Permit reconciliation's repair after the injected writer has failed to update its shadow.
  ctx.afterCommit = () => __setFsHooks();
  assert.equal(reconcileExternal(ctx).recorded, 1);
  assert.deepEqual(readEvents(ctx).map(({ op }) => op), ['note.write', 'external.change']);
  assert.deepEqual(shadowBytes(ctx, 'notes/b.md'), Buffer.from('own-b'));
});
