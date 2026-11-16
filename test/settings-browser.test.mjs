import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.mjs';
import { createApi } from '../server/api.mjs';
import { createGuard } from '../server/guard.mjs';
import { createSettings } from '../server/settings.mjs';
import { createWrites } from '../server/writes.mjs';
import { loginUrl, siteHost } from '../server/session.mjs';
import { openContext } from '../core/context.mjs';
import { initDataDir } from '../core/roots.mjs';
import { loadConfig } from '../core/config.mjs';
import { resolveBrowser } from '../scripts/lib/design-check/config.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { liveCleanup, liveUnavailable } from './support/live.mjs';
// The pages below are asserted in Turkish. The interface falls back to English, so this file sets the language
// explicitly, the way the server does at start.
process.env.CAIRN_LANGUAGE = 'tr';

const repo = fileURLToPath(new URL('../', import.meta.url));
const key = Buffer.alloc(32, 7), instance = 'run-aaaaaaaaaaaaaaaa';

// A real headless Chromium (CAIRN_BROWSER_PATH, or the downloaded one) against the real built pages, clicking the real
// buttons. Not run in the Codex sandbox: it needs a browser and a loopback listener.
test('Settings dialog and fallback: switches save, closing reloads, axe and console stay clean', async (t) => {
  const cleanup = liveCleanup(t);
  // The language steps at the end switch this process to English; later runs of this file start in Turkish again.
  cleanup(() => { process.env.CAIRN_LANGUAGE = 'tr'; });
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
  // The server's write table, as in server/start.mjs: the baseline guard alone does not know the language path.
  const { writable } = createWrites({ key, port, routes: settings.routes });
  const app = createApp({ root: repo, handler, guard: createGuard({ port, key, instance, writable }),
    writes: settings.handle,
    api: createApi({ open, live: settings.liveUpdates, events: { handle(req, res) { res.writeHead(200,
      { 'Content-Type': 'text/event-stream' }); res.write('retry: 2000\n\n'); return true; } } }),
    locals: { settings, cairn: { home: async () => empty } } });
  server.on('request', app);

  const context = await browser.newContext();
  cleanup(() => context.close());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  const origin = `http://${siteHost(key)}:${port}`;
  await page.goto(loginUrl(port, key, instance));
  await page.waitForURL(`${origin}/`, { timeout: 10_000 });
  assert.equal(await page.locator('script[src*="live-updates"]').count(), 1, 'live updates load while on');

  const gear = page.locator('[data-settings-open]');
  const dialog = page.getByRole('dialog', { name: 'Ayarlar', exact: true });
  const axeSource = readFileSync(fileURLToPath(import.meta.resolve('axe-core/axe.min.js')), 'utf8');
  await gear.click();
  await dialog.locator('[data-settings-panel]').waitFor();
  assert.equal(page.url(), `${origin}/`, 'opening Settings keeps Home in the address bar');
  assert.equal(await dialog.locator('.settings-row').count(), 4);
  assert.equal(await dialog.getByRole('switch', { checked: true }).count(), 4);

  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth), true,
      `the dialog fits at ${width}px`);
    assert.equal(await dialog.locator('[data-settings-body]').evaluate((element) =>
      element.scrollWidth <= element.clientWidth), true, `the body fits at ${width}px`);
    assert.deepEqual(errors, [], 'no app console errors before axe injects its own styles');
    // axe may insert styles that the production CSP refuses; only app errors are checked above and after this scan.
    await dialog.evaluate((element) => Promise.all(element.getAnimations({ subtree: true })
      .filter((animation) => animation.effect.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => {}))));
    await page.evaluate(axeSource);
    const violations = await page.evaluate(async () => {
      const result = await window.axe.run(document.querySelector('[data-settings-dialog]'),
        { resultTypes: ['violations'] });
      return result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) }));
    });
    assert.deepEqual(violations, [], `axe clean inside Settings at ${width}px`);
    errors.length = 0;
  }

  // The glass choice is per browser and applies at once; Follow system reads reduced transparency and contrast.
  assert.equal(await dialog.locator('[data-glass-choice]').isVisible(), true, 'the glass choice shows with script');
  const glass = () => page.evaluate(() =>
    [document.documentElement.dataset.glass, localStorage.getItem('cairn-glass')]);
  const glassGroup = dialog.getByRole('radiogroup', { name: 'Cam efekti', exact: true });
  await glassGroup.getByRole('radio', { name: 'Kapalı', exact: true }).check();
  assert.deepEqual(await glass(), ['off', 'off']);
  await glassGroup.getByRole('radio', { name: 'Açık', exact: true }).check();
  assert.deepEqual(await glass(), ['on', 'on']);
  await glassGroup.getByRole('radio', { name: 'Sisteme uy', exact: true }).check();
  const system = await page.evaluate(() =>
    (matchMedia('(prefers-reduced-transparency: reduce), (prefers-contrast: more)').matches ? 'off' : 'on'));
  assert.deepEqual(await glass(), [system, null]);

  // Background motion is the same kind of choice; the scene's clouds drift only while it resolves to on.
  const sceneMotion = () => page.evaluate(() => [document.documentElement.dataset.sceneMotion,
    localStorage.getItem('cairn-scene-motion'),
    getComputedStyle(document.querySelector('.scene-clouds-far')).animationName,
    getComputedStyle(document.querySelector('.scene-twinkle-b')).animationName]);
  const motionGroup = dialog.getByRole('radiogroup', { name: 'Arka plan hareketi', exact: true });
  assert.deepEqual(await sceneMotion(), ['on', null, 'scene-drift', 'scene-twinkle-b'], 'follows the system at first');
  await motionGroup.getByRole('radio', { name: 'Kapalı', exact: true }).check();
  assert.deepEqual(await sceneMotion(), ['off', 'off', 'none', 'none']);
  assert.deepEqual(await glass(), [system, null], 'the glass choice is untouched');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await motionGroup.getByRole('radio', { name: 'Sisteme uy', exact: true }).check();
  assert.deepEqual(await sceneMotion(), ['off', null, 'none', 'none'], 'Follow system reads reduced motion');
  assert.equal(await dialog.locator('[data-scene-motion-system-note]').isVisible(), true);
  await motionGroup.getByRole('radio', { name: 'Açık', exact: true }).check();
  assert.deepEqual(await sceneMotion(), ['on', 'on', 'scene-drift', 'scene-twinkle-b']);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await motionGroup.getByRole('radio', { name: 'Sisteme uy', exact: true }).check();
  assert.deepEqual(await sceneMotion(), ['on', null, 'scene-drift', 'scene-twinkle-b']);

  const writeRequest = page.waitForRequest((request) => request.method() === 'POST'
    && request.url() === `${origin}/settings/feature`);
  await dialog.getByRole('switch', { name: 'Canlı güncelleme: Kapat' }).click();
  const request = await writeRequest;
  const headers = await request.allHeaders();
  assert.equal(headers.origin, origin, 'the no-referrer shell still sends the real Origin');
  assert.equal(headers['sec-fetch-site'], 'same-origin');
  assert.match(headers['content-type'], /^application\/x-www-form-urlencoded/u);
  await dialog.getByRole('switch', { name: 'Canlı güncelleme: Aç', checked: false }).waitFor();
  assert.equal(page.url(), `${origin}/`, 'saving inside Settings keeps Home in the address bar');
  assert.equal(loadConfig(dataDir).features.liveUpdates, false, 'the write reached the data directory');
  assert.equal(await page.locator('script[src*="live-updates"]').count(), 1, 'the shell waits until close to reload');
  const reload = page.waitForEvent('load');
  await dialog.getByRole('button', { name: 'Kapat', exact: true }).click();
  await reload;
  assert.equal(page.url(), `${origin}/`);
  assert.equal(await page.locator('script[src*="live-updates"]').count(), 0, 'closing reloads the changed shell');
  assert.equal(await page.evaluate(async () => (await fetch('/api/events')).status), 404);
  assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation')[0].type), 'reload');

  // Without a write, Escape and a backdrop click only close and return focus to the gear.
  await gear.click();
  await dialog.locator('[data-settings-panel]').waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await gear.evaluate((element) => element === document.activeElement), true);
  await gear.click();
  await dialog.locator('[data-settings-panel]').waitFor();
  await page.mouse.click(1, 1);
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await gear.evaluate((element) => element === document.activeElement), true);

  // A malformed read offers the fallback page without changing Home's URL.
  await page.route('**/settings', (route) => route.fulfill({ status: 200, contentType: 'text/html',
    body: '<main>Panel missing</main>' }));
  await gear.click();
  await dialog.getByRole('link', { name: 'Ayarları aç' }).waitFor();
  assert.match(await dialog.getByRole('status').innerText(), /Ayarlar yüklenemedi/u);
  assert.equal(page.url(), `${origin}/`);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.unroute('**/settings');

  // Even two synchronous submissions send only one POST; a bad answer never triggers a native retry.
  let writes = 0;
  await page.route('**/settings/feature', (route) => {
    writes++;
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<main>Panel missing</main>' });
  });
  await gear.click();
  await dialog.locator('[data-settings-panel]').waitFor();
  await dialog.locator('form[action="/settings/feature"]').first()
    .evaluate((form) => { form.requestSubmit(); form.requestSubmit(); });
  await dialog.getByRole('link', { name: 'Ayarları aç' }).waitFor();
  assert.equal(writes, 1);
  assert.equal(page.url(), `${origin}/`);
  assert.equal(loadConfig(dataDir).features.liveUpdates, false, 'the failed write changed no stored feature');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.unroute('**/settings/feature');

  // Restore live updates through the no-script form path below.
  await page.goto(`${origin}/settings`);
  await page.getByRole('switch', { name: 'Canlı güncelleme: Aç' }).click();
  await page.waitForURL(`${origin}/settings?saved=liveUpdates`);
  assert.match(await page.getByRole('status').first().innerText(), /Kaydedildi: Canlı güncelleme/u);
  assert.equal(await page.getByRole('switch', { name: 'Canlı güncelleme: Kapat' }).count(), 1,
    'the page shows the new state');
  assert.equal(loadConfig(dataDir).features.liveUpdates, true);

  await page.goto(`${origin}/`);
  assert.equal(await page.locator('script[src*="live-updates"]').count(), 1, 'fallback restored live updates');

  await page.goto(`${origin}/settings`);
  await page.getByRole('switch', { name: 'Değişiklik izi: Kapat' }).click();
  await page.waitForURL(`${origin}/settings?saved=changeTrail`);
  assert.equal(await page.getByRole('switch', { name: 'Ne değişti: Kapat' }).isDisabled(), true,
    'content needs the trail');

  await page.goto(`${origin}/settings`);
  await page.getByRole('button', { name: 'Gölgeyi temizle' }).click();
  assert.match(await page.locator('body').innerText(), /onay kutusunu işaretle/u,
    'an unticked box is refused with a message');

  // Language, no-script path: the stored language is English while this server speaks Turkish, as after a CLI change.
  assert.equal(loadConfig(dataDir).language, 'en');
  await page.goto(`${origin}/settings`);
  assert.equal(await page.locator('html').getAttribute('lang'), 'tr');
  const choice = page.getByRole('radiogroup', { name: 'Arayüz dili' });
  assert.equal(await choice.getByRole('radio', { name: 'English', exact: true }).isChecked(), true);
  await choice.getByRole('radio', { name: 'Türkçe', exact: true }).check();
  await page.getByRole('button', { name: 'Dili kaydet', exact: true }).click();
  await page.waitForURL(`${origin}/settings?saved=language`);
  assert.match(await page.getByRole('status').first().innerText(), /Kaydedildi: Dil/u);
  assert.equal(loadConfig(dataDir).language, 'tr');
  assert.equal(await page.getByRole('radio', { name: 'Türkçe', exact: true }).isChecked(), true);

  // Language, dialog path: the panel comes back in the new language and closing reloads the shell into it.
  await page.goto(`${origin}/`);
  await gear.click();
  await dialog.locator('[data-settings-panel]').waitFor();
  await dialog.getByRole('radio', { name: 'English', exact: true }).check();
  await dialog.getByRole('button', { name: 'Dili kaydet', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save language', exact: true }).waitFor();
  assert.match(await dialog.getByRole('status').first().innerText(), /Saved: Language/u);
  assert.equal(await dialog.getByRole('heading', { name: 'Features', exact: true }).count(), 1);
  assert.equal(loadConfig(dataDir).language, 'en');
  assert.equal(page.url(), `${origin}/`);
  const english = page.waitForEvent('load');
  await dialog.getByRole('button', { name: 'Kapat', exact: true }).click();
  await english;
  assert.equal(await page.locator('html').getAttribute('lang'), 'en', 'no restart: the reloaded shell is English');
  assert.equal(await page.title(), 'Home · Cairnboard');
  await page.goto(`${origin}/no-such-page`);
  assert.match(await page.locator('h1').innerText(), /Page not found/u);
  assert.deepEqual(errors.filter((text) => !/status of (?:400|404)/u.test(text)), [], 'no CSP or other console errors');
});
