import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.mjs';
import { createApi } from '../server/api.mjs';
import { createCards } from '../server/cards.mjs';
import { createWrites } from '../server/writes.mjs';
import { createGuard } from '../server/guard.mjs';
import { createRead } from '../server/read.mjs';
import { createRenderPool } from '../server/render-pool.mjs';
import { loginUrl, siteHost } from '../server/session.mjs';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { addCard, claimCard, listCards } from '../core/card.mjs';
import { resolve } from '../core/entity.mjs';
import { resolveBrowser } from '../scripts/lib/design-check/config.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { liveCleanup, liveUnavailable } from './support/live.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const key = Buffer.alloc(32, 5), instance = 'run-cccccccccccccccc';

test('/board pointer and keyboard moves persist, preserve clicks and revert a claimed refusal', async (t) => {
  const cleanup = liveCleanup(t);
  if (!existsSync(join(repo, 'dist/app/server/entry.mjs'))) {
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
  cleanup(() => { server.closeAllConnections(); return new Promise((done) => server.close(done)); });
  try {
    await new Promise((done, reject) => server.once('error', reject).listen(0, '127.0.0.1', done));
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    return liveUnavailable(t, 'Loopback listen unavailable');
  }
  const port = server.address().port;
  const dataDir = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-10T12:00:00Z');
  initDataDir(dataDir, { home, env: {}, clock });
  const configFile = join(dataDir, '.cairn/config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.columns = [
    { key: 'todo', label: 'To do', role: 'todo' },
    { key: 'doing', label: 'Doing', role: 'doing' },
    { key: 'review', label: 'Review', role: 'doing' },
    { key: 'done', label: 'Done', role: 'done' },
    { key: 'archive', label: 'Archive', role: 'done', hidden: true },
  ];
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  const options = { dataDir, home, env: {}, clock };
  const open = () => openContext({ mode: 'read', ...options });
  const openWrite = () => openContext({ mode: 'write', actor: 'web:owner', ...options });
  const first = addCard(openWrite(), { title: 'Chart the route', column: 'todo' }).entity.id;
  const second = addCard(openWrite(), { title: 'Check the compass', column: 'todo' }).entity.id;
  const review = addCard(openWrite(), { title: 'Read the map', column: 'review' }).entity.id;
  const cards = createCards({ key, port, open, openWrite });
  const writes = createWrites({ key, port, routes: cards.routes, limit: 100 });
  const pool = createRenderPool();
  cleanup(() => pool.close());
  const { handler } = await import('../dist/app/server/entry.mjs');
  server.on('request', createApp({ root: repo, handler,
    guard: createGuard({ key, port, instance, writable: writes.writable }), writes: writes.handle,
    api: createApi({ open, events: { handle(_req, res) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('retry: 2000\n\n');
      return true;
    } } }),
    locals: { cards, cairn: createRead({ open, render: pool.render }) },
  }));
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  cleanup(() => context.close());
  const page = await context.newPage();
  const errors = [], consoleErrors = [], failed = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', (response) => {
    if (response.status() >= 400) failed.push({ status: response.status(), url: response.url() });
  });
  const origin = `http://${siteHost(key)}:${port}`;
  await page.goto(loginUrl(port, key, instance));
  await page.waitForURL(`${origin}/`);
  await page.goto(`${origin}/board`);
  const card = (id) => page.locator(`[data-card-id="${id}"]`);
  const link = (id) => card(id).locator('a.board-card');
  const columnOf = (id) => card(id).evaluate((element) => element.closest('section').dataset.moveColumn);
  const idle = () => page.waitForFunction(() => !document.documentElement.dataset.livePaused);
  const drag = async (id, column, beforeId) => {
    const box = await link(id).boundingBox();
    const target = await page.locator(`[data-move-column="${column}"]`).boundingBox();
    const before = beforeId ? await card(beforeId).boundingBox() : null;
    await page.mouse.move(box.x + box.width / 2, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, before ? before.y + 2 : target.y + target.height - 10,
      { steps: 12 });
    await page.waitForSelector('.board-drop-marker');
    // The lifted copy stays where it was grabbed: the pointer is still inside it, at the same offset.
    const ghost = await page.locator('.board-drag-ghost').boundingBox();
    const pointerX = target.x + target.width / 2;
    const pointerY = before ? before.y + 2 : target.y + target.height - 10;
    assert.ok(Math.abs(pointerX - ghost.x - box.width / 2) < 12 && Math.abs(pointerY - ghost.y - 20) < 12,
      `ghost at ${ghost.x},${ghost.y} for pointer ${pointerX},${pointerY}`);
    await page.mouse.up();
    await idle();
  };

  // A stationary press remains an ordinary click: it opens the card in the board's dialog, not a drag.
  await link(first).click();
  const dialog = page.locator('[data-card-dialog]');
  // The dialog opens the card's reading view, with no move control.
  await dialog.locator('[data-card-panel-edit]').waitFor();
  assert.equal(await dialog.locator('.document-heading h1').innerText(), 'Chart the route');
  assert.equal(await dialog.locator('.card-move').isVisible(), false);
  assert.equal(new URL(page.url()).pathname, '/board');
  await dialog.locator('[data-card-dialog-close]').click();
  assert.equal(await dialog.evaluate((element) => element.open), false);
  // After a drag the click that follows pointerup must not open the dialog.
  // The merged doing lane contains a review card: it must not become an invalid before/after reference.
  await drag(first, 'doing');
  assert.equal(await dialog.evaluate((element) => element.open), false);
  assert.equal(resolve(open(), 'card', first).data.column, 'doing');
  assert.equal(await columnOf(first), 'doing');
  assert.match(readFileSync(join(dataDir, resolve(open(), 'card', first).path), 'utf8'), /^column: doing$/mu);
  await idle();
  await link(second).focus();
  await page.keyboard.press('Alt+ArrowRight');
  await idle();
  assert.equal(resolve(open(), 'card', second).data.column, 'doing');
  assert.equal(await link(second).evaluate((element) => document.activeElement === element), true);

  // Test explicit columns for same-column order and counts after live replacement.
  await page.goto(`${origin}/board?columns=all`);
  await link(second).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await idle();
  assert.deepEqual(listCards(open(), { column: 'doing', includeDone: true }).map((card) => card.id), [second, first]);
  await page.keyboard.press('Alt+ArrowDown');
  await idle();
  assert.deepEqual(listCards(open(), { column: 'doing', includeDone: true }).map((card) => card.id), [first, second]);
  await drag(second, 'doing', first);
  assert.deepEqual(listCards(open(), { column: 'doing', includeDone: true }).map((card) => card.id), [second, first]);
  assert.equal((await page.locator('[data-move-column="todo"] [data-column-count]').innerText()).trim(), '0');
  assert.equal(await page.locator('[data-move-column="todo"] [data-column-empty]').isVisible(), true);

  // Hide the other card: no hidden card is sent as a position reference.
  await page.locator('[data-board-search]').fill('compass');
  const request = page.waitForRequest((req) => req.method() === 'POST' && req.url().endsWith('/move'));
  await link(second).focus();
  await page.keyboard.press('Alt+ArrowRight');
  assert.equal(new URLSearchParams((await request).postData()).has('before'), false);
  assert.equal(new URLSearchParams((await request).postData()).has('after'), false);
  await idle();
  assert.equal(resolve(open(), 'card', second).data.column, 'review');
  await page.locator('[data-board-search]').fill('');

  // An actual core claim refuses the POST. Observe optimism while holding the response, then rollback.
  claimCard(openContext({ mode: 'write', actor: 'agent:reader', ...options }), second);
  await page.goto(`${origin}/board?columns=all`);
  let release;
  const held = new Promise((done) => { release = done; });
  await page.route(`**/cards/${second}/move`, async (route) => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  const claimed = page.waitForResponse((response) => response.url().endsWith(`/cards/${second}/move`));
  await link(second).focus();
  await page.keyboard.press('Alt+ArrowRight');
  assert.equal(await columnOf(second), 'review', 'optimistic keyboard move enters the next visible column');
  release();
  assert.equal((await claimed).status(), 409);
  await idle();
  assert.equal(await columnOf(second), 'doing');
  assert.equal(resolve(open(), 'card', second).data.column, 'doing');
  assert.equal(await link(second).evaluate((element) => document.activeElement === element), true);
  assert.match(await page.locator('body > .sr-only[aria-live="polite"]').innerText(), /ajan tutuyor/u);
  assert.equal(resolve(open(), 'card', review).data.column, 'review');
  assert.deepEqual(failed, [{ status: 409, url: `${origin}/cards/${second}/move` }]);
  assert.deepEqual(errors, []);
  for (const message of consoleErrors) assert.match(message, /^Failed to load resource:.*409/u);
  assert.ok(consoleErrors.length <= 1, JSON.stringify(consoleErrors));

  // The card dialog edits the status lines in place and the new-card form adds a card, both without leaving /board.
  await page.goto(`${origin}/board`);
  await idle();
  await link(first).click();
  await dialog.locator('[data-card-panel-edit]').click();
  // The form arrives over fetch; if it does not, the dialog's status line says why.
  await page.waitForFunction(() => document.querySelector('[data-card-dialog] #card-now')
    || document.querySelector('[data-card-dialog-status]')?.textContent.trim().length > 0
      && !document.querySelector('[data-card-dialog-body]')?.getAttribute('aria-busy')?.startsWith('t'));
  assert.equal(await dialog.locator('#card-now').count(), 1,
    `${new URL(page.url()).pathname}: ${await dialog.locator('[data-card-dialog-status]').textContent()}`);
  await dialog.locator('#card-now').fill('Drawing the coast');
  await dialog.locator('button[type="submit"]').click();
  // Saving returns to the reading view, which shows the new line; Close then shuts the dialog.
  await dialog.locator('[data-card-panel-edit]').waitFor();
  assert.match(await dialog.locator('.document-heading').innerText(), /Drawing the coast/u);
  assert.equal(resolve(open(), 'card', first).data.now, 'Drawing the coast');
  await dialog.locator('[data-card-dialog-close]').click();
  await page.locator('[data-move-column="todo"] a.column-add').click();
  await dialog.locator('#card-title').fill('Pack the lantern');
  await dialog.locator('button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-card-dialog]').open);
  assert.ok(listCards(open(), { column: 'todo' }).some((item) => item.title === 'Pack the lantern'));
  assert.equal(new URL(page.url()).pathname, '/board');

  await page.goto(`${origin}/board?archive`);
  assert.equal(await page.locator('[data-board-draggable]').count(), 0);
  await page.goto(`${origin}/agents`);
  assert.equal(await page.locator('[data-board-draggable]').count(), 0);
});
