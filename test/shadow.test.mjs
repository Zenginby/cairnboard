import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { revision } from '../core/store.mjs';
import { readShadow, recordShadow, shadowBytes } from '../core/shadow.mjs';
import { fixedClock, tempDir } from './support/env.mjs';

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
  assert.deepEqual(readShadow(ctx).entries.get('notes/a.md'), { rev: revision(bytes), blob: true });
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

test('over 256 KiB keeps rev without blob', (t) => {
  const ctx = fixture(t), bytes = Buffer.alloc(256 * 1024 + 1, 97);
  recordShadow(ctx, [{ path: 'large.md', bytes }]);
  assert.deepEqual(readShadow(ctx).entries.get('large.md'), { rev: revision(bytes), blob: false });
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
