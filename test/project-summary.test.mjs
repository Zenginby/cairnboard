import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { homeView, projectsView, projectSummary } from '../cli/views.mjs';
import { createRead } from '../server/read.mjs';
import { human } from '../cli/output.mjs';
import { tempDir, fixedClock } from './support/env.mjs';

function fixture(t) {
  const data = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-10T12:00:00Z');
  initDataDir(data, { home, env: {}, clock });
  const file = join(data, '.cairn', 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, agents: { project: 'p-000009' } }));
  const put = (path, fields, body = '') => {
    mkdirSync(dirname(join(data, path)), { recursive: true });
    const lines = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
    writeFileSync(join(data, path), `---\n${lines.join('\n')}\n---\n${body}`);
  };
  const open = () => openContext({ mode: 'read', dataDir: data, home, env: {}, clock });
  return { put, open };
}

const mark = (id) => `<!-- cairn:project ${id} -->`;

function sampleData(t) {
  const f = fixture(t);
  const [todo, doing, , done] = ['todo', 'doing', 'review', 'done'];
  f.put('projects/alpha.md', { id: 'p-000001', title: 'Alpha' });
  f.put('projects/beta.md', { id: 'p-000002', title: 'Beta' });
  f.put('projects/gamma.md', { id: 'p-000003', title: 'Gamma' });
  f.put('projects/agents.md', { id: 'p-000009', title: 'Agent work' });
  // Alpha: a doing card with `now` wins over an earlier todo card with `now`.
  f.put('cards/a1.md', { id: 'c-000001', title: 'Alpha plan', column: todo, project: 'p-000001', now: 'Planning' });
  f.put('cards/a2.md', { id: 'c-000002', title: 'Alpha build', column: doing, project: 'p-000001',
    now: 'Writing the parser' });
  f.put('cards/a3.md', { id: 'c-000003', title: 'Alpha done', column: done, project: 'p-000001' });
  // Beta: no doing card; its first open card has no `now`, so the title is the status.
  f.put('cards/b1.md', { id: 'c-000004', title: 'Beta first', column: todo, project: 'p-000002' });
  f.put('cards/b2.md', { id: 'c-000005', title: 'Beta second', column: todo, project: 'p-000002', now: 'Later' });
  // Gamma has only done cards: no status line.
  f.put('cards/g1.md', { id: 'c-000006', title: 'Gamma done', column: done, project: 'p-000003' });
  // Agent work is not counted for any project.
  f.put('cards/x2.md', { id: 'c-000008', title: 'Agent card', column: doing, project: 'p-000009', now: 'Hidden' });
  // Journal: Alpha's newest job is the later one on the newest day; Beta's is on an older day.
  f.put('journal/2026-11-08.md', { date: '2026-11-08' },
    `## Beta: notes · desk\n\n${mark('p-000002')}\n\n- One\n\n## Alpha: old\n\n${mark('p-000001')}\n\n- Two\n`);
  f.put('journal/2026-11-09.md', { date: '2026-11-09' },
    `## Alpha: first\n\n${mark('p-000001')}\n\n- A\n\n## Loose\n\n- B\n\n## Alpha: second · laptop\n\n`
      + `${mark('p-000001')}\n\n- C\n`);
  return f;
}

test('the project summary gives counts, a status line and the newest linked journal job', (t) => {
  const f = sampleData(t);
  const ctx = f.open();
  const alpha = projectSummary(ctx, { id: 'p-000001', path: 'projects/alpha.md' });
  assert.deepEqual([alpha.total, alpha.done, alpha.doing, alpha.todo], [3, 1, 1, 1], 'agent cards are not counted');
  assert.deepEqual(alpha.status, { text: 'Writing the parser', source: 'now', card: 'c-000002' });
  assert.deepEqual(alpha.lastJob, { title: 'Alpha: second', label: 'laptop', date: '2026-11-09',
    ref: '@journal/2026-11-09' });

  const beta = projectSummary(ctx, { id: 'p-000002', path: 'projects/beta.md' });
  assert.deepEqual(beta.status, { text: 'Beta first', source: 'title', card: 'c-000004' });
  assert.deepEqual(beta.lastJob, { title: 'Beta: notes', label: 'desk', date: '2026-11-08',
    ref: '@journal/2026-11-08' });

  const gamma = projectSummary(ctx, { id: 'p-000003', path: 'projects/gamma.md' });
  assert.deepEqual([gamma.total, gamma.done, gamma.status, gamma.lastJob], [1, 1, null, null]);
});

test('Home, My projects and the project cover read the same summary', async (t) => {
  const f = sampleData(t);
  const home = homeView(f.open(), {}, { scope: 'owner' }).data.projectCards;
  const all = projectsView(f.open()).data.projectCards;
  const cover = (await createRead({ open: f.open, render: () => ({ html: '' }) }).project('p-000001')).data.summary;
  for (const path of ['projects/alpha.md', 'projects/beta.md']) {
    assert.deepEqual(all[path], home[path], path);
  }
  assert.deepEqual(cover, home['projects/alpha.md']);
});

test('card show prints now, next and needs on their own lines', () => {
  const text = human({ type: 'card', meta: { column: 'doing' },
    content: { title: 'Card', now: 'Writing', next: 'Review', needs: 'A name', body: 'Body\n' } });
  assert.equal(text, 'Card\n{"column":"doing"}\nnow: Writing\nnext: Review\nneeds: A name\nBody\n');
  const plain = human({ type: 'card', meta: {}, content: { title: 'Card', body: 'Body' } });
  assert.equal(plain, 'Card\n{}\nBody');
  const note = human({ type: 'note', meta: {}, content: { title: 'Note', now: 'not a card field', body: '' } });
  assert.doesNotMatch(note, /now:/u);
});
