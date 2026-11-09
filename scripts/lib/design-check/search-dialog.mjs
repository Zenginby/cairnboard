// Interaction steps for the ⌘K search dialog (src/scripts/search-dialog.js). Each step is its own check, so a
// failure names the behaviour that broke. The sample data has a card and two notes for QUERY, one card and one
// note for SECOND ("plan", the plan's example word, matches no card there).
const QUERY = 'kaynak';
const SECOND = 'saklama';
const OPTION = '.search-dialog [role="option"]';

export const SEARCH_DIALOG_STEPS = ['open', 'results', 'slow-answer', 'stale-enter', 'recent', 'star-limit',
  'no-storage', 'search-page', 'search-page-live', 'escape', 'network-error', 'axe'];
const RECENT_KEY = 'cairn.recent-searches.v1';

const shortcut = (platform) => (platform === 'darwin' ? 'Meta+K' : 'Control+K');
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const isOpen = (tab) => tab.evaluate(() => document.querySelector('.search-dialog')?.open === true);

// One fresh context per step: routes and init scripts never leak from one step into the next.
async function withTab(browser, baseURL, setup, run, { init, path = '/' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  try {
    await setup(context, { path });
    if (init) await context.addInitScript(init);
    await context.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        window.__cspViolations.push(`${event.violatedDirective}: ${event.blockedURI}`);
      });
    });
    const tab = await context.newPage();
    tab.setDefaultTimeout(5000);
    tab.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    tab.on('pageerror', (error) => errors.push(error.message));
    await tab.goto(`${baseURL}${path}`, { waitUntil: 'load' });
    await run(tab, errors, context);
    const csp = await tab.evaluate(() => window.__cspViolations ?? []).catch(() => []);
    assert(!csp.length, `CSP violation: ${csp.join(', ')}`);
  } finally {
    await context.close();
  }
}

async function typeQuery(tab, text) {
  await tab.locator('.search-dialog-input').fill(text);
}

async function groupTitles(tab) {
  return tab.locator('.search-dialog .search-group:visible').allTextContents();
}

// `addNote(name, title)` writes a note into the checked data folder (the live-update step needs a file change).
export async function checkSearchDialog(browser, baseURL, page, setup, axeSource,
  { platform = process.platform, addNote } = {}) {
  const key = shortcut(platform);
  const command = platform === 'darwin' ? 'Meta' : 'Control';
  const checks = Object.fromEntries(SEARCH_DIALOG_STEPS.map((name) => [name, []]));
  const step = async (name, action, options) => {
    try { await withTab(browser, baseURL, setup, action, options); } catch (error) {
      checks[name].push({ message: error.message });
    }
  };

  // 1. The shortcut opens the dialog; `/` does nothing while a text field has focus.
  await step('open', async (tab) => {
    await tab.keyboard.press(key);
    await tab.waitForSelector('dialog.search-dialog[open]');
    assert(await tab.evaluate(() => document.activeElement?.classList.contains('search-dialog-input')),
      'the field is not focused after opening');
    const label = await tab.locator('.shell-search [data-shortcut]').textContent();
    assert(label === (platform === 'darwin' ? '⌘K' : 'Ctrl K'), `shortcut hint reads "${label}"`);
    await tab.keyboard.press('Escape');
    assert(!await isOpen(tab), 'Escape on an empty field did not close');
    await tab.evaluate(() => {
      const field = document.createElement('input');
      field.id = 'probe-field';
      field.setAttribute('aria-label', 'probe');
      document.querySelector('main').append(field);
      field.focus();
    });
    await tab.keyboard.press('/');
    assert(!await isOpen(tab), '`/` opened the dialog while a text field had focus');
    await tab.locator('#probe-field').evaluate((field) => field.remove());
    await tab.keyboard.press('/');
    await tab.waitForSelector('dialog.search-dialog[open]');
  });

  // 2. Grouped results, arrow keys move the active row (which shows ↵), Enter opens it.
  await step('results', async (tab) => {
    await tab.keyboard.press(key);
    // The first search of a fresh server opens its index; time the second one. The 120 ms typing delay plus a
    // local answer takes about 200 ms; the bound leaves room for a loaded machine.
    await typeQuery(tab, SECOND);
    await tab.waitForSelector(OPTION);
    const started = Date.now();
    await typeQuery(tab, QUERY);
    await tab.waitForFunction((query) => document.querySelector('.search-dialog mark')?.textContent
      .toLocaleLowerCase('tr').startsWith(query), QUERY, { timeout: 2000 });
    const elapsed = Date.now() - started;
    const timing = await tab.evaluate(() => performance.getEntriesByType('resource')
      .filter((entry) => entry.name.includes('/api/search')).map((entry) => Math.round(entry.duration)));
    console.log(`search-dialog: results in ${elapsed} ms; api ${timing.join(', ')}`);
    assert(elapsed < 1000, `results took ${elapsed} ms`);
    const titles = await groupTitles(tab);
    assert(titles.length === 2, `expected two groups, got: ${titles.join(', ')}`);
    await tab.keyboard.press('ArrowDown');
    await tab.keyboard.press('ArrowDown');
    const second = await tab.locator(OPTION).nth(1).getAttribute('id');
    const active = await tab.locator('.search-dialog-input').getAttribute('aria-activedescendant');
    assert(active === second, `aria-activedescendant is ${active}, expected ${second}`);
    assert(await tab.locator(`#${second} .search-row-enter`).isVisible(), 'the active row shows no ↵');
    assert(!await tab.locator(OPTION).first().locator('.search-row-enter').isVisible(), 'an inactive row shows ↵');
    const snippetTags = await tab.evaluate(() => [...document.querySelectorAll('.search-dialog .search-row-snippet *')]
      .map((node) => node.tagName).filter((tag) => tag !== 'MARK'));
    assert(!snippetTags.length, `snippet holds non-<mark> elements: ${snippetTags.join(', ')}`);
    const activeId = () => tab.locator('.search-dialog-input').getAttribute('aria-activedescendant');
    await tab.keyboard.press('ArrowUp');
    await tab.keyboard.press('ArrowUp');
    assert(await activeId() === null, 'ArrowUp on the first row did not clear the active row');
    assert(!await tab.locator('.search-dialog [aria-selected="true"]').count(), 'a row stays selected');
    await tab.keyboard.press(`${command}+End`);
    const last = await tab.locator(OPTION).last().getAttribute('id');
    assert(await activeId() === last, `${command}+End did not go to the last row`);
    await tab.keyboard.press(`${command}+Home`);
    const firstId = await tab.locator(OPTION).first().getAttribute('id');
    assert(await activeId() === firstId, `${command}+Home did not go to the first row`);
    // Enter while an input method is composing belongs to the composition, not to the dialog.
    const url = tab.url();
    await tab.locator('.search-dialog-input').dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    await tab.waitForTimeout(300);
    assert(tab.url() === url, 'Enter during composition opened a result');
    await Promise.all([tab.waitForURL(/\/(cards|notes)\//u), tab.keyboard.press('Enter')]);
  });

  // 3b. The old query's answer lands while the new query still waits for its typing delay: Enter must open a
  // result of the new query, never one of the old list. The page's first search request is held until released.
  await step('stale-enter', async (tab) => {
    await tab.keyboard.press(key);
    const expected = await tab.evaluate(async (q) => {
      const body = await (await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=5`)).json();
      return ['card', 'note'].flatMap((type) => body.data.results[type]
        .map((row) => `/${type}s/${encodeURIComponent(row.ref)}`));
    }, QUERY);
    await typeQuery(tab, SECOND);
    await tab.waitForFunction(() => typeof window.__release === 'function');
    // Type, release the old answer and press Enter well inside the 120 ms delay, all in one go.
    await tab.evaluate(async (q) => {
      const input = document.querySelector('.search-dialog-input');
      input.value = q;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await window.__release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    }, QUERY);
    await tab.waitForURL(/\/(cards|notes)\//u);
    const path = new URL(tab.url()).pathname;
    assert(expected.includes(path), `Enter opened ${path}, not a result for "${QUERY}"`);
  }, { init: () => {
    const real = window.fetch.bind(window);
    let held = false;
    window.fetch = (url, options) => {
      // Only the dialog's requests carry a signal; the step's own lookup goes straight through.
      if (held || !options?.signal || !String(url).includes('/api/search')) return real(url, options);
      held = true;
      return new Promise((resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        window.__release = () => real(url, { ...options, signal: undefined }).then(resolve, reject).catch(() => {});
      });
    };
  } });

  // 3. A slow first answer arriving after a newer one never replaces the newer list.
  await step('slow-answer', async (tab) => {
    let first = true;
    await tab.route('**/api/search*', async (route) => {
      if (first) {
        first = false;
        await new Promise((resolve) => setTimeout(resolve, 800));
        // The page aborts this request when the next query starts; then there is nothing to continue.
        await route.continue().catch(() => {});
      } else await route.continue();
    });
    await tab.keyboard.press(key);
    await typeQuery(tab, 'ka');
    await tab.waitForRequest((request) => request.url().includes('/api/search?q=ka&'));
    await typeQuery(tab, QUERY);
    await tab.waitForSelector(OPTION);
    const before = await tab.locator('.search-dialog-results').innerHTML();
    await tab.waitForTimeout(1000);
    const after = await tab.locator('.search-dialog-results').innerHTML();
    assert(before === after, 'the list changed after the slow answer arrived');
    const marks = await tab.locator('.search-dialog .search-row mark').allTextContents();
    assert(marks.length > 0 && marks.every((mark) => mark.toLocaleLowerCase('tr').startsWith(QUERY)),
      `highlights are not for "${QUERY}": ${marks.join(', ')}`);
  });

  // 4. An opened result saves the query; star moves it to the top; × removes it.
  await step('recent', async (tab) => {
    await tab.keyboard.press(key);
    await typeQuery(tab, SECOND);
    await tab.waitForSelector(OPTION);
    await tab.locator('.search-dialog-all').click();
    await tab.waitForURL(new RegExp(`/search\\?q=${SECOND}`, 'u'));
    await tab.goto(`${baseURL}/`, { waitUntil: 'load' });
    await tab.keyboard.press(key);
    await typeQuery(tab, QUERY);
    await tab.waitForSelector(OPTION);
    await Promise.all([tab.waitForURL(/\/(cards|notes)\//u), tab.keyboard.press('Enter')]);
    await tab.goBack({ waitUntil: 'load' });
    await tab.keyboard.press(key);
    const queries = () => tab.locator('.search-dialog .search-recent-query').allTextContents();
    await tab.waitForSelector('.search-dialog .search-recent-query');
    let list = await queries();
    assert(list[0] === QUERY && list.includes(SECOND), `recent searches are ${list.join(', ')}`);
    await tab.locator('.search-dialog .search-recent-item', { hasText: SECOND }).locator('.search-recent-star').click();
    list = await queries();
    assert(list[0] === SECOND, `starring did not move it to the top: ${list.join(', ')}`);
    await tab.locator('.search-dialog .search-recent-item', { hasText: QUERY }).locator('.search-recent-remove')
      .click();
    list = await queries();
    assert(!list.includes(QUERY), `× did not remove "${QUERY}": ${list.join(', ')}`);
    await tab.keyboard.press('Escape');
    await tab.goto(`${baseURL}/search`, { waitUntil: 'load' });
    const page = await tab.locator('[data-recent-searches] .search-recent-query').allTextContents();
    assert(page.join() === SECOND, `the /search page lists ${page.join(', ')}`);
    // Removing the last entry leaves focus in the search field, not on the page body.
    await tab.locator('[data-recent-searches] .search-recent-remove').click();
    assert(await tab.evaluate(() => document.activeElement?.id === 'search-query'),
      'removing the last recent search on /search lost focus');
    await tab.evaluate(([name]) => localStorage.setItem(name, JSON.stringify([{ q: 'x', starred: false }])),
      [RECENT_KEY]);
    await tab.goto(`${baseURL}/`, { waitUntil: 'load' });
    await tab.keyboard.press(key);
    await tab.locator('.search-dialog .search-recent-remove').click();
    assert(await tab.evaluate(() => document.activeElement?.classList.contains('search-dialog-input')),
      'removing the last recent search in the dialog lost focus');
    assert(await tab.locator('.search-dialog-recent').isHidden(), 'the empty recent list is still shown');
  });

  // 4b. Eight starred searches is the limit: a ninth cannot be starred, and the button says why.
  await step('star-limit', async (tab) => {
    const list = [...Array.from({ length: 8 }, (_, i) => ({ q: `s${i}`, starred: true })),
      { q: 'plain', starred: false }];
    await tab.evaluate(([name, value]) => localStorage.setItem(name, value), [RECENT_KEY, JSON.stringify(list)]);
    await tab.reload({ waitUntil: 'load' });
    await tab.keyboard.press(key);
    const star = tab.locator('.search-dialog .search-recent-item', { hasText: 'plain' }).locator('.search-recent-star');
    assert(await star.getAttribute('aria-disabled') === 'true', 'the ninth star is not disabled');
    assert(Boolean(await star.getAttribute('title')), 'the disabled star does not say why');
    // Playwright refuses to click an aria-disabled button; a real click still reaches it.
    await star.dispatchEvent('click');
    const stored = await tab.evaluate((name) => JSON.parse(localStorage.getItem(name)), RECENT_KEY);
    assert(stored.filter((item) => item.starred).length === 8 && stored.some((item) => item.q === 's0'),
      'starring a ninth search changed the starred ones');
    const unstar = tab.locator('.search-dialog .search-recent-item', { hasText: 's0' }).locator('.search-recent-star');
    assert(await unstar.getAttribute('aria-disabled') !== 'true', 'a starred search cannot be unstarred');
  });

  // 5. Storage that throws: the dialog still searches, recent searches stay hidden, nothing in the console.
  await step('no-storage', async (tab, errors) => {
    await tab.keyboard.press(key);
    await tab.waitForSelector('dialog.search-dialog[open]');
    assert(await tab.locator('.search-dialog-recent').isHidden(), 'recent searches are shown without storage');
    await typeQuery(tab, QUERY);
    await tab.waitForSelector(OPTION);
    await tab.locator('.search-dialog-all').click();
    await tab.waitForURL(/\/search\?q=/u);
    assert(!errors.length, `console errors: ${errors.join(' | ')}`);
  }, { init: () => {
    const fail = () => { throw new DOMException('blocked', 'SecurityError'); };
    for (const name of ['getItem', 'setItem', 'removeItem']) Storage.prototype[name] = fail;
  } });

  // 6. On /search the shortcut focuses the page's field and selects its text; the dialog stays closed.
  await step('search-page', async (tab) => {
    await tab.locator('main h1').click();
    await tab.keyboard.press(key);
    assert(!await isOpen(tab), 'the dialog opened on /search');
    const state = await tab.evaluate(() => {
      const field = document.querySelector('#search-query');
      return { focused: document.activeElement === field, selected: field.selectionEnd - field.selectionStart,
        length: field.value.length };
    });
    assert(state.focused, '#search-query is not focused');
    assert(state.selected === state.length, 'the field text is not selected');
    await tab.locator('main h1').click();
    await tab.locator('.shell-search').click();
    assert(!await isOpen(tab), 'the top bar link opened the dialog on /search');
    assert(await tab.evaluate(() => document.activeElement?.id === 'search-query'), 'the link did not focus the field');
  }, { path: `/search?q=${QUERY}` });

  // 6b. A live update replaces /search's main region: shortcuts and the form still work with the new nodes, and
  // the recent searches on the empty page are drawn again.
  await step('search-page-live', async (tab) => {
    assert(addNote, 'no addNote helper');
    const swapped = (selector) => tab.waitForFunction((css) => {
      const node = document.querySelector(css);
      return node && !node.__beforeSwap;
    }, selector, { timeout: 20000 });
    await tab.evaluate(() => { document.querySelector('#search-query').__beforeSwap = true; });
    addNote('live-check-1', `${QUERY} canlı bir`);
    await swapped('#search-query');
    await tab.locator('main h1').click();
    await tab.keyboard.press(key);
    assert(await tab.evaluate(() => document.activeElement?.id === 'search-query'),
      'after a live update the shortcut no longer focuses #search-query');
    await tab.locator('#search-query').fill(SECOND);
    await Promise.all([tab.waitForURL(new RegExp(`q=${SECOND}`, 'u')), tab.keyboard.press('Enter')]);
    const stored = await tab.evaluate((name) => localStorage.getItem(name) ?? '', RECENT_KEY);
    assert(stored.includes(SECOND), 'a search sent from the swapped form was not remembered');
    await tab.goto(`${baseURL}/search`, { waitUntil: 'load' });
    await tab.waitForSelector('[data-recent-searches] .search-recent-query');
    await tab.evaluate(() => { document.querySelector('[data-recent-searches]').__beforeSwap = true; });
    addNote('live-check-2', `${QUERY} canlı iki`);
    await swapped('[data-recent-searches]');
    await tab.waitForSelector('[data-recent-searches] .search-recent-query', { timeout: 2000 })
      .catch(() => { throw new Error('the recent searches disappeared after a live update'); });
  }, { path: `/search?q=${QUERY}` });

  // 7. Escape clears a filled field, closes an empty one, and focus goes back to the opener.
  await step('escape', async (tab) => {
    await tab.locator('.shell-search').focus();
    await tab.keyboard.press('Enter');
    await tab.waitForSelector('dialog.search-dialog[open]');
    await typeQuery(tab, QUERY);
    await tab.keyboard.press('Escape');
    assert(await isOpen(tab), 'Escape closed the dialog with text in the field');
    assert(await tab.locator('.search-dialog-input').inputValue() === '', 'Escape did not clear the field');
    await tab.keyboard.press('Escape');
    assert(!await isOpen(tab), 'Escape on an empty field did not close');
    assert(await tab.evaluate(() => document.activeElement?.classList.contains('shell-search')),
      'focus did not return to the search link');
    // Opened by a mouse click (Safari does not focus links on click) and the opener is gone: focus goes to #main.
    await tab.locator('.shell-search').click();
    await tab.waitForSelector('dialog.search-dialog[open]');
    await tab.evaluate(() => document.querySelector('.shell-search').remove());
    await tab.keyboard.press('Escape');
    // The dialog's close event is queued, so give it a moment.
    await tab.waitForFunction(() => document.activeElement?.id === 'main', null, { timeout: 2000 })
      .catch(() => { throw new Error('focus did not go to #main'); });
  });

  // 8. A network failure shows the error and a retry button that asks again.
  await step('network-error', async (tab) => {
    let calls = 0;
    await tab.route('**/api/search*', (route) => { calls++; return calls === 1 ? route.abort() : route.continue(); });
    await tab.keyboard.press(key);
    await typeQuery(tab, QUERY);
    const retry = tab.locator('.search-dialog [data-search-retry]');
    await retry.waitFor({ state: 'visible' });
    const failed = await tab.locator('.search-dialog').getAttribute('data-failed');
    assert(await tab.locator('.search-dialog-status').textContent() === failed, 'the failure text is missing');
    await retry.click();
    await tab.waitForSelector(OPTION);
    assert(calls === 2, `retry made ${calls - 1} more request(s)`);
    assert(await retry.isHidden(), 'the retry button stays after a good answer');
  });

  // The open dialog with results passes axe too (the page matrix only sees it closed). Axe inserts inline
  // styles, so CSP is read before it runs.
  await step('axe', async (tab) => {
    await tab.keyboard.press(key);
    await typeQuery(tab, QUERY);
    await tab.waitForSelector(OPTION);
    await tab.keyboard.press('ArrowDown');
    // Let the fade-in finish: axe reads a half-transparent row as low contrast.
    await tab.waitForTimeout(500);
    const csp = await tab.evaluate(() => window.__cspViolations.splice(0));
    assert(!csp.length, `CSP violation: ${csp.join(', ')}`);
    await tab.evaluate(axeSource);
    const found = await tab.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] }))
      .violations.map(({ id, impact, nodes }) => ({ id, impact,
        targets: nodes.map((node) => node.target.join(' ')) })));
    for (const { id, impact, targets } of found) {
      checks.axe.push({ level: ['serious', 'critical'].includes(impact) ? 'error' : 'warning',
        message: `${id}: ${impact}, ${targets.length} target(s): ${targets.slice(0, 3).join(', ')}` });
    }
  });

  for (const [name, findings] of Object.entries(checks)) {
    for (const finding of findings) console.error(`${page.name} ${name}: ${finding.message}`);
  }
  return { page: page.name, path: page.path, width: 1280, family: 'app', mode: 'interaction', checks };
}
