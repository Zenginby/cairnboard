import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { __setFsHooks } from '../core/fsx.mjs';
import { homeView, boardView, showView } from '../cli/views.mjs';
import { okEnvelope } from '../cli/output.mjs';
import { createRead, DataNotReadyError } from '../server/read.mjs';
import { createRenderPool } from '../server/render-pool.mjs';
import tr from '../src/i18n/tr.json' with { type: 'json' };
import en from '../src/i18n/en.json' with { type: 'json' };
import { language, t as translate } from '../src/i18n/index.mjs';
import { tempDir, fixedClock } from './support/env.mjs';

function fixture(t, body) {
  const data = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(data, { home, env: {}, clock });
  mkdirSync(join(data, 'notes'), { recursive: true });
  writeFileSync(join(data, 'notes/pinned.md'), '---\nid: n-000001\ntitle: Pinned title\npinned: true\n---\nA note.');
  if (body !== undefined) {
    mkdirSync(join(data, 'journal'), { recursive: true });
    writeFileSync(join(data, 'journal/2026-11-01.md'), `---\ndate: 2026-11-01\n---\n${body}`);
  }
  const ctx = openContext({ mode: 'read', dataDir: data, home, env: {}, clock });
  return { ctx, data };
}

test('in-process Home returns the CLI envelope and combines context and view warnings', async (t) => {
  const { ctx } = fixture(t);
  ctx.warnings.push('pending_recovery', 'pending_recovery');
  const view = homeView(ctx);
  let opens = 0;
  const reader = createRead({ open: () => { opens++; return ctx; } });
  const result = await reader.home();
  assert.deepEqual(result, okEnvelope(view.data, [...ctx.warnings, ...view.warnings]));
  assert.equal(result.data.pinned[0].content.title, 'Pinned title');
  assert.equal(result.warnings.filter((code) => code === 'pending_recovery').length, 1);
  await reader.home();
  assert.equal(opens, 2, 'each request opens a fresh read context');
});

test('Home renders the journal from one full source read through the sanitized Markdown worker', async (t) => {
  const body = '## Daily work\n\n**Finished** [[pinned|Pinned title]].\n\n<script>alert("journal attack")</script>';
  const { ctx, data } = fixture(t, body);
  homeView(ctx);
  const source = join(data, 'journal/2026-11-01.md');
  let reads = 0;
  __setFsHooks({ openSync(path, ...args) {
    if (path === source) reads++;
    return openSync(path, ...args);
  } });
  t.after(() => __setFsHooks());
  const pool = createRenderPool();
  t.after(() => pool.close());
  const result = await createRead({ open: () => ctx, render: pool.render }).home();
  assert.equal(reads, 1);
  assert.equal(result.data.journal.content.body, body);
  assert.match(result.data.journal.content.html, /<h2>Daily work<\/h2>/u);
  assert.match(result.data.journal.content.html, /<strong>Finished<\/strong>/u);
  assert.match(result.data.journal.content.html, /href="\/notes\/n-000001"/u);
  assert.doesNotMatch(result.data.journal.content.html, /<script|alert\(|\[\[/u);
});

test('Home renders the full journal rather than its bounded plain-text content', async (t) => {
  const body = `${'a'.repeat(70_000)}\n\n## End marker`;
  const { ctx } = fixture(t, body);
  const result = await createRead({ open: () => ctx, render: (markdown) => {
    assert.equal(markdown, body);
    return { html: '<h2>End marker</h2>' };
  } }).home();
  assert.equal(result.data.journal.content.body.length, 65536);
  assert.equal(result.data.journal.content.html, '<h2>End marker</h2>');
  assert.ok(result.warnings.includes('truncated'));
});

test('Home journal render limits and failures retain plain text with the API warning codes', async (t) => {
  const { ctx } = fixture(t, '## Daily work');
  for (const [flag, code] of [['tooLarge', 'too_large'], ['timedOut', 'render_timeout'], ['failed', 'render_failed']]) {
    const result = await createRead({ open: () => ctx, render: () => ({ html: null, [flag]: true }) }).home();
    assert.equal(result.data.journal.content.html, null);
    assert.equal(result.data.journal.content.body, '## Daily work');
    assert.ok(result.warnings.includes(code), code);
  }
  const oversized = fixture(t, 'x'.repeat(5 * 1024 * 1024 + 1));
  const result = await createRead({ open: () => oversized.ctx, render: () => assert.fail('oversized journal must not reach the worker') }).home();
  assert.equal(result.data.journal.content.html, null);
  assert.ok(result.warnings.includes('too_large'));
});

test('only context-open failures become data-not-ready errors', async () => {
  const failure = new Error('open failed');
  for (const open of [() => { throw failure; }, async () => { throw failure; }]) {
    await assert.rejects(createRead({ open }).home(), (error) => {
      assert.ok(error instanceof DataNotReadyError);
      assert.equal(error.code, 'data_not_ready');
      assert.equal(error.cause, failure);
      return true;
    });
  }
  await assert.rejects(createRead({ open: () => null }).home(), (error) => {
    assert.ok(!(error instanceof DataNotReadyError));
    return true;
  });
});

test('Home dictionaries share keys and the language is chosen in one place', () => {
  assert.deepEqual(Object.keys(tr).sort(), Object.keys(en).sort());
  assert.equal(language, 'tr');
  assert.equal(translate('shell.home'), tr['shell.home']);
  for (const value of [...Object.values(tr), ...Object.values(en)]) assert.ok(value.trim());
});

function documentFixture(t) {
  const data = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(data, { home, env: {}, clock });
  const put = (path, fields, body = '') => {
    mkdirSync(dirname(join(data, path)), { recursive: true });
    writeFileSync(join(data, path), `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n${body}`);
  };
  put('projects/alpha.md', { id: 'p-000001', title: 'Alpha', tone: 3 });
  put('projects/beta.md', { id: 'p-000002', title: 'Beta' });
  put('notes/target.md', { id: 'n-000001', title: 'Target', project: '@projects/alpha.md' }, '## Note body');
  put('cards/work.md', { id: 'c-000001', title: 'Work', column: 'doing', project: 'p-000001' },
    '## Card body\n\n- [x] First\n- [ ] Second\n\n[[target]]\n\n<script>bodyAttack(1)</script>');
  put('cards/related.md', { id: 'c-000002', title: 'Related', column: 'planned', project: '@projects/alpha' });
  put('cards/done.md', { id: 'c-000003', title: 'Done', column: 'done', project: '@projects/alpha.md' });
  put('cards/unknown.md', { id: 'c-000004', title: 'Unknown', column: 'planned', project: 'missing' });
  const open = () => openContext({ mode: 'read', dataDir: data, home, env: {}, clock });
  return { put, open };
}

test('Board and documents join all project reference forms without changing CLI views', async (t) => {
  const { open, put } = documentFixture(t);
  put('notes/other.md', { id: 'n-000002', title: 'Other', project: 'p-000002' });
  const reader = createRead({ open, render: () => ({ html: '<p>Safe body</p>' }) });
  const board = await reader.board();
  const cards = board.data.columns.flatMap((column) => column.cards);
  const project = { id: 'p-000001', title: 'Alpha', tone: 3 };
  for (const id of ['c-000001', 'c-000002', 'c-000003']) assert.deepEqual(cards.find((card) => card.id === id).project, project);
  assert.equal(cards.find((card) => card.id === 'c-000004').project, null);
  const card = await reader.card('c-000001');
  assert.deepEqual(card.data.project, project);
  assert.equal(card.data.column.key, 'doing');
  assert.equal(card.data.column.label, board.data.columns.find((column) => column.key === 'doing').label);
  assert.deepEqual(card.data.relatedCards.map((item) => item.id), ['c-000002']);
  assert.deepEqual((await reader.note('n-000001')).data.project, project);
  assert.equal((await reader.note('n-000002')).data.project.tone, 2);
  assert.equal((await reader.card('c-000004')).data.relatedCards.length, 0);
  const ctx = open();
  assert.ok(boardView(ctx).data.columns.flatMap((column) => column.cards).every((item) => !Object.hasOwn(item, 'project')));
  assert.equal(showView(ctx, 'note', 'n-000001').data.content.project, '@projects/alpha.md');
});

test('Card side panel limits open cards from the same project to eight', async (t) => {
  const { open, put } = documentFixture(t);
  for (let index = 10; index < 20; index++) {
    put(`cards/related-${index}.md`, { id: `c-0000${index}`, title: `Related ${index}`, column: 'planned', project: 'p-000001' });
  }
  const result = await createRead({ open, render: () => ({ html: '' }) }).card('c-000001');
  assert.equal(result.data.relatedCards.length, 8);
  assert.ok(result.data.relatedCards.every((card) => !['c-000001', 'c-000003', 'c-000004'].includes(card.id)));
});

test('Note backlinks resolve index titles and journal date ids, retaining unresolved paths', async (t) => {
  const { open, put } = documentFixture(t);
  put('notes/source.md', { id: 'n-000002', title: '<img src=x onerror=attack(1)>' }, '[[target]]');
  put('journal/2026-11-01.md', { date: 'invalid' }, '[[target]]');
  put('projects/source.md', { id: 'p-000003', title: 'Source project' }, '[[target]]');
  put('notes/hidden\u200b.md', { id: 'n-000003', title: 'Hidden path' }, '[[target]]');
  const result = await createRead({ open, render: () => ({ html: '' }) }).note('n-000001');
  const links = result.data.meta.backlinks;
  assert.deepEqual(links.find((link) => link.type === 'card'), { src_path: 'cards/work.md', line: 12, type: 'card', id: 'c-000001', title: 'Work' });
  assert.equal(links.find((link) => link.type === 'note').title, '<img src=x onerror=attack(1)>');
  assert.equal(links.find((link) => link.type === 'journal').id, '2026-11-01');
  assert.equal(links.find((link) => link.type === 'project').title, 'Source project');
  assert.deepEqual(links.find((link) => link.src_path === 'notes/hidden.md'), { src_path: 'notes/hidden.md', line: 5 });
});

test('Card and Note render sanitized Markdown and retain plain text on every render warning', async (t) => {
  const { open } = documentFixture(t);
  const pool = createRenderPool();
  t.after(() => pool.close());
  const reader = createRead({ open, render: pool.render });
  const card = await reader.card('c-000001');
  assert.match(card.data.content.html, /<h2>Card body<\/h2>/u);
  assert.match(card.data.content.html, /type="checkbox"/u);
  assert.match(card.data.content.html, /href="\/notes\/n-000001"/u);
  assert.doesNotMatch(card.data.content.html, /<script|bodyAttack/u);
  assert.match((await reader.note('n-000001')).data.content.html, /<h2>Note body<\/h2>/u);
  for (const method of ['card', 'note']) {
    const id = method === 'card' ? 'c-000001' : 'n-000001';
    for (const [flag, code] of [['tooLarge', 'too_large'], ['timedOut', 'render_timeout'], ['failed', 'render_failed']]) {
      const result = await createRead({ open, render: () => ({ html: null, [flag]: true }) })[method](id);
      assert.equal(result.data.content.html, null);
      assert.match(result.data.content.body, /## (?:Card|Note) body/u);
      assert.ok(result.warnings.includes(code));
    }
  }
});

test('new readers open a fresh context, distinguish unavailable data and reject unknown ids', async (t) => {
  const { open } = documentFixture(t);
  let opens = 0;
  const reader = createRead({ open: () => { opens++; return open(); }, render: () => ({ html: '' }) });
  await reader.board();
  await reader.card('c-000001');
  await reader.note('n-000001');
  assert.equal(opens, 3);
  for (const method of ['card', 'note']) {
    for (const id of ['missing', '@notes/target', 'n-999999']) await assert.rejects(reader[method](id), { code: 'entity_not_found' });
  }
  for (const method of ['board', 'card', 'note']) {
    await assert.rejects(createRead({ open: () => { throw new Error('unavailable'); } })[method]('n-000001'), { code: 'data_not_ready' });
    await assert.rejects(createRead({ open: () => null })[method]('n-000001'), (error) => error.code !== 'data_not_ready');
  }
});
