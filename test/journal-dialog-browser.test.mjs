import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
import { APP_ALLOWLIST, filterAllowed } from '../scripts/lib/design-check/allowlist.mjs';
import { resolveBrowser } from '../scripts/lib/design-check/config.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { liveCleanup, liveUnavailable } from './support/live.mjs';
// The pages below are asserted in Turkish. The interface falls back to English, so this file sets the language
// explicitly, the way the server does at start.
process.env.CAIRN_LANGUAGE = 'tr';

const repo = fileURLToPath(new URL('../', import.meta.url));
const key = Buffer.alloc(32, 12), instance = 'run-hhhhhhhhhhhhhhhh';
const ALPHA = 'p-a1pha2';
const paragraph = 'A long line of notes about the work so the dialog body has to scroll to reach it. '.repeat(6);

function fixture(t) {
  const dataDir = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-08T12:00:00Z');
  initDataDir(dataDir, { home, env: {}, clock });
  mkdirSync(join(dataDir, 'projects'), { recursive: true });
  writeFileSync(join(dataDir, `projects/${ALPHA}.md`),
    `---\nid: ${ALPHA}\ntitle: Alpha project\ntone: 2\nstatus: active\n---\nBody.\n`);
  mkdirSync(join(dataDir, 'journal'), { recursive: true });
  const job = (title, project) => `## ${title} · desk\n\n${project ? `<!-- cairn:project ${project} -->\n\n` : ''}`
    + Array.from({ length: 6 }, (_, i) => `- ${title} item ${i + 1}: ${paragraph}`).join('\n') + '\n';
  for (const date of ['2026-11-02', '2026-11-03', '2026-11-05']) {
    writeFileSync(join(dataDir, `journal/${date}.md`), `---\ndate: ${date}\n---\n`
      + [job(`Loose ${date}`), job(`Alpha one ${date}`, ALPHA), job(`Alpha two ${date}`, ALPHA)].join('\n'));
  }
  const options = { dataDir, home, env: {}, clock };
  return { open: () => openContext({ mode: 'read', ...options }),
    openWrite: () => openContext({ mode: 'write', ...options, actor: 'web:owner' }) };
}

// The month page in a real headless Chromium: a day opens in a modal dialog with its own scrolling body and a
// grouped "On this page" panel; "Add to today" opens the add form in a dialog and posts with fetch.
test('journal month page: day dialog and add dialog, keyboard, focus, axe and the no-script fallback', async (t) => {
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
  const { open, openWrite } = fixture(t);
  const journals = createJournal({ key, port, open, openWrite });
  const { handler } = await import('../dist/app/server/entry.mjs');
  const writes = createWrites({ key, port, routes: journals.routes });
  server.on('request', createApp({ root: repo, handler,
    guard: createGuard({ port, key, instance, writable: writes.writable }), writes: writes.handle,
    api: createApi({ open, live: () => true, events: { handle(req, res) { res.writeHead(200,
      { 'Content-Type': 'text/event-stream' }); res.write('retry: 2000\n\n'); return true; } } }),
    locals: { journal: journals, cairn: createRead({ open }) } }));

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  cleanup(() => context.close());
  const page = await context.newPage(), errors = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  const axeSource = await readFile(fileURLToPath(import.meta.resolve('axe-core/axe.min.js')), 'utf8');
  const origin = `http://${siteHost(key)}:${port}`;
  await page.goto(loginUrl(port, key, instance));
  await page.waitForURL(`${origin}/`, { timeout: 10_000 });
  const axe = async () => {
    await page.evaluate(axeSource);
    const regions = [...new Set(APP_ALLOWLIST.map((item) => item.within))];
    const found = await page.evaluate(async (regions) => {
      const result = await window.axe.run(document, { resultTypes: ['violations'] });
      return result.violations.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.map((node) => {
        const element = document.querySelector(node.target[0]);
        return { within: regions.filter((region) => element?.closest(region)) };
      }) }));
    }, regions);
    return filterAllowed(found, APP_ALLOWLIST);
  };

  const response = await page.goto(`${origin}/journal?month=2026-11`);
  assert.equal(response?.status(), 200);
  assert.equal(response.headers()['referrer-policy'], 'same-origin');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  assert.deepEqual(await axe(), [], 'month page: no axe findings');
  await page.evaluate(() => window.scrollTo(0, 0));

  // A calendar day opens the dialog; the page neither navigates nor scrolls.
  const day = page.locator('button[data-journal-day="2026-11-03"]');
  await day.click();
  const dialog = page.locator('[data-journal-day-dialog]');
  await dialog.locator('article#job-1').waitFor();
  assert.equal(await dialog.evaluate((element) => element.open && element.matches(':modal')), true);
  assert.equal(await page.evaluate(() => window.scrollY), 0, 'the page did not jump');
  assert.equal(new URL(page.url()).pathname, '/journal');
  assert.equal(new URL(page.url()).searchParams.get('day'), '2026-11-03', '?day= follows the open day');
  assert.equal(await page.locator('#journal-preview').count(), 0, 'no preview was loaded');
  const title = page.locator('#journal-dialog-title');
  assert.match(await title.textContent(), /3 Kasım 2026/u);
  assert.equal(await dialog.getAttribute('aria-labelledby'), 'journal-dialog-title');
  assert.equal(await dialog.locator('[data-journal-dialog-body]').getAttribute('aria-busy'), 'false');
  assert.equal(await dialog.locator('[data-journal-dialog-full]').getAttribute('href'), '/journal/2026-11-03');
  // The dialog is about 85% of the viewport high and wider than the card dialog.
  const box = await dialog.boundingBox();
  assert.ok(box.height > 900 * 0.8 && box.height <= 900 * 0.86, `dialog height ${box.height}`);
  assert.ok(box.width > 1080 * 0.8, `dialog width ${box.width}`);

  // Contents: on the right, grouped by project in first-appearance order, the unlinked group last.
  const toc = dialog.locator('[data-doc-toc]');
  assert.equal(await toc.getAttribute('data-doc-toc-root'), '[data-journal-dialog-body]');
  const labels = await toc.locator('.doc-toc-group-label').allTextContents();
  assert.deepEqual(labels.map((text) => text.trim()), ['Alpha project', 'Projesiz']);
  assert.match(await toc.locator('.doc-toc-group-label').first().getAttribute('class'), /tone-2/u);
  const tocBox = await toc.boundingBox(), jobBox = await dialog.locator('#job-1').boundingBox();
  assert.ok(tocBox.x > jobBox.x + jobBox.width - 1, 'contents sit to the right of the jobs');
  // A contents link scrolls the dialog body only; the page keeps its hash and scroll position.
  const before = page.url();
  await toc.getByRole('link', { name: 'Loose 2026-11-03' }).click();
  await page.waitForFunction(() => document.querySelector('[data-journal-dialog-body]').scrollTop > 0);
  assert.equal(page.url(), before);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  assert.deepEqual(await axe(), [], 'open day dialog: no axe findings');

  // Previous and next days come from the day data; the page stays where it is.
  const next = dialog.locator('[data-journal-dialog-step="next"]');
  assert.match(await next.getAttribute('aria-label'), /5 Kasım 2026/u);
  await next.click();
  await page.waitForFunction(() => /5 Kasım/u.test(document.getElementById('journal-dialog-title').textContent));
  assert.equal(new URL(page.url()).searchParams.get('day'), '2026-11-05');
  assert.equal(await next.isDisabled(), true, 'the last recorded day has no next');
  assert.notEqual(await page.evaluate(() => document.activeElement?.dataset.journalDialogStep), 'next');

  // Esc closes, focus returns to the day that opened it and the URL loses ?day=.
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await day.evaluate((element) => element === document.activeElement), true);
  assert.equal(new URL(page.url()).searchParams.get('day'), null);

  // The "days with records" list opens the same dialog; a click on the backdrop closes it.
  const row = page.locator('a.journal-list-row[data-journal-day="2026-11-02"]');
  await row.click();
  await dialog.locator('article#job-1').waitFor();
  assert.match(await title.textContent(), /2 Kasım 2026/u);
  await page.mouse.click(5, 5);
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await row.evaluate((element) => element === document.activeElement), true);

  // "Add to today": a dialog with the add form; a refusal keeps the text and shows the short message.
  const add = page.locator('[data-journal-add-open]');
  assert.equal(await add.getAttribute('aria-haspopup'), 'dialog');
  await add.click();
  const addDialog = page.locator('[data-journal-add-dialog]');
  await addDialog.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'journal-title');
  assert.deepEqual(await axe(), [], 'open add dialog: no axe findings');
  await page.getByLabel('Başlık').fill('Dialog job');
  await page.getByLabel('Maddeler').fill('One\nTwo');
  await page.evaluate(() => { document.querySelector('[data-journal-add-dialog] input[name="csrf"]').value = 'x'; });
  await addDialog.getByRole('button', { name: 'İşi ekle' }).click();
  await page.waitForFunction(() => document.querySelector('[data-journal-add-status]').textContent.trim() !== '');
  assert.equal(await addDialog.evaluate((element) => element.open), true);
  assert.equal(await page.getByLabel('Başlık').inputValue(), 'Dialog job', 'the typed text survives a refusal');
  // Unsaved text asks before closing; dismissing keeps the dialog open.
  page.once('dialog', (prompt) => prompt.dismiss());
  await page.keyboard.press('Escape');
  assert.equal(await addDialog.evaluate((element) => element.open), true);

  // The refused post is the one expected console error.
  assert.ok(errors.length === 1 && /403/u.test(errors[0]), errors.join('\n'));
  errors.length = 0;

  // A real post: the dialog closes, the form is empty again and the job is in today's record.
  await page.reload();
  await add.click();
  await addDialog.waitFor();
  await page.getByLabel('Başlık').fill('Dialog job');
  await page.getByLabel('Maddeler').fill('One\nTwo');
  await addDialog.getByLabel('Proje').selectOption({ label: 'Alpha project' });
  await addDialog.getByRole('button', { name: 'İşi ekle' }).click();
  await addDialog.waitFor({ state: 'hidden' });
  assert.equal(await page.getByLabel('Başlık').inputValue(), '');
  assert.equal(await add.evaluate((element) => element === document.activeElement), true);
  const sections = journal.sections(journal.show(open(), '2026-11-08').body);
  assert.equal(sections.length, 1);
  await page.waitForFunction(() => document.querySelector('[data-journal-note]').textContent.trim() !== '');
  assert.deepEqual(errors, [], 'no CSP or other console errors');

  // Without scripts the calendar posts ?day= and shows the preview; "Add to today" goes to the day page form.
  const plain = await browser.newContext({ javaScriptEnabled: false });
  cleanup(() => plain.close());
  const bare = await plain.newPage();
  await bare.goto(loginUrl(port, key, instance));
  await bare.goto(`${origin}/journal?month=2026-11`);
  await bare.locator('button[data-journal-day="2026-11-03"]').click();
  await bare.waitForURL(/day=2026-11-03/u);
  assert.equal(await bare.locator('#journal-preview').count(), 1);
  assert.equal(await bare.locator('[data-journal-day-dialog]').evaluate((element) => element.open), false);
  await bare.locator('[data-journal-add-open]').click();
  await bare.waitForURL(`${origin}/journal/2026-11-08#journal-add`);
  assert.equal(await bare.getByRole('heading', { name: 'Dialog job' }).count(), 1);
});
