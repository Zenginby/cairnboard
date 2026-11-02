import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as fs from '../core/fsx.mjs';
import { tempDir } from './support/env.mjs';
import { PRESETS } from '../core/presets.mjs';
import { openIndex, refresh, rows, search, findById, backlinks, outlinks, journalEntries, indexPath, dropPath } from '../core/index.mjs';

function setup(t, preset = 'default') {
  const root = tempDir(t);
  return { root, schema: structuredClone(PRESETS[preset]), warnings: [], indexPath: join(root, '.cairn/index.db'), indexTimeoutMs: 10 };
}

function put(ctx, path, text) {
  fs.mkdirSync(dirname(join(ctx.root, path)), { recursive: true });
  fs.writeFileSync(join(ctx.root, path), text);
}

function query(ctx, sql) {
  const index = openIndex(ctx);
  try { return index.db.prepare(sql).all(); } finally { index.close(); }
}

test('refresh caches metadata, detects ctime edits and removals, and searches Turkish words safely', (t) => {
  const ctx = setup(t);
  put(ctx, 'notes/a.md', '---\nid: n-acme12\n---\n# IŞIK\nşapka');
  put(ctx, 'notes/b.md', '---\nid: n-acme12\n---\nOther');
  const path = join(ctx.root, 'notes/a.md');
  fs.utimesSync(path, 1, 1);
  assert.equal(refresh(ctx).added, 2);
  let reads = 0;
  fs.__setFsHooks({ afterCheck: (path) => { if (path.endsWith('.md')) reads++; } });
  t.after(() => fs.__setFsHooks());
  assert.deepEqual(refresh(ctx), { added: 0, updated: 0, removed: 0, skipped: [] });
  assert.equal(reads, 0);
  assert.equal(search(ctx, 'ISIK sapka')[0].path, 'notes/a.md');
  assert.deepEqual(search(ctx, '" OR *'), []);
  assert.deepEqual(findById(ctx, 'n-acme12'), ['notes/a.md', 'notes/b.md']);
  const before = fs.statSync(path);
  put(ctx, 'notes/a.md', '---\nid: n-acme12\n---\n# IŞIK\nkalemi');
  fs.utimesSync(path, before.atime, before.mtime);
  assert.equal(fs.statSync(path).size, before.size);
  assert.equal(fs.statSync(path).mtimeMs, before.mtimeMs);
  assert.notEqual(fs.statSync(path).ctimeMs, before.ctimeMs);
  assert.equal(refresh(ctx).updated, 1);
  assert.equal(search(ctx, 'kalemi').length, 1);
  fs.unlinkSync(join(ctx.root, 'notes/b.md'));
  assert.equal(refresh(ctx).removed, 1);
  assert.deepEqual(findById(ctx, 'n-acme12'), ['notes/a.md']);
  assert.equal(rows(ctx, 'note')[0].body, null);
  assert.equal(fs.statSync(dirname(ctx.indexPath)).mode & 0o777, 0o700);
});

test('link targets change without rereading source pages, with ambiguity and exact names', (t) => {
  const ctx = setup(t, 'tr-wiki');
  put(ctx, 'a.md', '[[b]] [[Sistem 1]] [[CLAUDE]] [[wiki/kavramlar/b.md#Part]]');
  put(ctx, 'CLAUDE.md', 'ignored');
  put(ctx, 'wiki/kavramlar/sistem-1.md', '# Concept');
  refresh(ctx);
  assert.deepEqual(outlinks(ctx, 'a.md').map((link) => link.status), ['unresolved', 'unresolved', 'resolved', 'unresolved']);
  let sourceReads = 0;
  fs.__setFsHooks({ afterCheck: (path) => { if (path === join(ctx.root, 'a.md')) sourceReads++; } });
  t.after(() => fs.__setFsHooks());
  put(ctx, 'wiki/kavramlar/b.md', '# B');
  refresh(ctx);
  assert.equal(sourceReads, 0);
  assert.equal(outlinks(ctx, 'a.md')[0].target_path, 'wiki/kavramlar/b.md');
  assert.deepEqual(backlinks(ctx, 'wiki/kavramlar/b.md'), [{ src_path: 'a.md', line: 1, field: null }]);
  assert.deepEqual(backlinks(ctx, 'CLAUDE.md'), []);
  put(ctx, 'b.md', '# B');
  indexPath(ctx, 'b.md');
  const ambiguous = outlinks(ctx, 'a.md')[0];
  assert.equal(ambiguous.status, 'ambiguous');
  assert.deepEqual(ambiguous.candidates, ['b.md', 'wiki/kavramlar/b.md']);
  fs.unlinkSync(join(ctx.root, 'b.md'));
  dropPath(ctx, 'b.md');
  assert.equal(outlinks(ctx, 'a.md')[0].status, 'resolved');
});

test('catalog, canonical frontmatter links and journal entries are indexed', (t) => {
  const ctx = setup(t, 'tr-wiki');
  put(ctx, 'index.md', '[[wiki/kavramlar/a]]');
  put(ctx, 'wiki/kavramlar/a.md', '---\nkaynaklar: ["[[b]]"]\n---\n# A');
  put(ctx, 'b.md', '# B');
  put(ctx, 'wiki/gunluk-loglar/2026-11-01.md', '---\ndate: 2026-11-01\n---\n## Work · acme\n- **Ders:** Learn\n- Tuzak: Trap → [[b]]');
  refresh(ctx);
  assert.equal(rows(ctx).some((row) => row.path === 'index.md'), false);
  assert.equal(outlinks(ctx, 'wiki/kavramlar/a.md')[0].field, 'sources');
  assert.deepEqual(query(ctx, 'SELECT target_name, line FROM catalog').map((row) => ({ ...row })), [{ target_name: 'wiki/kavramlar/a', line: 1 }]);
  assert.equal(journalEntries(ctx, { unprocessed: true }).length, 1);
  assert.equal(journalEntries(ctx, { type: 'pitfall', since: '2026-11-01' })[0].processed, true);
  assert.deepEqual(journalEntries(ctx, { since: '2026-11-02' }), []);
  assert.equal(rows(ctx, 'note', { kind: 'concept' }).length, 1);
});

test('corruption, schema version and schema fingerprint rebuild the cache', (t) => {
  const ctx = setup(t);
  put(ctx, 'notes/a.md', '# A');
  fs.mkdirSync(dirname(ctx.indexPath));
  fs.writeFileSync(ctx.indexPath, 'broken database');
  assert.equal(refresh(ctx).added, 1);
  let index = openIndex(ctx);
  index.db.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
  index.close();
  assert.equal(refresh(ctx).added, 1);
  ctx.schema.ignore.push('notes/a.md');
  assert.equal(refresh(ctx).added, 0);
  assert.deepEqual(rows(ctx), []);
  index = openIndex(ctx);
  assert.equal(index.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '2');
  index.close();
});

test('busy databases fall back to source files and cache hooks never break writes', (t) => {
  const ctx = setup(t);
  put(ctx, 'notes/a.md', '# Old\n[[b]]');
  refresh(ctx);
  const before = fs.statSync(ctx.indexPath).ino;
  const blocker = new DatabaseSync(ctx.indexPath);
  t.after(() => blocker.close());
  blocker.exec('BEGIN IMMEDIATE');
  put(ctx, 'notes/a.md', '# New\nışık');
  const fresh = { ...ctx, warnings: [] };
  assert.equal(rows(fresh)[0].title, 'New');
  assert.equal(search(fresh, 'ISIK').length, 1);
  assert.doesNotThrow(() => indexPath(fresh, 'notes/a.md'));
  assert.doesNotThrow(() => dropPath(fresh, 'notes/a.md'));
  assert.ok(fresh.warnings.includes('index_unavailable'));
  assert.equal(fs.statSync(ctx.indexPath).ino, before);
  blocker.exec('ROLLBACK');
  assert.equal(refresh(fresh).updated, 1);
});

test('non-Markdown, symlinks and oversized Markdown are handled conservatively', (t) => {
  const ctx = setup(t);
  put(ctx, 'notes/a.png', 'image');
  put(ctx, 'notes/huge.md', `---\ntitle: Huge\n---\n${'x'.repeat(6 * 1024 * 1024)}`);
  fs.symlinkSync(join(ctx.root, 'notes/huge.md'), join(ctx.root, 'notes/link.md'));
  const result = refresh(ctx);
  assert.deepEqual(result.skipped.map(({ path, reason }) => [path, reason]).sort(), [
    ['notes/a.png', 'not-markdown'], ['notes/huge.md', 'too-large'], ['notes/link.md', 'symlink'],
  ]);
  assert.equal(rows(ctx)[0].title, 'Huge');
  assert.equal(rows(ctx)[0].body, null);
  assert.deepEqual(search(ctx, 'xxxx'), []);
});

test('verify hashes every source, keeps unchanged rows and clears removed source records', (t) => {
  const ctx = setup(t, 'tr-wiki');
  put(ctx, 'a.md', '[[b]]');
  put(ctx, 'b.md', '# B');
  put(ctx, 'index.md', '[[a]]');
  put(ctx, 'wiki/gunluk-loglar/2026-11-01.md', '## Work\n- Lesson: Learn [[b]]');
  refresh(ctx);
  let reads = 0;
  fs.__setFsHooks({ afterCheck: (path) => { if (path.endsWith('.md')) reads++; } });
  t.after(() => fs.__setFsHooks());
  assert.deepEqual(refresh(ctx, { verify: true }), { added: 0, updated: 0, removed: 0, skipped: [] });
  assert.equal(reads, 4);
  fs.unlinkSync(join(ctx.root, 'a.md'));
  fs.unlinkSync(join(ctx.root, 'index.md'));
  fs.unlinkSync(join(ctx.root, 'wiki/gunluk-loglar/2026-11-01.md'));
  assert.equal(refresh(ctx).removed, 2);
  assert.deepEqual(outlinks(ctx, 'a.md'), []);
  assert.deepEqual(backlinks(ctx, 'b.md'), []);
  assert.deepEqual(journalEntries(ctx), []);
  assert.deepEqual(query(ctx, 'SELECT * FROM catalog'), []);
});

test('ephemeral caches stay outside the data root, and names use case and NFC without slug folding', (t) => {
  const root = tempDir(t);
  const cache = tempDir(t);
  const ctx = { root, schema: PRESETS.default, warnings: [], ephemeral: true,
    indexPath: join(cache, 'cache/acme/index.db') };
  put(ctx, 'notes/Öğe.md'.normalize('NFD'), '# Title');
  put(ctx, 'notes/a.md', '[[ÖĞE.md]] [[OGE]]');
  assert.equal(rows(ctx).length, 2);
  assert.deepEqual(outlinks(ctx, 'notes/a.md').map((link) => link.status), ['resolved', 'unresolved']);
  assert.deepEqual(fs.readdirSync(root), ['notes']);
  assert.equal(fs.statSync(dirname(ctx.indexPath)).mode & 0o777, 0o700);
});

test('a busy version mismatch and a failed replacement preserve the old cache', (t) => {
  const ctx = setup(t);
  put(ctx, 'notes/a.md', '# A');
  refresh(ctx);
  let blocker = new DatabaseSync(ctx.indexPath);
  t.after(() => blocker?.close());
  blocker.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'; BEGIN IMMEDIATE");
  const ino = fs.statSync(ctx.indexPath).ino;
  assert.equal(rows({ ...ctx, warnings: [] }).length, 1);
  assert.equal(fs.statSync(ctx.indexPath).ino, ino);
  blocker.exec('ROLLBACK');
  blocker.close();
  blocker = undefined;
  fs.__setFsHooks({ rename: () => { throw new Error('Replacement unavailable.'); } });
  t.after(() => fs.__setFsHooks());
  const fresh = { ...ctx, warnings: [] };
  assert.equal(rows(fresh).length, 1);
  assert.equal(fs.statSync(ctx.indexPath).ino, ino);
  assert.ok(fresh.warnings.includes('index_unavailable'));
  assert.deepEqual(fs.readdirSync(dirname(ctx.indexPath)), ['index.db']);
});

test('a read after cache corruption rebuilds and populates even with an already fresh context', (t) => {
  const ctx = setup(t);
  put(ctx, 'notes/a.md', '# A');
  assert.equal(rows(ctx).length, 1);
  fs.writeFileSync(ctx.indexPath, 'broken database');
  assert.equal(rows(ctx).length, 1);
});

test('fallback queries retain ids, resolved links, journal filters and schema kinds', (t) => {
  const ctx = setup(t);
  put(ctx, 'notes/a.md', '---\nid: n-acme12\n---\n[[wiki/concepts/b]]\nfoo_bar');
  put(ctx, 'wiki/concepts/b.md', '# B');
  put(ctx, 'journal/2026-11-01.md', '## Work\n- Discovery: New [[a]]');
  refresh(ctx);
  assert.equal(search(ctx, 'foo').length, 1);
  const blocker = new DatabaseSync(ctx.indexPath);
  t.after(() => blocker.close());
  blocker.exec('BEGIN IMMEDIATE');
  const fresh = { ...ctx, warnings: [] };
  assert.deepEqual(findById(fresh, 'n-acme12'), ['notes/a.md']);
  assert.equal(search(fresh, 'foo').length, 1);
  assert.equal(rows(fresh, 'note', { kind: 'concept' }).length, 1);
  assert.equal(outlinks(fresh, 'notes/a.md')[0].status, 'resolved');
  assert.deepEqual(backlinks(fresh, 'wiki/concepts/b.md'), [{ src_path: 'notes/a.md', line: 4, field: null }]);
  assert.equal(journalEntries(fresh, { type: 'discovery', unprocessed: true })[0].text, 'New [[a]]');
  blocker.exec('ROLLBACK');
});

test('ignored Markdown supplies only target names, including ignored directories', (t) => {
  const ctx = setup(t, 'tr-wiki');
  put(ctx, 'a.md', '[[.obsidian/template]] [[raw/source]]');
  put(ctx, '.obsidian/template.md', '---\nkind: note\n---\n[[a]]');
  put(ctx, 'raw/source.md', '[[a]]');
  const read = [];
  fs.__setFsHooks({ afterCheck: (path) => { if (path.endsWith('.md')) read.push(path); } });
  t.after(() => fs.__setFsHooks());
  refresh(ctx);
  assert.deepEqual(read, [join(ctx.root, 'a.md')]);
  assert.deepEqual(outlinks(ctx, 'a.md').map((link) => link.status), ['resolved', 'resolved']);
  assert.equal(rows(ctx).length, 1);
  assert.deepEqual(backlinks(ctx, 'raw/source.md'), []);
});

test('git, dependency and cairn folders are never walked', (t) => {
  const ctx = setup(t, 'tr-wiki');
  put(ctx, 'a.md', '[[readme]] [[hook]]');
  put(ctx, 'node_modules/pkg/readme.md', 'x');
  put(ctx, '.git/hook.md', 'x');
  const seen = [];
  fs.__setFsHooks({ afterCheck: (path) => { seen.push(path); } });
  t.after(() => fs.__setFsHooks());
  refresh(ctx);
  assert.equal(seen.some((path) => /node_modules|[/\\]\.git[/\\]/u.test(path)), false);
  assert.deepEqual(outlinks(ctx, 'a.md').map((link) => link.status), ['unresolved', 'unresolved']);
});
