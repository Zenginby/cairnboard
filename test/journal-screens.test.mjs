import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.mjs';
import { guard } from '../server/guard.mjs';
import { createRead, journalMonthResult } from '../server/read.mjs';
import { createRenderPool } from '../server/render-pool.mjs';
import { openContext } from '../core/context.mjs';
import { tempDir, fixedClock, seedDataDir } from './support/env.mjs';
// The pages below are asserted in Turkish. The interface falls back to English, so this file sets the language
// explicitly, the way the server does at start.
process.env.CAIRN_LANGUAGE = 'tr';

const root = fileURLToPath(new URL('../', import.meta.url));
const clock = fixedClock('2026-11-18T12:00:00Z');

// Real Node request/response objects let the test run without permission to bind a socket.
async function inProcess(app, path) {
  const req = new IncomingMessage(new Socket());
  req.url = path;
  req.method = 'GET';
  req.headers = { host: '127.0.0.1:4321' };
  let output = '';
  const socket = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } });
  const res = new ServerResponse(req);
  res.useChunkedEncodingByDefault = false;
  res.assignSocket(socket);
  const finished = new Promise((resolve) => res.once('finish', resolve));
  await app(req, res);
  await finished;
  return { status: res.statusCode, body: output.slice(output.indexOf('\r\n\r\n') + 4) };
}

// Invented data: two projects, 30 weekday-only journal days over October and November 2026.
const OCTOBER = [1, 2, 3, 6, 7, 8, 9, 10, 13, 14, 15, 16, 17, 20, 21, 22, 23, 24];
const NOVEMBER = [2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 16, 17];
const DATES = [...OCTOBER.map((day) => `2026-10-${String(day).padStart(2, '0')}`),
  ...NOVEMBER.map((day) => `2026-11-${String(day).padStart(2, '0')}`)];
const ALPHA = 'p-alpha1', BETA = 'p-beta02';

// Per day: an Alpha job on even dates, a Beta job on dates divisible by three, an unlinked job on every date.
function jobsOf(date) {
  const day = Number(date.slice(8));
  return [
    ...(day % 2 === 0 ? [{ project: ALPHA, title: `Alpha work ${date}`, label: 'build-host-01' }] : []),
    ...(day % 3 === 0 ? [{ project: BETA, title: `Beta work ${date}`, label: 'laptop' }] : []),
    { project: null, title: `Loose work ${date}`, label: 'desk' },
  ];
}

function populateFixture(data, days) {
  seedDataDir(data, { register: false });
  mkdirSync(join(data, 'projects'), { recursive: true });
  for (const [id, title, tone] of [[ALPHA, 'Alpha project', 2], [BETA, 'Beta project', 5]]) {
    writeFileSync(join(data, `projects/${id}.md`),
      `---\nid: ${id}\ntitle: ${title}\ntone: ${tone}\nstatus: active\n---\nBody.\n`);
  }
  mkdirSync(join(data, 'journal'), { recursive: true });
  for (const date of days) {
    const summary = Number(date.slice(8)) % 2 === 0 ? `summary: Summary of ${date}\n` : '';
    const jobs = jobsOf(date).map((job) => `## ${job.title} · ${job.label}\n\n`
      + `${job.project ? `<!-- cairn:project ${job.project} -->\n\n` : ''}`
      + `- **Decision:** first item of ${job.title}\n- second item with [[some page|a link]]\n`
      + '- third\n- fourth item\n').join('\n');
    writeFileSync(join(data, `journal/${date}.md`), `---\ndate: ${date}\n${summary}---\n${jobs}`);
  }
}

function fixtureOpen(data, home) {
  return () => openContext({ mode: 'read', dataDir: data, home, env: {}, clock });
}

function fixture(t, { days = DATES } = {}) {
  const data = tempDir(t);
  populateFixture(data, days);
  return { open: fixtureOpen(data, tempDir(t)), data };
}

let template = null;
let sharedPool = null;
let sharedHandler = null;

before(async () => {
  if (existsSync(join(root, 'dist/app/server/entry.mjs'))) {
    template = realpathSync(mkdtempSync(join(tmpdir(), 'cairn-journal-scr-')));
    populateFixture(template, DATES);
    ({ handler: sharedHandler } = await import('../dist/app/server/entry.mjs'));
    sharedPool = createRenderPool();
  }
});

after(async () => {
  await sharedPool?.close();
  if (template) rmSync(template, { recursive: true, force: true });
});

async function page(t, open) {
  if (!sharedHandler) return t.skip('Astro output missing; run build:app.');
  if (!open) {
    const data = tempDir(t);
    cpSync(template, data, { recursive: true });
    open = fixtureOpen(data, tempDir(t));
  }
  const app = createApp({ root, guard, handler: sharedHandler,
    locals: { cairn: createRead({ open, render: sharedPool.render }) } });
  return (path) => inProcess(app, path);
}

const dayButtons = (html) => new Map([...html.matchAll(
  /<button[^>]*name="day" value="(\d{4}-\d{2}-\d{2})"[^>]*>.*?journal-day-count[^>]*>(\d+)</gsu)]
  .map((m) => [m[1], Number(m[2])]));
const expectedCounts = (month, project) => new Map(DATES.filter((date) => date.startsWith(month))
  .map((date) => [date, jobsOf(date).filter((job) => !project || job.project === project).length])
  .filter(([, count]) => count > 0));

test('the built shell is sticky and leaves room for fragment targets', async (t) => {
  const get = await page(t);
  if (!get) return;
  const { body, status } = await get('/journal');
  assert.equal(status, 200);
  assert.match(body, /<header class="app-shell"[\s>]/u);
  const styles = [...body.matchAll(/<link rel="stylesheet" href="(\/_astro\/[^"]+\.css)"/gu)]
    .map(([, href]) => readFileSync(join(root, 'dist/app/client', href), 'utf8')).join('\n');
  assert.match(styles, /\.app-shell\s*\{[^}]*\bposition:\s*sticky\s*;/u);
  assert.match(styles, /\.app-shell\s*\{[^}]*[;{]\s*top:\s*0\s*[;}]/u);
  assert.match(styles, /:root\s*\{[^}]*\bscroll-padding-top:\s*var\(--shell-scroll-offset\)/u);
  assert.match(styles, /\.app-shell\s*\{[^}]*\banimation-timeline:\s*scroll\(\)/u);
});

test('every recorded day answers 200; unrecorded and malformed dates answer 404', async (t) => {
  const get = await page(t);
  if (!get) return;
  assert.ok(DATES.length >= 28);
  for (const date of DATES) {
    const response = await get(`/journal/${date}`);
    assert.equal(response.status, 200, date);
    assert.match(response.body, new RegExp(`Alpha work|Loose work ${date}`, 'u'));
    assert.match(response.body, /journal-label/u);
  }
  for (const path of ['/journal/2026-11-18', '/journal/2026-10-04', '/journal/2026-02-30', '/journal/nope',
    '/journal/2026-1-1', '/journal/..%2Fnotes']) {
    const response = await get(path);
    assert.equal(response.status, 404, path);
    assert.match(response.body, /404/u);
  }
});

test('the month view marks exactly the recorded days with the right counts and a chip narrows them', async (t) => {
  const get = await page(t);
  if (!get) return;
  // No month in the URL: the month of the newest recorded day.
  const open = await get('/journal');
  // Top tabs: Home, Projects, Board, Notes, Journal, Research, in that order, with Journal current here.
  const tabBar = open.body.match(/<div class="app-tabs">[\s\S]*?<\/div>/u)[0];
  const tabs = [...tabBar.matchAll(/<a href="([^"]+)"([^>]*)>/gu)];
  assert.deepEqual(tabs.map(([, href]) => href), ['/', '/projects', '/board', '/notes', '/journal', '/research']);
  assert.match(tabs[4][2], /aria-current="page"/u);
  assert.equal(open.status, 200);
  assert.match(open.body, /Kasım 2026/u);
  assert.deepEqual(dayButtons(open.body), expectedCounts('2026-11'));
  assert.equal(dayButtons(open.body).size, NOVEMBER.length);
  const october = await get('/journal?month=2026-10');
  assert.deepEqual(dayButtons(october.body), expectedCounts('2026-10'));
  assert.equal(dayButtons(october.body).size, OCTOBER.length);
  assert.doesNotMatch(october.body, /name="day" value="2026-10-04"/u);
  // Weekday headers, Monday first.
  assert.match(october.body, /<th[^>]*>Pzt<\/th>\s*<th[^>]*>Sal</u);
  // Chips: All plus the two linked projects; the unlinked jobs make no chip.
  assert.equal([...october.body.matchAll(/class="journal-chip"/gu)].length, 3);
  const chips = october.body.match(/<form class="journal-filters"[\s\S]*?<\/form>/u)[0];
  assert.equal([...chips.matchAll(/aria-pressed="true"/gu)].length, 1);
  assert.match(chips, /aria-pressed="true"[^>]*>Tümü</u);
  assert.match(october.body, /href="\/journal\?month=2026-09"/u);
  assert.match(october.body, /href="\/journal\?month=2026-11"/u);
  for (const project of [ALPHA, BETA]) {
    const narrowed = await get(`/journal?month=2026-11&project=${project}`);
    assert.equal(narrowed.status, 200);
    assert.deepEqual(dayButtons(narrowed.body), expectedCounts('2026-11', project));
    assert.ok(dayButtons(narrowed.body).size < NOVEMBER.length);
    const name = project === ALPHA ? 'Alpha' : 'Beta';
    assert.match(narrowed.body,
      new RegExp(`class="journal-chip"[^>]*aria-pressed="true"[^>]*>${name} project<`, 'u'));
  }
  // An unknown project and a malformed month are ignored.
  const unknown = await get('/journal?month=bad&project=p-none');
  assert.deepEqual(dayButtons(unknown.body), expectedCounts('2026-11'));
});

test('the preview shows summary, titles, label badges, the day link and respects the project chip', async (t) => {
  const get = await page(t);
  if (!get) return;
  const date = '2026-11-12';
  const preview = await get(`/journal?month=2026-11&day=${date}`);
  assert.equal(preview.status, 200);
  assert.match(preview.body, /id="journal-preview"/u);
  assert.match(preview.body, new RegExp(`href="/journal/${date}">[^<]*12 Kasım 2026`, 'u'));
  assert.match(preview.body, new RegExp(`href="/journal/${date}"[^>]*>Günün tam kaydı<`, 'u'));
  assert.match(preview.body, new RegExp(`Summary of ${date}`, 'u'));
  for (const title of [`Alpha work ${date}`, `Beta work ${date}`, `Loose work ${date}`]) {
    assert.match(preview.body, new RegExp(title, 'u'));
  }
  for (const label of ['build-host-01', 'laptop', 'desk']) {
    assert.match(preview.body, new RegExp(`class="chip journal-label"[^>]*>${label}<`, 'u'));
  }
  assert.match(preview.body, new RegExp(`href="/projects/${ALPHA}"`, 'u'));
  assert.match(preview.body, /first item of Alpha work/u);
  assert.match(preview.body, /a link/u);
  assert.doesNotMatch(preview.body, /\[\[/u);
  assert.match(preview.body, /\+1 madde daha/u, 'only the first three items, then a count');
  // With a chip active: the summary is hidden and only that project's jobs remain.
  const filtered = await get(`/journal?month=2026-11&day=${date}&project=${ALPHA}`);
  assert.doesNotMatch(filtered.body, new RegExp(`Summary of ${date}`, 'u'));
  assert.match(filtered.body, new RegExp(`Alpha work ${date}`, 'u'));
  assert.doesNotMatch(filtered.body, new RegExp(`(?:Beta|Loose) work ${date}`, 'u'));
  // A selected day with no job of the active project says so in one line.
  const none = await get(`/journal?month=2026-11&day=2026-11-05&project=${ALPHA}`);
  assert.match(none.body, /Bu günde seçili projeye ait iş yok/u);
  // A day outside the month or unrecorded opens no preview.
  for (const day of ['2026-10-05', '2026-11-07', 'x']) {
    assert.doesNotMatch((await get(`/journal?month=2026-11&day=${day}`)).body, /id="journal-preview"/u);
  }
});

test('previous and next on the day page skip unrecorded days; it lists and links its jobs', async (t) => {
  const get = await page(t);
  if (!get) return;
  const middle = await get('/journal/2026-10-03');
  assert.match(middle.body, /href="\/journal\/2026-10-02"[^>]*rel="prev"/u);
  assert.match(middle.body, /href="\/journal\/2026-10-06"[^>]*rel="next"/u);
  const across = await get('/journal/2026-10-24');
  assert.match(across.body, /href="\/journal\/2026-11-02"[^>]*rel="next"/u);
  assert.match((await get('/journal/2026-11-02')).body, /href="\/journal\/2026-10-24"[^>]*rel="prev"/u);
  const first = await get(`/journal/${DATES[0]}`);
  assert.doesNotMatch(first.body, /rel="prev"/u);
  const last = await get(`/journal/${DATES.at(-1)}`);
  assert.doesNotMatch(last.body, /rel="next"/u);
  const day = await get('/journal/2026-11-12');
  assert.match(day.body, /href="#job-1"/u);
  assert.match(day.body, /href="#job-3"/u);
  assert.match(day.body, new RegExp(`href="/projects/${BETA}"`, 'u'));
  assert.match(day.body, /<li>second item with <span class="wikilink[^"]*">a link<\/span><\/li>/u,
    'items go through the safe renderer');
  assert.match(day.body, /Summary of 2026-11-12/u);
  // The contents sit in a DocToc grouped by project (first appearance order), the unlinked jobs last; the day
  // itself is wrapped in the panel the month page's dialog imports.
  assert.doesNotMatch(day.body, /journal-contents/u);
  assert.match(day.body, /<div class="journal-day-panel" data-journal-day-panel data-journal-day-date="2026-11-12"/u);
  assert.match(day.body, /data-journal-day-previous="2026-11-11"[^>]*data-journal-day-next="2026-11-13"/su);
  const toc = day.body.match(/<nav class="doc-toc"[\s\S]*?<\/nav>/u)[0];
  const groups = [...toc.matchAll(/<p class="doc-toc-group-label([^"]*)"[^>]*>\s*([^<]+?)\s*<\/p>/gu)]
    .map((m) => [m[2], m[1].trim()]);
  assert.deepEqual(groups, [['Alpha project', 'has-tone tone-2'], ['Beta project', 'has-tone tone-5'],
    ['Projesiz', '']]);
  assert.match(toc, /href="#job-3"[^>]*>Loose work 2026-11-12</u);
  // The month page sends a same-origin referrer so the add dialog's POST carries its origin.
  const month = await get('/journal?month=2026-11');
  assert.match(month.body, /<meta name="referrer" content="same-origin">/u);
  assert.match(month.body, /data-journal-day="2026-11-12"/u);
  assert.match(month.body, /<dialog[^>]*data-journal-day-dialog[^>]*aria-labelledby="journal-dialog-title"/u);
});

test('an empty journal shows the current month and an empty state', async (t) => {
  const get = await page(t, fixture(t, { days: [] }).open);
  if (!get) return;
  const empty = await get('/journal');
  assert.equal(empty.status, 200);
  assert.match(empty.body, /Kasım 2026/u);
  assert.match(empty.body, /Henüz günlük kaydı yok/u);
  assert.equal(dayButtons(empty.body).size, 0);
  assert.equal((await get('/journal/2026-11-18')).status, 404);
});

test('the month reader keeps the raw model: unknown project ids are unlinked and chips need a linked job', (t) => {
  const { open } = fixture(t, { days: ['2026-11-02', '2026-11-03'] });
  const { data } = journalMonthResult(open(), { month: '2026-11', day: '2026-11-02' });
  assert.deepEqual(data.projects.map((project) => project.id), [ALPHA, BETA]);
  assert.deepEqual(data.days, [{ date: '2026-11-02', count: 2 }, { date: '2026-11-03', count: 2 }]);
  assert.deepEqual(data.list.map((day) => day.date), ['2026-11-03', '2026-11-02']);
  assert.equal(data.selected.jobs.length, 2);
  assert.equal(data.previousMonth, '2026-10');
  assert.equal(journalMonthResult(open(), { month: '2026-01' }).data.previousMonth, '2025-12');
});

test('titles, labels, summaries and items are escaped or sanitized on both screens', async (t) => {
  const { open, data } = fixture(t, { days: [] });
  writeFileSync(join(data, 'journal/2026-11-02.md'), '---\ndate: 2026-11-02\nsummary: <b>bold</b>\n---\n'
    + '## <img src=x onerror=attack(1)> · <i>tag</i>\n\n- item <script>attack(2)</script> done\n');
  const get = await page(t, open);
  if (!get) return;
  for (const path of ['/journal?month=2026-11&day=2026-11-02', '/journal/2026-11-02']) {
    const response = await get(path);
    assert.equal(response.status, 200);
    assert.doesNotMatch(response.body, /<img\b|<script>attack|<b>bold|<i>tag/u, path);
    assert.match(response.body, /&lt;img src=x onerror=attack\(1\)&gt;/u, path);
  }
});
