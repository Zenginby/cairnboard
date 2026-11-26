import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.mjs';
import { createGuard } from '../server/guard.mjs';
import { createNotes } from '../server/notes.mjs';
import { createWrites } from '../server/writes.mjs';
import { createRead, pinnedExcerpt, pinnedNotesResult, plainItem } from '../server/read.mjs';
import { cookieName, csrfToken, mintCookie, siteHost } from '../server/session.mjs';
import { openContext } from '../core/context.mjs';
import { readEvents } from '../core/events.mjs';
import { parseFile } from '../core/frontmatter.mjs';
import { refresh } from '../core/index.mjs';
import { renderMarkdown } from '../core/render.mjs';
import { CairnError } from '../core/errors.mjs';
import * as entity from '../core/entity.mjs';
import * as note from '../core/note.mjs';
import * as project from '../core/project.mjs';
import { useLanguage } from '../src/i18n/index.mjs';
import { fixedClock, seedDataDir, tempDir } from './support/env.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const port = 4321;
const key = Buffer.alloc(32, 9);
const instance = 'run-dddddddddddddddd';
const clock = fixedClock('2026-11-15T10:00:00Z');

async function call(app, { method = 'GET', path, headers = {}, body }) {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = path;
  req.headers = { host: `${siteHost(key)}:${port}`, ...headers };
  if (body !== undefined) {
    const raw = Buffer.from(body);
    req.push(raw);
    req.headers['content-length'] = String(raw.length);
  }
  req.push(null);

  const chunks = [];
  const res = new ServerResponse(req);
  res.assignSocket(new Writable({
    write(chunk, _enc, done) { chunks.push(chunk); done(); },
  }));
  const finished = new Promise((resolve) => res.on('finish', resolve));
  app(req, res);
  await finished;
  const raw = Buffer.concat(chunks).toString('utf8');
  const split = raw.indexOf('\r\n\r\n');
  return { status: res.statusCode, headers: res.getHeaders(), body: split < 0 ? raw : raw.slice(split + 4) };
}

async function setup(t, { language = 'en', rules, agentsProject } = {}) {
  useLanguage(language);
  const dir = tempDir(t, 'cairn-notes-route-');
  const home = tempDir(t, 'cairn-notes-home-');
  seedDataDir(dir, { register: false, language });
  if (rules || agentsProject) {
    const cfgPath = join(dir, '.cairn', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    if (rules) cfg.rules = { ...(cfg.rules ?? {}), ...rules };
    if (agentsProject) cfg.agents = { ...(cfg.agents ?? {}), project: agentsProject };
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  }
  const open = () => openContext({ dataDir: dir, home, env: {}, clock, mode: 'read' });
  const openWrite = () => openContext({ dataDir: dir, home, env: {}, clock, mode: 'write', actor: 'web:owner' });
  const notes = createNotes({ key, port, open, openWrite });
  const writes = createWrites({ key, port, routes: notes.routes, limit: 100 });
  const guard = createGuard({ port, key, instance, writable: writes.writable });
  let handler = (_req, res) => { res.statusCode = 404; res.end('not found'); };
  let built = false;
  if (existsSync(join(repo, 'dist/app/server/entry.mjs'))) {
    ({ handler } = await import(new URL('../dist/app/server/entry.mjs', import.meta.url)));
    built = true;
  }
  const app = createApp({
    root: repo,
    handler,
    guard,
    writes: writes.handle,
    locals: { cairn: createRead({ open, render: renderMarkdown }), notes },
  });
  const cookie = mintCookie(key, port);
  const cookieHeader = `${cookieName(port)}=${cookie}`;
  const csrf = csrfToken(key, port, cookie, 'note');
  const post = (form, { token = csrf, withCookie = true } = {}) => call(app, {
    method: 'POST',
    path: '/notes',
    headers: {
      ...(withCookie ? { cookie: cookieHeader } : {}),
      origin: `http://${siteHost(key)}:${port}`,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(token === null ? form : { ...form, csrf: token }).toString(),
  });
  return { dir, open, openWrite, notes, app, cookieHeader, csrf, post, built };
}

test('POST /notes creates a kind:note file with normalized body and logs web:owner', async (t) => {
  const { open, post } = await setup(t);
  const res = await post({ title: '  Quick thought  ', body: 'Line 1\r\nLine 2', project: '' });
  assert.equal(res.status, 303);
  assert.match(String(res.headers.location), /^\/notes\/n-[0-9a-hjkmnp-tv-z]{6}$/u);
  const id = String(res.headers.location).slice('/notes/'.length);
  const ctx = open();
  const created = entity.resolve(ctx, 'note', id);
  assert.equal(created.data.kind, 'note');
  assert.equal(created.id, id);
  assert.equal(created.title, 'Quick thought');
  assert.equal(created.body, 'Line 1\nLine 2');
  assert.equal(existsSync(join(ctx.root, created.path)), true);
  assert.equal(readEvents(ctx).at(-1).actor, 'web:owner');
});

test('POST /notes accepts optional active project and refuses the agents project', async (t) => {
  const env = await setup(t);
  const active = project.create(env.openWrite(), { title: 'Work', status: 'active' }, '', {}).entity;
  const paused = project.create(env.openWrite(), { title: 'Hold', status: 'paused' }, '', {}).entity;
  const agent = project.create(env.openWrite(), { title: 'Bots', status: 'active' }, '', {}).entity;
  const cfgPath = join(env.dir, '.cairn', 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.agents = { project: agent.id };
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

  const view = env.notes.view(env.cookieHeader);
  assert.equal(view.state, 'ready');
  assert.deepEqual(view.projects.map((p) => p.id), [active.id]);

  const ok = await env.post({ title: 'Project note', body: '', project: active.id });
  assert.equal(ok.status, 303);
  const id = String(ok.headers.location).slice('/notes/'.length);
  assert.equal(entity.resolve(env.open(), 'note', id).data.project, active.id);

  // Unknown and paused-is-okay? Check non-existent fails 400 and agents project fails 400.
  const unknown = await env.post({ title: 'Bad proj', body: '', project: 'no-such-project' });
  assert.equal(unknown.status, 400);
  const byAgent = await env.post({ title: 'Agent note', body: '', project: agent.id });
  assert.equal(byAgent.status, 400);
  assert.equal(entity.list(env.open(), 'note', { all: true }).length, 1);
  // Active check passes while paused stays hidden from picker.
  assert.ok(paused.id);
});

test('POST /notes rejects bad titles, unknown fields and oversized bodies without writing', async (t) => {
  const { open, post } = await setup(t);
  const badCases = [
    { title: '', body: '', project: '' },
    { title: '   ', body: '', project: '' },
    { title: 'a'.repeat(201), body: '', project: '' },
    { title: 'Line\tbreak', body: '', project: '' },
    { title: 'Line\nbreak', body: '', project: '' },
    { title: 'Line\rbreak', body: '', project: '' },
    { title: 'Line\u0085break', body: '', project: '' },
    { title: 'Hidden\u200bchar', body: '', project: '' },
    { body: 'missing title', project: '' },
    { title: 'Extra', body: '', project: '', extra: 'nope' },
    { title: 'Kind', body: '', project: '', kind: 'concept' },
    { title: 'Pinned', body: '', project: '', pinned: 'true' },
    { title: 'Tags', body: '', project: '', tags: 'a' },
    { title: 'Path', body: '', project: '', path: 'evil.md' },
    { title: 'Id', body: '', project: '', id: 'n-aaaaaa' },
    { title: 'Too big', body: 'x'.repeat(256 * 1024 + 1), project: '' },
  ];
  for (const fields of badCases) {
    const res = await post(fields);
    assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify(fields).slice(0, 60)}`);
  }
  const overLimit = await post({ title: 'Way too big', body: 'x'.repeat(4 * 256 * 1024 + 5000), project: '' });
  assert.equal(overLimit.status, 413);
  assert.equal(entity.list(open(), 'note', { all: true }).length, 0);
});

test('POST /notes rejects missing, wrong and wrong-form CSRF tokens with 403', async (t) => {
  const { open, post, cookieHeader } = await setup(t);
  const cookie = cookieHeader.split('=')[1];
  const cardToken = csrfToken(key, port, cookie, 'card');
  const settingsToken = csrfToken(key, port, cookie, 'settings');

  for (const token of [null, 'wrong-token', cardToken, settingsToken]) {
    const res = await post({ title: 'Blocked', body: '', project: '' }, { token });
    assert.equal(res.status, 403);
  }
  assert.equal(entity.list(open(), 'note', { all: true }).length, 0);
});

test('POST /notes returns 422 naming the rule when a write rule is error severity', async (t) => {
  const { open, post } = await setup(t, { rules: { links: 'error' } });
  const res = await post({ title: 'Broken link note', body: 'See [[ghost]] for details.', project: '' });
  assert.equal(res.status, 422);
  assert.match(res.body, /links/u);
  assert.match(res.body, /href="\/notes\/new"/u);
  assert.equal(entity.list(open(), 'note', { all: true }).length, 0);
});

test('POST /notes handles conflicts (409), validation (400), notReady (409) and locked stores (503 Retry-After)',
  async (t) => {
    const dir = tempDir(t, 'cairn-notes-err-');
    const home = tempDir(t, 'cairn-notes-err-home-');
    seedDataDir(dir, { register: false, language: 'en' });
    const cookie = mintCookie(key, port);
    const csrf = csrfToken(key, port, cookie, 'note');
    const postWith = (notes) => {
      const writes = createWrites({ key, port, routes: notes.routes, limit: 100 });
      const app = createApp({
        root: repo,
        handler: (_req, res) => { res.statusCode = 404; res.end(); },
        guard: createGuard({ port, key, instance, writable: writes.writable }),
        writes: writes.handle,
      });
      return call(app, {
        method: 'POST',
        path: '/notes',
        headers: {
          cookie: `${cookieName(port)}=${cookie}`,
          origin: `http://${siteHost(key)}:${port}`,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ csrf, title: 'Note', body: '', project: '' }).toString(),
      });
    };

    const cases = [
      ['conflict', 409],
      ['duplicate_id', 409],
      ['validation', 400],
      ['not_found', 409],
    ];
    for (const [code, expected] of cases) {
      const notes = createNotes({
        key,
        port,
        open: () => openContext({ dataDir: dir, home, env: {}, clock, mode: 'read' }),
        openWrite: () => { throw new CairnError(code, `Simulated ${code}`); },
      });
      const res = await postWith(notes);
      assert.equal(res.status, expected, `Expected ${expected} for ${code}`);
    }

    const missingDir = join(tempDir(t, 'cairn-missing-'), 'absent');
    const uninit = createNotes({
      key,
      port,
      open: () => openContext({ dataDir: missingDir, home, env: {}, clock, mode: 'read' }),
      openWrite: () => openContext({ dataDir: missingDir, home, env: {}, clock, mode: 'write', actor: 'web:owner' }),
    });
    assert.equal((await postWith(uninit)).status, 409);

    const locked = createNotes({
      key,
      port,
      open: () => { throw new CairnError('locked', 'Busy lock'); },
      openWrite: () => { throw new CairnError('locked', 'Busy lock'); },
    });
    const lockedRes = await postWith(locked);
    assert.equal(lockedRes.status, 503);
    assert.equal(lockedRes.headers['retry-after'], '1');
  });

test('GET /notes and /notes/new render form links and submit without scripts in built app', async (t) => {
  const env = await setup(t);
  if (!env.built) {
    t.skip('Astro output missing; run npm run build:app to verify built pages.');
    return;
  }
  const active = project.create(env.openWrite(), { title: 'Alpha', status: 'active' }, '', {}).entity;
  const agent = project.create(env.openWrite(), { title: 'AgentProj', status: 'active' }, '', {}).entity;
  const cfgPath = join(env.dir, '.cairn', 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.agents = { project: agent.id };
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

  const listEmpty = await call(env.app, { path: '/notes', headers: { cookie: env.cookieHeader } });
  assert.equal(listEmpty.status, 200);
  const newLinks = listEmpty.body.match(/href="\/notes\/new"/gu) ?? [];
  assert.equal(newLinks.length >= 2, true);

  const formPage = await call(env.app, { path: '/notes/new', headers: { cookie: env.cookieHeader } });
  assert.equal(formPage.status, 200);
  assert.equal(formPage.headers['referrer-policy'], 'same-origin');
  assert.match(formPage.body, /data-note-panel/u);
  assert.match(formPage.body, /name="csrf"/u);
  assert.match(formPage.body, /Alpha/u);
  assert.doesNotMatch(formPage.body, /AgentProj/u);
  assert.doesNotMatch(formPage.body, /style="/u);

  const created = await env.post({ title: 'Scriptless note', body: 'Hello world', project: active.id });
  assert.equal(created.status, 303);
  const readNote = await call(env.app, {
    path: String(created.headers.location),
    headers: { cookie: env.cookieHeader },
  });
  assert.equal(readNote.status, 200);
  assert.match(readNote.body, /Scriptless note/u);
});

function postPin(env, ref, form, { token = env.csrf, withCookie = true } = {}) {
  return call(env.app, {
    method: 'POST',
    path: `/notes/${ref}/pin`,
    headers: {
      ...(withCookie ? { cookie: env.cookieHeader } : {}),
      origin: `http://${siteHost(key)}:${port}`,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(token === null ? form : { ...form, csrf: token }).toString(),
  });
}

test('POST /notes accepts pinned=on as boolean true and rejects invalid pinned values', async (t) => {
  const env = await setup(t);
  const pinnedRes = await env.post({ title: 'Pinned quick', body: 'Keep me visible', project: '', pinned: 'on' });
  assert.equal(pinnedRes.status, 303);
  const id = String(pinnedRes.headers.location).slice('/notes/'.length);
  const resolved = entity.resolve(env.open(), 'note', id);
  const parsed = parseFile(readFileSync(join(env.dir, resolved.path), 'utf8'));
  assert.strictEqual(parsed.data.pinned, true);

  for (const badPinned of ['', 'off', 'yes', 'true']) {
    const res = await env.post({ title: 'Bad pinned', body: '', project: '', pinned: badPinned });
    assert.equal(res.status, 400);
  }
  assert.equal(entity.list(env.open(), 'note', { all: true }).length, 1);
});

test('POST /notes/<ref>/pin toggles boolean pinned on notes with and without id', async (t) => {
  const env = await setup(t);
  const withId = note.create(env.openWrite(), { title: 'Has id' }, 'Body', {}).entity;

  const pinRes = await postPin(env, withId.id, { pinned: 'on', revision: withId.revision });
  assert.equal(pinRes.status, 303);
  assert.equal(pinRes.headers.location, `/notes/${withId.id}`);
  const afterPin = entity.resolve(env.open(), 'note', withId.id);
  assert.strictEqual(parseFile(readFileSync(join(env.dir, afterPin.path), 'utf8')).data.pinned, true);

  const unpinRes = await postPin(env, withId.id, { pinned: 'off', revision: afterPin.revision });
  assert.equal(unpinRes.status, 303);
  assert.equal(unpinRes.headers.location, `/notes/${withId.id}`);
  const afterUnpin = entity.resolve(env.open(), 'note', withId.id);
  assert.strictEqual(parseFile(readFileSync(join(env.dir, afterUnpin.path), 'utf8')).data.pinned, false);

  const rawPath = join(env.dir, 'notes', 'manual-note.md');
  mkdirSync(dirname(rawPath), { recursive: true });
  writeFileSync(rawPath, '---\ntitle: Manual note without id\n---\nHand-written body\n');
  const writeCtx = env.openWrite();
  refresh(writeCtx);
  const noId = note.list(writeCtx).find((item) => item.path === 'notes/manual-note.md');
  assert.ok(noId);
  assert.equal(noId.id, null);
  assert.match(noId.ref, /^n-[0-9a-f]{16}$/u);

  const pinNoId = await postPin(env, noId.ref, { pinned: 'on', revision: noId.revision });
  assert.equal(pinNoId.status, 303);
  assert.equal(pinNoId.headers.location, `/notes/${noId.ref}`);
  const parsedNoId = parseFile(readFileSync(rawPath, 'utf8'));
  assert.strictEqual(parsedNoId.data.pinned, true);
  assert.equal(Object.hasOwn(parsedNoId.data, 'id'), false);

  const nextNoId = note.resolve(env.open(), noId.ref);
  const unpinNoId = await postPin(env, noId.ref, { pinned: 'off', revision: nextNoId.revision });
  assert.equal(unpinNoId.status, 303);
  assert.strictEqual(parseFile(readFileSync(rawPath, 'utf8')).data.pinned, false);
});

test('POST /notes/<ref>/pin enforces revision 409, fields 400, values 400, CSRF 403, missing 404, rule 422',
  async (t) => {
  const env = await setup(t);
  const item = note.create(env.openWrite(), { title: 'Target note' }, 'Text', {}).entity;
  const staleRev = item.revision;
  note.update(env.openWrite(), item.id, { pinned: true });
  const fresh = note.resolve(env.open(), item.id);

  const conflict = await postPin(env, item.id, { pinned: 'off', revision: staleRev });
  assert.equal(conflict.status, 409);

  const unknownField = await postPin(env, item.id, {
    pinned: 'off', revision: fresh.revision, next: '/board',
  });
  assert.equal(unknownField.status, 400);

  const missingRev = await postPin(env, item.id, { pinned: 'off' });
  assert.equal(missingRev.status, 400);

  for (const bad of [
    { pinned: 'yes', revision: fresh.revision },
    { pinned: '', revision: fresh.revision },
    { pinned: 'off', revision: 'not-hex' },
    { pinned: 'off', revision: '0123456789abcdef0' },
  ]) {
    const res = await postPin(env, item.id, bad);
    assert.equal(res.status, 400);
  }

  const cookie = env.cookieHeader.split('=')[1];
  for (const token of [null, 'bad-token', csrfToken(key, port, cookie, 'card')]) {
    const res = await postPin(env, item.id, { pinned: 'off', revision: fresh.revision }, { token });
    assert.equal(res.status, 403);
  }

  const noCookie = await postPin(env, item.id, { pinned: 'off', revision: fresh.revision }, { withCookie: false });
  assert.equal(noCookie.status, 401);

  for (const missingRef of ['n-000000', 'n-0000000000000000']) {
    const missing = await postPin(env, missingRef, { pinned: 'on', revision: fresh.revision });
    assert.equal(missing.status, 404);
  }

  const ruleEnv = await setup(t, { rules: { links: 'error' } });
  const rulePath = join(ruleEnv.dir, 'notes', 'broken-link.md');
  mkdirSync(dirname(rulePath), { recursive: true });
  writeFileSync(rulePath, '---\ntitle: Broken\n---\nSee [[missing-note]].\n');
  const ruleCtx = ruleEnv.openWrite();
  refresh(ruleCtx);
  const broken = note.list(ruleCtx).find((entry) => entry.path === 'notes/broken-link.md');
  const ruleRes = await postPin(ruleEnv, broken.ref, { pinned: 'on', revision: broken.revision });
  assert.equal(ruleRes.status, 422);
  assert.match(ruleRes.body, /links/u);
});

test('note page renders script-free pin button and survives pinned rail read failure', async (t) => {
  const env = await setup(t);
  if (!env.built) return;
  const item = note.create(env.openWrite(), { title: 'View note' }, 'Body copy', {}).entity;

  const page1 = await call(env.app, { path: `/notes/${item.id}`, headers: { cookie: env.cookieHeader } });
  assert.equal(page1.status, 200);
  assert.equal(page1.headers['referrer-policy'], 'same-origin');
  assert.match(page1.body, new RegExp(`action="/notes/${item.id}/pin"`, 'u'));
  assert.match(page1.body, /name="pinned" value="on"/u);

  const pinned = await postPin(env, item.id, { pinned: 'on', revision: item.revision });
  assert.equal(pinned.status, 303);

  const page2 = await call(env.app, { path: `/notes/${item.id}`, headers: { cookie: env.cookieHeader } });
  assert.equal(page2.status, 200);
  assert.match(page2.body, /name="pinned" value="off"/u);
  assert.match(page2.body, /pinned-rail-item/u);

  const failingCairn = createRead({ open: env.open, render: renderMarkdown });
  failingCairn.pinnedNotes = () => { throw new Error('boom'); };
  const brokenRailApp = createApp({
    root: repo,
    handler: (await import(new URL('../dist/app/server/entry.mjs', import.meta.url))).handler,
    guard: createGuard({ port, key, instance, writable: () => false }),
    locals: { cairn: failingCairn, notes: env.notes },
  });
  const degraded = await call(brokenRailApp, { path: `/notes/${item.id}`, headers: { cookie: env.cookieHeader } });
  assert.equal(degraded.status, 200);
  assert.doesNotMatch(degraded.body, /class="pinned-rail"/u);
});

test('pinnedNotesResult orders newest first, caps at 30, drops agents project, includes all kinds, strips Markdown',
  (t) => {
    const dir = tempDir(t, 'cairn-pinned-read-');
    const home = tempDir(t, 'cairn-pinned-home-');
    seedDataDir(dir, { register: false, language: 'en' });
    const put = (rel, fields, body = 'Body') => {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      const front = Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
      writeFileSync(full, `---\n${front}\n---\n${body}\n`);
    };
    const work = { id: 'p-wrk001' };
    const bots = { id: 'p-bts001' };
    put('projects/work.md', { id: work.id, title: 'Work', status: 'active', tone: 2 }, '');
    put('projects/bots.md', { id: bots.id, title: 'Bots', status: 'active', tone: 1 }, '');
    const cfgPath = join(dir, '.cairn', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.agents = { project: bots.id };
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

    put('notes/agent-pin.md', { id: 'n-agnt01', title: 'Agent pin', kind: 'note', project: bots.id, pinned: true,
      updated: '2026-11-15T10:00:00.000Z' }, 'Secret agent note');
    put('notes/unpinned.md', { id: 'n-npn001', title: 'Unpinned note', kind: 'note', project: work.id, pinned: false,
      updated: '2026-11-15T10:00:00.000Z' }, 'Not pinned');

    let seq = 0;
    const writeAt = (iso, title, extra = {}, body = 'Body') => {
      const id = `n-p${String(++seq).padStart(5, '0')}`;
      const kind = extra.kind ?? 'note';
      const folder = kind === 'concept' ? 'wiki/concepts' : kind === 'tool' ? 'wiki/tools'
        : kind === 'query' ? 'wiki/queries' : kind === 'overview' ? 'wiki' : 'notes';
      const file = kind === 'overview' ? 'wiki/overview.md' : `${folder}/note-${seq}.md`;
      put(file, { id, title, kind, pinned: true, updated: iso, ...extra }, body);
    };

    writeAt('2026-11-01T00:00:00Z', 'Pinned 1');
    writeAt('2026-11-01T00:01:00Z', 'Pinned 2');
    writeAt('2026-11-01T00:02:00Z', 'Concept one', { kind: 'concept', project: work.id });
    writeAt('2026-11-01T00:03:00Z', 'Tool one', { kind: 'tool' });
    writeAt('2026-11-01T00:04:00Z', 'Query one', { kind: 'query' });
    writeAt('2026-11-01T00:05:00Z', 'Overview one', { kind: 'overview' });
    for (let i = 3; i <= 27; i += 1) {
      const mm = String(i + 3).padStart(2, '0');
      writeAt(`2026-11-01T00:${mm}:00Z`, `Pinned ${i}`);
    }
    writeAt(
      '2026-11-01T01:00:00Z',
      'Latest markdown note',
      { project: work.id },
      [
        '# Heading line',
        '',
        '> Quoted **bold** and *italic* with _under_ and ~~old~~ plus `code`',
        '',
        '- [ ] Task [external link](https://example.invalid) and [[wikilink|shown label]] ![pic](a.png)',
        'Extra padding '.repeat(20),
      ].join('\n'),
    );

    const readCtx = openContext({ dataDir: dir, home, env: {}, clock, mode: 'read' });
    const res = pinnedNotesResult(readCtx);
    assert.equal(res.ok, true);
    assert.equal(res.data.items.length, 30);
    assert.equal(res.data.items[0].title, 'Latest markdown note');
    assert.deepEqual(res.data.items[0].project, { id: work.id, title: 'Work', tone: 2 });
    assert.equal(res.data.items.at(-1).title, 'Concept one');
    assert.equal(res.data.items.some((item) => item.title === 'Pinned 1'), false);
    assert.equal(res.data.items.some((item) => item.title === 'Pinned 2'), false);
    assert.equal(res.data.items.some((item) => item.title === 'Agent pin'), false);
    assert.equal(res.data.items.some((item) => item.title === 'Unpinned note'), false);
    assert.equal(res.data.items.some((item) => item.kind === 'concept'), true);
    assert.equal(res.data.items.some((item) => item.kind === 'tool'), true);
    assert.equal(res.data.items.some((item) => item.kind === 'query'), true);
    assert.equal(res.data.items.some((item) => item.kind === 'overview'), true);

    const excerpt = res.data.items[0].excerpt;
    assert.ok(excerpt.length <= 160);
    assert.doesNotMatch(excerpt, /[#*`~\[\]>!]/u);
    assert.match(excerpt, /Heading line/u);
    assert.match(excerpt, /shown label/u);
    assert.match(excerpt, /external link/u);
  });

test('pinnedNotesResult handles 256 KiB blank and space-newline bodies under 250 ms each', (t) => {
  for (const [label, body] of [
    ['newlines', '\n'.repeat(256 * 1024)],
    ['space-newlines', ' \n'.repeat(128 * 1024)],
  ]) {
    const dir = tempDir(t, `cairn-pinned-perf-${label}-`);
    const home = tempDir(t, `cairn-pinned-perf-home-${label}-`);
    seedDataDir(dir, { register: false, language: 'en' });
    const seedCtx = openContext({ dataDir: dir, home, env: {}, clock, mode: 'write', actor: 'cli:test' });
    note.create(seedCtx, { title: `Blank ${label}`, pinned: true }, body, {});
    const readCtx = openContext({ dataDir: dir, home, env: {}, clock, mode: 'read' });
    const start = performance.now();
    const res = pinnedNotesResult(readCtx);
    const elapsed = performance.now() - start;
    assert.equal(res.data.items.length, 1);
    assert.equal(res.data.items[0].excerpt, '');
    assert.ok(elapsed < 250, `${label} took ${elapsed.toFixed(1)} ms`);
  }
});

test('plainItem keeps pre-rail journal day preview behavior', () => {
  assert.equal(
    plainItem('**Decision:** # keep ~~strike~~ and _under_ with [[page|shown]] plus [link](https://a.test)'),
    'Decision: # keep ~~strike~~ and _under_ with shown plus link',
  );
  assert.equal(plainItem('x'.repeat(250)).length, 200);
});

test('pinnedNotesResult formats heading, paragraph and Markdown table without separator rows or outer pipes',
  (t) => {
    const dir = tempDir(t, 'cairn-pinned-table-');
    const home = tempDir(t, 'cairn-pinned-table-home-');
    seedDataDir(dir, { register: false, language: 'en' });
    mkdirSync(join(dir, 'notes'), { recursive: true });
    writeFileSync(join(dir, 'notes', 'table-note.md'), [
      '---',
      'id: n-tb1001',
      'title: Table note',
      'kind: note',
      'pinned: true',
      '---',
      '# Section Title',
      '',
      'Short intro paragraph.',
      '',
      '| Alan | Örnek |',
      '| :--- | ---: |',
      '| Bir | İki |',
      '',
    ].join('\n'));
    const readCtx = openContext({ dataDir: dir, home, env: {}, clock, mode: 'read' });
    const res = pinnedNotesResult(readCtx);
    assert.equal(res.data.items[0].excerpt, 'Section Title Short intro paragraph. Alan · Örnek Bir · İki');
  });

test('PinnedRail falls back to notes.kind.note label for unknown note kinds', async (t) => {
  const env = await setup(t);
  if (!env.built) {
    t.skip('Astro output missing; run npm run build:app to verify built pages.');
    return;
  }
  const rawPath = join(env.dir, 'notes', 'unknown-kind.md');
  mkdirSync(dirname(rawPath), { recursive: true });
  writeFileSync(rawPath, '---\nid: n-u00001\ntitle: Unknown kind pin\nkind: custom-kind\npinned: true\n---\nBody\n');
  refresh(env.openWrite());
  const page = await call(env.app, { path: '/', headers: { cookie: env.cookieHeader } });
  assert.equal(page.status, 200);
  assert.match(page.body, /<span class="pinned-rail-kind">Note<\/span>/u);
  assert.doesNotMatch(page.body, /notes\.kind\.custom-kind/u);
  assert.match(page.body, /data-pinned-unpin/u);
});

test('POST /notes/<ref>/pin refuses notes belonging to the agents project with 400', async (t) => {
  const env = await setup(t);
  const agent = project.create(env.openWrite(), { title: 'Bots', status: 'active' }, '', {}).entity;
  const cfgPath = join(env.dir, '.cairn', 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.agents = { project: agent.id };
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

  const byId = note.create(env.openWrite(), { title: 'Agent id note', project: agent.id }, 'Body', {}).entity;
  const byPath = note.create(
    env.openWrite(),
    { title: 'Agent path note', project: `@${agent.path}`, pinned: true },
    'Body',
    {},
  ).entity;

  const pinRes = await postPin(env, byId.id, { pinned: 'on', revision: byId.revision });
  assert.equal(pinRes.status, 400);
  assert.strictEqual(entity.resolve(env.open(), 'note', byId.id).data.pinned, false);

  const unpinRes = await postPin(env, byPath.id, { pinned: 'off', revision: byPath.revision });
  assert.equal(unpinRes.status, 400);
  assert.strictEqual(entity.resolve(env.open(), 'note', byPath.id).data.pinned, true);
});

test('pinnedExcerpt avoids quadratic backtracking on repeated bracket prefixes', () => {
  for (const [label, body] of [
    ['open-brackets', '['.repeat(4096)],
    ['bang-double-brackets', '![['.repeat(1400)],
    ['bang-brackets', '!['.repeat(2048)],
  ]) {
    const start = performance.now();
    const out = pinnedExcerpt(body);
    const elapsed = performance.now() - start;
    assert.ok(out.length <= 160);
    assert.ok(elapsed < 50, `${label} took ${elapsed.toFixed(1)} ms`);
  }
});

function postEdit(env, ref, form, { token = env.csrf } = {}) {
  return call(env.app, {
    method: 'POST',
    path: `/notes/${ref}`,
    headers: {
      cookie: env.cookieHeader,
      origin: `http://${siteHost(key)}:${port}`,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(token === null ? form : { ...form, csrf: token }).toString(),
  });
}

const getPage = (env, path) => call(env.app, { path, headers: { cookie: env.cookieHeader } });

test('POST /notes/<ref> edits title, body and project, keeps the id and links Edit from the note page',
  async (t) => {
  const env = await setup(t);
  const work = project.create(env.openWrite(), { title: 'Work', status: 'active' }, '', {}).entity;
  const item = note.create(env.openWrite(), { title: 'Draft' }, 'Old text', {}).entity;
  if (env.built) {
    const page = await getPage(env, `/notes/${item.id}`);
    assert.match(page.body, new RegExp(`href="/notes/${item.id}/edit"`, 'u'));
    const form = await getPage(env, `/notes/${item.id}/edit`);
    assert.equal(form.status, 200);
    assert.equal(form.headers['referrer-policy'], 'same-origin');
    assert.match(form.body, new RegExp(`action="/notes/${item.id}"`, 'u'));
    assert.match(form.body, new RegExp(`name="revision" value="${item.revision}"`, 'u'));
    assert.match(form.body, /value="Draft"/u);
    assert.match(form.body, /Old text<\/textarea>/u);
    assert.doesNotMatch(form.body, /<script(?![^>]*\bsrc=)/u);
  }
  const res = await postEdit(env, item.id, { title: 'Final', body: 'New\r\ntext', project: work.id,
    revision: item.revision });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, `/notes/${item.id}`);
  const after = note.resolve(env.open(), item.id);
  assert.equal(after.id, item.id);
  assert.equal(after.path, item.path);
  assert.equal(after.title, 'Final');
  assert.equal(after.body.trim(), 'New\ntext');
  assert.equal(after.data.project, work.id);
  assert.equal(readEvents(env.open()).at(-1).actor, 'web:owner');
});

test('POST /notes/<ref> rejects unknown or missing fields, bad values and missing CSRF without writing',
  async (t) => {
  const env = await setup(t);
  const item = note.create(env.openWrite(), { title: 'Keep' }, 'Body', {}).entity;
  const before = readFileSync(join(env.dir, item.path), 'utf8');
  const good = { title: 'Changed', body: 'Changed', project: '', revision: item.revision };
  for (const form of [{ ...good, pinned: 'on' }, { ...good, kind: 'concept' }, { title: 'x', body: '', revision:
    item.revision }, { ...good, title: '' }, { ...good, title: 'a\tb' }, { ...good, revision: 'nothex' },
  { ...good, project: 'p-zzzzzz' }]) {
    const res = await postEdit(env, item.id, form);
    assert.equal(res.status, 400, JSON.stringify(form));
  }
  const tooLarge = await postEdit(env, item.id, { ...good, body: 'a'.repeat(256 * 1024 + 1) });
  assert.equal(tooLarge.status, 400);
  const cookie = env.cookieHeader.split('=')[1];
  for (const token of [null, 'bad-token', csrfToken(key, port, cookie, 'card')]) {
    assert.equal((await postEdit(env, item.id, good, { token })).status, 403);
  }
  assert.equal((await postEdit(env, 'n-000000', good)).status, 404);
  assert.equal(readFileSync(join(env.dir, item.path), 'utf8'), before);
});

test('POST /notes/<ref> with a stale revision answers 409 and brings the form back with the text kept',
  async (t) => {
  const env = await setup(t);
  // The form comes back from the built app; without it the re-render answers the stub's 404.
  if (!env.built) { t.skip('needs npm run build:app'); return; }
  const item = note.create(env.openWrite(), { title: 'Shared' }, 'First', {}).entity;
  note.update(env.openWrite(), item.id, { pinned: true });
  const before = readFileSync(join(env.dir, item.path), 'utf8');
  const fresh = note.resolve(env.open(), item.id);
  const res = await postEdit(env, item.id, { title: 'My title', body: 'My <long> text', project: '',
    revision: item.revision });
  assert.equal(res.status, 409);
  assert.equal(readFileSync(join(env.dir, item.path), 'utf8'), before);
  assert.match(res.body, /The note changed elsewhere/u);
  assert.match(res.body, /value="My title"/u);
  assert.match(res.body, /My &lt;long&gt; text<\/textarea>/u);
  assert.match(res.body, new RegExp(`name="revision" value="${fresh.revision}"`, 'u'));
  assert.match(res.body, new RegExp(`action="/notes/${item.id}"`, 'u'));
});

test('POST /notes/<ref> answers 422 naming an error rule with the text kept; a warn rule saves and is shown once',
  async (t) => {
  const env = await setup(t, { rules: { links: 'error' } });
  // The form comes back from the built app; without it the re-render answers the stub's 404.
  if (!env.built) { t.skip('needs npm run build:app'); return; }
  const item = note.create(env.openWrite(), { title: 'Linked' }, 'Fine', {}).entity;
  const before = readFileSync(join(env.dir, item.path), 'utf8');
  const res = await postEdit(env, item.id, { title: 'Linked', body: 'See [[ghost-page]].', project: '',
    revision: item.revision });
  assert.equal(res.status, 422);
  assert.equal(readFileSync(join(env.dir, item.path), 'utf8'), before);
  assert.match(res.body, /The links rule blocked this note/u);
  assert.match(res.body, /See \[\[ghost-page\]\]\.<\/textarea>/u);
  assert.match(res.body, new RegExp(`name="revision" value="${item.revision}"`, 'u'));

  const warnEnv = await setup(t, { rules: { links: 'warn' } });
  const warned = note.create(warnEnv.openWrite(), { title: 'Warned' }, 'Fine', {}).entity;
  const saved = await postEdit(warnEnv, warned.id, { title: 'Warned', body: 'See [[ghost-page]].', project: '',
    revision: warned.revision });
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.location, `/notes/${warned.id}?warning=links`);
  assert.equal(note.resolve(warnEnv.open(), warned.id).body.trim(), 'See [[ghost-page]].');
  const page = await getPage(warnEnv, saved.headers.location);
  assert.equal(page.status, 200);
  assert.equal(page.body.match(/The links rule warns/gu)?.length, 1);
  const unknown = await getPage(warnEnv, `/notes/${warned.id}?warning=%3Cb%3E`);
  assert.doesNotMatch(unknown.body, /rule warns/u);
});

test('edit answers 404 for agent-project notes, the overview page and notes with a broken id', async (t) => {
  const env = await setup(t);
  const agent = project.create(env.openWrite(), { title: 'Bots', status: 'active' }, '', {}).entity;
  const cfgPath = join(env.dir, '.cairn', 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.agents = { project: agent.id };
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  const agentNote = note.create(env.openWrite(), { title: 'Agent note', project: `@${agent.path}` }, 'Body', {})
    .entity;
  const overview = note.create(env.openWrite(), { kind: 'overview', title: 'Overview' }, 'Map', {}).entity;
  const brokenPath = join(env.dir, 'notes', 'broken-id.md');
  mkdirSync(dirname(brokenPath), { recursive: true });
  writeFileSync(brokenPath, '---\nid: banana\ntitle: Broken id\n---\nBody\n');
  const ctx = env.openWrite();
  refresh(ctx);
  const broken = note.list(ctx).find((entry) => entry.path === 'notes/broken-id.md');

  const form = (item) => ({ title: 'Changed', body: 'Changed', project: '', revision: item.revision });
  for (const item of [agentNote, overview, broken]) {
    assert.equal((await postEdit(env, item.id ?? item.ref, form(item))).status, 404, item.path);
  }
  for (const item of [agentNote, overview, broken]) {
    assert.equal(readFileSync(join(env.dir, item.path), 'utf8').includes('Changed'), false, item.path);
  }
  if (env.built) {
    for (const item of [agentNote, overview, broken]) {
      const ref = item.id ?? item.ref;
      assert.equal((await getPage(env, `/notes/${ref}/edit`)).status, 404, item.path);
      const page = await getPage(env, `/notes/${ref}`);
      assert.doesNotMatch(page.body, /\/edit"/u, item.path);
    }
  }
});

test('edit addresses a note without an id by its note key and never gives it an id', async (t) => {
  const env = await setup(t);
  const rawPath = join(env.dir, 'notes', 'hand-written.md');
  mkdirSync(dirname(rawPath), { recursive: true });
  writeFileSync(rawPath, '---\ntitle: Hand written\n---\nOld body\n');
  const ctx = env.openWrite();
  refresh(ctx);
  const item = note.list(ctx).find((entry) => entry.path === 'notes/hand-written.md');
  assert.equal(item.id, null);
  if (env.built) {
    assert.match((await getPage(env, `/notes/${item.ref}`)).body, new RegExp(`href="/notes/${item.ref}/edit"`, 'u'));
    const form = await getPage(env, `/notes/${item.ref}/edit`);
    assert.equal(form.status, 200);
    assert.match(form.body, new RegExp(`action="/notes/${item.ref}"`, 'u'));
  }
  const res = await postEdit(env, item.ref, { title: 'Hand written', body: 'New body', project: '',
    revision: item.revision });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, `/notes/${item.ref}`);
  const parsed = parseFile(readFileSync(rawPath, 'utf8'));
  assert.equal(Object.hasOwn(parsed.data, 'id'), false);
  assert.equal(parsed.body.trim(), 'New body');
});

test('an unchanged edit leaves a lone carriage return alone; a changed project must be active', async (t) => {
  const env = await setup(t);
  const hold = project.create(env.openWrite(), { title: 'Hold', status: 'paused' }, '', {}).entity;
  const item = note.create(env.openWrite(), { title: 'Mixed' }, 'one\rtwo', {}).entity;
  const before = readFileSync(join(env.dir, item.path), 'utf8');
  // A browser submits the lone CR as CRLF.
  const same = await postEdit(env, item.id, { title: 'Mixed', body: 'one\r\ntwo', project: '',
    revision: item.revision });
  assert.equal(same.status, 303);
  assert.equal(readFileSync(join(env.dir, item.path), 'utf8'), before);
  const moved = await postEdit(env, item.id, { title: 'Mixed', body: 'one\r\ntwo', project: hold.id,
    revision: item.revision });
  assert.equal(moved.status, 400);
  assert.equal(readFileSync(join(env.dir, item.path), 'utf8'), before);
});

function postDelete(env, ref, form, { token = env.csrf } = {}) {
  return call(env.app, {
    method: 'POST',
    path: `/notes/${ref}/delete`,
    headers: {
      cookie: env.cookieHeader,
      origin: `http://${siteHost(key)}:${port}`,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(token === null ? form : { ...form, csrf: token }).toString(),
  });
}

test('POST /notes/<ref>/delete moves the note to the trash and goes back to the notes list', async (t) => {
  const env = await setup(t);
  const item = note.create(env.openWrite(), { title: 'Old idea' }, 'Body', {}).entity;
  if (env.built) {
    const page = await getPage(env, `/notes/${item.id}`);
    assert.match(page.body, new RegExp(`action="/notes/${item.id}/delete"`, 'u'));
    assert.match(page.body, /data-note-view-panel/u);
    const list = await getPage(env, '/notes');
    assert.match(list.body, new RegExp(`action="/notes/${item.id}/delete"`, 'u'));
    assert.match(list.body, new RegExp(`action="/notes/${item.id}/pin"`, 'u'));
    assert.match(list.body, /data-notes-search/u);
    assert.equal(list.headers['referrer-policy'], 'same-origin');
  }
  const res = await postDelete(env, item.id, { revision: item.revision });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/notes?deleted=1');
  assert.equal(existsSync(join(env.dir, item.path)), false);
  assert.equal(readdirSync(join(env.dir, '.cairn', 'trash')).some((name) => name.endsWith('old-idea.md')), true);
  assert.equal(readEvents(env.open()).at(-1).actor, 'web:owner');
});

test('POST /notes/<ref>/delete refuses a stale revision, extra fields, missing CSRF and refused notes', async (t) => {
  const env = await setup(t);
  const item = note.create(env.openWrite(), { title: 'Keep me' }, 'Body', {}).entity;
  const overview = note.create(env.openWrite(), { kind: 'overview', title: 'Overview' }, 'Map', {}).entity;
  assert.equal((await postDelete(env, item.id, { revision: '0000000000000000' })).status, 409);
  assert.equal((await postDelete(env, item.id, { revision: item.revision, title: 'x' })).status, 400);
  assert.equal((await postDelete(env, item.id, { revision: 'nope' })).status, 400);
  assert.equal((await postDelete(env, item.id, { revision: item.revision }, { token: null })).status, 403);
  assert.equal((await postDelete(env, 'n-zzzzzz', { revision: item.revision })).status, 404);
  assert.equal((await postDelete(env, overview.id, { revision: overview.revision })).status, 404);
  assert.equal(existsSync(join(env.dir, item.path)), true);
  assert.equal(existsSync(join(env.dir, overview.path)), true);
});

