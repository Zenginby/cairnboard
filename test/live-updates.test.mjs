import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cpSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { openContext } from '../core/context.mjs';
import { watch } from '../core/watch.mjs';
import { createEvents } from '../server/events.mjs';
import { createApp } from '../server/app.mjs';
import { createApi } from '../server/api.mjs';
import { createRead } from '../server/read.mjs';
import { createRenderPool } from '../server/render-pool.mjs';
import { createGuard } from '../server/guard.mjs';
import { siteHost, cookieName, mintCookie } from '../server/session.mjs';
import { spawnCli } from './support/cli.mjs';
import { tempDir } from './support/env.mjs';
import { liveBudgetMs, liveCleanup, liveUnavailable } from './support/live.mjs';

function focusedFieldFixture(type = 'text') {
  const handlers = new Map();
  const status = { textContent: '', dataset: { updated: 'Updated' } };
  const field = (value) => ({ id: 'search-query', tagName: 'INPUT', value, isConnected: true,
    selectionStart: type === 'checkbox' ? null : value.length, selectionEnd: type === 'checkbox' ? null : value.length,
    getAttribute: () => null,
    focus() { document.activeElement = this; },
    setSelectionRange(start, end) {
      if (type === 'checkbox') throw new Error('Selection is not supported');
      this.selectionStart = start; this.selectionEnd = end;
    } });
  let current = field('pla'), nextHTML = '<input id="search-query" value="plan"><p>New results</p>';
  const region = { dataset: { live: 'card' }, innerHTML: '<input id="search-query" value=""><p>Old results</p>',
    contains: (element) => element === current, querySelectorAll: () => [],
    replaceChildren(...nodes) {
      current.isConnected = false; current = field('plan'); this.innerHTML = nodes.join('');
    } };
  const document = { visibilityState: 'visible', activeElement: current,
    querySelector: (selector) => selector === '[data-live]' ? region : status,
    getElementById: (id) => id === current.id ? current : null, addEventListener() {} };
  class EventSource {
    addEventListener(type, handler) { handlers.set(type, handler); }
  }
  class DOMParser {
    parseFromString(html) {
      return { title: 'Search', querySelector: () => ({ innerHTML: html, childNodes: [html] }) };
    }
  }
  runInNewContext(readFileSync(new URL('../src/scripts/live-updates.js', import.meta.url), 'utf8'), {
    document, EventSource, DOMParser, location: { href: 'http://example.test/search' },
    window: { scrollX: 0, scrollY: 0, scrollTo() {}, addEventListener() {} },
    fetch: async () => ({ ok: true, text: async () => nextHTML }), setTimeout() {}, clearTimeout() {},
  });
  return { document, region, status, current: () => current,
    async swap(html = nextHTML) {
      nextHTML = html; handlers.get('change')({ data: '{"kinds":["card"]}' }); await setImmediate();
    } };
}

test('live swap keeps the typed value and caret of a focused input with an id', async () => {
  const f = focusedFieldFixture();
  const original = f.current();
  await f.swap();
  assert.notEqual(f.current(), original);
  assert.equal(f.current().value, 'pla');
  assert.equal(f.current().selectionStart, 3);
  assert.equal(f.current().selectionEnd, 3);
  assert.equal(f.document.activeElement, f.current());
  const previous = f.current();
  await f.swap(f.region.innerHTML.replace('value="plan"', 'value="planet"'));
  assert.notEqual(f.current(), previous, 'a value attribute change still swaps the region');
  assert.equal(f.current().value, 'pla');
  assert.equal(f.current().selectionStart, 3);
});

test('live swap tolerates a focused checkbox without selection support', async () => {
  const f = focusedFieldFixture('checkbox');
  await f.swap();
  assert.equal(f.current().value, 'pla');
  assert.equal(f.document.activeElement, f.current());
  assert.equal(f.status.textContent, 'Updated', 'an unsupported selection must not abort the update');
});

test('Board moves a CLI-claimed card without navigation or CSP and console errors', async (t) => {
  const cleanup = liveCleanup(t);
  let browser;
  try {
    // Playwright's headless shell (no executablePath): never the installed Chrome, whose crashes raise a dialog.
    browser = await chromium.launch({ headless: true, timeout: 15_000,
      args: ['--no-proxy-server', '--host-resolver-rules=MAP *.cairnboard.localhost 127.0.0.1'] });
  } catch (error) {
    liveUnavailable(t, `Browser unavailable: ${error.message.split('\n')[0]}`);
    return;
  }
  cleanup(() => browser.close());
  const data = join(tempDir(t), 'data'), home = tempDir(t);
  cpSync('sample-data', data, { recursive: true });
  const open = () => openContext({ mode: 'read', dataDir: data, home, env: {} });
  const watcher = watch(open());
  cleanup(() => watcher.close());
  if (!await watcher.ready) { liveUnavailable(t, 'Native file watching unavailable'); return; }
  execFileSync(process.execPath, ['scripts/build-app.mjs'], { stdio: 'pipe', timeout: 120_000 });
  const { handler } = await import('../dist/app/server/entry.mjs');
  const pool = createRenderPool();
  cleanup(() => pool.close());
  const events = createEvents(watcher);
  cleanup(() => events.close());
  const server = createServer();
  cleanup(() => { events.close(); server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  try { await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve)); }
  catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    liveUnavailable(t, 'Loopback listen unavailable');
    return;
  }
  const port = server.address().port, key = Buffer.alloc(32, 7), hostname = siteHost(key);
  server.on('request', createApp({ root: process.cwd(), handler,
    guard: createGuard({ port, key, instance: 'run-aaaaaaaaaaaaaaaa' }),
    api: createApi({ open, render: pool.render, events }), locals: { cairn: createRead({ open, render: pool.render }) } }));
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  cleanup(() => context.close());
  await context.addCookies([{ name: cookieName(port), value: mintCookie(key, port), url: `http://${hostname}:${port}`, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage(), errors = [], failedResponses = [];
  cleanup(() => page.close());
  page.on('response', (response) => {
    if (response.status() >= 400) {
      const failure = `${response.status()} ${response.url()}`;
      failedResponses.push(failure);
      t.diagnostic(failure);
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  let navigations = 0;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations++; });
  const url = `http://${hostname}:${port}/board`;
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/api/reconcile'), { timeout: 30_000 }),
    page.goto(url),
  ]);
  const selector = 'a.board-card[href="/cards/c-fat009"]';
  await page.locator(selector).focus();
  const initialColumn = await page.locator(selector).evaluate((element) => element.closest('section').getAttribute('aria-labelledby'));
  const start = Date.now();
  const claimed = await spawnCli(['card', 'claim', 'c-fat009', '--json'], { data, home, cleanup, timeout: liveBudgetMs, env: { CAIRN_ACTOR: 'test-agent' } });
  assert.equal(claimed.code, 0, claimed.stdout + claimed.stderr);
  await page.waitForFunction(({ selector, initialColumn }) => document.querySelector(selector)?.closest('section').getAttribute('aria-labelledby') !== initialColumn,
    { selector, initialColumn }, { timeout: Math.max(1, liveBudgetMs - (Date.now() - start)) });
  if (process.env.CAIRN_LIVE_STRICT === '1') assert.ok(Date.now() - start < liveBudgetMs);
  assert.equal(await page.locator(selector).evaluate((element) => element === document.activeElement), true);
  assert.equal(navigations, 1);
  assert.equal(page.url(), url);
  assert.deepEqual(failedResponses, []);
  assert.deepEqual(errors, [], failedResponses.join('\n'));
});
