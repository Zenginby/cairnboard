import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.mjs';
import { createApi } from '../server/api.mjs';
import { createGuard } from '../server/guard.mjs';
import { createRead } from '../server/read.mjs';
import { createRenderPool } from '../server/render-pool.mjs';
import { loginUrl, siteHost } from '../server/session.mjs';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { resolveBrowser } from '../scripts/lib/design-check/config.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { liveCleanup, liveUnavailable } from './support/live.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const key = Buffer.alloc(32, 9);
const instance = 'run-tttttttttttttttt';
const LONG = 'r-d0c001';
const SHORT = 'r-d0c002';
const paragraph = 'Field notes describe how the soil moisture probes behaved across the season and why. '.repeat(12);

function fixture(t) {
  const data = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-18T12:00:00Z');
  initDataDir(data, { home, env: {}, clock });
  mkdirSync(join(data, 'research'), { recursive: true });
  const sections = [];
  for (let i = 1; i <= 6; i++) {
    sections.push(`## Section ${i}`, paragraph, '', paragraph, '', `### Detail ${i}`, paragraph, '');
  }
  writeFileSync(join(data, `research/${LONG}.md`),
    ['---', `id: ${LONG}`, 'kind: analysis', 'title: Long Study', '---', ...sections].join('\n'));
  writeFileSync(join(data, `research/${SHORT}.md`),
    ['---', `id: ${SHORT}`, 'kind: analysis', 'title: Short Study', '---', '## Only', paragraph, ''].join('\n'));
  return () => openContext({ mode: 'read', dataDir: data, home, env: {}, clock });
}

// Real headless Chromium against the built pages: layout widths, sticky panel, scroll-spy, click-to-scroll,
// the narrow disclosure, rebinding after a live update and plain anchors without JavaScript.
test('research document: wide reading column with a sticky, scroll-spied table of contents', async (t) => {
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
  const open = fixture(t);
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  cleanup(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.goto(loginUrl(port, key, instance));
  await page.waitForURL(`${origin}/`, { timeout: 10_000 });
  await page.goto(`${origin}/research/${LONG}`);

  const box = (selector) => page.locator(selector).first().evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { width: Math.round(rect.width), top: Math.round(rect.top), left: Math.round(rect.left) };
  });
  const article = await box('.research-document');
  const panel = await box('[data-doc-toc]');
  t.diagnostic(`1440px: article ${article.width}px, panel ${panel.width}px`);
  assert.ok(article.width >= 780, `article uses the page frame (got ${article.width}px)`);
  assert.ok(panel.width >= 200 && panel.width <= 260, `panel is a side column (got ${panel.width}px)`);
  assert.ok(panel.left > article.left + article.width, 'panel sits on the right');
  assert.equal(await page.locator('[data-doc-toc-details]').evaluate((el) => el.open), true);
  assert.equal(await page.locator('.doc-toc-summary').isVisible(), false);

  await page.locator('.doc-toc-link[href="#sec-section-4"]').click();
  await page.waitForFunction(() => location.hash === '#sec-section-4');
  await page.waitForFunction(() => document.querySelector('.doc-toc-link[aria-current="true"]')
    ?.getAttribute('href') === '#sec-section-4');
  const heading = await box('#sec-section-4');
  assert.ok(heading.top >= 0 && heading.top < 200, `heading scrolled into view (top ${heading.top})`);
  assert.equal(await page.locator('.doc-toc-link[aria-current="true"]').count(), 1);
  const stuck = await box('[data-doc-toc]');
  assert.ok(stuck.top >= 0 && stuck.top < 120, `panel stays in view while reading (top ${stuck.top})`);

  await page.evaluate(() => document.getElementById('sec-detail-2').scrollIntoView({ block: 'start' }));
  await page.waitForFunction(() => document.querySelector('.doc-toc-link[aria-current="true"]')
    ?.getAttribute('href') === '#sec-detail-2');

  // A live update swaps <main>; the panel must rebind to the new nodes.
  await page.evaluate(() => {
    const main = document.querySelector('main');
    main.replaceWith(main.cloneNode(true));
    document.dispatchEvent(new CustomEvent('live:updated'));
    document.getElementById('sec-section-6').scrollIntoView({ block: 'start' });
  });
  await page.waitForFunction(() => document.querySelector('.doc-toc-link[aria-current="true"]')
    ?.getAttribute('href') === '#sec-section-6');

  await page.setViewportSize({ width: 800, height: 900 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => document.querySelector('[data-doc-toc-details]').open === false);
  assert.equal(await page.locator('[data-doc-toc]').evaluate((el) => getComputedStyle(el).position), 'static');
  const narrowPanel = await box('[data-doc-toc]');
  const narrowArticle = await box('.research-document');
  assert.ok(narrowPanel.top < narrowArticle.top, 'panel sits above the article on narrow screens');
  await page.locator('.doc-toc-summary').click();
  assert.equal(await page.locator('.doc-toc-link[href="#sec-section-2"]').isVisible(), true);
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth
    > document.documentElement.clientWidth), false, 'no horizontal overflow at 375px');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/research/${SHORT}`);
  assert.equal(await page.locator('[data-doc-toc]').count(), 0);
  const single = await box('.research-document');
  t.diagnostic(`1440px without contents: article ${single.width}px`);
  assert.ok(single.width >= 1000, `article takes the full frame without contents (got ${single.width}px)`);
  assert.deepEqual(errors, []);

  const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1440, height: 900 } });
  cleanup(() => noJs.close());
  const plain = await noJs.newPage();
  await plain.goto(loginUrl(port, key, instance));
  await plain.goto(`${origin}/research/${LONG}`);
  await plain.locator('.doc-toc-summary').click();
  await plain.locator('.doc-toc-link[href="#sec-section-3"]').click();
  assert.match(plain.url(), /#sec-section-3$/u);
});
