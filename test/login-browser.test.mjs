import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { createGuard } from '../server/guard.mjs';
import { loginUrl, siteHost } from '../server/session.mjs';
import { openLogin } from '../server/open-browser.mjs';
import { tempDir } from './support/env.mjs';
import { liveCleanup, liveUnavailable } from './support/live.mjs';

// npm start and cairn open hand the browser a local file that redirects to /auth. Chromium does not send a
// SameSite=Strict cookie on a redirect chain that a file:// page started, so /auth must not answer with a redirect.
test('the login launcher file signs a real browser in and lands on the signed-in home page', async (t) => {
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
  const server = createServer();
  cleanup(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  try { await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve)); }
  catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    liveUnavailable(t, 'Loopback listen unavailable');
    return;
  }
  const port = server.address().port, key = Buffer.alloc(32, 7), instance = 'run-aaaaaaaaaaaaaaaa';
  const guard = createGuard({ port, key, instance });
  server.on('request', (req, res) => {
    if (!guard(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Signed in</title><p>signed in</p>');
  });
  const file = openLogin(loginUrl(port, key, instance), { dir: tempDir(t), spawn: () => ({ once() {}, unref() {} }) });
  const context = await browser.newContext();
  cleanup(() => context.close());
  const page = await context.newPage(), errors = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`file://${file}`);
  await page.waitForURL(`http://${siteHost(key)}:${port}/`, { timeout: 10_000 });
  await page.waitForLoadState('load');
  assert.equal(await page.title(), 'Signed in');
  assert.deepEqual(errors, [], 'no CSP or other console errors on the way');
});
