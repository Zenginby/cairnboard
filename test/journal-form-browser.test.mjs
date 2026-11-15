import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.mjs';
import { createApi } from '../server/api.mjs';
import { createGuard } from '../server/guard.mjs';
import { createRead } from '../server/read.mjs';
import { createJournal } from '../server/journal.mjs';
import { createWrites } from '../server/writes.mjs';
import { loginUrl, siteHost } from '../server/session.mjs';
import { openContext } from '../core/context.mjs';
import { initDataDir } from '../core/roots.mjs';
import * as journal from '../core/journal.mjs';
import * as project from '../core/project.mjs';
import { APP_ALLOWLIST, filterAllowed } from '../scripts/lib/design-check/allowlist.mjs';
import { resolveBrowser } from '../scripts/lib/design-check/config.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { liveCleanup, liveUnavailable } from './support/live.mjs';
// The pages below are asserted in Turkish. The interface falls back to English, so this file sets the language
// explicitly, the way the server does at start.
process.env.CAIRN_LANGUAGE = 'tr';

const repo = fileURLToPath(new URL('../', import.meta.url));
const key = Buffer.alloc(32, 11), instance = 'run-gggggggggggggggg';

// The day page in a real headless Chromium: today with no record yet, axe clean, console clean, a form post.
test('journal day page: add form works, axe clean, console clean, saving works without scripts', async (t) => {
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
  const dataDir = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-08T12:00:00Z');
  initDataDir(dataDir, { home, env: {}, clock });
  const options = { dataDir, home, env: {}, clock };
  project.create(openContext({ mode: 'write', ...options, actor: 'web:owner' }),
    { title: 'Garden plan', status: 'active', tone: 1 }, '', {});
  const open = () => openContext({ mode: 'read', ...options });
  const openWrite = () => openContext({ mode: 'write', ...options, actor: 'web:owner' });
  const journals = createJournal({ key, port, open, openWrite });
  const { handler } = await import('../dist/app/server/entry.mjs');
  const writes = createWrites({ key, port, routes: journals.routes });
  const app = createApp({ root: repo, handler, guard: createGuard({ port, key, instance, writable: writes.writable }),
    writes: writes.handle,
    api: createApi({ open, live: () => true, events: { handle(req, res) { res.writeHead(200,
      { 'Content-Type': 'text/event-stream' }); res.write('retry: 2000\n\n'); return true; } } }),
    locals: { journal: journals, cairn: createRead({ open }) } });
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

  const audit = async (path) => {
    const response = await page.goto(`${origin}${path}`);
    assert.equal(response?.status(), 200, `${path} answers 200`);
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

  // Today has no record yet: an empty day with the form, not a 404.
  await audit('/journal/2026-11-08');
  await page.getByLabel('Başlık').fill('Sample job');
  await page.getByLabel('Maddeler').fill('First item\nSecond item');
  await page.getByLabel('Proje').selectOption({ label: 'Garden plan' });
  await page.getByRole('button', { name: 'İşi ekle' }).click();
  await page.waitForURL(`${origin}/journal/2026-11-08`);
  assert.equal(await page.getByRole('heading', { name: 'Sample job' }).count(), 1);
  assert.equal(await page.getByText('Second item').count(), 1);
  assert.equal(journal.sections(journal.show(open(), '2026-11-08').body).length, 1);
  await audit('/journal/2026-11-08');
  await audit('/journal');
  assert.equal(await page.getByRole('link', { name: 'Bugüne iş ekle' }).count(), 1);

  // The same post with scripts switched off.
  const plain = await browser.newContext({ javaScriptEnabled: false });
  cleanup(() => plain.close());
  const bare = await plain.newPage();
  await bare.goto(loginUrl(port, key, instance));
  await bare.goto(`${origin}/journal/2026-11-08`);
  await bare.getByLabel('Başlık').fill('Plain job');
  await bare.getByRole('button', { name: 'İşi ekle' }).click();
  await bare.waitForURL(`${origin}/journal/2026-11-08`);
  assert.equal(await bare.getByRole('heading', { name: 'Plain job' }).count(), 1);
  assert.equal(journal.sections(journal.show(open(), '2026-11-08').body).length, 2);

  assert.deepEqual(errors, [], 'no CSP or other console errors');
  // Any other unrecorded day stays not found.
  assert.equal((await page.goto(`${origin}/journal/2026-11-07`))?.status(), 404);
});
