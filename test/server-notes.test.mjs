import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.mjs';
import { createGuard } from '../server/guard.mjs';
import { createNotes } from '../server/notes.mjs';
import { createWrites } from '../server/writes.mjs';
import { createRead } from '../server/read.mjs';
import { cookieName, csrfToken, mintCookie, siteHost } from '../server/session.mjs';
import { openContext } from '../core/context.mjs';
import { initDataDir } from '../core/roots.mjs';
import { readEvents } from '../core/events.mjs';
import { renderMarkdown } from '../core/render.mjs';
import { CairnError } from '../core/errors.mjs';
import * as entity from '../core/entity.mjs';
import * as project from '../core/project.mjs';
import { useLanguage } from '../src/i18n/index.mjs';
import { fixedClock, tempDir } from './support/env.mjs';

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
  initDataDir(dir, { language });
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
    initDataDir(dir, { language: 'en' });
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
