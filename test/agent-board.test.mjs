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
  put('cards/agent-pinned.md',
    { id: 'c-000007', title: 'Agent pinned', column: 'doing', project: 'p-000009', pinned: true });
  put('notes/own-pinned.md', { id: 'n-000001', title: 'Own pinned', pinned: true });
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
  assert.equal(ids(all).length, 7);
  assert.equal(all.data.columns.at(-1).hidden, true);
  assert.ok(!Object.hasOwn(all.data.columns[0], 'hidden'), 'visible columns carry no hidden key');
  assert.ok(!Object.hasOwn(all.data, 'agentProject'));

  const owner = boardView(ctx, {}, { scope: 'owner' });
  assert.deepEqual(keys(owner), ['backlog', 'doing', 'review', 'done']);
  assert.deepEqual(ids(owner), ['c-000001']);

  const agents = boardView(ctx, {}, { scope: 'agents' });
  assert.deepEqual(keys(agents), ['doing', 'review', 'done'], 'an empty planning column is left out');
  assert.deepEqual(ids(agents).sort(), ['c-000003', 'c-000004', 'c-000005', 'c-000007']);
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
    assert.deepEqual(owner, ['c-000001', 'c-000003', 'c-000004', 'c-000005', 'c-000007']);
    const view = boardView(ctx, {}, { scope: 'agents' });
    assert.equal(view.data.agentProject, null);
    assert.equal(ids(view).length, 0);
    assert.equal(homeView(ctx, {}, { scope: 'owner' }).data.agents, null);
  }
});

test('Home leaves agent work out only in the owner scope; CLI and API Home stay as before', async (t) => {
  const { open } = fixture(t);
  const home = homeView(open(), {}, { scope: 'owner' }).data;
  assert.deepEqual(home.openCards.map((card) => card.id), ['c-000001']);
  assert.deepEqual(home.projects.map((project) => project.id), ['p-000001']);
  assert.deepEqual(home.pinned.map((item) => item.id), ['n-000001'], 'a pinned agent card stays off Home');
  assert.equal(home.featuredProject, 'p-000001');
  assert.deepEqual(home.agents.map(({ key, count }) => [key, count]), [['doing', 2], ['review', 1], ['done', 1]]);
  const plain = homeView(open()).data;
  assert.ok(!Object.hasOwn(plain, 'agents'));
  assert.equal(plain.projects.length, 2);
  assert.equal(plain.pinned.length, 2);
  assert.ok(plain.openCards.some((card) => card.id === 'c-000003'));
  const read = createRead({ open, render: () => ({ html: '' }) });
  assert.deepEqual((await read.home()).data.agents, home.agents);
  assert.deepEqual(ids(await read.board({ scope: 'owner' })), ['c-000001']);
  assert.deepEqual(ids(await read.board({ scope: 'archive' })), ['c-000006']);
  assert.equal((await read.board()).data.columns.length, 5, 'no scope: every column, as the CLI and API');
});

test('a configured featured project that is the agents project falls back on the owner Home', (t) => {
  const { open, data } = fixture(t);
  const file = join(data, '.cairn', 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, home: { featuredProject: 'p-000009' } }));
  assert.equal(homeView(open(), {}, { scope: 'owner' }).data.featuredProject, 'p-000001');
  assert.equal(homeView(open()).data.featuredProject, 'p-000009', 'unscoped Home keeps the setting');
});

test('only the archive view lists every card of a hidden done column; other views keep the newest 50', (t) => {
  const { open, data } = fixture(t);
  for (let index = 0; index < 55; index++) {
    const id = `c-1${String(index).padStart(5, '0')}`;
    mkdirSync(join(data, 'cards'), { recursive: true });
    writeFileSync(join(data, 'cards', `old-${index}.md`),
      `---\nid: ${id}\ntitle: Old ${index}\ncolumn: archive\nproject: p-000009\n---\n`);
  }
  const ctx = open();
  const archived = (view) => view.data.columns.find((column) => column.key === 'archive');
  assert.equal(archived(boardView(ctx, {}, { scope: 'archive' })).cards.length, 56);
  assert.equal(archived(boardView(ctx)).cards.length, 50);
  assert.equal(archived(boardView(ctx)).total, 57, 'the owner\'s archived card counts too');
});

test('owner Home counts each project\'s visible cards and lists its open ones; the board narrows to one project',
  async (t) => {
    const { open, data } = fixture(t);
    const put = (path, fields) => writeFileSync(join(data, path),
      `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n`);
    put('cards/own-backlog.md', { id: 'c-000011', title: 'Own backlog', column: 'backlog', project: '@projects/own' });
    put('cards/own-done.md', { id: 'c-000012', title: 'Own done', column: 'done', project: 'p-000001' });
    const home = homeView(open(), {}, { scope: 'owner' }).data;
    // The archived card is not counted; the doing card leads the open list; agent work is not on the owner's Home.
    assert.deepEqual(home.projectCards, { 'projects/own.md': { total: 3, done: 1, doing: 1, todo: 1, upcoming: [
      { id: 'c-000001', title: 'Own doing', column: { key: 'doing', label: 'Doing', role: 'doing' } },
      { id: 'c-000011', title: 'Own backlog', column: { key: 'backlog', label: 'Backlog', role: 'todo' } },
    ] } });
    assert.ok(!Object.hasOwn(homeView(open()).data, 'projectCards'), 'CLI and API Home stay as before');

    const read = createRead({ open, render: () => ({ html: '' }) });
    const narrowed = await read.board({ scope: 'owner', project: 'p-000001' });
    assert.deepEqual(ids(narrowed).sort(), ['c-000001', 'c-000011', 'c-000012']);
    assert.equal(narrowed.data.project.title, 'Own');
    const unknown = await read.board({ scope: 'owner', project: 'p-999999' });
    assert.ok(!Object.hasOwn(unknown.data, 'project'));
    assert.equal(ids(unknown).length, 3, 'an unknown project shows the whole owner board');
  });
