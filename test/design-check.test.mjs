import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { CHECKS, parseArgs, discoverPages, buildMatrix, resolveBrowser, aggregateResults, exitCode } from '../scripts/lib/design-check/config.mjs';
import { checkCase } from '../scripts/design-check.mjs';
import { rememberFocusStyles, inspectFocus } from '../scripts/lib/design-check/browser.mjs';

test('design check arguments have conservative defaults and accept documented options', () => {
  assert.deepEqual(parseArgs([]), { browser: 'chromium', quick: false, only: null, workers: 4, help: false });
  assert.deepEqual(parseArgs(['--browser', 'brave', '--only', 'board', '--quick', '--workers', '2']), {
    browser: 'brave', quick: true, only: 'board', workers: 2, help: false,
  });
  for (const browser of ['chrome', 'brave', 'chromium', 'webkit', 'firefox']) {
    assert.equal(parseArgs(['--browser', browser]).browser, browser);
  }
  assert.equal(parseArgs(['--help']).help, true);
  for (const args of [['--unknown'], ['--browser'], ['--only', '--quick'], ['--workers'], ['--browser', 'safari'], ['--workers', '0'], ['--workers', '17'], ['--workers', '1.5'], ['--workers', 'NaN']]) {
    assert.throws(() => parseArgs(args), Error, args.join(' '));
  }
});

test('design check discovers only immediate screen indexes, plus the directory and style guide', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'design-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const screen of ['zeta', 'alpha', '_shared', '_styleguide', 'missing', 'nested/child']) {
    await mkdir(join(root, 'design/prototypes', screen), { recursive: true });
    if (screen !== 'missing') await writeFile(join(root, 'design/prototypes', screen, 'index.html'), '<main></main>');
  }
  await writeFile(join(root, 'design/prototypes/index.html'), '<main></main>');
  await writeFile(join(root, 'design/prototypes/other.html'), '<main></main>');
  await symlink(join(root, 'design/prototypes/alpha'), join(root, 'design/prototypes/linked'));
  const pages = discoverPages(root);
  assert.deepEqual(pages, [
    { name: 'index', path: '/prototypes/index.html' },
    { name: '_styleguide', path: '/prototypes/_styleguide/' },
    { name: 'alpha', path: '/prototypes/alpha/' },
    { name: 'zeta', path: '/prototypes/zeta/' },
  ]);
  for (const page of pages) assert.deepEqual(discoverPages(root, page.name), [page]);
  assert.throws(() => discoverPages(root, 'absent'), /Unknown screen: absent/);
  assert.throws(() => discoverPages(root, '../alpha'), /Unknown screen/);
});

test('design check matrix covers all default widths/modes and the other families at 1280 only', () => {
  const matrix = buildMatrix();
  assert.equal(matrix.length, 10);
  assert.equal(new Set(matrix.map((entry) => JSON.stringify(entry))).size, 10);
  for (const family of ['bento', 'paper', 'graphite']) {
    for (const width of family === 'bento' ? [375, 1280, 2000] : [1280]) {
      for (const mode of ['light', 'dark']) assert.ok(matrix.some((entry) => entry.family === family && entry.width === width && entry.mode === mode));
    }
  }
  assert.deepEqual(buildMatrix({ quick: true }), [{ width: 1280, family: 'bento', mode: 'light' }]);
});

test('design check aggregates all cases and warnings while bounding messages per page/check', () => {
  const entry = { page: 'board', path: '/prototypes/board/', width: 1280, family: 'bento', mode: 'light' };
  const checks = Object.fromEntries(CHECKS.map((name) => [name, []]));
  const results = [{ ...entry, checks }, ...Array.from({ length: 9 }, (_, i) => ({
    ...entry, width: 375, state: i === 0 ? '' : `state-${i}`,
    checks: {
      console: [{ message: `console ${i}` }],
      axe: [{ level: 'warning', message: `moderate ${i}` }],
    },
  })), {
    ...entry, mode: 'dark', checks: { axe: [{ level: 'error', message: 'critical: 3 targets' }] },
  }, { ...entry, page: 'index', checks: { console: [] } }];
  const original = structuredClone(results);
  const report = aggregateResults(results);
  assert.deepEqual(results, original, 'aggregation does not mutate input');
  assert.equal(report.cases.length, 12);
  assert.deepEqual(report.summary.map((page) => page.page), ['board', 'index']);
  const summary = report.summary[0].checks;
  assert.equal(summary.console.pass, 1);
  assert.equal(summary.console.fail, 9);
  assert.equal(summary.console.messages.length, 5);
  assert.deepEqual(summary.console.messages[0], { ...entry, width: 375, state: '', check: 'console', level: 'error', message: 'console 0' });
  assert.equal(summary.axe.pass, 10);
  assert.equal(summary.axe.fail, 1);
  assert.equal(summary.axe.warnings, 9);
  assert.equal(summary.axe.messages.length, 5);
  assert.equal(summary.axe.messages[0].message, 'critical: 3 targets');
  assert.deepEqual(report.cases[1].checks.axe, { status: 'pass', failures: 0, warnings: 1 });
  assert.equal(exitCode(report), 1);
  const long = aggregateResults([{ ...entry, checks: { console: [{ message: `first\n${'x'.repeat(300)}` }] } }]);
  assert.equal(long.summary[0].checks.console.messages[0].message.length, 240);
  assert.ok(!long.summary[0].checks.console.messages[0].message.includes('\n'));
});

test('design check exits successfully for passes/warnings and fails for acceptance or runner errors', () => {
  assert.equal(exitCode(aggregateResults([])), 0);
  const entry = { page: 'index', width: 1280, family: 'bento', mode: 'light' };
  assert.equal(exitCode(aggregateResults([{ ...entry, checks: { console: [], axe: [{ level: 'warning', message: 'minor' }] } }])), 0);
  for (const check of [...CHECKS, 'runner']) {
    assert.equal(exitCode(aggregateResults([{ ...entry, checks: { [check]: [{ message: 'failed' }] } }])), 1, check);
  }
  assert.equal(exitCode({ summary: [], cases: [], error: 'runtime failed' }), 1);
});

test('design check resolves system browser paths per OS using fake environment and filesystem', () => {
  const cases = [
    ['chrome', 'darwin', {}, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['brave', 'darwin', {}, '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    ['chrome', 'linux', { PATH: '/missing:/opt/bin:/usr/bin' }, '/opt/bin/google-chrome'],
    ['brave', 'linux', { PATH: '/missing:/opt/bin' }, '/opt/bin/brave-browser'],
    ['chrome', 'win32', { ProgramFiles: 'C:\\Program Files' }, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
    ['brave', 'win32', { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }, 'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
    ['chrome', 'win32', { LOCALAPPDATA: 'C:\\Local' }, 'C:\\Local\\Google\\Chrome\\Application\\chrome.exe'],
  ];
  for (const [name, platform, env, executablePath] of cases) {
    assert.deepEqual(resolveBrowser(name, { platform, env, isExecutable: (file) => file === executablePath }), { engine: 'chromium', executablePath });
  }
  assert.throws(() => resolveBrowser('chrome', { platform: 'linux', env: {}, isExecutable: () => false }), /Cannot find chrome.*CAIRN_BROWSER_PATH/);
  assert.throws(() => resolveBrowser('brave', { platform: 'darwin', env: {}, isExecutable: () => false }), /Cannot find brave/);
});

test('design check browser override takes precedence; downloaded browsers give exact install hints', () => {
  for (const name of ['chrome', 'brave', 'chromium', 'webkit', 'firefox']) {
    assert.deepEqual(resolveBrowser(name, { env: { CAIRN_BROWSER_PATH: '/override/browser' }, isExecutable: (file) => file === '/override/browser' }), {
      engine: ['chrome', 'brave'].includes(name) ? 'chromium' : name, executablePath: '/override/browser',
    });
    assert.throws(() => resolveBrowser(name, { env: { CAIRN_BROWSER_PATH: '/missing' }, isExecutable: () => false }), /CAIRN_BROWSER_PATH is not an executable/);
  }
  for (const name of ['chromium', 'webkit', 'firefox']) {
    assert.deepEqual(resolveBrowser(name, { env: {}, downloadedPath: `/cache/${name}`, isExecutable: (file) => file === `/cache/${name}` }), {
      engine: name, executablePath: name === 'chromium' ? undefined : `/cache/${name}`,
    });
    for (const downloadedPath of [undefined, '/missing']) {
      assert.throws(() => resolveBrowser(name, { env: {}, downloadedPath, isExecutable: () => false }), { message: `Missing ${name} browser. Run: npx playwright-core install ${name}` });
    }
  }
});

test('design check freezes real console/CSP findings after keyboard and hover, before injecting axe', async () => {
  const listeners = new Map();
  let csp = [];
  let tabs = 0;
  let hovers = 0;
  let loads = 0;
  let auditing = false;
  const emit = (message) => {
    listeners.get('console')({ type: () => 'error', location: () => ({ url: 'http://example.com/prototypes/board/' }), text: () => message });
    listeners.get('pageerror')(new Error(message));
    csp.push(message);
  };
  const page = {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
    on(event, callback) { listeners.set(event, callback); },
    async goto() { assert.equal(auditing, false); emit(`load ${++loads}`); return { ok: () => true }; },
    async waitForLoadState() {}, async emulateMedia() {}, isClosed: () => false,
    keyboard: { async press(key) { assert.equal(key, 'Tab'); assert.equal(auditing, false); tabs++; emit('keyboard'); } },
    locator: () => ({
      count: async () => 3,
      nth: () => ({
        isVisible: async () => true, isEnabled: async () => true, evaluate: async () => true,
        async hover() { assert.equal(auditing, false); hovers++; emit('hover'); },
      }),
    }),
    async evaluate(action) {
      if (typeof action === 'string') {
        assert.equal(tabs, 15);
        assert.equal(hovers, 3);
        assert.deepEqual(csp, [], 'CSP events must be drained before injection');
        auditing = true;
        emit('axe injection');
      } else if (action === inspectFocus) return [];
      else if (action.toString().includes('window.__cspViolations.splice')) {
        assert.equal(auditing, false, 'CSP collection must remain frozen during audit and cleanup');
        const findings = csp; csp = []; return findings;
      } else if (action.toString().includes('window.axe.run')) {
        emit('axe run');
        return [{ id: 'example-rule', impact: 'serious', nodes: [{ within: [] }] }];
      } else if (action.toString().includes('return { overflow, overlap }')) return { overflow: [], overlap: [] };
      else if (action.toString().includes('window.__motionViolations')) return [];
    },
  };
  const context = { async addInitScript() {}, newPage: async () => page, async close() { emit('cleanup after axe'); } };
  const { result } = await checkCase({ newContext: async () => context }, 'http://example.com', {
    page: 'board', path: '/prototypes/board/', width: 1280, family: 'bento', mode: 'light',
  }, 'axe source', false);
  assert.equal(result.checks.runner, undefined);
  assert.equal(result.checks.console.length, (loads + tabs + hovers) * 2);
  assert.equal(result.checks.csp.length, loads + tabs + hovers);
  assert.ok(result.checks.console.every(({ message }) => !message.includes('axe')));
  assert.ok(result.checks.csp.every(({ message }) => !message.includes('axe')));
  assert.match(result.checks.axe[0].message, /example-rule: serious/);
});

// Geometry, animation completion and computed styles are supplied explicitly; no DOM/browser is launched.
function focusFixture(type = 'button') {
  let elapsed = 0;
  const node = (tagName, parentElement = null) => ({
    tagName, parentElement, classList: [], type: '',
    style: { opacity: '1', visibility: 'visible', outlineStyle: 'none', outlineWidth: '0px', outlineColor: 'transparent', boxShadow: 'none' },
    rect: { x: 10, y: 10, width: 100, height: 30 },
    getBoundingClientRect() { const { x, y, width, height } = this.rect; return { x, y, width, height, left: x, right: x + width, top: y, bottom: y + height }; },
    getAnimations: () => [], blur() {},
    matches() { return this.tagName === 'INPUT' && ['radio', 'checkbox'].includes(this.type); },
  });
  const body = node('BODY');
  const card = node('LABEL', body);
  const input = node(type === 'button' ? 'BUTTON' : 'INPUT', card);
  input.type = type;
  const document = { body, activeElement: body, querySelectorAll: () => [input] };
  const context = createContext({
    window: {}, document, innerWidth: 1280, innerHeight: 900,
    getComputedStyle: (item) => item.style, performance: { now: () => elapsed },
    requestAnimationFrame(callback) { elapsed += 100; queueMicrotask(() => callback(elapsed)); },
    setTimeout, clearTimeout,
  });
  const remember = () => runInContext(`(${rememberFocusStyles.toString()})()`, context);
  const inspect = () => runInContext(`(${inspectFocus.toString()})()`, context);
  remember();
  document.activeElement = input;
  return { input, card, body, node, context, document, remember, inspect, elapsed: () => elapsed };
}

test('keyboard waits for focus transitions, including delayed skip-link entry and cancellation', async () => {
  const fixture = focusFixture();
  fixture.input.rect.y = -100;
  fixture.input.style.outlineStyle = 'solid'; fixture.input.style.outlineWidth = '2px'; fixture.input.style.outlineColor = 'rgb(0, 0, 0)';
  let finished = false;
  fixture.input.getAnimations = () => [{ finished: Promise.resolve().then(() => { fixture.input.rect.y = 10; finished = true; }) }, { finished: Promise.reject(new Error('cancelled')) }];
  assert.equal((await fixture.inspect()).length, 0);
  assert.equal(finished, true);
  // An animation that never finishes must not prevent checking a genuinely offscreen control.
  fixture.input.rect.y = -100;
  fixture.input.getAnimations = () => [{ finished: new Promise(() => {}) }];
  fixture.context.setTimeout = (callback, delay) => { assert.equal(delay, 1000); return setTimeout(callback, 0); };
  assert.match((await fixture.inspect())[0].message, /outside the viewport/);
});

test('keyboard accepts hidden native choices only with a visible nearby ancestor focus indicator', async () => {
  for (const type of ['radio', 'checkbox']) {
    for (const indicator of ['outline', 'shadow']) {
      const fixture = focusFixture(type);
      fixture.input.style.opacity = '0';
      if (indicator === 'outline') Object.assign(fixture.card.style, { outlineStyle: 'solid', outlineWidth: '2px', outlineColor: 'rgb(0, 0, 0)' });
      else fixture.card.style.boxShadow = 'rgb(0, 0, 0) 0px 0px 0px 2px';
      assert.equal((await fixture.inspect()).length, 0, `${type} ${indicator}`);
    }
  }
  for (const problem of ['no indicator', 'unchanged shadow', 'hidden card', 'distant ancestor', 'outside label', 'text input']) {
    const fixture = focusFixture(problem === 'text input' ? 'text' : 'radio');
    fixture.input.style.opacity = '0';
    if (problem === 'unchanged shadow') {
      fixture.card.style.boxShadow = 'rgb(0, 0, 0) 0px 0px 0px 2px'; fixture.remember(); fixture.document.activeElement = fixture.input;
    } else if (problem !== 'no indicator') {
      Object.assign(fixture.card.style, { outlineStyle: 'solid', outlineWidth: '2px', outlineColor: 'rgb(0, 0, 0)' });
      if (problem === 'hidden card') fixture.card.style.opacity = '0';
      if (problem === 'distant ancestor') {
        fixture.card.tagName = 'DIV';
        for (let i = 0; i < 3; i++) fixture.input.parentElement = fixture.node('DIV', fixture.input.parentElement);
      }
      if (problem === 'outside label') fixture.input.parentElement = fixture.node('LABEL', fixture.card);
    }
    assert.ok((await fixture.inspect()).some(({ message }) => message.includes('hidden or outside')), problem);
  }
});

test('keyboard waits for long native scrolling and still reports genuinely offscreen buttons', async () => {
  const fixture = focusFixture();
  Object.assign(fixture.input.style, { outlineStyle: 'solid', outlineWidth: '2px', outlineColor: 'rgb(0, 0, 0)' });
  const box = fixture.input.getBoundingClientRect;
  fixture.input.getBoundingClientRect = function () { this.rect.y = fixture.elapsed() < 900 ? 1800 : 10; return box.call(this); };
  assert.equal((await fixture.inspect()).length, 0);
  fixture.input.getBoundingClientRect = box;
  fixture.input.rect.y = 950;
  assert.match((await fixture.inspect())[0].message, /y=950.*viewport 1280×900/);
});

test('keyboard accepts a focused region taller than the viewport only while its top edge is on screen', async () => {
  const fixture = focusFixture();
  Object.assign(fixture.input.style, { outlineStyle: 'solid', outlineWidth: '2px', outlineColor: 'rgb(0, 0, 0)' });
  Object.assign(fixture.input.rect, { y: 0, height: 1100 });
  assert.equal((await fixture.inspect()).length, 0);
  fixture.input.rect.y = -1200;
  assert.match((await fixture.inspect())[0].message, /outside the viewport/);
});
