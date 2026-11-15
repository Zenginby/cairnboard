import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { resolveBrowser } from '../scripts/lib/design-check/config.mjs';

test('search dialog renders research labels, counts and destinations', async (t) => {
  let browser;
  try {
    const { executablePath } = resolveBrowser('chromium', { downloadedPath: chromium.executablePath() });
    browser = await chromium.launch({ executablePath, headless: true, timeout: 15000 });
  } catch (error) {
    return t.skip(`browser unavailable: ${error.message}`);
  }
  t.after(() => browser.close());
  const page = await browser.newPage();
  const texts = JSON.parse(readFileSync(new URL('../src/i18n/tr.json', import.meta.url), 'utf8'));
  const typingScript = readFileSync(new URL('../src/scripts/typing.js', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../src/scripts/search-dialog.js', import.meta.url), 'utf8');
  await page.route('http://localhost/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/typing.js') return route.fulfill({ contentType: 'application/javascript', body: typingScript });
    if (pathname === '/search-dialog.js') return route.fulfill({ contentType: 'application/javascript', body: script });
    if (route.request().url().includes('/api/search?')) return route.fulfill({ json: { ok: true, data: {
      results: { research: [{ type: 'research', ref: 'r-000001', title: '<b>Study</b>',
        snippetHtml: '<mark>Study</mark>', project: null, column: null, updated: null }] },
      counts: { card: 0, note: 0, research: 6 }, more: { research: true },
    } } });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>
      <a href="/search" data-search-open>Search</a>
      <dialog data-search-dialog data-lang="tr" data-research="${texts['research.title']}"
        data-kind-research="${texts['type.research']}" data-count="${texts['search.count']}"
        data-more="${texts['search.moreOfType']}">
        <input data-search-input><p data-search-status></p><button data-search-retry hidden>Retry</button>
        <div data-search-recent><ul data-search-recent-list></ul></div>
        <div data-search-results></div><a data-search-all>All</a>
      </dialog></body></html>` });
  });
  await page.goto('http://localhost/');
  await page.addScriptTag({ url: 'http://localhost/search-dialog.js', type: 'module' });
  await page.locator('[data-search-open]').click();
  await page.locator('[data-search-input]').fill('Study');
  const row = page.locator('#search-dialog-research-0');
  await row.waitFor();
  assert.equal(await page.locator('#search-dialog-group-research').textContent(), 'Araştırmalar');
  assert.equal(await row.locator('.search-row-title').textContent(), '<b>Study</b>');
  assert.equal(await row.locator('.search-row-kind').textContent(), 'Araştırma');
  assert.equal(await row.getAttribute('data-href'), '/research/r-000001');
  assert.equal(await page.locator('[data-search-status]').textContent(), '6 sonuç');
  const more = page.locator('#search-dialog-research-more');
  assert.equal(await more.textContent(), 'Tüm araştırmalar (6)');
  assert.equal(await more.getAttribute('data-href'), '/search?q=Study&type=research');
  await row.click();
  await page.waitForURL('http://localhost/research/r-000001');
});
