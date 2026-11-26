import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openContext } from '../core/context.mjs';
import { openIndex, refresh, rows, search } from '../core/index.mjs';
import { runCli } from './support/cli.mjs';
import { fixedClock, seedDataDir, tempDir } from './support/env.mjs';

const clock = fixedClock('2026-11-01T12:00:00Z');

function setup(t) {
  const home = tempDir(t), root = tempDir(t);
  seedDataDir(root, { home, env: {}, clock });
  const ctx = openContext({ mode: 'write', dataDir: root, home, env: {}, clock, actor: 'cli:acme' });
  return { home, root, ctx };
}

function put(root, path, bytes) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
}

function rawRows(ctx) {
  const index = openIndex(ctx);
  try {
    return index.db.prepare('SELECT path, size, sha256, text_ok FROM raw_docs ORDER BY path').all().map((row) => ({ ...row }));
  } finally {
    index.close();
  }
}

test('raw .md and .txt sources are searchable with type raw but are never pages', async (t) => {
  const { home, root, ctx } = setup(t);
  put(root, 'raw/2026-11-01-acme.md', 'Source: https://example.test/a\nDate: 2026-11-01\n\nThe zorblax engine shipped.\n');
  put(root, 'raw/arastirma/notes.txt', 'Plain text mentions zorblax too.\r\n');
  put(root, 'notes/page.md', '# Page\nNothing raw here.\n');
  refresh(ctx);
  const found = search(ctx, 'zorblax', { type: 'raw' });
  assert.deepEqual(found.map((item) => [item.path, item.type, item.title]).sort(), [
    ['raw/2026-11-01-acme.md', 'raw', '2026-11-01-acme'], ['raw/arastirma/notes.txt', 'raw', 'notes']]);
  assert.ok(found.every((item) => item.ref === null && item.id === null && typeof item.snippet === 'string'));
  assert.deepEqual(search(ctx, 'zorblax'), []);
  assert.deepEqual(search(ctx, 'nothing', { type: 'raw' }), []);
  assert.deepEqual(rows(ctx).map((row) => row.path), ['notes/page.md']);
  const opts = { home, data: root, clock };
  const listed = await runCli(['note', 'list', '--all', '--json'], opts);
  assert.deepEqual(listed.json.data.items.map((item) => item.path), ['notes/page.md']);
  const cli = await runCli(['search', 'zorblax', '--type', 'raw', '--json'], opts);
  assert.equal(cli.code, 0, cli.stdout);
  assert.deepEqual(cli.json.data.items.map((item) => [item.path, item.type, item.ref]).sort(),
    [['raw/2026-11-01-acme.md', 'raw', null], ['raw/arastirma/notes.txt', 'raw', null]]);
  assert.ok(cli.json.data.items.every((item) => item.content.snippet.includes('zorblax')));
  const bad = await runCli(['search', 'zorblax', '--type', 'pdf', '--json'], opts);
  assert.equal(bad.code, 5);
  const lint = await runCli(['wiki', 'lint', '--json'], opts);
  assert.equal(lint.code, 0, lint.stdout);
  assert.ok(lint.json.data.findings.every((item) => !item.path.startsWith('raw/')));
});

test('a 30 MB PDF, a large text and non-UTF-8 text under raw never break refresh or enter search', (t) => {
  const { root, ctx } = setup(t);
  put(root, 'raw/paper.pdf', Buffer.concat([Buffer.from('%PDF-1.7 zorblax\n'), Buffer.alloc(30 * 1024 * 1024, 0xff)]));
  put(root, 'raw/latin1.txt', Buffer.from([0x7a, 0x6f, 0x72, 0x62, 0x6c, 0x61, 0x78, 0x20, 0xe7, 0xfe, 0x0a]));
  put(root, 'raw/huge.txt', Buffer.alloc(5 * 1024 * 1024 + 1, 0x7a));
  put(root, 'raw/empty.md', '');
  put(root, 'raw/ok.md', 'zorblax fine\n');
  assert.doesNotThrow(() => refresh(ctx));
  assert.deepEqual(search(ctx, 'zorblax', { type: 'raw' }).map((item) => item.path), ['raw/ok.md']);
  const docs = rawRows(ctx);
  assert.deepEqual(docs.map((row) => [row.path, row.text_ok]), [
    ['raw/empty.md', 1], ['raw/huge.txt', 0], ['raw/latin1.txt', 0], ['raw/ok.md', 1]]);
  assert.equal(docs.find((row) => row.path === 'raw/huge.txt').sha256, null);
  assert.equal(docs.find((row) => row.path === 'raw/ok.md').sha256.length, 64);
});

test('refresh re-reads only raw sources whose stat changed, and drops removed ones', (t) => {
  const { root, ctx } = setup(t);
  put(root, 'raw/a.txt', 'alpha zorblax\n');
  put(root, 'raw/b.md', 'beta\n');
  refresh(ctx);
  const index = openIndex(ctx);
  index.db.exec("UPDATE raw_docs SET sha256 = 'cached' WHERE path = 'raw/a.txt'");
  index.close();
  refresh(ctx);
  assert.equal(rawRows(ctx).find((row) => row.path === 'raw/a.txt').sha256, 'cached');
  writeFileSync(join(root, 'raw/a.txt'), 'gamma\n');
  utimesSync(join(root, 'raw/a.txt'), new Date('2030-01-01'), new Date('2030-01-01'));
  refresh(ctx);
  assert.notEqual(rawRows(ctx).find((row) => row.path === 'raw/a.txt').sha256, 'cached');
  assert.deepEqual(search(ctx, 'zorblax', { type: 'raw' }), []);
  assert.equal(search(ctx, 'gamma', { type: 'raw' })[0].path, 'raw/a.txt');
  assert.equal(search(ctx, 'beta', { type: 'raw' }).length, 1);
  rmSync(join(root, 'raw/b.md'));
  refresh(ctx);
  assert.deepEqual(rawRows(ctx).map((row) => row.path), ['raw/a.txt']);
  assert.deepEqual(search(ctx, 'beta', { type: 'raw' }), []);
});

test('raw search falls back to reading files when the index is unavailable', (t) => {
  const { root, ctx } = setup(t);
  put(root, 'raw/a.txt', 'alpha zorblax\n');
  put(root, 'raw/bad.txt', Buffer.from([0x7a, 0x6f, 0x72, 0x62, 0x6c, 0x61, 0x78, 0x20, 0xff]));
  refresh(ctx);
  const blocker = new DatabaseSync(ctx.indexPath);
  t.after(() => { if (blocker.isOpen) blocker.close(); });
  blocker.exec('BEGIN IMMEDIATE');
  put(root, 'raw/b.md', 'beta zorblax\n');
  const blocked = { ...ctx, warnings: [], indexTimeoutMs: 10 };
  const found = search(blocked, 'zorblax', { type: 'raw' });
  assert.deepEqual(found.map((item) => [item.path, item.type, item.ref]), [['raw/a.txt', 'raw', null], ['raw/b.md', 'raw', null]]);
  assert.deepEqual(search(blocked, 'zorblax'), []);
  assert.ok(blocked.warnings.includes('index_unavailable'));
  blocker.exec('ROLLBACK');
  blocker.close();
});
