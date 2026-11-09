import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cpSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { openContext } from '../core/context.mjs';
import { selectAppPages, buildAppMatrix, MISSING_PATH } from '../scripts/lib/design-check/app-pages.mjs';
import { APP_ALLOWLIST, filterAllowed } from '../scripts/lib/design-check/allowlist.mjs';
import { checkCase } from '../scripts/lib/design-check/case.mjs';
import { resolveBrowser } from '../scripts/lib/design-check/config.mjs';
import { fixedClock, tempDir } from './support/env.mjs';

function sample(t) {
  const dataDir = join(tempDir(t), 'sample');
  cpSync('sample-data', dataDir, { recursive: true });
  return openContext({ mode: 'read', dataDir, home: tempDir(t), env: {}, platform: process.platform, clock: fixedClock('2026-11-06T12:00:00Z') });
}

test('app pages are picked from the data, in a fixed order, and --only narrows them', (t) => {
  const pages = selectAppPages(sample(t));
  assert.deepEqual(pages.map((page) => page.name),
    ['home', 'board', 'card', 'note', 'search', 'search-empty', 'search-dialog', 'not-found', 'signed-out']);
  assert.match(pages[2].path, /^\/cards\/c-[0-9a-z]+$/u);
  assert.match(pages[3].path, /^\/notes\/n-[0-9a-z]+$/u);
  assert.match(pages[4].path, /^\/search\?q=[^&\s]+$/u);
  assert.equal(pages[4].noscript, true, 'search is also checked with JavaScript off');
  assert.deepEqual(pages[5], { name: 'search-empty', path: '/search?q=zzzzqqq' });
  assert.deepEqual(pages[6], { name: 'search-dialog', path: '/', interaction: 'search-dialog' });
  assert.deepEqual(pages[7], { name: 'not-found', path: MISSING_PATH, status: 404 });
  assert.deepEqual(pages[8], { name: 'signed-out', path: '/', status: 401, auth: false });
  assert.deepEqual(selectAppPages(sample(t)), pages, 'selection is deterministic');
  assert.deepEqual(selectAppPages(sample(t), 'board'), [pages[1]]);
  assert.deepEqual(selectAppPages(sample(t), 'search-dialog'), [pages[6]], 'the dialog steps run on their own');
  assert.throws(() => selectAppPages(sample(t), 'nope'), /Unknown page: nope/);
});


test('app matrix covers 375 and 1280 in light and dark; quick is one case', () => {
  assert.deepEqual(buildAppMatrix().map(({ width, mode }) => `${width}/${mode}`), ['375/light', '375/dark', '1280/light', '1280/dark']);
  assert.equal(buildAppMatrix({ quick: true }).length, 1);
});

test('the allowlist hides heading-order only inside the body region', () => {
  assert.equal(APP_ALLOWLIST.length, 1);
  assert.equal(APP_ALLOWLIST[0].rule, 'heading-order');
  assert.match(APP_ALLOWLIST[0].reason, /B2/);
  const inside = { within: ['.document-body'] };
  const outside = { within: [] };
  const found = (id, ...nodes) => [{ id, impact: 'moderate', nodes }];
  assert.deepEqual(filterAllowed(found('heading-order', inside), APP_ALLOWLIST), []);
  assert.deepEqual(filterAllowed(found('heading-order', inside, outside), APP_ALLOWLIST), [{ id: 'heading-order', impact: 'moderate', targets: 1 }]);
  assert.equal(filterAllowed(found('heading-order', outside), APP_ALLOWLIST).length, 1);
  assert.equal(filterAllowed(found('label', inside), APP_ALLOWLIST).length, 1, 'other rules stay visible inside the body');
  assert.equal(filterAllowed(found('heading-order', inside), []).length, 1, 'no allowlist, no hiding');
});

// Real browser; skipped cleanly when none is installed (same environment as design:check).
test('the allowlist works in a real page: body heading hidden, same rule elsewhere reported', async (t) => {
  let executablePath;
  try { executablePath = resolveBrowser('chromium', { downloadedPath: chromium.executablePath() }).executablePath; } catch (error) {
    return t.skip(`no browser: ${error.message}`);
  }
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const outside = req.url === '/outside' ? '<h4>Skipped level outside</h4>' : '';
    res.end(`<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Title</h1>${outside}<div class="document-body"><h1>Body heading</h1><h4>Body skip</h4></div></main></body></html>`);
  });
  try { await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve)); } catch (error) {
    if (error.code === 'EPERM') return t.skip('loopback listen is forbidden');
    throw error;
  }
  t.after(() => { server.closeAllConnections(); server.close(); });
  let browser;
  try { browser = await chromium.launch({ executablePath, headless: true, timeout: 15000 }); } catch (error) { return t.skip(`browser did not start: ${error.message}`); }
  t.after(() => browser.close());
  const axeSource = await readFile(fileURLToPath(import.meta.resolve('axe-core/axe.min.js')), 'utf8');
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = (path) => checkCase(browser, base, { page: 'x', path, width: 1280, family: 'app', mode: 'light' }, axeSource, false, { allowlist: APP_ALLOWLIST });
  const body = (await run('/body')).result.checks;
  assert.equal(body.runner, undefined);
  assert.deepEqual(body.axe.filter((finding) => finding.message.startsWith('heading-order')), []);
  const outside = (await run('/outside')).result.checks;
  assert.ok(outside.axe.some((finding) => finding.message.startsWith('heading-order')), 'same rule outside the body still fails');
});
