import { initializePage, inspectLayout, rememberFocusStyles, inspectFocus } from './browser.mjs';
import { filterAllowed } from './allowlist.mjs';

// `options.setup(context, entry)` runs before the page opens (the app check sets a session cookie there);
// `options.allowlist` lists axe findings that are known and accepted (see allowlist.mjs); `entry.status` is the
// HTTP status the page is expected to answer with (default: any 2xx).
export async function checkCase(browser, baseURL, entry, axeSource, discoverStates, options = {}) {
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
    await options.setup?.(context, entry);
    page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(8000);
    page.on('console', (message) => {
      if (runtimeFrozen || message.type() !== 'error') return;
      const location = message.location().url || '';
      // Do not suppress other 404s or errors that merely mention a favicon.
      if (/^https?:\/\/[^/]+\/favicon\.ico(?:[?#]|$)/.test(location) && /\b404\b/.test(message.text())) return;
      // The browser logs every non-2xx document as an error; when that status is the expected one it is not a finding.
      if (entry.status !== undefined && location === `${baseURL}${entry.path}` && message.text().includes(`status of ${entry.status}`)) return;
      add('console', message.text());
    });
    page.on('pageerror', (error) => { if (!runtimeFrozen) add('console', error.message); });
    const load = async () => {
      const response = await page.goto(`${baseURL}${entry.path}`, { waitUntil: 'load' });
      if (entry.status === undefined ? !response?.ok() : response?.status() !== entry.status) throw new Error(`Page load returned HTTP ${response?.status() ?? 'no response'}`);
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
      const regions = [...new Set((options.allowlist ?? []).map((item) => item.within))];
      const found = await page.evaluate(async (regions) => {
        const result = await window.axe.run(document, { resultTypes: ['violations'] });
        return result.violations.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.map((node) => {
          const element = document.querySelector(node.target[0]);
          return { within: regions.filter((region) => element?.closest(region)) };
        }) }));
      }, regions);
      for (const { id, impact, targets } of filterAllowed(found, options.allowlist)) {
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
