import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.mjs';
import { createApi } from '../server/api.mjs';
import { createEvents } from '../server/events.mjs';
import { createGuard } from '../server/guard.mjs';
import { createNotes } from '../server/notes.mjs';
import { createRead } from '../server/read.mjs';
import { createWrites } from '../server/writes.mjs';
import { cookieName, loginUrl, mintCookie, siteHost } from '../server/session.mjs';
import { openContext } from '../core/context.mjs';
import { parseFile } from '../core/frontmatter.mjs';
import { renderMarkdown } from '../core/render.mjs';
import { watch } from '../core/watch.mjs';
import * as entity from '../core/entity.mjs';
import * as note from '../core/note.mjs';
import * as project from '../core/project.mjs';
import { APP_ALLOWLIST, filterAllowed } from '../scripts/lib/design-check/allowlist.mjs';
import { useLanguage } from '../src/i18n/index.mjs';
import { fixedClock, seedDataDir, tempDir } from './support/env.mjs';
import { launchLiveChromium } from './support/live-browser.mjs';
import { liveCleanup, liveUnavailable } from './support/live.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const key = Buffer.alloc(32, 13);
const instance = 'run-ffffffffffffffff';

let sharedBrowser = null;
let browserUnavailable = null;

before(async () => {
  if (!existsSync(join(repo, 'dist/app/server/entry.mjs'))) {
    browserUnavailable = 'Astro output missing; run npm run build:app to enable browser coverage.';
    return;
  }
  ({ browser: sharedBrowser, unavailable: browserUnavailable } = await launchLiveChromium());
});

after(async () => {
  await sharedBrowser?.close();
});

async function launchBrowser(t) {
  if (sharedBrowser) return sharedBrowser;
  liveUnavailable(t, browserUnavailable ?? 'Chromium unavailable.');
  return null;
}

async function axeCheck(page, axeSource) {
  await page.evaluate(axeSource);
  const regions = [...new Set(APP_ALLOWLIST.map((item) => item.within))];
  const found = await page.evaluate(async (allowedRegions) => {
    const result = await window.axe.run(document, { resultTypes: ['violations'] });
    return result.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      nodes: nodes.map((node) => {
        const element = document.querySelector(node.target[0]);
        return { within: allowedRegions.filter((region) => element?.closest(region)) };
      }),
    }));
  }, regions);
  return filterAllowed(found);
}

test('pinned rail layout, breakpoints, pre-paint persistence, Escape, unpin/undo, error restore and axe themes',
  async (t) => {
    useLanguage('en');
    const cleanup = liveCleanup(t);
    const browser = await launchBrowser(t, cleanup);
    if (!browser) return;

    const dir = tempDir(t, 'cairn-rail-');
    const home = tempDir(t, 'cairn-rail-home-');
    seedDataDir(dir, { register: false, language: 'en' });
    const openAt = (iso) => openContext({ dataDir: dir, home, env: {}, clock: fixedClock(iso), mode: 'write',
      actor: 'web:owner' });
    const open = () => openContext({ dataDir: dir, home, env: {}, clock: fixedClock('2026-11-15T10:00:00Z'),
      mode: 'read' });
    const openWrite = () => openAt('2026-11-15T10:00:00Z');
    const work = project.create(openWrite(), { title: 'Work', status: 'active', tone: 3 }, '', {}).entity;

    const server = createServer();
    cleanup(() => { server.closeAllConnections(); return new Promise((done) => server.close(done)); });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address();
    const { handler } = await import(new URL('../dist/app/server/entry.mjs', import.meta.url));
    const notes = createNotes({ key, port, open, openWrite });
    const writes = createWrites({ key, port, routes: notes.routes, limit: 100 });
    const app = createApp({
      root: repo,
      handler,
      guard: createGuard({ port, key, instance, writable: writes.writable }),
      writes: writes.handle,
      api: createApi({ open, render: renderMarkdown, live: () => false }),
      locals: { cairn: createRead({ open, render: renderMarkdown }), notes, settings: { liveUpdates: () => false } },
    });
    server.on('request', app);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    cleanup(() => context.close());
    await context.addInitScript(() => {
      window.__railBoot = { mode: null, domMode: null, domRight: null };
      window.addEventListener('DOMContentLoaded', () => {
        window.__railBoot.domMode = document.documentElement.dataset.pinnedRail || null;
        window.__railBoot.domRight = document.querySelector('main')?.getBoundingClientRect().right ?? null;
      });
      new MutationObserver((_, observer) => {
        if (!document.body) return;
        window.__railBoot.mode = document.documentElement.dataset.pinnedRail || null;
        observer.disconnect();
      }).observe(document, { childList: true, subtree: true });
    });

    const page = await context.newPage();
    const errors = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(error.message));
    const axeSource = await readFile(fileURLToPath(import.meta.resolve('axe-core/axe.min.js')), 'utf8');

    const origin = `http://${siteHost(key)}:${port}`;
    await page.goto(loginUrl(port, key, instance));
    await page.waitForURL(`${origin}/`, { timeout: 10_000 });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    // Empty rail stays visible at 1440px so the owner learns how to pin notes.
    await page.locator('[data-pinned-empty]').waitFor({ state: 'visible' });

    // Seed two pinned notes in explicit updated order: Beta newest, Alpha older.
    const alpha = note.create(openAt('2026-11-15T09:00:00Z'),
      { title: 'Alpha pin', project: work.id, pinned: true }, '# Alpha\nFirst **pinned** note', {}).entity;
    const beta = note.create(openAt('2026-11-15T10:00:00Z'),
      { title: 'Beta pin', project: work.id, pinned: true }, 'See [[missing|Beta link]] text.', {}).entity;

    await page.reload();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const rail = page.locator('[data-pinned-panel]');
    const tab = page.locator('[data-pinned-tab]');
    assert.equal(await rail.evaluate((el) => getComputedStyle(el).display !== 'none' && !el.inert), true);
    assert.equal(await tab.evaluate((el) => el.inert), true);

    const checkNoOverlapAt1440 = async () => {
      const box = await page.evaluate(() => {
        const panel = document.querySelector('[data-pinned-panel]').getBoundingClientRect();
        const main = document.querySelector('main').getBoundingClientRect();
        const fab = document.querySelector('[data-quick-note-fab]').getBoundingClientRect();
        const status = document.querySelector('.live-status')?.getBoundingClientRect() ?? null;
        return { panel, main, fab, status };
      });
      assert.ok(box.main.right <= box.panel.left + 1, 'main must clear the open pinned rail at 1440px');
      assert.ok(box.fab.right <= box.panel.left + 1, 'FAB must sit left of open pinned rail at 1440px');
      if (box.status && box.status.height > 0) {
        assert.ok(box.fab.bottom <= box.status.top + 1, 'FAB must not overlap live-status');
      }
    };
    await checkNoOverlapAt1440();
    await page.goto(`${origin}/board`);
    await checkNoOverlapAt1440();
    await page.goto(`${origin}/`);

    // Below 90rem (1280px and 375px), rail and edge tab are removed from layout and marked inert.
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 800 });
      assert.equal(await rail.evaluate((el) => getComputedStyle(el).display === 'none' && el.inert), true);
      assert.equal(await tab.evaluate((el) => getComputedStyle(el).display === 'none' && el.inert), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      assert.deepEqual(await axeCheck(page, axeSource), [], `no axe findings at ${width}px`);
    }

    // Hide persists across reload with pre-paint application and zero layout jump.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('[data-pinned-close]').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('cairn-pinned-rail')), 'closed');
    assert.equal(await rail.evaluate((el) => el.inert), true);
    assert.equal(await tab.evaluate((el) => el.inert), false);
    assert.equal(await tab.evaluate((el) => el === document.activeElement), true);

    await page.reload();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const closedBoot = await page.evaluate(() => ({
      ...window.__railBoot,
      loadRight: document.querySelector('main')?.getBoundingClientRect().right ?? null,
    }));
    assert.equal(closedBoot.mode, 'closed');
    assert.equal(closedBoot.domMode, 'closed');
    assert.equal(closedBoot.domRight, closedBoot.loadRight, 'closed rail must not jump after reload');

    // Edge tab restores rail and persists open across reload without layout jump.
    await tab.click();
    assert.equal(await page.evaluate(() => localStorage.getItem('cairn-pinned-rail')), 'open');
    assert.equal(await rail.evaluate((el) => el.inert), false);
    assert.equal(await tab.evaluate((el) => el.inert), true);

    await page.reload();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const openBoot = await page.evaluate(() => ({
      ...window.__railBoot,
      loadRight: document.querySelector('main')?.getBoundingClientRect().right ?? null,
    }));
    assert.equal(openBoot.mode, 'open');
    assert.equal(openBoot.domMode, 'open');
    assert.equal(openBoot.domRight, openBoot.loadRight, 'open rail must not jump after reload');

    // Escape inside the rail closes it and focuses the edge tab.
    await page.locator('[data-pinned-item] .pinned-rail-link').first().focus();
    await page.keyboard.press('Escape');
    assert.equal(await rail.evaluate((el) => el.inert), true);
    assert.equal(await tab.evaluate((el) => el === document.activeElement), true);
    await tab.click();

    // Unpin removes row, moves focus to next row, writes pinned: false to disk; Undo restores pinned: true.
    const betaFile = join(dir, entity.resolve(open(), 'note', beta.id).path);
    await page.locator('[data-pinned-item]').first().locator('button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-pinned-item]').length === 1);
    assert.equal(await page.locator('[data-pinned-item]').first().locator('.pinned-rail-link')
      .evaluate((el) => el === document.activeElement), true, 'focus moves to next pinned row after unpin');
    assert.strictEqual(parseFile(readFileSync(betaFile, 'utf8')).data.pinned, false);

    const undo = page.locator('[data-pinned-undo]');
    await undo.waitFor({ state: 'visible' });
    await undo.click();
    await page.waitForFunction(() => document.querySelectorAll('[data-pinned-item]').length === 2);
    assert.strictEqual(parseFile(readFileSync(betaFile, 'utf8')).data.pinned, true);

    // Conflict (409) on unpin keeps the row in place, reports error in status, and restores focus to unpin button.
    note.update(openWrite(), beta.id, { title: 'Beta revised externally' });
    const firstUnpin = page.locator('[data-pinned-item]').first().locator('[data-pinned-unpin]');
    await firstUnpin.click();
    await page.waitForFunction(() => Boolean(document.querySelector('[data-pinned-status]')?.textContent?.trim()));
    assert.equal(await page.locator('[data-pinned-item]').count(), 2);
    assert.equal(await page.locator('[data-pinned-item].is-leaving').count(), 0);
    assert.equal(await firstUnpin.evaluate((el) => el === document.activeElement && !el.disabled), true);
    assert.ok(errors.length === 1 && /409/u.test(errors[0]), errors.join('; '));
    errors.length = 0;

    // Axe clean in light, dark, and Cam (light & dark glass) with open rail at 1440px.
    const themes = [
      { name: 'light', mode: 'light', glass: 'off' },
      { name: 'dark', mode: 'dark', glass: 'off' },
      { name: 'cam-light', mode: 'light', glass: 'on' },
      { name: 'cam-dark', mode: 'dark', glass: 'on' },
    ];
    for (const theme of themes) {
      await page.evaluate(({ mode, glass }) => {
        localStorage.setItem('cairn-mode', mode);
        localStorage.setItem('cairn-glass', glass);
      }, theme);
      await page.reload();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      assert.deepEqual(await axeCheck(page, axeSource), [], `axe clean in ${theme.name}`);
    }

    assert.equal(alpha.id !== beta.id, true);
    assert.deepEqual(errors, [], `unexpected console/page errors: ${errors.join('; ')}`);
  });

test('live updates refresh the pinned rail when an external write pins a note', async (t) => {
  useLanguage('en');
  const cleanup = liveCleanup(t);
  const browser = await launchBrowser(t, cleanup);
  if (!browser) return;

  const dir = tempDir(t, 'cairn-rail-live-');
  const home = tempDir(t, 'cairn-rail-live-home-');
  seedDataDir(dir, { register: false, language: 'en' });
  const open = () => openContext({ dataDir: dir, home, env: {}, mode: 'read' });
  const openWrite = () => openContext({ dataDir: dir, home, mode: 'write', actor: 'agent:test', env: {} });
  const watcher = watch(open());
  cleanup(() => watcher.close());
  if (!await watcher.ready) { liveUnavailable(t, 'Native file watching unavailable'); return; }

  const events = createEvents(watcher);
  cleanup(() => events.close());
  const server = createServer();
  cleanup(() => { events.close(); server.closeAllConnections(); return new Promise((done) => server.close(done)); });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  const { handler } = await import(new URL('../dist/app/server/entry.mjs', import.meta.url));
  const notes = createNotes({ key, port, open, openWrite });
  const writes = createWrites({ key, port, routes: notes.routes, limit: 100 });
  server.on('request', createApp({
    root: repo,
    handler,
    guard: createGuard({ port, key, instance, writable: writes.writable }),
    writes: writes.handle,
    api: createApi({ open, render: renderMarkdown, events }),
    locals: { cairn: createRead({ open, render: renderMarkdown }), notes },
  }));

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  cleanup(() => context.close());
  const hostname = siteHost(key);
  await context.addCookies([{ name: cookieName(port), value: mintCookie(key, port),
    url: `http://${hostname}:${port}`, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage();
  const errors = [];
  let navigations = 0;
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });

  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/api/reconcile'), { timeout: 15_000 }),
    page.goto(`http://${hostname}:${port}/`),
  ]);
  await page.locator('[data-pinned-empty]').waitFor({ state: 'visible' });

  const firstLive = note.create(openWrite(), { title: 'Live pinned note', pinned: true }, 'Synced via watcher', {});
  await page.waitForFunction(() => document.querySelectorAll('[data-pinned-item]').length === 1, null,
    { timeout: 15_000 });
  assert.match(await page.locator('[data-pinned-item]').first().innerText(), /Live pinned note/u);

  // Focus on an unpin button returns to that unpin button after a live refresh.
  const firstId = firstLive.entity.id;
  await page.locator(`[data-pinned-item][data-ref="${firstId}"] [data-pinned-unpin]`).focus();
  note.create(openWrite(), { title: 'Second live pin', pinned: true }, 'Second body', {});
  await page.waitForFunction(() => document.querySelectorAll('[data-pinned-item]').length === 2, null,
    { timeout: 15_000 });
  assert.equal(await page.evaluate((ref) => {
    const active = document.activeElement;
    return Boolean(active?.matches('[data-pinned-unpin]')
      && active.closest('[data-pinned-item]')?.dataset.ref === ref);
  }, firstId), true, 'live refresh must return focus to the same unpin button');

  assert.equal(navigations, 1);
  assert.deepEqual(errors, [], `unexpected console/page errors: ${errors.join('; ')}`);
});

test('pinned rail handles followed-page 500, failed undo retry, failed refresh notice and external livePaused',
  async (t) => {
    useLanguage('en');
    const cleanup = liveCleanup(t);
    const browser = await launchBrowser(t, cleanup);
    if (!browser) return;

    const dir = tempDir(t, 'cairn-rail-edge-');
    const home = tempDir(t, 'cairn-rail-edge-home-');
    seedDataDir(dir, { register: false, language: 'en' });
    const open = () => openContext({ dataDir: dir, home, env: {},
      clock: fixedClock('2026-11-15T10:00:00Z'), mode: 'read' });
    const openWrite = () => openContext({ dataDir: dir, home, env: {},
      clock: fixedClock('2026-11-15T10:00:00Z'), mode: 'write', actor: 'web:owner' });
    const first = note.create(openWrite(), { title: 'One pin', pinned: true }, 'Body 1', {}).entity;
    const second = note.create(openWrite(), { title: 'Two pin', pinned: true }, 'Body 2', {}).entity;

    const server = createServer();
    cleanup(() => { server.closeAllConnections(); return new Promise((done) => server.close(done)); });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address();
    const { handler } = await import(new URL('../dist/app/server/entry.mjs', import.meta.url));
    const notes = createNotes({ key, port, open, openWrite });
    const writes = createWrites({ key, port, routes: notes.routes, limit: 100 });
    let failNoteGet = false;
    const wrappedHandler = (req, res, ...rest) => {
      if (failNoteGet && req.method === 'GET' && /^\/notes\/n-/u.test(req.url || '')) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<h1>Note render failed</h1>');
        return;
      }
      return handler(req, res, ...rest);
    };
    server.on('request', createApp({
      root: repo,
      handler: wrappedHandler,
      guard: createGuard({ port, key, instance, writable: writes.writable }),
      writes: writes.handle,
      api: createApi({ open, render: renderMarkdown, live: () => false }),
      locals: { cairn: createRead({ open, render: renderMarkdown }), notes, settings: { liveUpdates: () => false } },
    }));

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    cleanup(() => context.close());
    const page = await context.newPage();
    const errors = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(error.message));

    const origin = `http://${siteHost(key)}:${port}`;
    await page.goto(loginUrl(port, key, instance));
    await page.waitForURL(`${origin}/`, { timeout: 10_000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-pinned-item]').length === 2);

    // 1. Failed undo keeps the Undo button enabled so it can be retried.
    await page.locator('[data-pinned-item]').first().locator('[data-pinned-unpin]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-pinned-item]').length === 1);
    const undo = page.locator('[data-pinned-undo]');
    await undo.waitFor({ state: 'visible' });

    let failUndoOnce = true;
    const undoRoute = async (route) => {
      if (failUndoOnce && route.request().method() === 'POST') {
        failUndoOnce = false;
        await route.fulfill({ status: 503, contentType: 'text/html', body: '<h1>Busy</h1>' });
        return;
      }
      await route.continue();
    };
    await page.route(/\/notes\/n-[^/]+\/pin$/u, undoRoute);
    await undo.click();
    await page.waitForFunction(() => /Could not update/u
      .test(document.querySelector('[data-pinned-status]')?.textContent || ''));
    assert.equal(await undo.isVisible(), true);
    assert.equal(await undo.isEnabled(), true);
    await page.unroute(/\/notes\/n-[^/]+\/pin$/u, undoRoute);

    // Retry undo succeeds and restores the item.
    await undo.click();
    await page.waitForFunction(() => document.querySelectorAll('[data-pinned-item]').length === 2);
    assert.ok(errors.length === 1 && /503/u.test(errors[0]), errors.join('; '));
    errors.length = 0;

    // 2. Unpin preserves external livePaused flag and does not dispatch live:resume.
    await page.evaluate(() => {
      window.__resumes = 0;
      document.addEventListener('live:resume', () => { window.__resumes += 1; });
      document.documentElement.dataset.livePaused = 'true';
    });
    await page.locator('[data-pinned-item]').first().locator('[data-pinned-unpin]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-pinned-item]').length === 1);
    assert.deepEqual(await page.evaluate(() => ({
      paused: document.documentElement.dataset.livePaused,
      resumes: window.__resumes,
    })), { paused: 'true', resumes: 0 });
    await page.evaluate(() => { delete document.documentElement.dataset.livePaused; });

    // 3. When undo succeeds but refreshing the rail fails, status asks to reload the page.
    await undo.waitFor({ state: 'visible' });
    const failHome = async (route) => {
      if (route.request().method() === 'GET' && new URL(route.request().url()).pathname === '/') {
        await route.fulfill({ status: 500, contentType: 'text/html', body: '<h1>Refresh error</h1>' });
        return;
      }
      await route.continue();
    };
    await page.route(`${origin}/`, failHome);
    await undo.click();
    await page.waitForFunction(() => /reload the page/iu
      .test(document.querySelector('[data-pinned-status]')?.textContent || ''));
    await page.unroute(`${origin}/`, failHome);
    assert.equal(await page.locator('[data-pinned-undo]').count(), 0);
    assert.ok(errors.length === 1 && /500/u.test(errors[0]), errors.join('; '));
    errors.length = 0;

    // Reload to restore the rail, then test followed note GET 500 on unpin.
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('[data-pinned-item]').length === 2);

    // 4. Followed note page returning 500 after redirect still counts as unpin success and refreshes rail.
    failNoteGet = true;
    await page.locator('[data-pinned-item]').first().locator('[data-pinned-unpin]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-pinned-item]').length === 1);
    failNoteGet = false;
    assert.equal((await page.locator('[data-pinned-status]').textContent())?.trim(), '');
    assert.equal(await page.locator('[data-pinned-undo]').count(), 0);
    assert.ok(first.id !== second.id);
    assert.ok(errors.length === 1 && /500/u.test(errors[0]), errors.join('; '));
  });

test('pinned rail preserves $& in note titles for unpin aria-label and undo status', async (t) => {
  useLanguage('en');
  const cleanup = liveCleanup(t);
  const browser = await launchBrowser(t, cleanup);
  if (!browser) return;

  const dir = tempDir(t, 'cairn-rail-dollar-');
  const home = tempDir(t, 'cairn-rail-dollar-home-');
  seedDataDir(dir, { register: false, language: 'en' });
  const clock = fixedClock('2026-11-15T10:00:00Z');
  const open = () => openContext({ dataDir: dir, home, env: {}, clock, mode: 'read' });
  const openWrite = () => openContext({ dataDir: dir, home, env: {}, clock, mode: 'write', actor: 'web:owner' });
  note.create(openWrite(), { title: 'Pay $& now', pinned: true }, 'Details.', {});

  const server = createServer();
  cleanup(() => { server.closeAllConnections(); return new Promise((done) => server.close(done)); });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  const { handler } = await import(new URL('../dist/app/server/entry.mjs', import.meta.url));
  const notes = createNotes({ key, port, open, openWrite });
  const writes = createWrites({ key, port, routes: notes.routes, limit: 100 });
  server.on('request', createApp({
    root: repo,
    handler,
    guard: createGuard({ port, key, instance, writable: writes.writable }),
    writes: writes.handle,
    api: createApi({ open, render: renderMarkdown, live: () => false }),
    locals: { cairn: createRead({ open, render: renderMarkdown }), notes, settings: { liveUpdates: () => false } },
  }));

  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  cleanup(() => context.close());
  const page = await context.newPage();
  const origin = `http://${siteHost(key)}:${port}`;
  await page.goto(loginUrl(port, key, instance));
  await page.waitForURL(`${origin}/`, { timeout: 10_000 });

  const unpin = page.locator('[data-pinned-unpin]').first();
  assert.equal(await unpin.getAttribute('aria-label'), 'Unpin Pay $& now');
  await unpin.click();
  await page.waitForFunction(() => /Pay \$& now/u
    .test(document.querySelector('[data-pinned-status]')?.textContent || ''));
  assert.match(await page.locator('[data-pinned-status] span').textContent(), /Pay \$& now/u);
});
