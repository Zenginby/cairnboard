import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { createApp } from '../server/app.mjs';
import { createGuard } from '../server/guard.mjs';
import { createProjects } from '../server/projects.mjs';
import { createCards } from '../server/cards.mjs';
import { createWrites } from '../server/writes.mjs';
import { cookieName, csrfToken, mintCookie, siteHost } from '../server/session.mjs';
import { openContext } from '../core/context.mjs';
import { readEvents } from '../core/events.mjs';
import * as project from '../core/project.mjs';
import { fixedClock, seedDataDir, tempDir } from './support/env.mjs';

const port = 4333, key = Buffer.alloc(32, 8), instance = 'run-dddddddddddddddd';
const site = `${siteHost(key)}:${port}`;

async function call(app, { method = 'GET', path, headers = {}, body }) {
  const req = new IncomingMessage(new Socket());
  const data = body === undefined ? undefined : Buffer.from(body);
  Object.assign(req, { url: path, method,
    headers: { host: site, ...headers, ...(data ? { 'content-length': String(data.length) } : {}) } });
  if (data) req.push(data);
  req.push(null);
  let output = '';
  const res = new ServerResponse(req);
  res.useChunkedEncodingByDefault = false;
  res.assignSocket(new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } }));
  const finished = new Promise((resolve) => res.once('finish', resolve));
  await app(req, res);
  await finished;
  return { status: res.statusCode, headers: res.getHeaders(), body: output.slice(output.indexOf('\r\n\r\n') + 4) };
}

function fixture(t) {
  const dataDir = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-08T12:00:00Z');
  seedDataDir(dataDir, { home, env: {}, clock });
  const options = { dataDir, home, env: {}, clock };
  const open = () => openContext({ mode: 'read', ...options });
  const openWrite = () => openContext({ mode: 'write', ...options, actor: 'web:owner' });
  const projects = createProjects({ key, port, open, openWrite });
  const cards = createCards({ key, port, open, openWrite });
  const writes = createWrites({ key, port, routes: [...cards.routes, ...projects.routes] });
  const app = createApp({ root: process.cwd(), guard: createGuard({ key, port, instance, writable: writes.writable }),
    writes: writes.handle, handler: (req, res, next) => next(), locals: { projects, cards } });
  const post = (path, fields = {}, { cookie = mintCookie(key, port), token, withCookie = true } = {}) => call(app, {
    method: 'POST', path,
    body: new URLSearchParams({ csrf: token ?? csrfToken(key, port, cookie, 'project'), ...fields }).toString(),
    headers: { origin: `http://${site}`, 'sec-fetch-site': 'same-origin',
      'content-type': 'application/x-www-form-urlencoded',
      ...(withCookie ? { cookie: `${cookieName(port)}=${cookie}` } : {}) } });
  const add = (fields = {}) => post('/projects', { title: 'Garden plan', body: 'About the garden.', status: 'active',
    tone: '3', ...fields });
  const edit = (id, fields = {}) => {
    const current = project.resolve(open(), id);
    return post(`/projects/${id}`, { title: current.title, body: current.body, status: current.data.status,
      tone: String(current.data.tone), revision: current.revision, ...fields });
  };
  return { open, openWrite, projects, post, add, edit };
}

test('add stores title, description, tone and status and records web:owner', async (t) => {
  const f = fixture(t);
  const response = await f.add({ title: '  Garden plan  ', body: 'Line one\r\nLine two' });
  assert.equal(response.status, 303);
  const [item] = project.list(f.open());
  assert.equal(response.headers.location, `/projects/${item.id}`);
  assert.equal(item.title, 'Garden plan');
  assert.equal(item.data.tone, 3);
  assert.equal(item.data.status, 'active');
  assert.match(project.resolve(f.open(), item.id).body, /Line one\nLine two/u);
  const event = readEvents(f.open()).at(-1);
  assert.equal(event.op, 'project.create');
  assert.equal(event.actor, 'web:owner');
});

test('edit changes fields, archives and restores', async (t) => {
  const f = fixture(t);
  await f.add();
  const id = project.list(f.open())[0].id;
  assert.equal((await f.edit(id, { title: 'Garden plan 2', body: 'New text', tone: '5' })).status, 303);
  let item = project.resolve(f.open(), id);
  assert.equal(item.title, 'Garden plan 2');
  assert.equal(item.data.tone, 5);
  assert.equal(item.body.trim(), 'New text');
  assert.equal((await f.edit(id, { status: 'archived' })).status, 303);
  assert.equal(project.resolve(f.open(), id).data.status, 'archived');
  assert.equal((await f.edit(id, { status: 'active' })).status, 303);
  assert.equal(project.resolve(f.open(), id).data.status, 'active');
  assert.equal(readEvents(f.open()).at(-1).op, 'project.update');
});

test('an unchanged edit writes nothing', async (t) => {
  const f = fixture(t);
  await f.add();
  const id = project.list(f.open())[0].id;
  const before = readEvents(f.open()).length;
  assert.equal((await f.edit(id)).status, 303);
  assert.equal(readEvents(f.open()).length, before);
});

test('an empty name, bad tone, bad status and extra fields are refused', async (t) => {
  const f = fixture(t);
  for (const fields of [{ title: '   ' }, { title: 'a\nb' }, { title: 'x'.repeat(201) }, { tone: '9' }, { tone: '0' },
    { tone: 'red' }, { status: 'gone' }, { extra: '1' }]) {
    assert.equal((await f.add(fields)).status, 400, JSON.stringify(fields));
  }
  assert.deepEqual(project.list(f.open()), []);
  await f.add();
  const id = project.list(f.open())[0].id;
  assert.equal((await f.edit(id, { title: '' })).status, 400);
  assert.equal((await f.edit(id, { tone: '12' })).status, 400);
  assert.equal((await f.edit(id, { revision: 'nope' })).status, 400);
});

test('an old revision answers a conflict and keeps the newer text', async (t) => {
  const f = fixture(t);
  await f.add();
  const id = project.list(f.open())[0].id;
  const stale = project.resolve(f.open(), id).revision;
  assert.equal((await f.edit(id, { body: 'First change' })).status, 303);
  const response = await f.edit(id, { body: 'Second change', revision: stale });
  assert.equal(response.status, 409);
  assert.equal(project.resolve(f.open(), id).body.trim(), 'First change');
});

const minimal = { title: 'x', body: '', status: 'active' };

test('writes need the session key: no cookie, wrong token or another form token are refused', async (t) => {
  const f = fixture(t);
  const cookie = mintCookie(key, port);
  assert.equal((await f.post('/projects', minimal,
    { cookie, token: 'wrong' })).status, 403);
  assert.equal((await f.post('/projects', minimal,
    { cookie, token: csrfToken(key, port, cookie, 'card') })).status, 403);
  const bare = await f.post('/projects', minimal, { withCookie: false });
  assert.notEqual(bare.status, 303);
  assert.equal(project.list(f.open()).filter((item) => item.title === 'x').length, 0);
});

test('an unknown project id is not a route', async (t) => {
  const f = fixture(t);
  const response = await f.post('/projects/p-zzzzzz', { ...minimal, revision: '0'.repeat(16) });
  assert.equal(response.status, 404);
});

test('the form view carries a token, tone and status; unknown ids are not found', async (t) => {
  const f = fixture(t);
  const cookie = `${cookieName(port)}=${mintCookie(key, port)}`;
  const fresh = f.projects.view(cookie);
  assert.equal(fresh.state, 'ready');
  assert.ok(fresh.csrf);
  assert.equal(fresh.tone, 1);
  await f.add();
  const id = project.list(f.open())[0].id;
  const shown = f.projects.view(cookie, id);
  assert.equal(shown.tone, 3);
  assert.equal(shown.status, 'active');
  assert.equal(f.projects.view(cookie, 'p-zzzzzz').state, 'notFound');
  assert.equal(f.projects.view(cookie, '../x').state, 'notFound');
});
