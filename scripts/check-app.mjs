import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit, firefox } from 'playwright-core';
import { openContext } from '../core/context.mjs';
import { createApp } from '../server/app.mjs';
import { createGuard } from '../server/guard.mjs';
import { createApi } from '../server/api.mjs';
import { watch } from '../core/watch.mjs';
import { createEvents } from '../server/events.mjs';
import { createSettings } from '../server/settings.mjs';
import { createCards } from '../server/cards.mjs';
import { createWrites } from '../server/writes.mjs';
import { createRead } from '../server/read.mjs';
import { createRenderPool } from '../server/render-pool.mjs';
import { listenLoopback, serverGroup } from '../server/listen.mjs';
import { cookieName, mintToken, newInstanceId, sessionKey, siteHost } from '../server/session.mjs';
import { parseArgs, resolveBrowser, aggregateResults, exitCode } from './lib/design-check/config.mjs';
import { checkCase } from './lib/design-check/case.mjs';
import { printTable } from './lib/design-check/report.mjs';
import { selectAppPages, buildAppMatrix } from './lib/design-check/app-pages.mjs';
import { APP_ALLOWLIST } from './lib/design-check/allowlist.mjs';
import { checkSearchDialog } from './lib/design-check/search-dialog.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const engines = { chromium, webkit, firefox };
const reportPath = new URL('../design/check-app-report.json', import.meta.url);
const usage = 'Usage: npm run check:app -- [--browser chrome|brave|chromium|webkit|firefox]'
  + ' [--only home|board|card|note|search|search-empty|search-dialog|settings|not-found|signed-out]'
  + ' [--quick] [--workers 4]';

// Same one-time-token to cookie exchange a browser does at /auth; the token and the key stay in this process.
function signIn(port, key, instance) {
  const host = `${siteHost(key)}:${port}`;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: `/auth?t=${mintToken(key, port, instance)}`, headers: { host }, agent: false }, (res) => {
      res.resume();
      const cookie = (res.headers['set-cookie'] ?? []).map((line) => line.split(';')[0]).find((part) => part.startsWith(`${cookieName(port)}=`));
      if (res.statusCode !== 200 || !cookie) reject(new Error(`Sign-in failed (HTTP ${res.statusCode}).`));
      else resolve({ name: cookieName(port), value: cookie.slice(cookieName(port).length + 1), host });
    });
    req.on('error', reject);
    req.end();
  });
}

// The search page is a plain GET form: with JavaScript off it must still answer with results for its query.
async function checkNoScript(browser, baseURL, page, setup) {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 900 } });
  const findings = [];
  try {
    await setup(context, page);
    const tab = await context.newPage();
    tab.setDefaultTimeout(5000);
    const response = await tab.goto(`${baseURL}${page.path}`, { waitUntil: 'load' });
    if (!response?.ok()) findings.push({ message: `JavaScript off: HTTP ${response?.status() ?? 'no response'}` });
    else {
      const rows = await tab.locator('.search-row').count();
      if (!rows) findings.push({ message: 'JavaScript off: no .search-row results' });
      const query = new URL(page.path, baseURL).searchParams.get('q');
      if (await tab.locator('#search-query').inputValue() !== query) {
        findings.push({ message: 'JavaScript off: #search-query does not hold the query' });
      }
    }
  } catch (error) {
    findings.push({ message: `JavaScript off: ${error.message}` });
  } finally {
    await context.close();
  }
  for (const finding of findings) console.error(`${page.name}: ${finding.message}`);
  return { page: page.name, path: page.path, width: 1280, family: 'app', mode: 'noscript',
    checks: { noscript: findings } };
}

async function main() {
  let browser;
  let group;
  let deadline;
  let temp;
  let watcher;
  let events;
  let report = { summary: [], cases: [] };
  let code = 1;
  let help = false;
  try {
    let options;
    try {
      options = parseArgs(process.argv.slice(2));
      if (options.help) { help = true; console.log(usage); return; }
      const engine = ['chrome', 'brave'].includes(options.browser) ? 'chromium' : options.browser;
      const target = resolveBrowser(options.browser, { downloadedPath: engines[engine].executablePath() });
      browser = await engines[target.engine].launch({ executablePath: target.executablePath, headless: true, timeout: 15000 });
    } catch (error) {
      code = 2;
      throw new Error(`Cannot start app check: ${error.message}\n${usage}`);
    }
    // Always build first, like `npm start`: an older dist/app would check a different UI than the source.
    const built = spawnSync(process.execPath, [join(root, 'scripts/build-app.mjs')], { cwd: root, stdio: 'inherit' });
    if (built.status !== 0) throw new Error('The app build failed.');
    temp = realpathSync(mkdtempSync(join(tmpdir(), 'check-app-')));
    // The temp folder holds a session key; remove it even when the run is interrupted.
    const dir = temp;
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => { rmSync(dir, { recursive: true, force: true }); process.exit(130); });
    }
    const dataDir = join(temp, 'sample');
    const home = join(temp, 'home');
    cpSync(join(root, 'sample-data'), dataDir, { recursive: true });
    const env = {};
    const openRead = () => openContext({ mode: 'read', dataDir, home, env, platform: process.platform });
    const pages = selectAppPages(openRead(), options.only);

    const key = sessionKey({ home, env });
    const instance = newInstanceId();
    const { handler } = await import('../dist/app/server/entry.mjs');
    const { port, servers } = await listenLoopback({ from: 43000, to: 43200 });
    group = serverGroup(servers);
    const { render } = createRenderPool();
    // Same wiring as server/start.mjs, so pages' live-update stream is served too.
    watcher = watch(openRead());
    events = createEvents(watcher);
    const openWrite = () => openContext({ mode: 'write', dataDir, home, env, platform: process.platform,
      actor: 'web:owner' });
    const settings = createSettings({ key, port, open: openRead, openWrite });
    const cards = createCards({ key, port, open: openRead, openWrite });
    const writes = createWrites({ key, port, routes: [...settings.routes, ...cards.routes] });
    const app = createApp({ root, handler, writes: writes.handle,
      guard: createGuard({ port, key, instance, writable: writes.writable }),
      api: createApi({ open: openRead, render, events, live: settings.liveUpdates }),
      locals: { cairn: createRead({ open: openRead, render }), settings, cards } });
    for (const server of servers) server.on('request', app);
    const session = await signIn(port, key, instance);
    const baseURL = `http://${session.host}`;
    const setup = (context, entry) => entry.auth === false ? undefined
      : context.addCookies([{ name: session.name, value: session.value, url: baseURL, httpOnly: true, sameSite: 'Strict' }]);

    const axeSource = await readFile(fileURLToPath(import.meta.resolve('axe-core/axe.min.js')), 'utf8');
    const queue = pages.filter((page) => !page.interaction)
      .flatMap((page) => buildAppMatrix(options).map((variant) => ({ page: page.name, path: page.path,
      ...(page.status ? { status: page.status } : {}), ...(page.auth === false ? { auth: false } : {}), ...variant })));
    const total = queue.length;
    const results = [];
    let expired = false;
    deadline = setTimeout(() => { expired = true; browser.close().catch(() => {}); }, Math.max(120000, total * 5000));
    await Promise.all(Array.from({ length: options.workers }, async () => {
      while (queue.length && !expired) {
        const entry = queue.shift();
        try {
          const { result } = await checkCase(browser, baseURL, entry, axeSource, false, { setup, allowlist: APP_ALLOWLIST });
          results.push(result);
        } catch (error) {
          results.push({ ...entry, checks: { runner: [{ message: error.message }] } });
        }
      }
    }));
    for (const page of pages.filter((item) => item.noscript && !expired)) {
      results.push(await checkNoScript(browser, baseURL, page, setup));
    }
    for (const page of pages.filter((item) => item.interaction === 'search-dialog' && !expired)) {
      // Last on purpose: its live-update step adds notes to the checked data folder.
      const addNote = (name, title) => writeFileSync(join(dataDir, 'notes', `${name}.md`),
        `---\nkind: note\ntitle: ${title}\n---\n${title}\n`);
      results.push(await checkSearchDialog(browser, baseURL, page, setup, axeSource, { addNote }));
    }
    report = aggregateResults(results);
    if (expired) throw new Error(`App check timed out; ${queue.length} of ${total} case(s) not started. Narrow with --only or --quick.`);
    code = exitCode(report);
  } catch (error) {
    report.error = error.message;
    console.error(error.message);
  } finally {
    clearTimeout(deadline);
    if (browser) await browser.close();
    if (group) {
      group.closeAllConnections();
      await new Promise((resolve) => group.close(resolve));
    }
    events?.close();
    await watcher?.close();
    if (temp) rmSync(temp, { recursive: true, force: true });
    if (!help) {
      printTable(report);
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      console.log('Report: design/check-app-report.json');
      process.exitCode = code;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
