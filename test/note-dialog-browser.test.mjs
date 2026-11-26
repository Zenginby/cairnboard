import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.mjs';
import { createApi } from '../server/api.mjs';
import { createGuard } from '../server/guard.mjs';
import { createRead } from '../server/read.mjs';
import { createNotes } from '../server/notes.mjs';
import { createWrites } from '../server/writes.mjs';
import { loginUrl, siteHost } from '../server/session.mjs';
import { openContext } from '../core/context.mjs';
import { renderMarkdown } from '../core/render.mjs';
import * as entity from '../core/entity.mjs';
import { create as createNote } from '../core/note.mjs';
import * as project from '../core/project.mjs';
import { APP_ALLOWLIST, filterAllowed } from '../scripts/lib/design-check/allowlist.mjs';
import { resolveBrowser } from '../scripts/lib/design-check/config.mjs';
import { useLanguage } from '../src/i18n/index.mjs';
import { fixedClock, seedDataDir, tempDir } from './support/env.mjs';
import { liveCleanup, liveUnavailable } from './support/live.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const key = Buffer.alloc(32, 11);
const instance = 'run-eeeeeeeeeeeeeeee';
const clock = fixedClock('2026-11-15T10:00:00Z');

let sharedBrowser = null;
let browserUnavailable = null;

before(async () => {
  if (!existsSync(join(repo, 'dist/app/server/entry.mjs'))) {
    browserUnavailable = 'Astro output missing; run npm run build:app to enable integration coverage.';
    return;
  }
  try {
    const { executablePath } = resolveBrowser('chromium', { downloadedPath: chromium.executablePath() });
    sharedBrowser = await chromium.launch({
      executablePath,
      headless: true,
      timeout: 15_000,
      args: ['--no-proxy-server', '--host-resolver-rules=MAP *.cairnboard.localhost 127.0.0.1'],
    });
  } catch (error) {
    browserUnavailable = `Chromium missing: ${error.message}`;
  }
});

after(async () => {
  await sharedBrowser?.close();
});

async function boot(t, { language = 'en', seed = false } = {}) {
  useLanguage(language);
  const cleanup = liveCleanup(t);
  if (!sharedBrowser) {
    liveUnavailable(t, browserUnavailable ?? 'Chromium unavailable.');
    return null;
  }
  const browser = sharedBrowser;
  const dir = tempDir(t, 'cairn-note-dialog-');
  const home = tempDir(t, 'cairn-note-dialog-home-');
  seedDataDir(dir, { register: false, language });
  const open = () => openContext({ dataDir: dir, home, env: {}, clock, mode: 'read' });
  const openWrite = () => openContext({ dataDir: dir, home, env: {}, clock, mode: 'write', actor: 'web:owner' });
  const active = project.create(openWrite(), { title: 'Garden', status: 'active' }, '', {}).entity;
  if (seed) createNote(openWrite(), { kind: 'note', title: 'Seed note', project: active.id }, 'Initial text.', {});

  const server = createServer();
  cleanup(() => new Promise((done) => server.close(done)));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  const { handler } = await import(new URL('../dist/app/server/entry.mjs', import.meta.url));
  const notes = createNotes({ key, port, open, openWrite });
  const writes = createWrites({ key, port, routes: notes.routes, limit: 100 });
  const serverState = { failNoteGet: false };
  const wrappedHandler = (req, res, ...rest) => {
    if (serverState.failNoteGet && req.method === 'GET' && /^\/notes\/n-/u.test(req.url || '')) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<h1>Render error</h1>');
      return;
    }
    return handler(req, res, ...rest);
  };
  const app = createApp({
    root: repo,
    handler: wrappedHandler,
    guard: createGuard({ port, key, instance, writable: writes.writable }),
    writes: writes.handle,
    api: createApi({ open, render: renderMarkdown, live: () => false }),
    locals: { cairn: createRead({ open, render: renderMarkdown }), notes, settings: { liveUpdates: () => false } },
  });
  server.on('request', app);

  return { dir, open, active, port, browser, cleanup, serverState };
}

async function axeCheck(page, axeSource) {
  await page.evaluate(axeSource);
  const regions = [...new Set(APP_ALLOWLIST.map((item) => item.within))];
  const found = await page.evaluate(async (regions) => {
    const result = await window.axe.run(document, { resultTypes: ['violations'] });
    return result.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      nodes: nodes.map((node) => {
        const element = document.querySelector(node.target[0]);
        return { within: regions.filter((region) => element?.closest(region)) };
      }),
    }));
  }, regions);
  return filterAllowed(found);
}

test('quick-note dialog: N shortcut, typing guard, save keeps page, failure keeps text, Escape restores focus',
  async (t) => {
    const env = await boot(t, { seed: true });
    if (!env) return;
    const context = await env.browser.newContext({ viewport: { width: 1280, height: 800 } });
    env.cleanup(() => context.close());
    const page = await context.newPage();
    const errors = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(error.message));
    const axeSource = await readFile(fileURLToPath(import.meta.resolve('axe-core/axe.min.js')), 'utf8');

    const origin = `http://${siteHost(key)}:${env.port}`;
    await page.goto(loginUrl(env.port, key, instance));
    await page.waitForURL(`${origin}/`, { timeout: 10_000 });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    // Modifier keys do not open the quick-note dialog.
    const dialog = page.locator('[data-note-dialog]');
    for (const combo of ['Control+n', 'Alt+n', 'Meta+n']) {
      await page.keyboard.press(combo);
      assert.equal(await dialog.evaluate((el) => el.open), false, `${combo} should not open note dialog`);
    }

    // Typing inside an input, textarea or select does not open the quick-note dialog.
    await page.goto(`${origin}/search`);
    await page.locator('#search-query').focus();
    await page.keyboard.press('n');
    assert.equal(await dialog.evaluate((el) => el.open), false);
    assert.equal(await page.locator('#search-query').inputValue(), 'n');

    await page.goto(`${origin}/notes/new`);
    await page.locator('#note-body').focus();
    await page.keyboard.press('n');
    assert.equal(await dialog.evaluate((el) => el.open), false);
    assert.equal(await page.locator('#note-body').inputValue(), 'n');
    await page.locator('#note-project').focus();
    await page.keyboard.press('n');
    assert.equal(await dialog.evaluate((el) => el.open), false);

    // N does nothing while another dialog is already open.
    await page.goto(`${origin}/`);
    await page.locator('[data-search-open]').click();
    await page.locator('[data-search-dialog]').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.locator('[data-search-open]').click();
    await page.evaluate(() => { document.activeElement?.blur?.(); });
    await page.keyboard.press('n');
    assert.equal(await dialog.evaluate((el) => el.open), false);
    await page.keyboard.press('Escape');

    // Focus an element on /, press N: dialog opens and focuses the title field.
    const notesTab = page.locator('.app-tabs a[href="/notes"]');
    await notesTab.focus();
    await page.keyboard.press('n');
    await dialog.waitFor({ state: 'visible' });
    await page.locator('#note-title').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'note-title');
    assert.deepEqual(await axeCheck(page, axeSource), [], 'open quick-note dialog on desktop: no axe findings');

    // A refused write shows the error message and keeps the typed text.
    const cfgPath = join(env.dir, '.cairn', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.rules = { ...(cfg.rules ?? {}), links: 'error' };
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

    await page.locator('#note-title').fill('Rule checked note');
    await page.locator('#note-body').fill('Body kept [[ghost]]');
    await page.locator('#note-project').selectOption(env.active.id);
    await dialog.getByRole('button', { name: 'Save note' }).click();

    const status = page.locator('[data-note-dialog-status]');
    await page.waitForFunction(() => Boolean(document.querySelector('[data-note-dialog-status]')?.textContent?.trim()));
    assert.match(await status.textContent(), /links/u);
    assert.equal(await page.locator('#note-title').inputValue(), 'Rule checked note');
    assert.equal(await page.locator('#note-body').inputValue(), 'Body kept [[ghost]]');
    assert.equal(await page.locator('#note-project').inputValue(), env.active.id);
    // The refused 422 write is the only expected console error.
    assert.ok(errors.length === 1 && /422/u.test(errors[0]), errors.join('\n'));
    errors.length = 0;

    // Fix the note, save: page URL stays on /, the dialog closes and a toast links to the created note.
    await page.locator('#note-body').fill('Body kept without broken link');
    await dialog.getByRole('button', { name: 'Save note' }).click();
    const toast = page.locator('[data-app-toast]');
    await toast.locator('a').waitFor({ state: 'visible' });

    assert.equal(page.url(), `${origin}/`);
    assert.equal(await dialog.evaluate((el) => el.open), false);
    assert.match(await toast.textContent(), /Note saved\./u);
    const savedHref = await toast.locator('a').getAttribute('href');
    assert.match(savedHref ?? '', /^\/notes\/n-[0-9a-hjkmnp-tv-z]{6}$/u);
    const savedId = savedHref.slice('/notes/'.length);
    const savedEntity = entity.resolve(env.open(), 'note', savedId);
    assert.equal(savedEntity.title, 'Rule checked note');
    assert.equal(savedEntity.data.kind, 'note');
    assert.equal(savedEntity.data.project, env.active.id);

    // Saving gave focus back to where it was before N; Escape closes a reopened dialog.
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('href')), '/notes');
    await page.keyboard.press('n');
    await page.locator('#note-title').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    assert.equal(await dialog.evaluate((el) => el.open), false);

    // Close button also closes.
    await page.keyboard.press('n');
    await page.locator('#note-title').waitFor({ state: 'visible' });
    await page.locator('[data-note-dialog-close]').click();
    assert.equal(await dialog.evaluate((el) => el.open), false);

    // FAB opens the dialog and checking Pin creates a note with boolean pinned: true.
    const fab = page.locator('[data-quick-note-fab]');
    await fab.waitFor({ state: 'visible' });
    await fab.click();
    await page.locator('#note-title').waitFor({ state: 'visible' });
    await page.locator('#note-title').fill('FAB pinned note');
    await page.locator('dialog[data-note-dialog] input[name="pinned"]').check();
    await dialog.getByRole('button', { name: 'Save note' }).click();
    await dialog.waitFor({ state: 'hidden' });
    const fabHref = await page.locator('[data-app-toast] a').getAttribute('href');
    const fabId = fabHref.slice('/notes/'.length);
    assert.strictEqual(entity.resolve(env.open(), 'note', fabId).data.pinned, true);

    for (const path of ['/board', '/notes', '/search']) {
      await page.goto(`${origin}${path}`);
      await page.locator('[data-quick-note-fab]').waitFor({ state: 'visible' });
    }
    await page.goto(`${origin}/notes/new`);
    assert.equal(await page.locator('[data-quick-note-fab]').count(), 0);

    assert.deepEqual(errors, [], `unexpected console/page errors: ${errors.join('; ')}`);
  });

test('quick-note dialog and /notes/new work at 375px with axe clean and no overflow', async (t) => {
  const env = await boot(t);
  if (!env) return;
  const context = await env.browser.newContext({ viewport: { width: 375, height: 700 } });
  env.cleanup(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  const axeSource = await readFile(fileURLToPath(import.meta.resolve('axe-core/axe.min.js')), 'utf8');

  const origin = `http://${siteHost(key)}:${env.port}`;
  await page.goto(loginUrl(env.port, key, instance));
  await page.waitForURL(`${origin}/`, { timeout: 10_000 });

  await page.goto(`${origin}/notes`);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const mobileFab = await page.locator('[data-quick-note-fab]').boundingBox();
  assert.ok(mobileFab && mobileFab.width > 0);
  assert.ok(Math.abs(mobileFab.width - mobileFab.height) <= 2, 'FAB under 40rem should be round icon-only');

  await page.keyboard.press('n');
  await page.locator('#note-title').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(await axeCheck(page, axeSource), [], 'open quick-note dialog at 375px: no axe findings');
  await page.keyboard.press('Escape');

  await page.locator('a[href="/notes/new"]').first().click();
  await page.waitForURL(`${origin}/notes/new`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(await axeCheck(page, axeSource), [], '/notes/new at 375px: no axe findings');

  await page.locator('#note-title').fill('Mobile page note');
  await page.locator('#note-body').fill('Written on narrow screen.');
  await page.getByRole('button', { name: 'Save note' }).click();
  await page.waitForURL(new RegExp(`^${origin}/notes/n-[0-9a-hjkmnp-tv-z]{6}$`, 'u'));
  assert.deepEqual(errors, [], `unexpected console/page errors: ${errors.join('; ')}`);

  // Without JavaScript, the floating button navigates to /notes/new and saves cleanly.
  const plain = await env.browser.newContext({ javaScriptEnabled: false });
  env.cleanup(() => plain.close());
  const bare = await plain.newPage();
  await bare.goto(loginUrl(env.port, key, instance));
  await bare.goto(`${origin}/notes`);
  await bare.locator('[data-quick-note-fab]').click();
  await bare.waitForURL(`${origin}/notes/new`);
  await bare.locator('#note-title').fill('No-script note');
  await bare.getByRole('button', { name: 'Save note' }).click();
  await bare.waitForURL(new RegExp(`^${origin}/notes/n-[0-9a-hjkmnp-tv-z]{6}$`, 'u'));
});

test('quick-note dialog reports success with link even when the followed note page fails to render', async (t) => {
  const env = await boot(t);
  if (!env) return;
  const context = await env.browser.newContext({ viewport: { width: 1280, height: 800 } });
  env.cleanup(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));

  const origin = `http://${siteHost(key)}:${env.port}`;
  await page.goto(loginUrl(env.port, key, instance));
  await page.waitForURL(`${origin}/`, { timeout: 10_000 });

  env.serverState.failNoteGet = true;

  await page.keyboard.press('n');
  const dialog = page.locator('[data-note-dialog]');
  await page.locator('#note-title').waitFor({ state: 'visible' });
  await page.locator('#note-title').fill('Saved despite 500');
  await page.locator('#note-body').fill('Body text');
  await dialog.getByRole('button', { name: 'Save note' }).click();

  await page.locator('[data-app-toast] a').waitFor({ state: 'visible' });
  assert.match(await page.locator('[data-app-toast]').textContent(), /Note saved\./u);
  const href = await page.locator('[data-app-toast] a').getAttribute('href');
  assert.match(href ?? '', /^\/notes\/n-[0-9a-hjkmnp-tv-z]{6}$/u);
  assert.equal(await page.locator('[data-note-dialog]').evaluate((el) => el.open), false);
  assert.equal(entity.resolve(env.open(), 'note', href.slice('/notes/'.length)).title, 'Saved despite 500');
  assert.ok(errors.length === 1 && /500/u.test(errors[0]), errors.join('\n'));
});

test('/notes/new N shortcut focuses the page title field instead of opening a duplicate dialog', async (t) => {
  const env = await boot(t);
  if (!env) return;
  const context = await env.browser.newContext({ viewport: { width: 1280, height: 800 } });
  env.cleanup(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));

  const origin = `http://${siteHost(key)}:${env.port}`;
  await page.goto(loginUrl(env.port, key, instance));
  await page.waitForURL(`${origin}/`, { timeout: 10_000 });

  await page.goto(`${origin}/notes/new`);
  await page.locator('#note-title').waitFor({ state: 'visible' });
  await page.locator('h1').click();
  await page.keyboard.press('n');

  assert.equal(await page.locator('[data-note-dialog]').evaluate((el) => el.open), false);
  assert.equal(await page.locator('#note-title').count(), 1);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'note-title');
  assert.deepEqual(errors, [], `unexpected console/page errors: ${errors.join('; ')}`);
});
