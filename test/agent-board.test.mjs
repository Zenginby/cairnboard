import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { defaultConfig, loadConfig } from '../core/config.mjs';
import { boardView, homeView } from '../cli/views.mjs';
import { createRead } from '../server/read.mjs';
import { tempDir, fixedClock } from './support/env.mjs';

const ARCHIVE = { key: 'archive', label: 'Archive', role: 'done', hidden: true };

function fixture(t, agents = { project: 'p-000009' }) { // `null`: no agents setting
  const data = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(data, { home, env: {}, clock });
  const file = join(data, '.cairn', 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.columns.push(ARCHIVE);
  if (agents !== null) config.agents = agents;
  writeFileSync(file, JSON.stringify(config));
  const put = (path, fields) => {
    mkdirSync(dirname(join(data, path)), { recursive: true });
    const lines = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
    writeFileSync(join(data, path), `---\n${lines.join('\n')}\n---\n`);
  };
  put('projects/own.md', { id: 'p-000001', title: 'Own' });
  put('projects/agents.md', { id: 'p-000009', title: 'Agent work' });
  put('cards/own-doing.md', { id: 'c-000001', title: 'Own doing', column: 'doing', project: 'p-000001' });
  put('cards/own-archived.md', { id: 'c-000002', title: 'Own archived', column: 'archive', project: 'p-000001' });
  // Every project reference form must count as the agents project.
  put('cards/agent-running.md', { id: 'c-000003', title: 'Agent running', column: 'doing', project: 'p-000009' });
  put('cards/agent-review.md',
    { id: 'c-000004', title: 'Agent review', column: 'review', project: '@projects/agents' });
  put('cards/agent-done.md', { id: 'c-000005', title: 'Agent done', column: 'done', project: '@projects/agents.md' });
  put('cards/agent-archived.md', { id: 'c-000006', title: 'Agent archived', column: 'archive', project: 'p-000009' });
  const open = () => openContext({ mode: 'read', dataDir: data, home, env: {}, clock });
  return { open, data };
}

const ids = (view) => view.data.columns.flatMap((column) => column.cards.map((card) => card.id));
const keys = (view) => view.data.columns.map((column) => column.key);

test('config accepts boolean hidden columns and an agents object, nothing else', (t) => {
  const root = tempDir(t, 'cairn-data-');
  mkdirSync(join(root, '.cairn'));
  const file = join(root, '.cairn', 'config.json');
  const valid = defaultConfig('en');
  for (const config of [{ ...valid, columns: [...valid.columns, ARCHIVE] }, { ...valid, agents: {} },
    { ...valid, agents: { project: 'p-000001' } }, { ...valid, columns: [{ ...valid.columns[0], hidden: false }] }]) {
    writeFileSync(file, JSON.stringify(config));
    assert.deepEqual(loadConfig(root), config);
  }
  for (const invalid of [{ ...valid, columns: [...valid.columns, { ...ARCHIVE, hidden: 'yes' }] },
    { ...valid, columns: valid.columns.map((column) => ({ ...column, hidden: true })) },
    { ...valid, agents: null }, { ...valid, agents: [] }, { ...valid, agents: 'p-000001' },
    { ...valid, agents: { project: 1 } }]) {
    writeFileSync(file, JSON.stringify(invalid));
    assert.throws(() => loadConfig(root), { code: 'validation' }, JSON.stringify(invalid.agents ?? invalid.columns));
  }
});

test('the CLI board keeps every column and card; the web scopes split owner, agent and archive work', (t) => {
  const { open } = fixture(t);
  const ctx = open();
  const all = boardView(ctx);
  assert.deepEqual(keys(all), ['backlog', 'doing', 'review', 'done', 'archive']);
  assert.equal(ids(all).length, 6);
  assert.equal(all.data.columns.at(-1).hidden, true);
  assert.ok(!Object.hasOwn(all.data.columns[0], 'hidden'), 'visible columns carry no hidden key');
  assert.ok(!Object.hasOwn(all.data, 'agentProject'));

  const owner = boardView(ctx, {}, { scope: 'owner' });
  assert.deepEqual(keys(owner), ['backlog', 'doing', 'review', 'done']);
  assert.deepEqual(ids(owner), ['c-000001']);

  const agents = boardView(ctx, {}, { scope: 'agents' });
  assert.deepEqual(keys(agents), ['doing', 'review', 'done'], 'an empty planning column is left out');
  assert.deepEqual(ids(agents).sort(), ['c-000003', 'c-000004', 'c-000005']);
  assert.equal(agents.data.agentProject, 'p-000009');
  assert.equal(agents.data.archived, 1, 'only agent cards count toward the archive link');

  const archive = boardView(ctx, {}, { scope: 'archive' });
  assert.deepEqual(keys(archive), ['archive']);
  assert.deepEqual(ids(archive), ['c-000006']);
  assert.equal(archive.data.archived, null);
});

test('without a resolvable agents project the owner board shows every card and the agent board none', (t) => {
  for (const agents of [null, { project: 'p-999999' }, {}]) {
    const { open } = fixture(t, agents);
    const ctx = open();
    const owner = ids(boardView(ctx, {}, { scope: 'owner' })).sort();
    assert.deepEqual(owner, ['c-000001', 'c-000003', 'c-000004', 'c-000005']);
    const view = boardView(ctx, {}, { scope: 'agents' });
    assert.equal(view.data.agentProject, null);
    assert.equal(ids(view).length, 0);
    assert.equal(homeView(ctx).data.agents, null);
  }
});

test('Home leaves agent cards and the agents project out and counts agent work per visible column', async (t) => {
  const { open } = fixture(t);
  const home = homeView(open()).data;
  assert.deepEqual(home.openCards.map((card) => card.id), ['c-000001']);
  assert.deepEqual(home.projects.map((project) => project.id), ['p-000001']);
  assert.equal(home.featuredProject, 'p-000001');
  assert.deepEqual(home.agents.map(({ key, count }) => [key, count]), [['doing', 1], ['review', 1], ['done', 1]]);
  const read = createRead({ open, render: () => ({ html: '' }) });
  assert.deepEqual(ids(await read.board({ scope: 'owner' })), ['c-000001']);
  assert.deepEqual(ids(await read.board({ scope: 'archive' })), ['c-000006']);
  assert.equal((await read.board()).data.columns.length, 5, 'no scope: every column, as the CLI and API');
});
