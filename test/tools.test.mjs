import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
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
import { checkData } from '../core/doctor.mjs';
import { hasToolSnapshots, mergeTools, parseSnapshot, readToolSnapshots } from '../core/tools.mjs';
import { filterTools } from '../src/scripts/tools-filter.js';
import { APP_ALLOWLIST, filterAllowed } from '../scripts/lib/design-check/allowlist.mjs';
import { resolveBrowser } from '../scripts/lib/design-check/config.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { liveCleanup, liveUnavailable } from './support/live.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const key = Buffer.alloc(32, 9);
const instance = 'run-tttttttttttttttt';

const NORTH = {
  version: 1, machine: 'north', scannedAt: '2026-11-10T08:00:00Z',
  tools: [
    { name: 'lantern', kind: 'skill', description: 'Lights the path.', uses: { count: 4, last: '2026-11-09' },
      link: 'https://example.com/lantern' },
    { name: 'compass', kind: 'plugin', uses: { count: 0 } },
    { name: 'kettle', kind: 'mcp', link: 'javascript:alert(1)', description: 'Boils\u0000 water‮.' },
    { kind: 'skill' },
  ],
};
const SOUTH = {
  version: 1, machine: 'south', scannedAt: '2026-11-12',
  tools: [{ name: 'Lantern', kind: 'skill', uses: { count: 2, last: '2026-11-12' } }, { name: 'atlas', kind: 'skill' }],
};

function fixture(t, files = { 'north.json': NORTH, 'south.json': SOUTH }) {
  const data = tempDir(t);
  const home = tempDir(t);
  const clock = fixedClock('2026-11-14T12:00:00Z');
  initDataDir(data, { home, env: {}, clock });
  const dir = join(data, '.cairn/tools');
  if (files) mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files ?? {})) {
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return { data, dir, home, clock, open: () => openContext({ mode: 'read', dataDir: data, home, env: {}, clock }) };
}

test('snapshots: fields are cleaned, unsafe links dropped, nameless tools skipped', () => {
  const parsed = parseSnapshot(JSON.stringify(NORTH));
  assert.equal(parsed.machine, 'north');
  assert.deepEqual(parsed.tools.map((tool) => tool.name), ['lantern', 'compass', 'kettle']);
  assert.equal(parsed.tools[0].link, 'https://example.com/lantern');
  assert.equal(parsed.tools[2].link, null, 'a javascript: link never reaches the page');
  assert.equal(parsed.tools[2].description, 'Boils water.');
  assert.deepEqual(parsed.tools[1].uses, { count: 0, last: null });
  for (const bad of ['{', '[]', JSON.stringify({ ...NORTH, version: 2 }), JSON.stringify({ ...NORTH, machine: '' }),
    JSON.stringify({ ...NORTH, scannedAt: 'yesterday' }), JSON.stringify({ ...NORTH, tools: {} })]) {
    assert.equal(parseSnapshot(bad), null, bad.slice(0, 40));
  }
});

test('reading: machines sort, bad, oversized and linked files are skipped with one warning', (t) => {
  const { dir, open } = fixture(t, {
    'south.json': SOUTH, 'north.json': NORTH, 'broken.json': '{', 'big.json': ' '.repeat(1024 * 1024 + 1),
    'notes.txt': 'ignored',
  });
  symlinkSync(join(dir, 'north.json'), join(dir, 'linked.json'));
  const { snapshots, warnings } = readToolSnapshots(open());
  assert.deepEqual(snapshots.map((s) => s.machine), ['north', 'south']);
  assert.deepEqual(warnings, ['tools_snapshot_invalid']);
  assert.equal(hasToolSnapshots(open()), true);
});

test('review cases: hidden characters, Obsidian actions, impossible dates, linked folder, unknown use', (t) => {
  const one = (tool, extra = {}) => parseSnapshot(JSON.stringify({ ...NORTH, ...extra, tools: [tool] }));
  const tag = String.fromCodePoint(0xe0041);
  assert.equal(one({ name: `ab${tag}c\u2028d\u0085e\ufeff` }).tools[0].name, 'abcde');
  assert.equal(one({ name: 'a', link: 'obsidian://advanced-uri?commandid=x' }).tools[0].link, null);
  const note = 'obsidian://open?vault=V&file=n';
  assert.equal(one({ name: 'a', link: note }).tools[0].link, note);
  assert.equal(one({ name: 'a', uses: { count: 1, last: '2026-02-30' } }).tools[0].uses.last, null);
  assert.equal(parseSnapshot(JSON.stringify({ ...NORTH, scannedAt: '2026-11-10T08:00:00.000Z' })).scannedAt,
    '2026-11-10T08:00:00.000Z');
  const { data, dir, open } = fixture(t);
  const moved = join(data, 'elsewhere');
  renameSync(dir, moved);
  symlinkSync(moved, dir);
  assert.deepEqual(readToolSnapshots(open()), { snapshots: [], warnings: ['tools_snapshot_invalid'] });
  const unknown = mergeTools([
    parseSnapshot(JSON.stringify({ ...NORTH, tools: [{ name: 'x', kind: 'skill' }] })),
    parseSnapshot(JSON.stringify({ ...SOUTH, tools: [{ name: 'x', kind: 'skill', uses: { count: 0 } }] })),
  ]);
  assert.equal(unknown[0].uses, null, 'one machine without counts keeps the use unknown');
});

test('no snapshot folder: nothing to show and no tab', (t) => {
  const { open } = fixture(t, null);
  assert.deepEqual(readToolSnapshots(open()), { snapshots: [], warnings: [] });
  assert.equal(hasToolSnapshots(open()), false);
});

test('doctor: a snapshot folder changes no data check', (t) => {
  const status = ({ data, home, clock }) => Object.fromEntries(
    checkData({ dataDir: data, env: {}, home, cwd: home, clock }).map(({ name, ok }) => [name, ok]));
  assert.deepEqual(status(fixture(t)), status(fixture(t, null)));
});

test('merging joins a tool across machines by name and kind and adds up its uses', () => {
  const rows = mergeTools([parseSnapshot(JSON.stringify(NORTH)), parseSnapshot(JSON.stringify(SOUTH))]);
  assert.deepEqual(rows.map((row) => row.name), ['atlas', 'compass', 'kettle', 'lantern']);
  const lantern = rows.find((row) => row.name === 'lantern');
  assert.deepEqual(lantern.machines, ['north', 'south']);
  assert.deepEqual(lantern.uses, { count: 6, last: '2026-11-12' });
  assert.equal(lantern.description, 'Lights the path.');
});

test('filters: kind, search, no description and unused', () => {
  const items = [
    { name: 'lantern', description: 'Lights the path.', project: 'wayfinder', kind: 'skill',
      described: true, used: true },
    { name: 'compass', description: '', project: 'cairn', kind: 'plugin', described: false, used: false },
    { name: 'atlas', description: '', project: '', kind: 'skill', described: false, used: null },
  ];
  const names = (result) => result.visible.map((item) => item.name);
  assert.deepEqual(names(filterTools(items, { kind: 'skill' }, ['plugin', 'skill'])), ['lantern', 'atlas']);
  assert.deepEqual(names(filterTools(items, { query: 'COMP' })), ['compass']);
  assert.deepEqual(names(filterTools(items, { query: 'path' })), ['lantern']);
  assert.deepEqual(names(filterTools(items, { query: 'cairn' })), ['compass']);
  assert.deepEqual(names(filterTools(items, { query: 'plugin' })), ['compass']);
  const undescribed = filterTools(items, { undescribed: true });
  assert.deepEqual(names(undescribed), ['compass', 'atlas']);
  assert.deepEqual(undescribed.flagCounts, { undescribed: 2, unused: 1 });
  const unused = filterTools(items, { unused: true }, ['plugin', 'skill']);
  assert.deepEqual(names(unused), ['compass'], 'unknown usage is not "unused"');
  assert.deepEqual(unused.kindCounts, { plugin: 1, skill: 0 });
  assert.deepEqual(unused.flagCounts, { undescribed: 1, unused: 1 });
});

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

test('HTTP smoke: /tools lists merged tools and the tab shows only with a snapshot', async (t) => {
  if (!existsSync(join(root, 'dist/app/server/entry.mjs'))) return t.skip('Astro output missing; run build:app.');
  const { handler } = await import('../dist/app/server/entry.mjs');
  const pool = createRenderPool();
  t.after(() => pool.close());
  const get = (open) => {
    const app = createApp({ root, guard, handler, locals: { cairn: createRead({ open, render: pool.render }) } });
    return (path) => inProcess(app, path);
  };
  const withTools = get(fixture(t).open);
  const page = await withTools('/tools');
  assert.equal(page.status, 200);
  for (const text of ['lantern', 'compass', 'atlas', 'north', 'south', 'Açıklama yok', 'Kullanılmayan', '4 araç',
    'id="lantern"', 'kurulu değil', '✓', '—']) {
    assert.match(page.body, new RegExp(text, 'u'), text);
  }
  assert.match(page.body, /data-flag-count="undescribed">2</u);
  assert.match(page.body, /data-flag-count="unused">1</u);
  assert.doesNotMatch(page.body, /javascript:/u);
  assert.match(page.body, /href="https:\/\/example\.com\/lantern"[^>]*rel="noopener noreferrer"/u);
  assert.match((await withTools('/')).body, /href="\/tools"/u, 'tab present with a snapshot');
  const without = get(fixture(t, null).open);
  assert.doesNotMatch((await without('/')).body, /href="\/tools"/u, 'no tab without a snapshot');
});

test('/tools browser smoke: filters, axe and console clean, 375px without sideways scroll', async (t) => {
  const cleanup = liveCleanup(t);
  if (!existsSync(join(root, 'dist/app/server/entry.mjs'))) {
    return liveUnavailable(t, 'Astro output missing; run npm run build:app.');
  }
  let browser;
  try {
    const { executablePath } = resolveBrowser('chromium', { downloadedPath: chromium.executablePath() });
    browser = await chromium.launch({ executablePath, headless: true, timeout: 15_000,
      args: ['--no-proxy-server', '--host-resolver-rules=MAP *.cairnboard.localhost 127.0.0.1'] });
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
  server.on('request', createApp({
    root, handler, guard: createGuard({ port, key, instance }),
    api: createApi({ open, events: { handle(_req, res) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('retry: 2000\n\n');
      return true;
    } } }),
    locals: { cairn: createRead({ open, render: pool.render }) },
  }));

  const origin = `http://${siteHost(key)}:${port}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  cleanup(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(loginUrl(port, key, instance));
  await page.waitForURL(`${origin}/`, { timeout: 10_000 });
  assert.equal((await page.goto(`${origin}/tools`))?.status(), 200);

  assert.equal(await page.locator('[data-tools-empty-filtered]').isVisible(), false, 'no "no matches" note at first');
  for (const width of [1280, 1366, 1440, 1600]) {
    await page.setViewportSize({ width, height: 900 });
    const overlap = await page.evaluate(() => {
      const tabs = document.querySelector('.app-tabs').getBoundingClientRect();
      const search = document.querySelector('.shell-search').getBoundingClientRect();
      return tabs.right > search.left && tabs.left < search.right && tabs.bottom > search.top;
    });
    assert.equal(overlap, false, `six tabs do not run into the search field at ${width}px`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const summary = page.locator('[data-tools-summary]');
  const visible = () => page.locator('[data-tool-row]:not(.hidden)').evaluateAll((rows) =>
    rows.map((row) => row.dataset.name));
  assert.equal((await summary.innerText()).trim(), '4 araç');
  const undescribedBtn = page.getByRole('button', { name: /^Açıklama yok/u });
  const unusedBtn = page.getByRole('button', { name: /^Kullanılmayan/u });
  assert.equal(await undescribedBtn.locator('[data-flag-count]').innerText(), '2');
  assert.equal(await unusedBtn.locator('[data-flag-count]').innerText(), '1');
  await page.getByRole('button', { name: /^skill/u }).click();
  assert.deepEqual(await visible(), ['atlas', 'lantern']);
  assert.equal(await undescribedBtn.locator('[data-flag-count]').innerText(), '1');
  assert.equal(await unusedBtn.locator('[data-flag-count]').innerText(), '0');
  await undescribedBtn.click();
  assert.deepEqual(await visible(), ['atlas']);
  assert.equal(await page.locator('[data-tool-row][data-name="lantern"]').isVisible(), false,
    'filtered rows are hidden');
  assert.equal((await summary.innerText()).trim(), '1 araç');
  await undescribedBtn.click();
  await page.getByRole('button', { name: /^Tümü/u }).click();
  await unusedBtn.click();
  assert.deepEqual(await visible(), ['compass'], 'unknown usage is not "unused"');
  await unusedBtn.click();
  await page.getByLabel('Adda ara').fill('lant');
  assert.deepEqual(await visible(), ['lantern']);
  await page.getByLabel('Adda ara').fill('boils');
  assert.deepEqual(await visible(), ['kettle']);
  await page.getByLabel('Adda ara').fill('');
  const controlHeights = await page.locator('.tools-page .research-input, .tools-page .research-type-btn')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  assert.equal(controlHeights.every((h) => h >= 44), true, 'filter controls meet touch target height');

  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const fits = await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    assert.equal(fits,
      true, `no sideways scroll at ${width}px`);
  }
  assert.deepEqual(errors, [], 'no console/page errors before axe');
  await page.evaluate(readFileSync(fileURLToPath(import.meta.resolve('axe-core/axe.min.js')), 'utf8'));
  const regions = [...new Set(APP_ALLOWLIST.map((item) => item.within))];
  const found = await page.evaluate(async (withinRegions) => {
    const result = await window.axe.run(document, { resultTypes: ['violations'] });
    return result.violations.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.map((node) => {
      const element = document.querySelector(node.target[0]);
      return { within: withinRegions.filter((region) => element?.closest(region)) };
    }) }));
  }, regions);
  assert.deepEqual(filterAllowed(found, APP_ALLOWLIST), [], '/tools: no axe findings');
});
