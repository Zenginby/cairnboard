import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.mjs';
import { createApi } from '../server/api.mjs';
import { createGuard, guard } from '../server/guard.mjs';
import { createRead } from '../server/read.mjs';
import { createRenderPool } from '../server/render-pool.mjs';
import { loginUrl, siteHost } from '../server/session.mjs';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { APP_ALLOWLIST, filterAllowed } from '../scripts/lib/design-check/allowlist.mjs';
import { resolveBrowser } from '../scripts/lib/design-check/config.mjs';
import { filterBoardCards } from '../src/scripts/board-filter.js';
import { fixedClock, tempDir } from './support/env.mjs';
import { liveCleanup, liveUnavailable } from './support/live.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const key = Buffer.alloc(32, 5);
const instance = 'run-cccccccccccccccc';

const SAMPLE_CARDS = [
  { id: 'c-1', column: 'todo', project: 'p-north', priority: 'urgent' },
  { id: 'c-2', column: 'todo', project: 'p-garden', priority: '' },
  { id: 'c-3', column: 'doing', project: 'p-north', priority: 'important' },
  { id: 'c-4', column: 'review', project: '', priority: 'urgent' },
];
const SAMPLE_COLUMNS = ['todo', 'doing', 'review', 'done'];

test('filterBoardCards returns matching cards and per-column counts', () => {
  const all = filterBoardCards(SAMPLE_CARDS, {}, SAMPLE_COLUMNS);
  assert.deepEqual(all.visible.map((c) => c.id), ['c-1', 'c-2', 'c-3', 'c-4']);
  assert.equal(all.total, 4);
  assert.deepEqual(all.counts, { todo: 2, doing: 1, review: 1, done: 0 });

  const byProject = filterBoardCards(SAMPLE_CARDS, { project: 'p-north' }, SAMPLE_COLUMNS);
  assert.deepEqual(byProject.visible.map((c) => c.id), ['c-1', 'c-3']);
  assert.equal(byProject.total, 2);
  assert.deepEqual(byProject.counts, { todo: 1, doing: 1, review: 0, done: 0 });

  const byPriority = filterBoardCards(SAMPLE_CARDS, { priority: 'urgent' }, SAMPLE_COLUMNS);
  assert.deepEqual(byPriority.visible.map((c) => c.id), ['c-1', 'c-4']);
  assert.equal(byPriority.total, 2);
  assert.deepEqual(byPriority.counts, { todo: 1, doing: 0, review: 1, done: 0 });

  const both = filterBoardCards(SAMPLE_CARDS, { project: 'p-north', priority: 'urgent' }, SAMPLE_COLUMNS);
  assert.deepEqual(both.visible.map((c) => c.id), ['c-1']);
  assert.equal(both.total, 1);
  assert.deepEqual(both.counts, { todo: 1, doing: 0, review: 0, done: 0 });

  const empty = filterBoardCards(SAMPLE_CARDS, { project: 'p-garden', priority: 'urgent' }, SAMPLE_COLUMNS);
  assert.deepEqual(empty.visible, []);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.counts, { todo: 0, doing: 0, review: 0, done: 0 });
});

test('filterBoardCards searches card text (Turkish-aware) and counts priorities under the other filters', () => {
  const cards = [
    { id: 'c-1', column: 'todo', project: 'p-north', priority: 'urgent', text: 'Harita İzleri North Route' },
    { id: 'c-2', column: 'todo', project: 'p-garden', priority: '', text: 'Sera sulama Garden' },
    { id: 'c-3', column: 'doing', project: 'p-north', priority: 'important', text: 'Kontur çizgileri North Route' },
    { id: 'c-4', column: 'review', project: '', priority: 'urgent', text: 'Defter' },
  ];
  const byQuery = filterBoardCards(cards, { query: '  izler ' }, SAMPLE_COLUMNS);
  assert.deepEqual(byQuery.visible.map((c) => c.id), ['c-1']);
  assert.deepEqual(byQuery.counts, { todo: 1, doing: 0, review: 0, done: 0 });

  const byProjectName = filterBoardCards(cards, { query: 'north' }, SAMPLE_COLUMNS);
  assert.deepEqual(byProjectName.visible.map((c) => c.id), ['c-1', 'c-3']);
  assert.deepEqual(byProjectName.priorityCounts, { '': 2, urgent: 1, important: 1, low: 0 });

  const narrowed = filterBoardCards(cards, { query: 'north', priority: 'urgent' }, SAMPLE_COLUMNS);
  assert.deepEqual(narrowed.visible.map((c) => c.id), ['c-1']);
  assert.deepEqual(narrowed.priorityCounts, { '': 2, urgent: 1, important: 1, low: 0 },
    'priority counts ignore the priority choice itself');

  assert.deepEqual(filterBoardCards(cards, { query: 'yok' }, SAMPLE_COLUMNS).visible, []);
  assert.equal(filterBoardCards(cards, { query: '   ' }, SAMPLE_COLUMNS).total, 4, 'a blank query hides nothing');
});

function fixture(t) {
  const dataDir = tempDir(t);
  const home = tempDir(t);
  const clock = fixedClock('2026-11-10T12:00:00Z');
  initDataDir(dataDir, { home, env: {}, clock });
  const configFile = join(dataDir, '.cairn/config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.agents = { project: 'p-agent1' };
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);

  const writeMd = (relPath, fields, body = 'Not.\n') => {
    const dir = join(dataDir, relPath.split('/')[0]);
    mkdirSync(dir, { recursive: true });
    const lines = Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
    writeFileSync(join(dataDir, relPath), `---\n${lines.join('\n')}\n---\n${body}`);
  };

  writeMd('projects/kuzey.md', { id: 'p-kuzey1', title: 'Kuzey Rotası', tone: 1, status: 'active' });
  writeMd('projects/bahce.md', { id: 'p-bahce2', title: 'Kış Bahçesi', tone: 4, status: 'active' });
  writeMd('projects/bos.md', { id: 'p-bos003', title: 'Boş Proje', tone: 2, status: 'active' });
  writeMd('projects/ajan.md', { id: 'p-agent1', title: 'Ajan İşleri', tone: 6, status: 'active' });

  writeMd('cards/harita-cizimi.md', {
    id: 'c-kuz001',
    title: 'Harita katmanlarını düzenle',
    column: 'doing',
    project: 'p-kuzey1',
    priority: 'urgent',
    now: 'Kontur çizgileri yeniden ölçekleniyor',
    next: 'Bu satır pano kart yüzünde görünmemeli',
    needs: 'Son baskı boyutunu onayla',
  });
  writeMd('cards/sera-sulama.md', {
    id: 'c-bah002',
    title: 'Sera sulama vanasını kontrol et',
    column: 'backlog',
    project: 'p-bahce2',
    priority: 'important',
    now: 'Basınç ölçer bağlandı',
  });
  writeMd('cards/genel-defter.md', {
    id: 'c-gen003',
    title: 'Defter sayfalarını numarala',
    column: 'backlog',
    tags: ['bekliyor'],
  });
  writeMd('cards/ajan-karti.md', {
    id: 'c-agn004',
    title: 'Ajan iş kartı',
    column: 'doing',
    project: 'p-agent1',
    now: 'Ajan tarafında sürdürülüyor',
  });

  const open = () => openContext({ mode: 'read', dataDir, home, env: {}, clock });
  return { open, dataDir };
}

async function inProcess(app, path) {
  const req = new IncomingMessage(new Socket());
  req.url = path;
  req.method = 'GET';
  req.headers = { host: '127.0.0.1:4321' };
  let output = '';
  const socket = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  const res = new ServerResponse(req);
  res.useChunkedEncodingByDefault = false;
  res.assignSocket(socket);
  const finished = new Promise((resolve) => res.once('finish', resolve));
  await app(req, res);
  await finished;
  return { status: res.statusCode, body: output.slice(output.indexOf('\r\n\r\n') + 4) };
}

test('/board smoke: 200, search, project choice, priority pills and counter in HTML, now/needs and no next',
  async (t) => {
  if (!existsSync(join(repo, 'dist/app/server/entry.mjs'))) {
    t.skip('Astro output missing; run npm run build:app to enable integration coverage.');
    return;
  }
  const { open } = fixture(t);
  const { handler } = await import('../dist/app/server/entry.mjs');
  const pool = createRenderPool();
  t.after(() => pool.close());
  const app = createApp({ root: repo, guard, handler, locals: { cairn: createRead({ open, render: pool.render }) } });

  const board = await inProcess(app, '/board');
  assert.equal(board.status, 200);
  assert.match(board.body, /data-board-toolbar/u);
  assert.match(board.body,
    /<input[^>]*id="board-search"[^>]*type="search"[^>]*data-board-search[^>]*data-slash-search/u);
  assert.match(board.body,
    /<select[^>]*id="board-project"[^>]*data-board-project[^>]*>\s*<option value="">Tüm projeler/u);
  assert.match(board.body, /<option value="p-bahce2">Kış Bahçesi<\/option>\s*<option value="p-kuzey1">Kuzey Rotası/u);
  assert.doesNotMatch(board.body, /Boş Proje/u, 'a project with no cards on the board is not offered');
  assert.match(board.body, /<button[^>]*data-filter-priority=""[^>]*aria-pressed="true"[^>]*>\s*Tümü\s*<span[^>]*>3</u);
  assert.match(board.body, /<button[^>]*data-board-clear[^>]*hidden/u);
  assert.match(board.body, /<button[^>]*data-filter-priority="urgent"[^>]*aria-pressed="false"/u);
  assert.match(board.body, /<button[^>]*data-filter-priority="important"[^>]*aria-pressed="false"/u);
  assert.doesNotMatch(board.body, /data-filter-priority="low"/u, 'unused priority gets no pill');
  assert.match(board.body, /aria-live="polite"[^>]*data-board-summary[^>]*>\s*3 kart · 3 sütun\s*</u);

  // Columns that share a role (doing, review) become one lane; the link shows every column again.
  assert.match(board.body,
    /<section class="board-column role-doing"[^>]*data-column-key="doing"[\s\S]*?<h2[^>]*>Sürüyor</u);
  assert.match(board.body, /<span class="chip column-chip">Doing<\/span>/u);
  assert.match(board.body, /<a class="action-link board-columns-toggle" href="\/board\?columns=all">4 sütunu göster/u);
  const all = await inProcess(app, '/board?columns=all');
  assert.match(all.body, /data-board-summary[^>]*>\s*3 kart · 4 sütun\s*</u);
  assert.doesNotMatch(all.body, /column-chip/u);
  assert.match(all.body, /href="\/board\?columns=lanes">Sütunları grupla/u);

  assert.match(board.body, /class="status-lines"/u);
  assert.match(board.body, /Kontur çizgileri yeniden ölçekleniyor/u);
  assert.match(board.body, /Son baskı boyutunu onayla/u);
  assert.doesNotMatch(board.body, /Bu satır pano kart yüzünde görünmemeli/u);

  const agents = await inProcess(app, '/agents');
  assert.equal(agents.status, 200);
  assert.doesNotMatch(agents.body, /data-board-toolbar/u);
  assert.doesNotMatch(agents.body, /Ajan tarafında sürdürülüyor/u);
});

test('/board interactive browser smoke: search, project choice, pills, keyboard, empty state and axe', async (t) => {
  const cleanup = liveCleanup(t);
  if (!existsSync(join(repo, 'dist/app/server/entry.mjs'))) {
    return liveUnavailable(t, 'Astro output missing; run npm run build:app to enable integration coverage.');
  }
  let browser;
  try {
    const { executablePath } = resolveBrowser('chromium', { downloadedPath: chromium.executablePath() });
    browser = await chromium.launch({
      executablePath,
      headless: true,
      timeout: 15_000,
      args: ['--no-proxy-server', '--host-resolver-rules=MAP *.cairnboard.localhost 127.0.0.1'],
    });
  } catch (error) {
    return liveUnavailable(t, `Browser unavailable: ${error.message.split('\n')[0]}`);
  }
  cleanup(() => browser.close());

  const server = createServer();
  cleanup(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    return liveUnavailable(t, 'Loopback listen unavailable');
  }
  const port = server.address().port;
  const { open } = fixture(t);
  const pool = createRenderPool();
  t.after(() => pool.close());
  const { handler } = await import('../dist/app/server/entry.mjs');
  const app = createApp({
    root: repo,
    handler,
    guard: createGuard({ port, key, instance }),
    api: createApi({ open, events: { handle(_req, res) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('retry: 2000\n\n');
      return true;
    } } }),
    locals: { cairn: createRead({ open, render: pool.render }) },
  });
  server.on('request', app);

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  cleanup(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (error) => errors.push(error.message));

  const origin = `http://${siteHost(key)}:${port}`;
  await page.goto(loginUrl(port, key, instance));
  await page.waitForURL(`${origin}/`, { timeout: 10_000 });
  const response = await page.goto(`${origin}/board`);
  assert.equal(response?.status(), 200);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));

  const axeSource = readFileSync(fileURLToPath(import.meta.resolve('axe-core/axe.min.js')), 'utf8');
  await page.evaluate(axeSource);
  const regions = [...new Set(APP_ALLOWLIST.map((item) => item.within))];
  const found = await page.evaluate(async (withinRegions) => {
    const result = await window.axe.run(document, { resultTypes: ['violations'] });
    return result.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      nodes: nodes.map((node) => {
        const element = document.querySelector(node.target[0]);
        return { within: withinRegions.filter((region) => element?.closest(region)) };
      }),
    }));
  }, regions);
  assert.deepEqual(filterAllowed(found, APP_ALLOWLIST), [], '/board: no axe findings');

  const summary = page.locator('[data-board-summary]');
  assert.equal((await summary.innerText()).trim(), '3 kart · 3 sütun');
  const clamp = await page.locator('#card-c-kuz001 .status-line-now dd')
    .evaluate((el) => getComputedStyle(el).webkitLineClamp);
  assert.equal(clamp, '2');

  // `/` focuses the board's own search (not the global dialog).
  // A query matches titles, status values and project names.
  const search = page.locator('#board-search');
  await page.locator('h1').click();
  await page.keyboard.press('/');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'board-search');
  assert.equal(await page.locator('dialog[open]').count(), 0);
  await page.keyboard.type('KONTUR');
  assert.equal((await summary.innerText()).trim(), '1 kart · 3 sütun');
  assert.equal(await page.locator('#card-c-kuz001').isVisible(), true);
  assert.equal(await page.locator('#card-c-bah002').isVisible(), false);
  const clear = page.getByRole('button', { name: 'Süzgeçleri temizle' });
  assert.equal(await clear.isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await search.inputValue(), '');
  assert.equal((await summary.innerText()).trim(), '3 kart · 3 sütun');
  assert.equal(await clear.isVisible(), false);
  await search.fill('kış bahçesi');
  assert.equal((await summary.innerText()).trim(), '1 kart · 3 sütun', 'the project name is searched');
  assert.equal(await page.locator('#card-c-bah002').isVisible(), true);
  await search.fill('şimdi');
  assert.equal((await summary.innerText()).trim(), '0 kart · 3 sütun', 'status labels are not searched');
  await search.fill('BEKLİYOR');
  assert.equal((await summary.innerText()).trim(), '1 kart · 3 sütun', 'tags are searched, though not shown');
  assert.equal(await page.locator('#card-c-gen003').isVisible(), true);
  await search.fill('');

  // Choose Kuzey Rotası: only c-kuz001 in doing remains visible; backlog becomes empty and shows board.empty.
  await page.locator('#board-project').selectOption('p-kuzey1');
  assert.equal((await summary.innerText()).trim(), '1 kart · 3 sütun');
  assert.equal(await page.locator('#card-c-kuz001').isVisible(), true);
  assert.equal(await page.locator('#card-c-bah002').isVisible(), false);
  assert.equal(await page.locator('#card-c-gen003').isVisible(), false);
  const backlogCol = page.locator('[data-column-key="backlog"]');
  assert.equal((await backlogCol.locator('[data-column-count]').innerText()).trim(), '0');
  assert.equal(await backlogCol.locator('[data-column-empty]').isVisible(), true);
  const importantPill = page.locator('[data-filter-priority="important"]');
  assert.equal((await importantPill.locator('[data-priority-count]').innerText()).trim(), '0',
    'priority counts follow the project choice');

  // Combine with Önemli: 0 matching cards across the whole board.
  await importantPill.focus();
  await page.keyboard.press('Space');
  assert.equal(await importantPill.getAttribute('aria-pressed'), 'true');
  assert.equal((await summary.innerText()).trim(), '0 kart · 3 sütun');

  // Toggle Önemli back off with keyboard Enter, then reset everything with the clear button.
  await page.keyboard.press('Enter');
  assert.equal(await importantPill.getAttribute('aria-pressed'), 'false');
  assert.equal((await summary.innerText()).trim(), '1 kart · 3 sütun');

  await clear.click();
  assert.equal(await page.locator('#board-project').inputValue(), '');
  assert.equal(await page.locator('[data-filter-priority=""]').getAttribute('aria-pressed'), 'true');
  assert.equal((await summary.innerText()).trim(), '3 kart · 3 sütun');
  assert.equal((await backlogCol.locator('[data-column-count]').innerText()).trim(), '2');
  assert.equal(await backlogCol.locator('[data-column-empty]').isVisible(), false);
  assert.equal(await page.locator('#card-c-bah002').isVisible(), true);

  // At 375px the pill group stays one row that scrolls sideways; the page itself never scrolls sideways.
  await page.setViewportSize({ width: 375, height: 800 });
  const narrow = await page.evaluate(() => {
    const group = document.querySelector('.board-filter-group');
    const pill = group.querySelector('.board-filter-pill:last-child');
    for (let i = 0; i < 12; i += 1) group.append(pill.cloneNode(true));
    const tops = new Set([...group.querySelectorAll('.board-filter-pill')].map((el) => el.offsetTop));
    return { rows: tops.size, scrolls: group.scrollWidth > group.clientWidth,
      page: document.documentElement.scrollWidth <= document.documentElement.clientWidth };
  });
  assert.deepEqual(narrow, { rows: 1, scrolls: true, page: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // With JS disabled, all cards remain visible and clicking pills causes no harm.
  const noJsContext = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 900 } });
  cleanup(() => noJsContext.close());
  const noJsPage = await noJsContext.newPage();
  await noJsPage.goto(loginUrl(port, key, instance));
  await noJsPage.waitForURL(`${origin}/`, { timeout: 10_000 });
  await noJsPage.goto(`${origin}/board`);
  await noJsPage.locator('[data-filter-priority="urgent"]').click();
  assert.equal(await noJsPage.locator('#card-c-bah002').isVisible(), true);
  assert.equal(await noJsPage.locator('#card-c-gen003').isVisible(), true);

  assert.deepEqual(errors, [], 'no console or page errors');
});
