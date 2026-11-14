// README screenshots: builds the app, starts it on a fictional English data folder in a temp dir and saves
// light and dark PNGs to docs/images/. Usage: npm run screenshots [-- --scale 1]
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { openContext } from '../core/context.mjs';
import * as index from '../core/index.mjs';
import { createApp } from '../server/app.mjs';
import { createGuard } from '../server/guard.mjs';
import { createApi } from '../server/api.mjs';
import { watch } from '../core/watch.mjs';
import { createEvents } from '../server/events.mjs';
import { createSettings } from '../server/settings.mjs';
import { createCards } from '../server/cards.mjs';
import { createProjects } from '../server/projects.mjs';
import { createJournal } from '../server/journal.mjs';
import { createWrites } from '../server/writes.mjs';
import { createRead } from '../server/read.mjs';
import { createRenderPool } from '../server/render-pool.mjs';
import { listenLoopback, serverGroup } from '../server/listen.mjs';
import { cookieName, mintToken, newInstanceId, sessionKey, siteHost } from '../server/session.mjs';
import { resolveBrowser } from './lib/design-check/config.mjs';
import { buildDemoData } from './lib/demo-data.mjs';
import { useLanguage } from '../src/i18n/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const outDir = join(root, 'docs', 'images');
const appDir = 'dist/app-shots';
const scaleAt = process.argv.indexOf('--scale');
const scale = scaleAt > 0 ? Number(process.argv[scaleAt + 1]) : 1;
if (!(scale > 0)) throw new Error('Usage: npm run screenshots [-- --scale <number above 0>]');

function signIn(port, key, instance) {
  const host = `${siteHost(key)}:${port}`;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: `/auth?t=${mintToken(key, port, instance)}`, headers: { host },
      agent: false }, (res) => {
      res.resume();
      const name = cookieName(port);
      const cookie = (res.headers['set-cookie'] ?? []).map((line) => line.split(';')[0])
        .find((part) => part.startsWith(`${name}=`));
      if (res.statusCode !== 200 || !cookie) reject(new Error(`Sign-in failed (HTTP ${res.statusCode}).`));
      else resolve({ name, value: cookie.slice(name.length + 1), host });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  let temp; let browser; let group; let watcher; let events;
  try {
    const built = spawnSync(process.execPath, [join(root, 'scripts/build-app.mjs'), '--out', appDir],
      { cwd: root, stdio: 'inherit' });
    if (built.status !== 0) throw new Error('The app build failed.');
    temp = realpathSync(mkdtempSync(join(tmpdir(), 'cairn-shots-')));
    const dir = temp;
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => { rmSync(dir, { recursive: true, force: true }); process.exit(130); });
    }
    const dataDir = join(temp, 'data');
    const home = join(temp, 'home');
    const demo = buildDemoData(dataDir, home);
    const env = {};
    const open = (mode, actor) => openContext({ mode, dataDir, home, env, platform: process.platform,
      ...(actor ? { actor } : {}) });
    const openRead = () => open('read');
    const openWrite = () => open('write', 'web:owner');

    useLanguage(openRead().config.language);
    const key = sessionKey({ home, env });
    const instance = newInstanceId();
    const { handler } = await import(`../${appDir}/server/entry.mjs`);
    const { port, servers } = await listenLoopback({ from: 43300, to: 43500 });
    group = serverGroup(servers);
    const { render } = createRenderPool();
    // Same wiring as server/start.mjs.
    watcher = watch(openRead());
    events = createEvents(watcher);
    const settings = createSettings({ key, port, open: openRead, openWrite });
    const cards = createCards({ key, port, open: openRead, openWrite });
    const projects = createProjects({ key, port, open: openRead, openWrite });
    const journal = createJournal({ key, port, open: openRead, openWrite });
    const writes = createWrites({ key, port,
      routes: [...settings.routes, ...cards.routes, ...projects.routes, ...journal.routes] });
    const app = createApp({ root, appDir, handler, writes: writes.handle,
      guard: createGuard({ port, key, instance, writable: writes.writable }),
      api: createApi({ open: openRead, render, events, live: settings.liveUpdates }),
      locals: { cairn: createRead({ open: openRead, render }), settings, cards, projects, journal } });
    for (const server of servers) server.on('request', app);
    const session = await signIn(port, key, instance);
    const baseURL = `http://${session.host}`;

    const ctx = openRead();
    const byTitle = (type, title) => index.rows(ctx, type).find((row) => row.title === title)?.id;
    const shots = [
      { name: 'board', path: '/board' },
      { name: 'card', path: '/board', click: 'Move secrets to the vault' },
      { name: 'agents', path: '/agents' },
      { name: 'home', path: '/' },
      { name: 'note', path: `/notes/${byTitle('note', 'Release checklist')}` },
      { name: 'journal', path: `/journal/${demo.today}` },
    ];

    const target = resolveBrowser('chromium', { downloadedPath: chromium.executablePath() });
    browser = await chromium.launch({ executablePath: target.executablePath, headless: true, timeout: 15000 });
    mkdirSync(outDir, { recursive: true });
    for (const mode of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: scale,
        colorScheme: mode, reducedMotion: 'reduce' });
      await context.addCookies([{ name: session.name, value: session.value, url: baseURL, httpOnly: true,
        sameSite: 'Strict' }]);
      const page = await context.newPage();
      for (const shot of shots) {
        const response = await page.goto(`${baseURL}${shot.path}`, { waitUntil: 'networkidle' });
        if (!response?.ok()) throw new Error(`${shot.name}: HTTP ${response?.status()}`);
        if (shot.click) {
          await page.getByText(shot.click, { exact: true }).first().click();
          // The dialog opens first and loads the card after; wait for its title, not just the frame.
          await page.locator('dialog[open]').getByText(shot.click, { exact: true }).waitFor();
        }
        await page.evaluate(() => document.fonts.ready);
        const file = join(outDir, `${shot.name}-${mode}.png`);
        await page.screenshot({ path: file });
        console.log(`docs/images/${shot.name}-${mode}.png`);
      }
      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    if (group) { group.closeAllConnections(); await new Promise((resolve) => group.close(resolve)); }
    events?.close();
    await watcher?.close();
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
