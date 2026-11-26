import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { createApp } from '../server/app.mjs';
import { createGuard } from '../server/guard.mjs';
import { createJournal } from '../server/journal.mjs';
import { createProjects } from '../server/projects.mjs';
import { createWrites } from '../server/writes.mjs';
import { cookieName, csrfToken, mintCookie, siteHost } from '../server/session.mjs';
import { openContext } from '../core/context.mjs';
import * as journal from '../core/journal.mjs';
import * as project from '../core/project.mjs';
import { fixedClock, seedDataDir, tempDir } from './support/env.mjs';

const port = 4334, key = Buffer.alloc(32, 9), instance = 'run-ffffffffffffffff';
const site = `${siteHost(key)}:${port}`;

async function call(app, { method = 'GET', path, headers = {}, body }) {
  const req = new IncomingMessage(new Socket());
  const data = body === undefined ? undefined : Buffer.from(body);
  Object.assign(req, { url: path, method,
    headers: { host: site, ...headers, ...(data ? { 'content-length': String(data.length) } : {}) } });
  if (data) req.push(data);
  req.push(null);
  const res = new ServerResponse(req);
  res.useChunkedEncodingByDefault = false;
  res.assignSocket(new Writable({ write(chunk, encoding, done) { done(); } }));
  const finished = new Promise((resolve) => res.once('finish', resolve));
  await app(req, res);
  await finished;
  return { status: res.statusCode, headers: res.getHeaders() };
}

function fixture(t) {
  const dataDir = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-08T12:00:00Z');
  seedDataDir(dataDir, { home, env: {}, clock });
  const options = { dataDir, home, env: {}, clock };
  const open = () => openContext({ mode: 'read', ...options });
  const openWrite = () => openContext({ mode: 'write', ...options, actor: 'web:owner' });
  const journals = createJournal({ key, port, open, openWrite });
  const writes = createWrites({ key, port, routes: journals.routes });
  const app = createApp({ root: process.cwd(), guard: createGuard({ key, port, instance, writable: writes.writable }),
    writes: writes.handle, handler: (req, res, next) => next(), locals: { journal: journals } });
  const post = (path, fields = {}, { cookie = mintCookie(key, port), token, withCookie = true } = {}) => call(app, {
    method: 'POST', path,
    body: new URLSearchParams({ csrf: token ?? csrfToken(key, port, cookie, 'journal'), ...fields }).toString(),
    headers: { origin: `http://${site}`, 'sec-fetch-site': 'same-origin',
      'content-type': 'application/x-www-form-urlencoded',
      ...(withCookie ? { cookie: `${cookieName(port)}=${cookie}` } : {}) } });
  const add = (fields = {}, date = '2026-11-08') => post(`/journal/${date}`,
    { title: 'Sample job', items: 'First item\r\nSecond item', ...fields });
  return { open, openWrite, journals, post, add };
}

test('add appends a job with its items and records web:owner', async (t) => {
  const f = fixture(t);
  const response = await f.add();
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, '/journal/2026-11-08');
  const sections = journal.sections(journal.show(f.open(), '2026-11-08').body);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].title, 'Sample job');
  assert.match(journal.show(f.open(), '2026-11-08').body, /- First item\n- Second item/u);
});

test('a job linked to a project carries the project; a label is kept', async (t) => {
  const f = fixture(t);
  const changed = project.create(f.openWrite(), { title: 'Garden plan', status: 'active', tone: 1 }, '', {});
  const id = changed.entity.id;
  assert.equal((await f.add({ project: id, label: 'review' })).status, 303);
  const [job] = journal.sections(journal.show(f.open(), '2026-11-08').body);
  assert.equal(job.project, id);
  assert.equal(job.label, 'review');
  assert.equal((await f.add({ project: 'p-aaaaaa' })).status, 400);
});

test('an empty title, bad date, extra field and hidden characters are refused', async (t) => {
  const f = fixture(t);
  for (const fields of [{ title: '   ' }, { title: 'a\nb' }, { title: 'x'.repeat(201) }, { extra: '1' },
    { label: 'a\nb' }, { items: 'a​b' }]) {
    assert.equal((await f.add(fields)).status, 400, JSON.stringify(fields));
  }
  for (const date of ['2026-02-31', '2026-13-01', '0000-00-00']) {
    assert.equal((await f.add({}, date)).status, 400, date);
  }
  assert.equal((await f.post('/journal/2026-1-1', { title: 'x' })).status, 405);
  assert.equal(journal.list(f.open()).length, 0);
});

test('a write without the session cookie or a valid token is refused', async (t) => {
  const f = fixture(t);
  assert.notEqual((await f.post('/journal/2026-11-08', { title: 'x' }, { withCookie: false })).status, 303);
  assert.equal((await f.post('/journal/2026-11-08', { title: 'x' }, { token: 'bad' })).status, 403);
  assert.equal(journal.list(f.open()).length, 0);
});

test('view gives today and the active projects', async (t) => {
  const f = fixture(t);
  project.create(f.openWrite(), { title: 'Garden plan', status: 'active', tone: 1 }, '', {});
  project.create(f.openWrite(), { title: 'Old plan', status: 'archived', tone: 2 }, '', {});
  const view = f.journals.view(`${cookieName(port)}=${mintCookie(key, port)}`);
  assert.equal(view.state, 'ready');
  assert.equal(view.today, '2026-11-08');
  assert.deepEqual(view.projects.map(({ title }) => title), ['Garden plan']);
  assert.ok(view.csrf);
});
