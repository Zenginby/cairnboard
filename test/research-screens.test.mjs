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
import { createRead, DataNotReadyError, EntityNotFoundError, researchListResult } from '../server/read.mjs';
import { createRenderPool } from '../server/render-pool.mjs';
import { loginUrl, siteHost } from '../server/session.mjs';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { APP_ALLOWLIST, filterAllowed } from '../scripts/lib/design-check/allowlist.mjs';
import { resolveBrowser } from '../scripts/lib/design-check/config.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { liveCleanup, liveUnavailable } from './support/live.mjs';
// The pages below are asserted in Turkish. The interface falls back to English, so this file sets the language
// explicitly, the way the server does at start.
process.env.CAIRN_LANGUAGE = 'tr';

const root = fileURLToPath(new URL('../', import.meta.url));
const key = Buffer.alloc(32, 7);
const instance = 'run-rrrrrrrrrrrrrrrr';

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

const ALPHA = 'p-a1b001';
const BETA = 'p-b2c002';
const REC_NEW = 'r-a1b001';
const REC_MID = 'r-c3d002';
const REC_OLD = 'r-e5f003';
const REC_NO_DATE = 'r-g7h004';

function fixture(t, { empty = false, hiddenTitle = false } = {}) {
  const data = tempDir(t);
  const home = tempDir(t);
  const clock = fixedClock('2026-11-18T12:00:00Z');
  initDataDir(data, { home, env: {}, clock });
  mkdirSync(join(data, 'projects'), { recursive: true });
  for (const [id, title, tone] of [[ALPHA, 'Alpha Survey', 2], [BETA, 'Beta Archive', 5]]) {
    writeFileSync(join(data, `projects/${id}.md`),
      `---\nid: ${id}\ntitle: ${title}\ntone: ${tone}\nstatus: active\n---\nProject body.\n`);
  }
  mkdirSync(join(data, 'research'), { recursive: true });
  if (!empty) {
    writeFileSync(join(data, `research/${REC_OLD}.md`), [
      '---',
      `id: ${REC_OLD}`,
      'kind: analysis',
      `title: ${hiddenTitle ? 'Hydro\u200Blogy' : 'Hydrology'} Field Report`,
      'date: 2026-09-04',
      `project: ${BETA}`,
      'tags:',
      '  - water',
      '  - sensor',
      '---',
      '## Background',
      'Brief overview text.',
      '## Measurement Setup',
      'Sensor calibration steps.',
      '### Probe Drift',
      'Nested subsection.',
      '',
    ].join('\n'));
    writeFileSync(join(data, `research/${REC_NEW}.md`), [
      '---',
      `id: ${REC_NEW}`,
      'kind: source',
      'category: Saha Defteri',
      'title: Soil Moisture Synthesis',
      'date: 2026-11-10',
      `project: ${ALPHA}`,
      'source: "Quarterly Archive #14"',
      'tags:',
      '  - moisture',
      '  - field',
      '  - calibration',
      '  - fourth-tag',
      '---',
      '## First Finding',
      'See [vault entry](obsidian://open?vault=FieldVault&file=Notes%2FSurvey).',
      '## Second Finding',
      'Details for second finding.',
      '### Sub Finding',
      'Deep observation.',
      '## Third Finding',
      'Final notes, with a [reference](https://example.com "<h2>x<img src=x onerror=alert(1)></h2>").',
      '',
    ].join('\n'));
    writeFileSync(join(data, `research/${REC_MID}.md`), [
      '---',
      `id: ${REC_MID}`,
      'kind: review',
      'category: Saha Defteri',
      'title: Canopy Light Review',
      'date: 2026-10-15',
      `project: ${BETA}`,
      'tags:',
      '  - light',
      '---',
      '## Short Summary',
      'Only two headings here.',
      '## Open Questions',
      'Follow-up list.',
      '',
    ].join('\n'));
    writeFileSync(join(data, `research/${REC_NO_DATE}.md`), [
      '---',
      `id: ${REC_NO_DATE}`,
      'kind: source',
      'title: Baseline Inventory',
      '---',
      'Plain undated entry.',
      '',
    ].join('\n'));
  }
  const open = () => openContext({ mode: 'read', dataDir: data, home, env: {}, clock });
  return { open, data };
}

async function page(t, open) {
  if (!existsSync(join(root, 'dist/app/server/entry.mjs'))) return t.skip('Astro output missing; run build:app.');
  const { handler } = await import('../dist/app/server/entry.mjs');
  const pool = createRenderPool();
  t.after(() => pool.close());
  const app = createApp({ root, guard, handler, locals: { cairn: createRead({ open, render: pool.render }) } });
  return (path) => inProcess(app, path);
}

test('server read layer: researchList sorts newest-first without body, and research(id) extracts TOC', async (t) => {
  const { open } = fixture(t, { hiddenTitle: true });
  const pool = createRenderPool();
  t.after(() => pool.close());
  const read = createRead({ open, render: pool.render });

  const list = await read.researchList();
  assert.equal(list.ok, true);
  assert.deepEqual(list.data.items.map((item) => item.id), [REC_NEW, REC_MID, REC_OLD, REC_NO_DATE]);
  for (const item of list.data.items) {
    assert.equal(Object.hasOwn(item.content, 'body'), false, 'list records must not carry bodies');
  }
  assert.equal(list.data.items[2].content.title, 'Hydrology Field Report', 'hidden characters stripped');
  assert.equal(list.data.items[0].project.tone, 2);

  const single = await read.research(REC_NEW);
  assert.equal(single.ok, true);
  assert.equal(single.data.project.id, ALPHA);
  assert.deepEqual(single.data.toc.map((entry) => [entry.level, entry.id, entry.text]), [
    [2, 'sec-first-finding', 'First Finding'], [2, 'sec-second-finding', 'Second Finding'],
    [3, 'sec-sub-finding', 'Sub Finding'], [2, 'sec-third-finding', 'Third Finding'],
  ]);
  assert.match(single.data.content.html, /<h2 id="sec-first-finding">First Finding<\/h2>/u);
  // A heading written inside a link title is attribute text: it must stay inside the attribute and out of the list.
  assert.match(single.data.content.html, /title="<h2>x<img src=x onerror=alert\(1\)><\/h2>"/u);
  assert.doesNotMatch(single.data.content.html, /sec-x/u);
  assert.match(
    single.data.content.html,
    /href="obsidian:\/\/open\?vault=FieldVault(?:&amp;|&#x26;|&#38;)file=Notes%2FSurvey"/u,
  );

  const rawResult = researchListResult(open());
  assert.equal(rawResult.data.items.length, 4);

  await assert.rejects(() => read.research('r-zzzz99'), EntityNotFoundError);
  const broken = createRead({ open: async () => { throw new Error('missing vault'); }, render: pool.render });
  await assert.rejects(() => broken.researchList(), DataNotReadyError);
  await assert.rejects(() => broken.research(REC_NEW), DataNotReadyError);
});

test('HTTP smoke: /research list, /research/<id> detail, TOC threshold, obsidian href and 404', async (t) => {
  const get = await page(t, fixture(t).open);
  if (!get) return;

  const list = await get('/research');
  assert.equal(list.status, 200);
  assert.match(list.body, /href="\/research"[^>]*aria-current="page"/u);
  assert.match(list.body, /data-filter-type=""[^>]*aria-pressed="true"[^>]*>Tümü\s*<span[^>]*>4<\/span>/u);
  assert.match(list.body, /data-filter-type="Saha Defteri"[^>]*>Saha Defteri\s*<span[^>]*>2<\/span>/u);
  assert.match(list.body, /data-filter-type="Analiz"[^>]*>Analiz\s*<span[^>]*>1<\/span>/u);
  assert.match(list.body, /data-filter-type="Kaynak"[^>]*>Kaynak\s*<span[^>]*>1<\/span>/u);
  assert.match(list.body, /aria-live="polite"[^>]*data-research-summary[^>]*>4 araştırma</u);
  assert.ok(list.body.indexOf(REC_NEW) < list.body.indexOf(REC_MID));
  assert.ok(list.body.indexOf(REC_MID) < list.body.indexOf(REC_OLD));
  assert.match(list.body, /calibration/u);
  assert.doesNotMatch(list.body, /fourth-tag/u, 'list row caps preview tags');

  const detail = await get(`/research/${REC_NEW}`);
  assert.equal(detail.status, 200);
  assert.match(detail.body, /href="\/research"[^>]*aria-current="page"/u);
  assert.match(detail.body, /class="research-back" href="\/research"/u);
  assert.match(detail.body, /class="research-meta"/u);
  assert.match(detail.body, /Quarterly Archive #14/u);
  assert.match(detail.body, /fourth-tag/u, 'detail metadata renders all tags');
  assert.match(detail.body, /class="research-toc"/u, 'TOC shown when 3 or more headings');
  assert.match(detail.body, /href="#sec-first-finding"/u);
  assert.doesNotMatch(detail.body, /sec-x/u, 'a heading inside a link title never becomes markup');
  assert.match(
    detail.body,
    /href="obsidian:\/\/open\?vault=FieldVault(?:&amp;|&#x26;|&#38;)file=Notes%2FSurvey"/u,
  );

  const noToc = await get(`/research/${REC_MID}`);
  assert.equal(noToc.status, 200);
  assert.doesNotMatch(noToc.body, /class="research-toc"/u, 'TOC hidden when fewer than 3 headings');
  assert.doesNotMatch(noToc.body, /<dt>Kaynak<\/dt>/u, 'empty source omitted from metadata');

  const sparse = await get(`/research/${REC_NO_DATE}`);
  assert.equal(sparse.status, 200);
  assert.doesNotMatch(sparse.body, /<dt>Proje<\/dt>/u);
  assert.doesNotMatch(sparse.body, /<dt>Etiketler<\/dt>/u);

  const missing = await get('/research/r-zzzz99');
  assert.equal(missing.status, 404);

  const emptyGet = await page(t, fixture(t, { empty: true }).open);
  if (!emptyGet) return;
  const emptyRes = await emptyGet('/research');
  assert.equal(emptyRes.status, 200);
  assert.match(emptyRes.body, /Henüz araştırma kaydı yok/u);
});

test('/research browser smoke: combined filters, axe clean, console clean, 375px layout, no-JS list', async (t) => {
  const cleanup = liveCleanup(t);
  if (!existsSync(join(root, 'dist/app/server/entry.mjs'))) {
    return liveUnavailable(t, 'Astro output missing; run npm run build:app.');
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
    root,
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

  const origin = `http://${siteHost(key)}:${port}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  cleanup(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(loginUrl(port, key, instance));
  await page.waitForURL(`${origin}/`, { timeout: 10_000 });

  for (const path of ['/research', `/research/${REC_NEW}`]) {
    const res = await page.goto(`${origin}${path}`);
    assert.equal(res?.status(), 200);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    assert.deepEqual(errors, [], `${path}: no console/page errors before axe`);

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
    assert.deepEqual(filterAllowed(found, APP_ALLOWLIST), [], `${path}: no axe findings`);

    await page.setViewportSize({ width: 375, height: 812 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    assert.equal(overflow, false, `${path}: no horizontal overflow at 375px`);
    await page.setViewportSize({ width: 1280, height: 900 });
  }

  await page.goto(`${origin}/research`);
  const summary = page.locator('[data-research-summary]');
  assert.equal((await summary.innerText()).trim(), '4 araştırma');

  const sahaBtn = page.locator('[data-filter-type="Saha Defteri"]');
  await sahaBtn.click();
  assert.equal(await sahaBtn.getAttribute('aria-pressed'), 'true');
  assert.equal((await summary.innerText()).trim(), '2 araştırma');

  await page.selectOption('[data-research-project]', BETA);
  assert.equal((await summary.innerText()).trim(), '1 araştırma');
  assert.equal(await page.locator('[data-research-row]:not(.hidden)').count(), 1);
  assert.match(await page.locator('[data-research-row]:not(.hidden)').innerText(), /Canopy Light Review/u);

  await page.fill('[data-research-search]', 'moisture');
  assert.equal((await summary.innerText()).trim(), '0 araştırma');
  assert.equal(await page.locator('[data-research-empty-filtered]').isVisible(), true);

  await page.selectOption('[data-research-project]', '');
  assert.equal((await summary.innerText()).trim(), '1 araştırma');
  assert.match(await page.locator('[data-research-row]:not(.hidden)').innerText(), /Soil Moisture Synthesis/u);

  const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 900 } });
  cleanup(() => noJs.close());
  const noJsPage = await noJs.newPage();
  await noJsPage.goto(loginUrl(port, key, instance));
  await noJsPage.goto(`${origin}/research`);
  assert.equal(await noJsPage.locator('[data-research-row]').count(), 4);
  for (const row of await noJsPage.locator('[data-research-row]').all()) {
    assert.equal(await row.isVisible(), true);
  }
});
