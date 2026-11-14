import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.mjs';
import { guard } from '../server/guard.mjs';
import { createRead } from '../server/read.mjs';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { tempDir, fixedClock } from './support/env.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

async function render(cairn) {
  const { handler } = await import('../dist/app/server/entry.mjs');
  const req = new IncomingMessage(new Socket());
  Object.assign(req, { url: '/', method: 'GET', headers: { host: '127.0.0.1:4321' } });
  let output = '';
  const res = new ServerResponse(req);
  res.useChunkedEncodingByDefault = false;
  res.assignSocket(new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } }));
  const finished = new Promise((resolve) => res.once('finish', resolve));
  await createApp({ root, guard, handler, locals: { cairn } })(req, res);
  await finished;
  return { status: res.statusCode, body: output.slice(output.indexOf('\r\n\r\n') + 4) };
}

function fixture(t) {
  const data = tempDir(t), home = tempDir(t), clock = fixedClock('2026-12-10T12:00:00Z');
  initDataDir(data, { home, env: {}, clock });
  const path = join(data, '.cairn/config.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.columns = [{ key: 'queue', label: 'Queue', role: 'todo' },
    { key: 'working', label: 'Work', role: 'doing' }, { key: 'review', label: 'Review', role: 'doing' },
    { key: 'finished', label: 'Finished', role: 'done' }];
  config.home = { featuredProject: 'p-000001' };
  writeFileSync(path, JSON.stringify(config));
  const put = (path, fields, body = '') => {
    mkdirSync(dirname(join(data, path)), { recursive: true });
    writeFileSync(join(data, path), `---\n${Object.entries(fields)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n${body}`);
  };
  put('projects/field.md', { id: 'p-000001', title: 'Field guide', description: 'A guide to river plants' });
  put('projects/sky.md', { id: 'p-000002', title: 'Sky atlas' });
  put('cards/a.md', { id: 'c-000001', title: 'Map the bank', project: 'p-000001', column: 'working',
    now: 'Drawing the east bank', tags: ['mapping', 'field'] });
  put('cards/b.md', { id: 'c-000002', title: 'Gather seeds', project: 'p-000001', column: 'queue' });
  put('cards/c.md', { id: 'c-000003', title: 'Check labels', project: 'p-000001', column: 'review' });
  put('cards/d.md', { id: 'c-000004', title: 'Choose scale', project: 'p-000001', column: 'finished' });
  put('journal/2026-10-01.md', { date: '2026-10-01' }, '## Earlier work\n\n- Read\n');
  put('journal/2026-11-03.md', { date: '2026-11-03' }, '## Plant list\n\n- Read\n');
  put('journal/2026-11-08.md', { date: '2026-11-08' },
    '## River survey · desk\n\n<!-- cairn:project p-000001 -->\n\n- Done\n\n## Label review\n\n- Done\n');
  return { data, path, config, reader: () => createRead({
    open: () => openContext({ mode: 'read', dataDir: data, home, env: {}, clock }),
    render: () => ({ html: '' }),
  }) };
}

test('Home renders stored board, project and newest journal data through the server', async (t) => {
  const f = fixture(t);
  const result = await f.reader().home();
  assert.equal(result.data.inProgress.length, 1, 'review is not the in-progress column');
  assert.deepEqual(result.data.distribution.map((column) => column.total), [1, 1, 1, 1]);
  const { status, body } = await render(f.reader());
  assert.equal(status, 200);
  for (const text of ['1 kart yapılıyor, 1 kart sırada', '2026-12-10', 'A guide to river plants',
    '1/4 kart', 'Drawing the east bank', 'River survey', '2026-11-08', 'mapping', '4 kart']) {
    assert.ok(body.includes(text), text);
  }
  assert.match(body, /href="\/journal\/2026-11-08">Son kayıt/u);
  const calendar = body.match(/<div class="month-grid"[\s\S]*?<\/div>/u)[0];
  assert.equal((calendar.match(/has-entry/gu) ?? []).length, 2);
  assert.match(calendar, /is-latest[^>]*href="\/journal\/2026-11-08"/u);
  assert.match(calendar, /aria-label="8 Kasım 2026, kayıt var, Son kayıt"/u);
  assert.match(calendar, /href="\/journal\/2026-11-03"/u);
  assert.match(body, /class="project-last-job">Son iş\s*<a href="\/journal\/2026-11-08">River survey/u);
  assert.match(body, /stroke-dasharray="25 100"/u);
  assert.match(body, /class="project-cover-link" href="\/projects\/p-000001"/u);
  const progress = body.match(/<section class="panel ongoing"[\s\S]*?<\/section>/u)[0];
  assert.match(progress, /href="\/cards\/c-000001">Map the bank/u);
  assert.doesNotMatch(progress, /Check labels|Gather seeds|Choose scale|field</u);
  const distribution = body.match(/<dl class="home-column-counts">[\s\S]*?<\/dl>/u)[0];
  for (const label of ['Queue', 'Work', 'Review', 'Finished']) {
    assert.match(distribution, new RegExp(`<dt>${label}</dt><dd>1</dd>`, 'u'));
  }
  assert.match(body, /<ol class="home-day-jobs"><li>River survey<\/li><li>Label review<\/li><\/ol>/u);
  assert.ok(body.indexOf('calendar-box') < body.indexOf('project-featured'));
  assert.ok(body.indexOf('project-featured') < body.indexOf('panel ongoing'));
  assert.doesNotMatch(body, /<style\b|\bstyle=|project-percent|project-acceptance/u);
});

test('Home handles empty journal and project selection without browser storage', async (t) => {
  const f = fixture(t);
  rmSync(join(f.data, 'journal'), { recursive: true });
  f.config.home.hiddenProjects = ['p-000001', 'p-000002'];
  writeFileSync(f.path, JSON.stringify(f.config));
  const { status, body } = await render(f.reader());
  assert.equal(status, 200);
  assert.match(body, /0 günde kayıt var/u);
  assert.match(body, /Ana sayfada gösterilecek proje seçmedin/u);
  assert.doesNotMatch(body, /has-entry|is-latest|class="project-box|Son kayıt|home-day-jobs/u);
  assert.match(body, /Henüz kayıtlı gün yok/u);
});

test('Home keeps safe unavailable and failure states', async (t) => {
  t.mock.method(console, 'error', () => {});
  const unavailable = await render(createRead({ open: () => { throw new Error('unavailable'); } }));
  assert.equal(unavailable.status, 409);
  const failed = await render({ home: () => { throw new Error('internal detail'); } });
  assert.equal(failed.status, 500);
  assert.doesNotMatch(failed.body, /internal detail/u);
});

test('Home escapes stored titles and omits missing project and card fields', async (t) => {
  const f = fixture(t);
  const result = await f.reader().home();
  result.data.inProgress[0].content.title = '<img src=x onerror=attack(1)>';
  result.data.inProgress[0].content.now = '';
  result.data.inProgress[0].content.tags = [];
  result.data.projects[0].content.title = '" onmouseover="attack(1)';
  result.data.projectCards[result.data.projects[0].path].status = null;
  result.data.projectCards[result.data.projects[0].path].lastJob = null;
  const { body } = await render({ home: () => result });
  assert.match(body, /&lt;img src=x onerror=attack\(1\)&gt;/u);
  assert.doesNotMatch(body, /<img\b|"\s+onmouseover=/u);
  const progress = body.match(/<section class="panel ongoing"[\s\S]*?<\/section>/u)[0];
  assert.doesNotMatch(progress, /row-detail|class="chip"/u);
  const project = body.match(/<section class="panel project-box[\s\S]*?<\/section>/u)[0];
  assert.doesNotMatch(project, /project-status|project-last-job/u);
});

test('Home renders research box with total, newest 5 links, badges, dates and omits when empty', async (t) => {
  const f = fixture(t);
  const emptyRes = await render(f.reader());
  assert.equal(emptyRes.status, 200);
  assert.doesNotMatch(emptyRes.body, /class="panel research-box"/u);
  assert.match(emptyRes.body, /data-live="[^"]*\bresearch\b[^"]*"/u);

  const putResearch = (name, fields) => {
    mkdirSync(join(f.data, 'research'), { recursive: true });
    writeFileSync(join(f.data, 'research', name), `---\n${Object.entries(fields)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\nBody.\n`);
  };
  putResearch('r1.md', { id: 'r-000001', title: 'Oldest survey', kind: 'source', date: '2026-11-01' });
  putResearch('r2.md', { id: 'r-000002', title: 'Second analysis', kind: 'analysis', date: '2026-11-02' });
  putResearch('r3.md', { id: 'r-000003', title: 'Third review', kind: 'review', date: '2026-11-03' });
  putResearch('r4.md', { id: 'r-000004', title: 'Fourth source', kind: 'source', date: '2026-11-04',
    project: 'p-000001' });
  putResearch('r5.md', { id: 'r-000005', title: '<img src=x>', kind: 'review', category: 'Saha Notu',
    date: '2026-11-05' });
  putResearch('r6.md', { id: 'r-000006', title: 'Newest research', kind: 'analysis', date: '2026-11-06' });

  const { status, body } = await render(f.reader());
  assert.equal(status, 200);
  const box = body.match(/<section class="panel research-box[^"]*"[\s\S]*?<\/section>/u)?.[0];
  assert.ok(box, 'research box is rendered');
  assert.match(box, /<h2[^>]*><a href="\/research">Araştırmalar<\/a><\/h2>/u);
  assert.match(box, /<span class="panel-count">6<\/span>/u);
  assert.match(box, /class="action-link" href="\/research"/u);
  for (const id of ['r-000006', 'r-000005', 'r-000004', 'r-000003', 'r-000002']) {
    assert.match(box, new RegExp(`href="/research/${id}"`, 'u'));
  }
  assert.doesNotMatch(box, /r-000001|Oldest survey/u);
  assert.ok(box.indexOf('r-000006') < box.indexOf('r-000005'));
  assert.ok(box.indexOf('r-000005') < box.indexOf('r-000002'));
  assert.match(box, /Saha Notu/u);
  assert.match(box, /Analiz/u);
  assert.match(box, /Field guide/u);
  assert.match(box, /datetime="2026-11-06"/u);
  assert.match(box, /&lt;img src=x&gt;/u);
  assert.doesNotMatch(box, /<img\b/u);
});
