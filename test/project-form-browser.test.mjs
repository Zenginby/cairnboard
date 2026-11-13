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
import { createProjects } from '../server/projects.mjs';
import { createWrites } from '../server/writes.mjs';
import { loginUrl, siteHost } from '../server/session.mjs';
import { openContext } from '../core/context.mjs';
import { initDataDir } from '../core/roots.mjs';
import * as project from '../core/project.mjs';
import { APP_ALLOWLIST, filterAllowed } from '../scripts/lib/design-check/allowlist.mjs';
import { resolveBrowser } from '../scripts/lib/design-check/config.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { liveCleanup, liveUnavailable } from './support/live.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const key = Buffer.alloc(32, 10), instance = 'run-eeeeeeeeeeeeeeee';

// The add and edit pages in a real headless Chromium: 200, axe clean, console clean, and a form post through the page.
test('project add and edit pages: 200, axe clean, console clean, saving works without scripts', async (t) => {
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
  const projects = createProjects({ key, port, open, openWrite });
  const { handler } = await import('../dist/app/server/entry.mjs');
  const writes = createWrites({ key, port, routes: projects.routes });
  const app = createApp({ root: repo, handler, guard: createGuard({ port, key, instance, writable: writes.writable }),
    writes: writes.handle,
    api: createApi({ open, live: () => true, events: { handle(req, res) { res.writeHead(200,
      { 'Content-Type': 'text/event-stream' }); res.write('retry: 2000\n\n'); return true; } } }),
    locals: { projects, cairn: createRead({ open }) } });
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

  await audit('/projects/new');
  await page.getByLabel('Proje adı').fill('Garden plan');
  await page.getByLabel(/Açıklama/u).fill('About the garden.');
  await page.getByLabel('Renk 4').check({ force: true });
  await page.getByRole('button', { name: 'Projeyi ekle' }).click();
  const [item] = project.list(open());
  await page.waitForURL(`${origin}/projects/${item.id}`);
  assert.equal(item.data.tone, 4);

  await audit(`/projects/${item.id}/edit`);
  await page.getByLabel('Durum').selectOption('archived');
  await page.getByRole('button', { name: 'Projeyi kaydet' }).click();
  await page.waitForURL(`${origin}/projects/${item.id}`);
  assert.equal(project.resolve(open(), item.id).data.status, 'archived');
  assert.equal(await page.getByRole('link', { name: 'Düzenle' }).count(), 1);
  await audit('/projects');
  assert.equal(await page.getByRole('link', { name: 'Yeni proje' }).count(), 1);

  assert.deepEqual(errors, [], 'no CSP or other console errors');
});
