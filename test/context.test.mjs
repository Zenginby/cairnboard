import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initDataDir, stateDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { write } from '../core/store.mjs';
import { fixedClock, tempDir } from './support/env.mjs';

function fixture(t) {
  const home = tempDir(t), base = tempDir(t);
  const root = join(base, 'Proje Notları'.normalize('NFD'));
  mkdirSync(root);
  return { root, home, clock: fixedClock('2026-11-01T12:00:00Z'), env: {}, platform: process.platform };
}
const snapshot = (root) => readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile()).map((entry) => [join(entry.parentPath, entry.name), readFileSync(join(entry.parentPath, entry.name), 'hex')]);

test('ephemeral read and inspect use an in-memory preset and external cache without changing the root', (t) => {
  const opts = fixture(t);
  writeFileSync(join(opts.root, 'not.md'), '# İş\r\n');
  const before = snapshot(opts.root);
  for (const mode of ['read', 'inspect']) {
    const ctx = openContext({ ...opts, dataDir: opts.root, mode, preset: 'tr-wiki' });
    assert.equal(ctx.ephemeral, true);
    assert.equal(ctx.schema.quickNotes, '');
    const hash = createHash('sha256').update(opts.root).digest('hex').slice(0, 16);
    assert.equal(ctx.indexPath, join(stateDir(opts), 'cache', hash, 'index.db'));
    assert.deepEqual(snapshot(opts.root), before);
    assert.deepEqual(readdirSync(opts.root), ['not.md']);
  }
  for (const mode of ['write', 'dry-run']) {
    assert.throws(() => openContext({ ...opts, dataDir: opts.root, mode, preset: 'tr-wiki' }), { code: 'validation' });
  }
  assert.throws(() => openContext({ ...opts, dataDir: opts.root, mode: 'read' }), { code: 'validation' });
});

test('context discovers configured roots and read modes only warn about pending work', (t) => {
  const opts = fixture(t);
  initDataDir(opts.root, opts);
  const ctx = openContext({ ...opts, dataDir: opts.root, mode: 'write', actor: 'agent:acme' });
  ctx.faults = (point) => { if (point === 'before-rename') throw new Error('crashed'); };
  assert.throws(() => write(ctx, { op: 'note.write', path: 'note.md', apply: () => 'new' }), /crashed/u);
  const before = snapshot(opts.root);
  for (const mode of ['read', 'dry-run', 'inspect']) {
    const opened = openContext({ ...opts, mode });
    assert.equal(opened.root, opts.root);
    assert.equal(opened.indexPath, join(opts.root, '.cairn/index.db'));
    assert.deepEqual(opened.warnings, mode === 'inspect' ? [] : ['pending_recovery']);
    assert.deepEqual(snapshot(opts.root), before);
  }
  const opened = openContext({ ...opts, mode: 'write' });
  assert.deepEqual(opened.warnings, []);
  assert.deepEqual(readdirSync(join(opts.root, '.cairn/pending')), []);
});

test('migration warnings are read-only and write context migrates version zero', (t) => {
  const opts = fixture(t);
  initDataDir(opts.root, opts);
  const file = join(opts.root, '.cairn/config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, formatVersion: 0 }));
  const before = snapshot(opts.root);
  for (const mode of ['read', 'dry-run', 'inspect']) {
    assert.deepEqual(openContext({ ...opts, mode }).warnings, mode === 'inspect' ? [] : ['migration_pending']);
    assert.deepEqual(snapshot(opts.root), before);
  }
  assert.equal(openContext({ ...opts, mode: 'write' }).config.formatVersion, 1);
  assert.equal(readdirSync(join(opts.root, '.cairn/backup')).length, 1);
});

test('relative explicit and environment roots resolve against the supplied cwd', (t) => {
  const opts = fixture(t);
  const ctx = openContext({ ...opts, mode: 'read', cwd: opts.root, dataDir: '.', preset: 'default' });
  assert.equal(ctx.root, opts.root);
  const byEnv = openContext({ ...opts, mode: 'read', cwd: opts.root, env: { CAIRN_DATA: '.' }, preset: 'default' });
  assert.equal(byEnv.root, opts.root);
  assert.throws(() => openContext({ ...opts, mode: 'write', dataDir: join(opts.root, 'missing') }), { code: 'validation' });
});

test('a committed write updates the index without a separate refresh', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const { write } = await import('../core/store.mjs');
  const root = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(root, { home, env: {}, clock });
  const ctx = openContext({ mode: 'write', dataDir: root, home, env: {}, clock });
  write(ctx, { op: 'note.write', path: 'notes/acme.md', apply: () => '# Acme\n' });
  const db = new DatabaseSync(ctx.indexPath);
  t.after(() => db.close());
  assert.deepEqual(db.prepare('SELECT path, title FROM files').all().map((row) => ({ ...row })), [{ path: 'notes/acme.md', title: 'Acme' }]);
  write(ctx, { op: 'note.delete', path: 'notes/acme.md', apply: () => null });
  assert.deepEqual(db.prepare('SELECT path FROM files').all(), []);
});
