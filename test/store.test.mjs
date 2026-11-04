import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { readFile, revision, write, writeMany } from '../core/store.mjs';
import { readEvents } from '../core/events.mjs';
import { lockName } from '../core/lock.mjs';
import { __setFsHooks } from '../core/fsx.mjs';
import { fixedClock, tempDir } from './support/env.mjs';

function fixture(t) {
  const root = tempDir(t);
  const home = tempDir(t);
  const clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(root, { home, env: {}, clock });
  return openContext({ mode: 'write', dataDir: root, home, env: {}, clock, actor: 'agent:acme' });
}
const names = (ctx, dir) => readdirSync(join(ctx.root, '.cairn', dir));

test('create, update and delete preserve exact bytes with one event and history each', (t) => {
  const ctx = fixture(t);
  assert.equal(readFile(ctx, 'note.md'), null);
  for (const text of ['# İş\r\n\n', '# İkinci\n', null]) {
    const result = write(ctx, { op: 'note.write', path: 'note.md', apply: () => text });
    assert.equal(result.revision, text === null ? null : revision(text));
    assert.equal(result.dryRun, false);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(readFile(ctx, 'note.md'), text === null ? null : { text, revision: revision(text) });
  }
  assert.equal(readEvents(ctx).length, 3);
  assert.equal(names(ctx, 'history').length, 3);
  assert.deepEqual(names(ctx, 'pending'), []);
  assert.equal(names(ctx, 'trash').length, 2);
  assert.equal(revision('abc'), 'ba7816bf8f01cfea');
});

test('revision and absent preconditions fail before apply and expose the current revision', (t) => {
  const ctx = fixture(t);
  writeFileSync(join(ctx.root, 'note.md'), 'old');
  for (const options of [{ ifRevision: 'wrong' }, { expectAbsent: true }, { createOnly: true }]) {
    assert.throws(() => writeMany(ctx, { op: 'note.write', ...options,
      items: [{ path: 'note.md', ...options, apply: () => assert.fail() }] }), (error) => {
      assert.equal(error.exit, 4);
      assert.equal(error.details.current.revision, revision('old'));
      return true;
    });
  }
  assert.deepEqual(names(ctx, 'pending'), []);
  assert.deepEqual(readEvents(ctx), []);
});

test('dry-run is lockless and leaves every byte unchanged; read mode rejects writes', (t) => {
  const ctx = fixture(t);
  const before = readdirSync(ctx.root, { recursive: true });
  for (const options of [{ dryRun: true }, {}]) {
    const result = write({ ...ctx, mode: options.dryRun ? 'read' : 'dry-run' }, {
      op: 'note.write', path: 'missing/note.md', apply: () => 'preview', ...options,
    });
    assert.deepEqual(result, { path: 'missing/note.md', revision: revision('preview'), seq: null, dryRun: true, warnings: [] });
  }
  assert.deepEqual(readdirSync(ctx.root, { recursive: true }), before);
  assert.throws(() => write({ ...ctx, mode: 'read' }, { op: 'note.write', path: 'x.md', apply: () => 'x' }), { code: 'internal' });
});

test('a last-moment external edit survives CAS failure with no transaction debris', (t) => {
  const ctx = fixture(t);
  writeFileSync(join(ctx.root, 'note.md'), 'old');
  ctx.faults = (point) => {
    if (point === 'before-rename') writeFileSync(join(ctx.root, 'note.md'), 'external');
  };
  assert.throws(() => write(ctx, { op: 'note.write', path: 'note.md', apply: () => 'new' }), { code: 'conflict' });
  assert.equal(readFile(ctx, 'note.md').text, 'external');
  for (const dir of ['history', 'pending', 'locks']) assert.deepEqual(names(ctx, dir), []);
  assert.equal(readdirSync(ctx.root).some((name) => name.endsWith('.tmp')), false);
});

test('rename retries transient errors and repeats CAS before each retry', (t) => {
  const ctx = fixture(t);
  t.after(() => __setFsHooks({}));
  let attempts = 0;
  __setFsHooks({ rename(from, to) {
    if (to === join(ctx.root, 'note.md') && ++attempts < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    renameSync(from, to);
  } });
  write(ctx, { op: 'note.write', path: 'note.md', apply: () => 'new' });
  assert.equal(attempts, 3);
  __setFsHooks({ rename(from, to) {
    if (to === join(ctx.root, 'note.md')) {
      writeFileSync(to, 'external');
      throw Object.assign(new Error('busy'), { code: 'EACCES' });
    }
    renameSync(from, to);
  } });
  assert.throws(() => write(ctx, { op: 'note.write', path: 'note.md', apply: () => 'next' }), { code: 'conflict' });
  assert.equal(readFile(ctx, 'note.md').text, 'external');
});

test('writeMany uses one intention, one history, one event and protects raw sources', (t) => {
  const ctx = fixture(t);
  let seen = false;
  ctx.faults = (point) => {
    if (point !== 'before-rename') return;
    const intent = JSON.parse(readFileSync(join(ctx.root, '.cairn/pending', names(ctx, 'pending')[0]), 'utf8'));
    assert.equal(intent.items.length, 2);
    assert.equal(names(ctx, 'pending').length, 1);
    assert.equal(names(ctx, 'history').filter((name) => name.endsWith('.pending.json')).length, 2);
    seen = true;
  };
  const result = writeMany(ctx, { op: 'ingest', items: [
    { path: 'raw/a.md', createOnly: true, apply: () => Buffer.from('source') },
    { path: 'research/a.md', apply: () => 'summary' },
  ] });
  assert.ok(seen);
  assert.equal(result.items.length, 2);
  assert.equal(readEvents(ctx).length, 1);
  assert.equal(readEvents(ctx)[0].targets.length, 2);
  assert.equal(names(ctx, 'history').length, 1);
  for (const createOnly of [false, true]) {
    assert.throws(() => writeMany(ctx, { op: 'ingest', items: [
      { path: 'raw/a.md', createOnly, apply: () => 'overwrite' },
    ] }), { code: createOnly ? 'conflict' : 'validation' });
  }
});

test('duplicate paths, unsafe paths, symlinks and invalid events fail before writing', (t) => {
  const ctx = fixture(t);
  for (const paths of [['note.md', './note.md'], ['../escape.md'], ['.cairn/config.json']]) {
    assert.throws(() => writeMany(ctx, { op: 'note.write', items: paths.map((path) => ({ path, apply: () => 'x' })) }));
  }
  assert.throws(() => write(ctx, { op: 'note.write', path: 'note.md', extra: { body: 'secret' }, apply: () => 'x' }));
  const outside = tempDir(t);
  mkdirSync(join(ctx.root, 'notes'));
  symlinkSync(outside, join(ctx.root, 'linked'), 'dir');
  assert.throws(() => write(ctx, { op: 'note.write', path: 'linked/note.md', apply: () => 'x' }), { code: 'unsafe_path' });
  assert.deepEqual(readdirSync(outside), []);
  assert.deepEqual(readEvents(ctx), []);
});

test('deletion repeats CAS after the sidecar is durable and preserves an external edit', (t) => {
  const ctx = fixture(t);
  writeFileSync(join(ctx.root, 'note.md'), 'old');
  t.after(() => __setFsHooks({}));
  __setFsHooks({ rename(from, to) {
    renameSync(from, to);
    if (to.includes(`${join('.cairn', 'trash')}${sep}`) && to.endsWith('.json')) {
      writeFileSync(join(ctx.root, 'note.md'), 'external');
    }
  } });
  assert.throws(() => write(ctx, { op: 'note.delete', path: 'note.md', apply: () => null }), { code: 'conflict' });
  assert.equal(readFile(ctx, 'note.md').text, 'external');
  assert.deepEqual(names(ctx, 'pending'), []);
  assert.deepEqual(names(ctx, 'trash'), []);
});

test('afterCommit runs once with the committed multi-target result', (t) => {
  const ctx = fixture(t);
  let observed;
  ctx.afterCommit = (result) => { observed = result; };
  const result = writeMany(ctx, { op: 'pair.write', items: [
    { path: 'a.md', apply: () => 'a' }, { path: 'b.md', apply: () => 'b' },
  ] });
  assert.deepEqual(observed, result);
  assert.equal(result.seq, 1);
});

test('multi-target file locks are acquired in pathKey order regardless of item order', (t) => {
  const ctx = fixture(t);
  const observed = [];
  t.after(() => __setFsHooks({}));
  __setFsHooks({ afterCheck(path) {
    const name = path.split(/[\\/]/u).at(-1);
    if (/^f-[0-9a-f]{16}\.lock$/u.test(name) && !observed.includes(name)) observed.push(name);
  } });
  writeMany(ctx, { op: 'pair.write', items: [
    { path: 'z.md', apply: () => 'z' }, { path: 'a.md', apply: () => 'a' },
  ] });
  assert.deepEqual(observed, [lockName('a.md'), lockName('z.md')].map((name) => `${name}.lock`));
});

test('byte mutations receive invalid UTF-8 bytes and keep buffer writes working', (t) => {
  const ctx = fixture(t), before = Buffer.from([0xff, 0xfe, 0x0a]);
  writeFileSync(join(ctx.root, 'note.md'), before);
  write(ctx, { op: 'note.write', path: 'note.md', apply: (bytes) => {
    assert.deepEqual(bytes, before);
    return Buffer.concat([bytes, Buffer.from([0xff])]);
  } });
  assert.deepEqual(readFileSync(join(ctx.root, 'note.md')), Buffer.concat([before, Buffer.from([0xff])]));
});
