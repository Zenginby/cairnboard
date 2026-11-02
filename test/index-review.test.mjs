import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as fs from '../core/fsx.mjs';
import { tempDir } from './support/env.mjs';
import { PRESETS } from '../core/presets.mjs';
import { openIndex, refresh, rows, search, backlinks, outlinks } from '../core/index.mjs';

function setup(t, preset = 'default') {
  const root = tempDir(t);
  return { root, schema: structuredClone(PRESETS[preset]), warnings: [], indexPath: join(root, '.cairn/index.db'), indexTimeoutMs: 10 };
}
function put(ctx, path, text) {
  fs.mkdirSync(dirname(join(ctx.root, path)), { recursive: true });
  fs.writeFileSync(join(ctx.root, path), text);
}

test('search is answered by the index, with the original title', (t) => {
  const ctx = setup(t);
  put(ctx, 'notes/a.md', '# IŞIK\nmetin');
  refresh(ctx);
  const [hit] = search(ctx, 'isik');
  assert.equal(hit.title, 'IŞIK');
  assert.deepEqual(ctx.warnings, []);
});

test('a schema change resets the cache in place instead of replacing the file', (t) => {
  const ctx = setup(t);
  put(ctx, 'notes/a.md', '# A');
  refresh(ctx);
  const ino = fs.statSync(ctx.indexPath).ino;
  const db = new DatabaseSync(ctx.indexPath);
  db.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
  db.close();
  assert.equal(refresh(ctx).added, 1);
  assert.equal(fs.statSync(ctx.indexPath).ino, ino);
  assert.deepEqual(ctx.warnings, []);
});

test('a file that shrinks below the size limit during refresh is indexed from what was read', (t) => {
  const ctx = setup(t);
  put(ctx, 'notes/b.md', '# B');
  put(ctx, 'notes/big.md', `# Big\n${'x'.repeat(6 * 1024 * 1024)}`);
  let swapped = false;
  fs.__setFsHooks({ afterCheck: (path) => {
    if (!swapped && path.endsWith('big.md')) { swapped = true; fs.writeFileSync(path, '# Small\n[[b]]'); }
  } });
  t.after(() => fs.__setFsHooks());
  refresh(ctx);
  fs.__setFsHooks();
  const row = rows(ctx).find((item) => item.path === 'notes/big.md');
  assert.equal(row.title, 'Small');
  assert.equal(row.error, null);
  assert.deepEqual(backlinks(ctx, 'notes/b.md').map((link) => link.src_path), ['notes/big.md']);
});

test('one note with cyclic YAML does not break refresh or queries', (t) => {
  const ctx = setup(t);
  put(ctx, 'notes/a.md', '# A');
  put(ctx, 'notes/cycle.md', '---\nkind: &x [*x]\n---\n# Cycle');
  const result = refresh(ctx);
  assert.ok(result.skipped.some((item) => item.path === 'notes/cycle.md'));
  assert.deepEqual(rows(ctx).map((row) => row.path), ['notes/a.md']);
  fs.writeFileSync(ctx.indexPath, 'broken database');
  fs.__setFsHooks({ rename: () => { throw new Error('no replacement'); } });
  t.after(() => fs.__setFsHooks());
  assert.deepEqual(rows({ ...ctx, warnings: [] }).map((row) => row.path), ['notes/a.md']);
});

test('a context that was fresh notices a rebuilt cache', (t) => {
  const ctx = setup(t);
  put(ctx, 'notes/a.md', '# A');
  assert.equal(rows(ctx).length, 1);
  fs.writeFileSync(ctx.indexPath, 'broken database');
  // Another process rebuilds the empty cache and has not populated it yet.
  openIndex({ ...ctx, warnings: [] }).close();
  assert.equal(rows(ctx).length, 1);
});

test('broken frontmatter links survive indexing, and outlinks keep the exact target name', (t) => {
  const ctx = setup(t);
  put(ctx, 'notes/b.md', '# B');
  put(ctx, 'notes/a`x`.md', '# AX');
  put(ctx, 'notes/a.md', '---\nsources: ["[[b]]"\n---\n# A');
  put(ctx, 'notes/c.md', '---\nsources: ["[[a`x`]]"]\n---\n# C');
  refresh(ctx);
  assert.deepEqual(backlinks(ctx, 'notes/b.md').map((link) => link.src_path), ['notes/a.md']);
  const [link] = outlinks(ctx, 'notes/c.md');
  assert.equal(link.targetName, 'a`x`');
  assert.equal(link.target_path, 'notes/a`x`.md');
});
