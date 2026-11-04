import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECKS, parseArgs, discoverPages, buildMatrix, resolveBrowser, aggregateResults, exitCode } from '../scripts/lib/design-check/config.mjs';

test('design check arguments have conservative defaults and accept documented options', () => {
  assert.deepEqual(parseArgs([]), { browser: 'chrome', quick: false, only: null, workers: 4, help: false });
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
      engine: name, executablePath: `/cache/${name}`,
    });
    for (const downloadedPath of [undefined, '/missing']) {
      assert.throws(() => resolveBrowser(name, { env: {}, downloadedPath, isExecutable: () => false }), { message: `Missing ${name} browser. Run: npx playwright-core install ${name}` });
    }
  }
});
