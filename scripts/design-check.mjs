import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit, firefox } from 'playwright-core';
import { createDesignServer } from './design-serve.mjs';
import { CHECKS, parseArgs, discoverPages, buildMatrix, resolveBrowser, aggregateResults, exitCode } from './lib/design-check/config.mjs';
import { initializePage, inspectLayout, rememberFocusStyles, inspectFocus } from './lib/design-check/browser.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const engines = { chromium, webkit, firefox };
const reportPath = new URL('../design/check-report.json', import.meta.url);
const usage = 'Usage: npm run design:check -- [--browser chrome|brave|chromium|webkit|firefox] [--only <screen>] [--quick] [--workers 4]';

export async function checkCase(browser, baseURL, entry, axeSource, discoverStates) {
  const context = await browser.newContext({ viewport: { width: entry.width, height: 900 }, colorScheme: entry.mode, reducedMotion: 'no-preference' });
  const checks = { console: [], csp: [] };
  let states = [];
  let timedOut = false;
  let runtimeFrozen = false;
  // evaluate() has no Playwright timeout; closing the context also interrupts a stuck axe run.
  // Pages with many prototype states (settings: 8) need more than a plain page.
  const timer = setTimeout(() => { timedOut = true; context.close().catch(() => {}); }, 60000);
  const add = (check, message) => checks[check].push({ message });
  let page;
  const drainCsp = async () => {
    if (runtimeFrozen) return;
    for (const message of await page.evaluate(() => window.__cspViolations.splice(0))) add('csp', message);
  };
  try {
    await context.addInitScript(initializePage, entry);
    page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(8000);
    page.on('console', (message) => {
      if (runtimeFrozen || message.type() !== 'error') return;
      const location = message.location().url || '';
      // Do not suppress other 404s or errors that merely mention a favicon.
      if (/^https?:\/\/[^/]+\/favicon\.ico(?:[?#]|$)/.test(location) && /\b404\b/.test(message.text())) return;
      add('console', message.text());
    });
    page.on('pageerror', (error) => { if (!runtimeFrozen) add('console', error.message); });
    const load = async () => {
      const response = await page.goto(`${baseURL}${entry.path}`, { waitUntil: 'load' });
      if (!response?.ok()) throw new Error(`Page load returned HTTP ${response?.status() ?? 'no response'}`);
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      if (entry.state !== undefined) await page.getByRole('combobox', { name: /Prototip durumu/ }).selectOption({ value: entry.state });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const run = async (name, action) => {
      checks[name] = [];
      try { await action(); } catch (error) { add(name, error.message); }
    };
    await load();
    if (discoverStates) {
      const switcher = page.getByRole('combobox', { name: /Prototip durumu/ });
      if (await switcher.count()) states = await switcher.locator('option').evaluateAll((options) => [...new Set(options.map((option) => option.value))]);
    }
    const layout = await page.evaluate(inspectLayout);
    checks.overflow = layout.overflow;
    checks.overlap = layout.overlap;
    await run('keyboard', async () => {
      await page.evaluate(rememberFocusStyles);
      for (let i = 0; i < 15; i++) {
        await page.keyboard.press('Tab');
        checks.keyboard.push(...await page.evaluate(inspectFocus));
      }
    });
    await drainCsp();
    await run('reduced-motion', async () => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await load();
      const interactive = page.locator('a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"], [role="button"]');
      const count = await interactive.count();
      let hovered = 0;
      for (let i = 0; i < count && hovered < 3; i++) {
        const element = interactive.nth(i);
        if (!await element.isVisible() || !await element.isEnabled()) continue;
        const hoverable = await element.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return !node.closest('[inert]') && getComputedStyle(node).pointerEvents !== 'none'
            && rect.right > 0 && rect.left < innerWidth && rect.bottom > 0 && rect.top < innerHeight;
        });
        if (!hoverable) continue;
        // Something else on top (a sticky bar, the quick-note button on a phone) is a layout fact, not a motion failure.
        if (!await element.hover({ timeout: 1000 }).then(() => true, () => false)) continue;
        // Observe multiple frames immediately, while even short transitions are still running.
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        hovered++;
      }
      const messages = await page.evaluate(() => {
        cancelAnimationFrame(window.__motionFrame);
        return [...window.__motionViolations];
      });
      for (const message of messages) add('reduced-motion', message);
    });
    // Axe inserts inline styles. Freeze real page findings after keyboard/hover and before any audit code runs.
    await drainCsp();
    runtimeFrozen = true;
    await run('axe', async () => {
      await page.evaluate(axeSource);
      const violations = await page.evaluate(async () => {
        const result = await window.axe.run(document, { resultTypes: ['violations'] });
        return result.violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.length }));
      });
      for (const { id, impact, targets } of violations) {
        checks.axe.push({ level: ['serious', 'critical'].includes(impact) ? 'error' : 'warning', message: `${id}: ${impact}, ${targets} target(s)` });
      }
    });
  } catch (error) {
    checks.runner = [{ message: error.message }];
  } finally {
    if (page && !page.isClosed()) {
      try { await drainCsp(); } catch (error) { add('csp', `Could not collect CSP events: ${error.message}`); }
    }
    clearTimeout(timer);
    if (timedOut) (checks.runner ||= []).push({ message: 'Case exceeded 20 seconds.' });
    await context.close();
  }
  return { result: { ...entry, checks }, states };
}

function printTable(report) {
  const names = [...CHECKS, ...(report.summary.some((page) => page.checks.runner) ? ['runner'] : [])];
  const table = report.summary.map(({ page, checks }) => Object.fromEntries([
    ['page', page], ...names.map((name) => [name, checks[name] ? `${checks[name].pass}/${checks[name].fail}${checks[name].warnings ? ` (${checks[name].warnings}w)` : ''}` : '-']),
  ]));
  console.log('Checks: pass/fail (w = warning findings)');
  console.table(table);
}

async function main() {
  let browser;
  let server;
  let deadline;
  let report = { summary: [], cases: [] };
  let code = 1;
  let help = false;
  try {
    let options;
    let pages;
    let target;
    try {
      options = parseArgs(process.argv.slice(2));
      if (options.help) { help = true; console.log(usage); return; }
      pages = discoverPages(root, options.only);
      const engine = ['chrome', 'brave'].includes(options.browser) ? 'chromium' : options.browser;
      target = resolveBrowser(options.browser, { downloadedPath: engines[engine].executablePath() });
      browser = await engines[target.engine].launch({ executablePath: target.executablePath, headless: true, timeout: 15000 });
    } catch (error) {
      code = 2;
      throw new Error(`Cannot start design check: ${error.message}\n${usage}`);
    }
    server = createDesignServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    const axeSource = await readFile(fileURLToPath(import.meta.resolve('axe-core/axe.min.js')), 'utf8');
    const queue = pages.flatMap((page) => buildMatrix(options).map((variant) => ({ page: page.name, path: page.path, ...variant })));
    const results = [];
    let expired = false;
    // Bound the entire run as well as individual cases, including on a broken page/browser.
    // About 2.5 s per case on four workers; the full matrix is ~180 cases (measured 3.5 min on Chrome).
    deadline = setTimeout(() => { expired = true; browser.close().catch(() => {}); }, Math.max(240000, queue.length * 4000));
    await Promise.all(Array.from({ length: options.workers }, async () => {
      while (queue.length && !expired) {
        const entry = queue.shift();
        const discoverStates = entry.state === undefined && entry.width === 1280 && entry.family === 'bento' && entry.mode === 'light';
        try {
          const { result, states } = await checkCase(browser, baseURL, entry, axeSource, discoverStates);
          results.push(result);
          for (const state of states) queue.push({ ...entry, state });
        } catch (error) {
          results.push({ ...entry, checks: { runner: [{ message: error.message }] } });
        }
      }
    }));
    report = aggregateResults(results);
    if (expired) throw new Error(`Design check exceeded 210 seconds; ${queue.length} case(s) not started. Narrow with --only or --quick.`);
    code = exitCode(report);
  } catch (error) {
    report.error = error.message;
    console.error(error.message);
  } finally {
    clearTimeout(deadline);
    if (browser) await browser.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (!help) {
      printTable(report);
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      console.log('Report: design/check-report.json');
      process.exitCode = code;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
