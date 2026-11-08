import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import * as fs from '../core/fsx.mjs';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { refresh } from '../core/index.mjs';
import { resolveSchema } from '../core/schema.mjs';
import { exportBoard } from '../core/export.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { reconcileExternal } from '../core/changes.mjs';
import { runCli } from './support/cli.mjs';

for (const custom of [false, true]) {
  test(`Kanban export matches the handwritten ${custom ? 'custom' : 'default'} fixture without writing sources`, (t) => {
    const root = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
    initDataDir(root, { home, env: {}, clock });
    const ctx = openContext({ mode: 'read', dataDir: root, home, env: {}, clock });
    const folder = custom ? 'work/tasks' : 'cards';
    if (custom) {
      ctx.config.columns = [
        { key: 'queue', label: 'Queue', role: 'todo' },
        { key: 'active', label: 'Active', role: 'doing' },
        { key: 'closed', label: 'Closed', role: 'done' },
      ];
      ctx.schema.roots.card.path = folder;
      ctx.schema = resolveSchema({ ...ctx.config, schema: ctx.schema });
    }
    const files = custom ? [
      ['manual', '# Zorblax\n'],
      ['finished', '---\ntitle: Acme\ncolumn: closed\npriority: low\n---\n'],
    ] : [
      ['next', '---\ntitle: Acme\ncolumn: backlog\npriority: urgent\nposition: a1\n---\n'],
      ['first', '---\ntitle: Zorblax\ncolumn: absent\nposition: a0\n---\n'],
      ['working', '---\ntitle: Work\ncolumn: doing\n---\n'],
      ['finished', '---\ntitle: Finished\ncolumn: done\n---\n'],
    ];
    for (const [slug, text] of files) {
      const path = join(root, folder, `${slug}.md`);
      fs.mkdirSync(dirname(path), { recursive: true });
      fs.writeFileSync(path, text);
    }
    refresh(ctx);
    const snapshot = () => fs.readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('index.db'))
      .map((entry) => [join(entry.parentPath, entry.name), fs.readFileSync(join(entry.parentPath, entry.name), 'hex')]);
    const before = snapshot();
    const fixture = new URL(`./fixtures/kanban/${custom ? 'custom' : 'default'}.md`, import.meta.url);
    assert.equal(exportBoard(ctx), fs.readFileSync(fixture, 'utf8'));
    assert.deepEqual(snapshot(), before);
  });
}

test('titles cannot break out of their Kanban wiki link', (t) => {
  const root = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(root, { home, env: {}, clock });
  const ctx = openContext({ mode: 'read', dataDir: root, home, env: {}, clock });
  fs.mkdirSync(join(root, 'cards'), { recursive: true });
  fs.writeFileSync(join(root, 'cards/odd.md'), '---\ntitle: "a|b]] [[x"\n---\n');
  refresh(ctx);
  assert.match(exportBoard(ctx), /^- \[ \] \[\[cards\/odd\|a b x\]\]$/mu);
});

test('board export preserves an owner edit made after preflight reconciliation', async (t) => {
  const root = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(root, { home, env: {}, clock });
  const ctx = openContext({ mode: 'write', dataDir: root, home, env: {}, clock });
  const original = exportBoard(ctx), edited = original + '\nOwner edit\n';
  fs.writeFileSync(join(root, 'board.md'), original);
  reconcileExternal(ctx);
  let seen = 0;
  t.after(() => fs.__setFsHooks());
  fs.__setFsHooks({ afterCheck(path) {
    // Inject between the export's checked destination and its preimage read.
    if (path === join(root, 'board.md') && ++seen === 2) fs.writeFileSync(path, edited);
  } });
  const result = await runCli(['export', 'board', '--actor', 'acme', '--json'], { home, data: root, clock });
  assert.equal(result.code, 4, result.stdout);
  assert.equal(fs.readFileSync(join(root, 'board.md'), 'utf8'), edited);
  assert.equal(reconcileExternal(ctx).recorded, 1);
});
