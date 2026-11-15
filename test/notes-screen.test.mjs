import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.mjs';
import { createApi } from '../server/api.mjs';
import { createGuard, guard } from '../server/guard.mjs';
import { createRead, DataNotReadyError, notesResult } from '../server/read.mjs';
import { createRenderPool } from '../server/render-pool.mjs';
import { loginUrl, siteHost } from '../server/session.mjs';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { isNoteKey } from '../core/ids.mjs';
import { useLanguage } from '../src/i18n/index.mjs';
import { APP_ALLOWLIST, filterAllowed } from '../scripts/lib/design-check/allowlist.mjs';
import { resolveBrowser } from '../scripts/lib/design-check/config.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { liveCleanup, liveUnavailable } from './support/live.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const key = Buffer.alloc(32, 8);
const instance = 'run-nnnnnnnnnnnnnnnn';

const ALPHA = 'p-a10001';
const BETA = 'p-b20002';
const AGENTS = 'p-a90003';

async function inProcess(app, path) {
  const req = new IncomingMessage(new Socket());
  req.url = path;
  req.method = 'GET';
  req.headers = { host: '127.0.0.1:4321' };
  let output = '';
  const socket = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } });
  const res = new ServerResponse(req);
  res.useChunkedEncodingByDefault = false;
  res.assignSocket(socket);
  const finished = new Promise((resolve) => res.once('finish', resolve));
  await app(req, res);
  await finished;
  return { status: res.statusCode, body: output.slice(output.indexOf('\r\n\r\n') + 4) };
}

function setupFixture(t, { empty = false, singleKind = false, preset = 'default', tools = false } = {}) {
  const data = tempDir(t);
  const home = tempDir(t);
  const clock = fixedClock('2026-11-18T12:00:00Z');
  initDataDir(data, { home, env: {}, clock });
  const cfgPath = join(data, '.cairn/config.json');
  const existing = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const patch = preset === 'tr-wiki'
    ? { schemaPreset: 'tr-wiki', agents: { project: AGENTS }, language: 'tr' }
    : { agents: { project: AGENTS }, language: 'tr' };
  writeFileSync(cfgPath, `${JSON.stringify({ ...existing, ...patch }, null, 2)}\n`);

  mkdirSync(join(data, 'projects'), { recursive: true });
  writeFileSync(join(data, 'projects/alpha.md'),
    `---\nid: ${ALPHA}\ntitle: Alpha Project\ntone: 2\nstatus: active\n---\nAlpha body.\n`);
  writeFileSync(join(data, 'projects/beta.md'),
    `---\nid: ${BETA}\ntitle: Beta Project\ntone: 5\nstatus: active\n---\nBeta body.\n`);
  writeFileSync(join(data, 'projects/agents.md'),
    `---\nid: ${AGENTS}\ntitle: Agent Ops\ntone: 7\nstatus: active\n---\nAgents body.\n`);

  const noteRoot = preset === 'tr-wiki' ? 'wiki' : 'notes';
  mkdirSync(join(data, noteRoot), { recursive: true });

  if (!empty) {
    mkdirSync(join(data, noteRoot, 'mimari', 'nested'), { recursive: true });
    mkdirSync(join(data, noteRoot, 'donanim'), { recursive: true });

    // Pinned note inside nested folder (newer).
    writeFileSync(join(data, noteRoot, 'mimari/nested/pinned-deep.md'), [
      '---',
      'id: n-a1b001',
      'title: Pinned Architecture Note',
      `kind: ${singleKind ? 'note' : 'overview'}`,
      'pinned: true',
      `project: ${ALPHA}`,
      'updated: 2026-11-16T09:00:00Z',
      '---',
      'Deep pinned overview body.',
      '',
    ].join('\n'));

    // Pinned note directly in root (older).
    writeFileSync(join(data, noteRoot, 'pinned-root.md'), [
      '---',
      'id: n-a1b002',
      'title: Pinned Root Note',
      'kind: note',
      'pinned: true',
      `project: ${BETA}`,
      'updated: 2026-11-12T09:00:00Z',
      '---',
      'Root pinned body.',
      '',
    ].join('\n'));

    // Unpinned note with NO id (id: null) inside topic `donanim`.
    writeFileSync(join(data, noteRoot, 'donanim/no-id-note.md'), [
      '---',
      'title: Hardware No Id',
      `kind: ${singleKind ? 'note' : 'tool'}`,
      `project: ${BETA}`,
      'updated: 2026-11-15T10:00:00Z',
      '---',
      'Hardware note without frontmatter id.',
      '',
    ].join('\n'));

    // Unpinned note in nested folder under topic `mimari`.
    writeFileSync(join(data, noteRoot, 'mimari/nested/cache-design.md'), [
      '---',
      'id: n-b2c001',
      'title: Nested Cache Concept',
      `kind: ${singleKind ? 'note' : 'concept'}`,
      `project: ${ALPHA}`,
      'updated: 2026-11-14T08:00:00Z',
      '---',
      'Nested concept body.',
      '',
    ].join('\n'));

    // Older unpinned note in topic `mimari` (same project, older updated -> after Nested Cache Concept).
    writeFileSync(join(data, noteRoot, 'mimari/old-query.md'), [
      '---',
      'id: n-b2c002',
      'title: Older Mimari Note',
      `kind: ${singleKind ? 'note' : 'query'}`,
      `project: ${ALPHA}`,
      'updated: 2026-11-01T08:00:00Z',
      '---',
      'Older query note.',
      '',
    ].join('\n'));

    // Direct in noteRoot -> no topic (`topic: null`), should sort last after named topics.
    writeFileSync(join(data, noteRoot, 'loose-note.md'), [
      '---',
      'id: n-c3d001',
      'title: Loose Root Note',
      'kind: note',
      'updated: 2026-11-17T12:00:00Z',
      '---',
      'Unassigned note without project or topic folder.',
      '',
    ].join('\n'));

    // Agent notes (by id and by @path) -> both MUST be excluded from view, filter chips, and page.
    writeFileSync(join(data, noteRoot, 'donanim/agent-by-id.md'), [
      '---',
      'id: n-a90001',
      'title: Secret Agent Log',
      'kind: note',
      'pinned: true',
      `project: ${AGENTS}`,
      'updated: 2026-11-18T11:00:00Z',
      '---',
      'Agent note referenced by id.',
      '',
    ].join('\n'));

    writeFileSync(join(data, noteRoot, 'agent-by-ref.md'), [
      '---',
      'id: n-a90002',
      'title: Secret Agent Prompt',
      'kind: note',
      'project: "@projects/agents"',
      'updated: 2026-11-18T10:00:00Z',
      '---',
      'Agent note referenced by path.',
      '',
    ].join('\n'));
  }

  if (tools) {
    mkdirSync(join(data, '.cairn/tools'), { recursive: true });
    writeFileSync(join(data, '.cairn/tools/workstation.json'), JSON.stringify({
      machine: 'workstation',
      scannedAt: '2026-11-18T11:00:00Z',
      tools: [{ name: 'ripgrep', kind: 'cli', description: 'Fast search' }],
    }));
  }

  const open = () => openContext({ mode: 'read', dataDir: data, home, env: {}, platform: process.platform, clock });
  return { open, data };
}

async function mountApp(t, open) {
  if (!existsSync(new URL('../dist/app/server/entry.mjs', import.meta.url))) {
    t.skip('dist/app/server/entry.mjs not built; run npm run build:app first');
    return null;
  }
  const { handler } = await import('../dist/app/server/entry.mjs');
  const pool = createRenderPool();
  t.after(() => pool.close());
  const read = createRead({ open, render: pool.render });
  const app = createApp({
    root,
    handler,
    guard: () => true,
    api: createApi({ open, events: { handle() { return false; } } }),
    locals: { cairn: read },
  });
  return { get: (path) => inProcess(app, path), read };
}

test('notesResult pins first, derives topics for nested and no-id notes, hides agent notes', (t) => {
  const prev = process.env.CAIRN_LANGUAGE;
  t.after(() => { if (prev === undefined) delete process.env.CAIRN_LANGUAGE; else process.env.CAIRN_LANGUAGE = prev; });
  useLanguage('tr');

  const ctx = setupFixture(t).open();
  t.after(() => ctx.close?.());

  const { data } = notesResult(ctx);
  // 6 owner notes total; both agent notes excluded.
  assert.equal(data.items.length, 6);
  assert.equal(data.items.some((item) => item.title.includes('Secret Agent')), false);
  assert.deepEqual(data.projects.map((p) => p.id), [ALPHA, BETA]);

  // Pinned notes come first in newest-updated order, regardless of topic folder.
  assert.deepEqual(data.items.slice(0, 2).map((item) => item.ref), ['n-a1b001', 'n-a1b002']);
  assert.equal(data.items[0].pinned, true);
  assert.equal(data.items[0].topic, 'mimari');
  assert.equal(data.items[0].kind, 'overview');
  assert.deepEqual(data.items[0].project, { id: ALPHA, title: 'Alpha Project', tone: 2 });

  // Unpinned notes: `donanim` before `mimari` in Turkish locale, then null topic last.
  const rest = data.items.slice(2);
  assert.equal(rest[0].topic, 'donanim');
  assert.equal(isNoteKey(rest[0].ref), true); // note without id uses hashed n-... ref
  assert.equal(rest[0].title, 'Hardware No Id');
  assert.equal(rest[0].kind, 'tool');

  assert.equal(rest[1].topic, 'mimari');
  assert.equal(rest[1].ref, 'n-b2c001'); // newer inside mimari
  assert.equal(rest[1].kind, 'concept');

  assert.equal(rest[2].topic, 'mimari');
  assert.equal(rest[2].ref, 'n-b2c002'); // older inside mimari
  assert.equal(rest[2].kind, 'query');

  assert.equal(rest[3].topic, null);
  assert.equal(rest[3].ref, 'n-c3d001');
  assert.equal(rest[3].project, null);

  // Project filter narrows to Alpha notes and keeps active project id.
  const filtered = notesResult(ctx, { project: ALPHA }).data;
  assert.equal(filtered.project, ALPHA);
  assert.deepEqual(filtered.items.map((item) => item.ref), ['n-a1b001', 'n-b2c001', 'n-b2c002']);

  // Agents project or unknown project is ignored.
  assert.equal(notesResult(ctx, { project: AGENTS }).data.project, '');
  assert.equal(notesResult(ctx, { project: AGENTS }).data.items.length, 6);
  assert.equal(notesResult(ctx, { project: 'p-missing' }).data.items.length, 6);
});

test('notesResult derives topics from schema root path (tr-wiki) and respects UI locale ordering', (t) => {
  const prev = process.env.CAIRN_LANGUAGE;
  t.after(() => { if (prev === undefined) delete process.env.CAIRN_LANGUAGE; else process.env.CAIRN_LANGUAGE = prev; });
  useLanguage('tr');

  const { open, data: dataDir } = setupFixture(t, { preset: 'tr-wiki' });
  mkdirSync(join(dataDir, 'wiki/ışık'), { recursive: true });
  mkdirSync(join(dataDir, 'wiki/izmir'), { recursive: true });
  writeFileSync(join(dataDir, 'wiki/ışık/a.md'), '---\nid: n-d40001\ntitle: Light Topic\n---\nBody\n');
  writeFileSync(join(dataDir, 'wiki/izmir/b.md'), '---\nid: n-d40002\ntitle: Izmir Topic\n---\nBody\n');

  const ctx = open();
  t.after(() => ctx.close?.());
  const trTopics = notesResult(ctx).data.items
    .filter((item) => !item.pinned && (item.topic === 'ışık' || item.topic === 'izmir'))
    .map((item) => item.topic);
  assert.deepEqual(trTopics, ['ışık', 'izmir']);

  useLanguage('en');
  const enTopics = notesResult(ctx).data.items
    .filter((item) => !item.pinned && (item.topic === 'ışık' || item.topic === 'izmir'))
    .map((item) => item.topic);
  assert.deepEqual(enTopics, ['izmir', 'ışık']);

  const trWiki = notesResult(ctx).data;
  assert.equal(trWiki.items.find((item) => item.ref === 'n-b2c001')?.topic, 'mimari');
  assert.equal(trWiki.items.find((item) => item.ref === 'n-c3d001')?.topic, null);
});

test('notes page renders 200, groups, ref links, project filter and active top bar tab', async (t) => {
  const prev = process.env.CAIRN_LANGUAGE;
  t.after(() => { if (prev === undefined) delete process.env.CAIRN_LANGUAGE; else process.env.CAIRN_LANGUAGE = prev; });
  useLanguage('tr');

  const mounted = await mountApp(t, setupFixture(t).open);
  if (!mounted) return;

  const page = await mounted.get('/notes');
  assert.equal(page.status, 200);
  // Top bar contains Notes tab marked current.
  const tabBar = page.body.match(/<div class="app-tabs">[\s\S]*?<\/div>/u)[0];
  const tabs = [...tabBar.matchAll(/<a href="([^"]+)"([^>]*)>/gu)];
  const notesTab = tabs.find(([, href]) => href === '/notes');
  assert.ok(notesTab);
  assert.match(notesTab[2], /aria-current="page"/u);

  // Groups: Sabitlenenler, donanim, mimari, Başlıksız (in order).
  const headings = [...page.body.matchAll(/<h2 id="notes-group-[^"]+">([^<]+)<\/h2>/gu)].map((m) => m[1]);
  assert.deepEqual(headings, ['Sabitlenenler', 'donanim', 'mimari', 'Başlıksız']);

  // Multiple kinds -> kind chips appear.
  assert.match(page.body, />Genel bakış<\/span>/u);
  assert.match(page.body, />Kavram<\/span>/u);
  assert.match(page.body, />Araç<\/span>/u);

  // Links use ref, including no-id notes (`n-...`), and single-note page marks Notes tab current too.
  const noIdHref = page.body.match(/href="(\/notes\/n-[0-9a-f]{16})"/u)?.[1];
  assert.ok(noIdHref, 'expected /notes/<ref> link for note without id');
  assert.match(page.body, /href="\/notes\/n-a1b001"/u);
  assert.doesNotMatch(page.body, /Secret Agent/u);

  const single = await mounted.get(noIdHref);
  assert.equal(single.status, 200);
  const singleTabBar = single.body.match(/<div class="app-tabs">[\s\S]*?<\/div>/u)[0];
  const singleNotesTab = [...singleTabBar.matchAll(/<a href="([^"]+)"([^>]*)>/gu)]
    .find(([, href]) => href === '/notes');
  assert.match(singleNotesTab[2], /aria-current="page"/u);

  // Project filter narrows displayed rows and preserves pressed state.
  const alphaPage = await mounted.get(`/notes?project=${ALPHA}`);
  assert.equal(alphaPage.status, 200);
  assert.match(alphaPage.body, /Pinned Architecture Note/u);
  assert.match(alphaPage.body, /Nested Cache Concept/u);
  assert.doesNotMatch(alphaPage.body, /Hardware No Id/u);
  assert.doesNotMatch(alphaPage.body, /Loose Root Note/u);
  assert.match(alphaPage.body, new RegExp(`value="${ALPHA}"[^>]*aria-pressed="true"`, 'u'));

  // Filtering by Beta leaves one pinned note and one unpinned note (`donanim`), omitting `mimari` & `Başlıksız`.
  const betaPage = await mounted.get(`/notes?project=${BETA}`);
  const betaHeadings = [...betaPage.body.matchAll(/<h2 id="notes-group-[^"]+">([^<]+)<\/h2>/gu)].map((m) => m[1]);
  assert.deepEqual(betaHeadings, ['Sabitlenenler', 'donanim']);
});

test('notes page omits kind labels for single kind and shows one-line empty state', async (t) => {
  const prev = process.env.CAIRN_LANGUAGE;
  t.after(() => { if (prev === undefined) delete process.env.CAIRN_LANGUAGE; else process.env.CAIRN_LANGUAGE = prev; });
  useLanguage('en');

  const single = await mountApp(t, setupFixture(t, { singleKind: true }).open);
  if (!single) return;
  const singleRes = await single.get('/notes');
  assert.equal(singleRes.status, 200);
  assert.doesNotMatch(singleRes.body, /<span class="chip">(?:Note|Concept|Tool|Query|Overview)<\/span>/u);

  const empty = await mountApp(t, setupFixture(t, { empty: true }).open);
  const emptyRes = await empty.get('/notes');
  assert.equal(emptyRes.status, 200);
  assert.match(emptyRes.body, /No notes yet\./u);
  assert.doesNotMatch(emptyRes.body, /journal-filters/u);

  // DataNotReadyError gives 409 state screen cleanly.
  const notReady = await mountApp(t, async () => { throw new DataNotReadyError(new Error('not ready')); });
  const readyRes = await notReady.get('/notes');
  assert.equal(readyRes.status, 409);
});

test('notes screen passes browser accessibility, 375px width, and header geometry checks', async (t) => {
  const prev = process.env.CAIRN_LANGUAGE;
  t.after(() => { if (prev === undefined) delete process.env.CAIRN_LANGUAGE; else process.env.CAIRN_LANGUAGE = prev; });
  useLanguage('tr');

  if (!existsSync(new URL('../dist/app/server/entry.mjs', import.meta.url))) {
    return liveUnavailable(t, 'Build not present; run npm run build:app first');
  }
  const cleanup = liveCleanup(t);
  let browser;
  try {
    browser = await chromium.launch(resolveBrowser());
  } catch (error) {
    return liveUnavailable(t, `Browser unavailable: ${error.message.split('\n')[0]}`);
  }
  cleanup(() => browser.close());

  const server = createServer();
  cleanup(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    return liveUnavailable(t, 'Loopback listen unavailable');
  }
  const port = server.address().port;
  const { open } = setupFixture(t, { tools: true });
  const pool = createRenderPool();
  t.after(() => pool.close());
  const { handler } = await import('../dist/app/server/entry.mjs');
  const app = createApp({
    root,
    handler,
    guard: createGuard({ port, key, instance }),
    api: createApi({ open, events: { handle(_req, res) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('retry: 2000\n\n');
      return true;
    } } }),
    locals: { cairn: createRead({ open, render: pool.render }) },
  });
  server.on('request', app);

  const origin = `http://${siteHost(key)}:${port}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  cleanup(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(loginUrl(port, key, instance));
  await page.waitForURL(`${origin}/`, { timeout: 10_000 });

  for (const path of ['/notes', '/notes/n-a1b001']) {
    const res = await page.goto(`${origin}${path}`);
    assert.equal(res?.status(), 200);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    assert.deepEqual(errors, [], `${path}: no console/page errors`);

    const axeSource = readFileSync(fileURLToPath(import.meta.resolve('axe-core/axe.min.js')), 'utf8');
    await page.evaluate(axeSource);
    const regions = [...new Set(APP_ALLOWLIST.map((item) => item.within))];
    const found = await page.evaluate(async (withinRegions) => {
      const result = await window.axe.run(document, { resultTypes: ['violations'] });
      return result.violations.map(({ id, impact, nodes }) => ({
        id,
        impact,
        nodes: nodes.map((node) => {
          const element = document.querySelector(node.target[0]);
          return { within: withinRegions.filter((region) => element?.closest(region)) };
        }),
      }));
    }, regions);
    assert.deepEqual(filterAllowed(found, APP_ALLOWLIST), [], `${path}: no axe findings`);

    // Check top-bar non-overlap at 1280px even with 7 tabs (when Tools snapshot is active).
    const headerBoxes = await page.evaluate(() => {
      const box = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      };
      return {
        brand: box('.brand'),
        nav: box('.app-navigation'),
        search: box('.shell-search'),
      };
    });
    assert.ok(headerBoxes.brand.right <= headerBoxes.nav.left,
      `brand (${headerBoxes.brand.right}) must not overlap nav (${headerBoxes.nav.left})`);
    assert.ok(headerBoxes.nav.right <= headerBoxes.search.left,
      `nav (${headerBoxes.nav.right}) must not overlap search (${headerBoxes.search.left})`);

    await page.setViewportSize({ width: 375, height: 812 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    assert.equal(overflow, false, `${path}: no horizontal overflow at 375px`);
    await page.setViewportSize({ width: 1280, height: 900 });
  }
});
