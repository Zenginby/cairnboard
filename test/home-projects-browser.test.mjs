import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.mjs';
import { createApi } from '../server/api.mjs';
import { createGuard } from '../server/guard.mjs';
import { createRead } from '../server/read.mjs';
import { createSettings } from '../server/settings.mjs';
import { createWrites } from '../server/writes.mjs';
import { loginUrl, siteHost } from '../server/session.mjs';
import { openContext } from '../core/context.mjs';
import { APP_ALLOWLIST, filterAllowed } from '../scripts/lib/design-check/allowlist.mjs';
import { resolveBrowser } from '../scripts/lib/design-check/config.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { liveCleanup, liveUnavailable } from './support/live.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const key = Buffer.alloc(32, 9), instance = 'run-bbbbbbbbbbbbbbbb';

// Smoke check of the Home calendar, the agent work box and the My projects groups on the sample data, in a real
// headless Chromium (CAIRN_BROWSER_PATH, or the downloaded one): each page answers 200, axe finds nothing outside the
// accepted list and the console stays clean. Not run in the Codex sandbox: it needs a browser and a loopback listener.
test('Home calendar, agent box and My projects archive: 200, axe clean, console clean', async (t) => {
  const cleanup = liveCleanup(t);
  if (!existsSync(join(repo, 'dist/app/server/entry.mjs'))) {
    return liveUnavailable(t, 'Astro output missing; run npm run build:app to enable integration coverage.');
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

  // The sample data, with "Haftalık plan" as the agents project so Home has an agent work box.
  const dataDir = join(tempDir(t), 'sample'), home = tempDir(t), clock = fixedClock('2026-11-06T12:00:00Z');
  cpSync(join(repo, 'sample-data'), dataDir, { recursive: true });
  const configFile = join(dataDir, '.cairn/config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, `${JSON.stringify({ ...config, agents: { project: 'p-hft003' } }, null, 2)}\n`);
  const options = { dataDir, home, env: {}, clock };
  const open = () => openContext({ mode: 'read', ...options });
  const openWrite = () => openContext({ mode: 'write', ...options, actor: 'web:owner' });
  const settings = createSettings({ key, port, open, openWrite });
  const { handler } = await import('../dist/app/server/entry.mjs');
  // Wired like server/start.mjs: the guard accepts the posts the route table knows (the Home picker among them).
  const writes = createWrites({ key, port, routes: settings.routes });
  const app = createApp({ root: repo, handler, guard: createGuard({ port, key, instance, writable: writes.writable }),
    writes: writes.handle,
    api: createApi({ open, live: settings.liveUpdates, events: { handle(req, res) { res.writeHead(200,
      { 'Content-Type': 'text/event-stream' }); res.write('retry: 2000\n\n'); return true; } } }),
    locals: { settings, cairn: createRead({ open }) } });
  server.on('request', app);

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  cleanup(() => context.close());
  const page = await context.newPage(), errors = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  const axeSource = await readFile(fileURLToPath(import.meta.resolve('axe-core/axe.min.js')), 'utf8');
  const origin = `http://${siteHost(key)}:${port}`;
  await page.goto(loginUrl(port, key, instance));
  await page.waitForURL(`${origin}/`, { timeout: 10_000 });

  const visit = async (path) => {
    const response = await page.goto(`${origin}${path}`);
    assert.equal(response?.status(), 200, `${path} answers 200`);
    // Not networkidle: the live-update stream stays open.
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.evaluate(axeSource);
    const regions = [...new Set(APP_ALLOWLIST.map((item) => item.within))];
    const found = await page.evaluate(async (regions) => {
      const result = await window.axe.run(document, { resultTypes: ['violations'] });
      return result.violations.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.map((node) => {
        const element = document.querySelector(node.target[0]);
        return { within: regions.filter((region) => element?.closest(region)) };
      }) }));
    }, regions);
    assert.deepEqual(filterAllowed(found, APP_ALLOWLIST), [], `${path}: no axe findings`);
  };

  // Home: the month calendar marks the sample journal days, today is current; the agent box follows the first project.
  await visit('/');
  const calendar = page.locator('.calendar-box');
  assert.equal(await calendar.getByRole('heading', { name: 'Günlük' }).count(), 1);
  assert.equal(await calendar.locator('.month-day').count(), 30);
  const journalDays = readdirSync(join(dataDir, 'journal')).filter((name) => name.startsWith('2026-11-'))
    .map((name) => String(Number(name.slice(8, 10)))).sort((a, b) => a - b);
  assert.ok(journalDays.length > 0, 'the sample data has journal days in November 2026');
  assert.deepEqual(await calendar.locator('.month-day.has-entry').allInnerTexts(), journalDays);
  assert.equal(await calendar.locator('[aria-current="date"]').innerText(), '6');
  const order = await page.locator('.calendar-box, .agents-box, .project-box').evaluateAll((nodes) => nodes
    .map((node) => node.classList.contains('agents-box') ? 'agents'
      : node.classList.contains('calendar-box') ? 'calendar' : node.getAttribute('aria-label')));
  assert.deepEqual(order,['calendar', 'Mutfak defteri', 'agents', 'Tez taslağı'],
    'calendar, featured project, agent box, then the other project; the agents project is not a box');
  assert.equal(await page.locator('.agents-box').getByRole('link', { name: 'Ajan panosunu aç' }).count(), 1);

  // Home project choice: leave "Tez taslağı" off Home and save.
  await page.locator('.project-picker summary').click();
  await page.getByRole('checkbox', { name: 'Tez taslağı' }).uncheck();
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await page.waitForURL(`${origin}/?saved=projects`);
  assert.match(await page.getByRole('status').first().innerText(), /Ana sayfa projeleri kaydedildi/u);
  assert.equal(await page.locator('.project-box[aria-label="Tez taslağı"]').count(), 0, 'the hidden project is gone');
  assert.equal(await page.locator('.project-box[aria-label="Mutfak defteri"]').count(), 1);

  // My projects: active, paused and archive groups; the archived project sits in the archive group.
  await visit('/projects');
  assert.deepEqual(await page.locator('.projects-group-title').evaluateAll((nodes) => nodes
    .map((node) => node.firstChild.textContent.trim())), ['Aktif', 'Beklemede', 'Arşiv']);
  const archive = page.locator('.projects-group', { has: page.locator('#projects-archived') });
  assert.equal(await archive.locator('.project-box').count(), 1);
  assert.match(await archive.locator('.project-box').getAttribute('aria-label'), /^Sonbahar yürüyüşlerinden/u);
  assert.match(await page.locator('.projects-heading').innerText(), /4 proje · 2 aktif/u);

  // The archived project's own page opens too.
  await visit('/projects/p-a1b005');
  assert.match(await page.locator('h1').innerText(), /^Sonbahar yürüyüşlerinden/u);

  assert.deepEqual(errors, [], 'no CSP or other console errors');
});
