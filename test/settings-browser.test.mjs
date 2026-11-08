import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.mjs';
import { createApi } from '../server/api.mjs';
import { createGuard } from '../server/guard.mjs';
import { createSettings } from '../server/settings.mjs';
import { loginUrl, siteHost } from '../server/session.mjs';
import { openContext } from '../core/context.mjs';
import { initDataDir } from '../core/roots.mjs';
import { loadConfig } from '../core/config.mjs';
import { resolveBrowser } from '../scripts/lib/design-check/config.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { liveCleanup, liveUnavailable } from './support/live.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const key = Buffer.alloc(32, 7), instance = 'run-aaaaaaaaaaaaaaaa';

// A real headless Chromium (CAIRN_BROWSER_PATH, or the downloaded one) against the real built pages, clicking the real
// buttons. Not run in the Codex sandbox: it needs a browser and a loopback listener.
test('Settings page: a button saves, the page shows the new state and live updates stop loading', async (t) => {
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
  const open = () => openContext({ mode: 'read', ...options });
  const openWrite = () => openContext({ mode: 'write', ...options, actor: 'web:owner' });
  const settings = createSettings({ key, port, open, openWrite });
  const { handler } = await import('../dist/app/server/entry.mjs');
  const empty = { data: { pinned: [], recentNotes: [], openCards: [], projects: [], featuredProject: null,
    journal: null }, warnings: [] };
  const app = createApp({ root: repo, handler, guard: createGuard({ port, key, instance }), writes: settings.handle,
    api: createApi({ open, live: settings.liveUpdates, events: { handle(req, res) { res.writeHead(200,
      { 'Content-Type': 'text/event-stream' }); res.write('retry: 2000\n\n'); return true; } } }),
    locals: { settings, cairn: { home: async () => empty } } });
  server.on('request', app);

  const context = await browser.newContext();
  cleanup(() => context.close());
  const page = await context.newPage(), errors = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  const origin = `http://${siteHost(key)}:${port}`;
  await page.goto(loginUrl(port, key, instance));
  await page.waitForURL(`${origin}/`, { timeout: 10_000 });
  assert.equal(await page.locator('script[src*="live-updates"]').count(), 1, 'live updates load while on');

  await page.goto(`${origin}/settings`);
  await page.getByRole('button', { name: 'Canlı güncelleme: Kapat' }).click();
  await page.waitForURL(`${origin}/settings?saved=liveUpdates`);
  assert.match(await page.getByRole('status').first().innerText(), /Kaydedildi: Canlı güncelleme/u);
  assert.equal(await page.getByRole('button', { name: 'Canlı güncelleme: Aç' }).count(), 1,
    'the page shows the new state');
  assert.equal(loadConfig(dataDir).features.liveUpdates, false);

  await page.goto(`${origin}/`);
  assert.equal(await page.locator('script[src*="live-updates"]').count(), 0, 'no live script once it is off');
  assert.equal(await page.evaluate(async () => (await fetch('/api/events')).status), 404);

  await page.goto(`${origin}/settings`);
  await page.getByRole('button', { name: 'Değişiklik izi: Kapat' }).click();
  await page.waitForURL(`${origin}/settings?saved=changeTrail`);
  assert.equal(await page.getByRole('button', { name: 'Ne değişti: Kapat' }).isDisabled(), true,
    'content needs the trail');

  await page.getByRole('button', { name: 'Canlı güncelleme: Aç' }).click();
  await page.waitForURL(`${origin}/settings?saved=liveUpdates`);
  await page.goto(`${origin}/`);
  assert.equal(await page.locator('script[src*="live-updates"]').count(), 1, 'back on: the script loads again');

  await page.goto(`${origin}/settings`);
  await page.getByRole('button', { name: 'Gölgeyi temizle' }).click();
  assert.match(await page.locator('body').innerText(), /onay kutusunu işaretle/u,
    'an unticked box is refused with a message');
  assert.deepEqual(errors.filter((text) => !/status of (?:400|404)/u.test(text)), [], 'no CSP or other console errors');
});
