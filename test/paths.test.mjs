import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempData } from './support/env.mjs';
import { checkedPath, openForRead, realRoot, safeRelative, samePath } from '../core/paths.mjs';
import { __setFsHooks } from '../core/fsx.mjs';

function fixture(t) {
  const dir = tempData();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('relative paths reject traversal and names unsafe on Windows', () => {
  for (const rel of ['a\0b', 'a:b', '/x', 'C:\\x', '\\\\srv\\x', '../x', 'a/../x',
    'cards/CON.md', 'aux', 'LPT1.txt', 'cards/nul.MD', 'a.', 'a ', 'a?b', '']) {
    assert.throws(() => safeRelative(rel), { code: 'unsafe_path' }, rel);
  }
  assert.equal(safeRelative('cards/İş.md'), join('cards', 'İş.md'));
  assert.equal(safeRelative('cards\\work.md'), join('cards', 'work.md'));
});

test('path comparison uses NFC and only folds case on macOS and Windows', () => {
  const nfd = '/acme/İş'.normalize('NFD');
  for (const platform of ['linux', 'darwin', 'win32']) assert.ok(samePath('/acme/İş', nfd, platform));
  assert.ok(samePath('/Acme/Work', '/acme/work', 'darwin'));
  assert.ok(samePath('C:\\Acme', 'c:\\acme', 'win32'));
  assert.equal(samePath('/Acme', '/acme', 'linux'), false);
});

test('a symlink root resolves once and safe files can be opened', (t) => {
  const dir = fixture(t);
  mkdirSync(join(dir, 'data'));
  symlinkSync(join(dir, 'data'), join(dir, 'alias'), 'dir');
  const root = realRoot(join(dir, 'alias'));
  mkdirSync(join(root, 'cards'));
  writeFileSync(join(root, 'cards', 'work.md'), '# Work\n');
  assert.equal(checkedPath(root, 'cards/new.md'), join(root, 'cards', 'new.md'));
  const fd = openForRead(root, 'cards/work.md');
  try {
    assert.equal(readFileSync(fd, 'utf8'), '# Work\n');
  } finally {
    closeSync(fd);
  }
});

test('symlinks in any relative component are rejected', (t) => {
  const root = realRoot(fixture(t));
  mkdirSync(join(root, 'notes'));
  writeFileSync(join(root, 'notes', 'work.md'), 'notes');
  symlinkSync(join(root, 'notes'), join(root, 'cards'), 'dir');
  symlinkSync(join(root, 'notes', 'work.md'), join(root, 'link.md'));
  for (const rel of ['cards/work.md', 'link.md']) {
    assert.throws(() => checkedPath(root, rel), { code: 'unsafe_path' });
  }
});

test('a resolved root replaced by a symlink is not resolved a second time', (t) => {
  const dir = realRoot(fixture(t));
  mkdirSync(join(dir, 'root'));
  mkdirSync(join(dir, 'outside'));
  const root = realRoot(join(dir, 'root'));
  writeFileSync(join(dir, 'outside', 'work.md'), 'outside');
  renameSync(root, join(dir, 'old'));
  symlinkSync(join(dir, 'outside'), root, 'dir');
  assert.throws(() => checkedPath(root, 'work.md'), { code: 'unsafe_path' });
  assert.throws(() => openForRead(root, 'work.md'), { code: 'unsafe_path' });
});

test('a directory swapped for an outside symlink after lstat is rejected', (t) => {
  const dir = realRoot(fixture(t));
  mkdirSync(join(dir, 'root'));
  mkdirSync(join(dir, 'outside'));
  const root = join(dir, 'root');
  mkdirSync(join(root, 'cards'));
  writeFileSync(join(root, 'cards', 'work.md'), 'inside');
  writeFileSync(join(dir, 'outside', 'work.md'), 'outside');
  t.after(() => __setFsHooks({}));
  __setFsHooks({ afterCheck() {
    renameSync(join(root, 'cards'), join(root, 'old'));
    symlinkSync(join(dir, 'outside'), join(root, 'cards'), 'dir');
  } });
  assert.throws(() => openForRead(root, 'cards/work.md'), { code: 'unsafe_path' });
  assert.equal(readFileSync(join(dir, 'outside', 'work.md'), 'utf8'), 'outside');
});

test('a leaf swapped for an outside symlink after lstat is rejected', (t) => {
  const dir = realRoot(fixture(t));
  mkdirSync(join(dir, 'root'));
  const root = join(dir, 'root');
  writeFileSync(join(root, 'work.md'), 'inside');
  writeFileSync(join(dir, 'outside.md'), 'outside');
  t.after(() => __setFsHooks({}));
  __setFsHooks({ afterCheck() {
    renameSync(join(root, 'work.md'), join(root, 'old.md'));
    symlinkSync(join(dir, 'outside.md'), join(root, 'work.md'));
  } });
  assert.throws(() => openForRead(root, 'work.md'), { code: 'unsafe_path' });
});
