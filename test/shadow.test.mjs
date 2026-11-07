import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { revision } from '../core/store.mjs';
import { readShadow, recordShadow, shadowBytes } from '../core/shadow.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { __setFsHooks } from '../core/fsx.mjs';

function fixture(t) {
  const root = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(root, { home, env: {}, clock });
  return openContext({ mode: 'write', dataDir: root, home, env: {}, clock });
}

test('records and reads back bytes', (t) => {
  const ctx = fixture(t), bytes = Buffer.from('Old\r\n🙂\n');
  assert.deepEqual(readShadow(ctx), { initialized: false, entries: new Map() });
  assert.equal(shadowBytes(ctx, 'notes/a.md'), null);
  recordShadow(ctx, [{ path: 'notes/a.md', bytes }]);
  assert.deepEqual(shadowBytes(ctx, 'notes/a.md'), bytes);
  assert.deepEqual(readShadow(ctx).entries.get('notes/a.md'), { rev: revision(bytes), blob: true,
    size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') });
  assert.equal(readShadow(ctx).initialized, false);
  recordShadow(ctx, [], { initialize: true });
  assert.equal(readShadow(ctx).initialized, true);
  assert.deepEqual(readdirSync(join(ctx.root, '.cairn/shadow/blobs')),
    [createHash('sha256').update(bytes).digest('hex')]);
});

test('null removes entry and collects blob', (t) => {
  const ctx = fixture(t), bytes = Buffer.from('shared');
  recordShadow(ctx, [{ path: 'a.md', bytes }, { path: 'b.md', bytes }]);
  recordShadow(ctx, [{ path: 'a.md', bytes: null }]);
  assert.equal(readShadow(ctx).entries.has('a.md'), false);
  assert.deepEqual(shadowBytes(ctx, 'b.md'), bytes);
  recordShadow(ctx, [{ path: 'b.md', bytes: null }]);
  assert.equal(shadowBytes(ctx, 'b.md'), null);
  assert.deepEqual(readdirSync(join(ctx.root, '.cairn/shadow/blobs')), []);
});

test('exact shadow spelling takes precedence over folded aliases', (t) => {
  const ctx = fixture(t);
  recordShadow(ctx, [{ path: 'notes/A.md', bytes: Buffer.from('upper') },
    { path: 'notes/a.md', bytes: Buffer.from('lower') }]);
  recordShadow(ctx, [{ path: 'notes/A.md', bytes: Buffer.from('updated') }]);
  assert.deepEqual(shadowBytes(ctx, 'notes/A.md'), Buffer.from('updated'));
  assert.deepEqual(shadowBytes(ctx, 'notes/a.md'), Buffer.from('lower'));
});

test('over 256 KiB keeps rev without blob', (t) => {
  const ctx = fixture(t), bytes = Buffer.alloc(256 * 1024 + 1, 97);
  recordShadow(ctx, [{ path: 'large.md', bytes }]);
  assert.deepEqual(readShadow(ctx).entries.get('large.md'), { rev: revision(bytes), blob: false, size: bytes.length });
  assert.equal(shadowBytes(ctx, 'large.md'), null);
  const boundary = bytes.subarray(1);
  recordShadow(ctx, [{ path: 'boundary.md', bytes: boundary }]);
  assert.deepEqual(shadowBytes(ctx, 'boundary.md'), boundary);
});

test('budget over 64 MiB keeps rev without blob', (t) => {
  const ctx = fixture(t);
  ctx.shadowBudget = 4;
  recordShadow(ctx, [{ path: 'a.md', bytes: Buffer.from('aaaa') },
    { path: 'b.md', bytes: Buffer.from('bb') }, { path: 'c.md', bytes: Buffer.from('aaaa') }]);
  assert.equal(readShadow(ctx).entries.get('b.md').blob, false);
  assert.equal(shadowBytes(ctx, 'b.md'), null);
  assert.deepEqual(shadowBytes(ctx, 'c.md'), Buffer.from('aaaa'));
  recordShadow(ctx, [{ path: 'a.md', bytes: null }, { path: 'c.md', bytes: null },
    { path: 'b.md', bytes: Buffer.from('bbbb') }]);
  assert.deepEqual(shadowBytes(ctx, 'b.md'), Buffer.from('bbbb'));
});

test('manifest with foreign path is rejected', (t) => {
  const ctx = fixture(t);
  mkdirSync(join(ctx.root, '.cairn/shadow'));
  for (const path of ['../x', '.cairn/x', '/x', 'nested/.git/x.md', 'node_modules/x.md']) {
    writeFileSync(join(ctx.root, '.cairn/shadow/manifest.json'), JSON.stringify({
      v: 1, initialized: true, entries: { [path]: { rev: revision('x'), blob: true } },
    }));
    assert.throws(() => readShadow(ctx), { code: 'validation' });
  }
});

test('symlinked shadow dir is rejected', (t) => {
  const ctx = fixture(t), other = tempDir(t);
  symlinkSync(other, join(ctx.root, '.cairn/shadow'), 'dir');
  assert.throws(() => recordShadow(ctx, [{ path: 'a.md', bytes: Buffer.from('x') }]), { code: 'unsafe_path' });
  assert.deepEqual(readdirSync(other), []);
});

test('manifest validates stored blob size', (t) => {
  const ctx = fixture(t);
  recordShadow(ctx, [{ path: 'a.md', bytes: Buffer.from('a') }]);
  const path = join(ctx.root, '.cairn/shadow/manifest.json');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(data.entries['a.md'].size, 1);
  for (const size of [-1, 1.5, '1', 256 * 1024 + 1]) {
    data.entries['a.md'].size = size;
    writeFileSync(path, JSON.stringify(data));
    assert.throws(() => readShadow(ctx), { code: 'validation' });
  }
});

test('incremental recording does not scan existing blobs or flush blob directories', (t) => {
  const ctx = fixture(t);
  recordShadow(ctx, [{ path: 'a.md', bytes: Buffer.from('a') }]);
  const seen = [], flushed = [];
  t.after(() => __setFsHooks());
  __setFsHooks({ afterCheck(path) { seen.push(path); }, syncDirectory(path) { flushed.push(path); } });
  recordShadow(ctx, [{ path: 'b.md', bytes: Buffer.from('b') }]);
  const hash = createHash('sha256').update('a').digest('hex');
  assert.equal(seen.includes(join(ctx.root, '.cairn/shadow/blobs', hash)), false);
  assert.equal(flushed.includes(join(ctx.root, '.cairn/shadow/blobs')), false);
  assert.ok(flushed.includes(join(ctx.root, '.cairn/shadow')));
});

test('legacy manifests retain their blobs when metadata is added', (t) => {
  const ctx = fixture(t), bytes = Buffer.from('old');
  const hash = createHash('sha256').update(bytes).digest('hex');
  mkdirSync(join(ctx.root, '.cairn/shadow/blobs'), { recursive: true });
  writeFileSync(join(ctx.root, '.cairn/shadow/blobs', hash), bytes);
  writeFileSync(join(ctx.root, '.cairn/shadow/manifest.json'), JSON.stringify({ v: 1, initialized: true,
    entries: { 'a.md': { rev: revision(bytes), blob: true } } }));
  recordShadow(ctx, []);
  const data = JSON.parse(readFileSync(join(ctx.root, '.cairn/shadow/manifest.json'), 'utf8'));
  assert.equal(data.entries['a.md'].size, bytes.length);
  assert.deepEqual(shadowBytes(ctx, 'a.md'), bytes);
  unlinkSync(join(ctx.root, '.cairn/shadow/blobs', hash));
  assert.equal(shadowBytes(ctx, 'a.md'), null);
});

test('corrupt or incomplete blobs are unavailable and are replaced before publication', (t) => {
  const ctx = fixture(t), bytes = Buffer.from('complete');
  const hash = createHash('sha256').update(bytes).digest('hex');
  recordShadow(ctx, [{ path: 'a.md', bytes }]);
  writeFileSync(join(ctx.root, '.cairn/shadow/blobs', hash), 'partial');
  assert.equal(shadowBytes(ctx, 'a.md'), null);
  recordShadow(ctx, [{ path: 'a.md', bytes }]);
  assert.deepEqual(shadowBytes(ctx, 'a.md'), bytes);
});

test('first shadow creation preserves user ignore lines and adds private directories', (t) => {
  for (const existing of ['# Custom\ncustom/\nhistory/', null]) {
    const ctx = fixture(t), path = join(ctx.root, '.cairn/.gitignore');
    if (existing === null) unlinkSync(path);
    else writeFileSync(path, existing);
    recordShadow(ctx, [{ path: 'a.md', bytes: Buffer.from('private') }]);
    const text = readFileSync(path, 'utf8');
    if (existing !== null) assert.ok(text.startsWith(existing));
    for (const name of ['history/', 'shadow/', 'agents/']) assert.ok(text.split('\n').includes(name));
    recordShadow(ctx, [{ path: 'a.md', bytes: Buffer.from('changed') }]);
    assert.equal(readFileSync(path, 'utf8'), text);
  }
});

test('8.3 short name rejected', (t) => {
  const ctx = fixture(t);
  mkdirSync(join(ctx.root, '.cairn/shadow'));
  writeFileSync(join(ctx.root, '.cairn/shadow/manifest.json'), JSON.stringify({ v: 1, initialized: true,
    entries: { 'notes/SECRET~1.md': { rev: revision('x'), blob: false, size: 1 } } }));
  assert.throws(() => readShadow(ctx), { code: 'validation' });
});
