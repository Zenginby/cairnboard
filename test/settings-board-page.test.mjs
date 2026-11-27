import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { openContext } from '../core/context.mjs';
import { initDataDir } from '../core/roots.mjs';
import { revision } from '../core/store.mjs';
import { createApp } from '../server/app.mjs';
import { createGuard } from '../server/guard.mjs';
import { cookieName, csrfToken, mintCookie, siteHost, verifyCsrf } from '../server/session.mjs';
import { createSettings } from '../server/settings.mjs';
import { createWrites } from '../server/writes.mjs';
import { fixedClock, tempDir } from './support/env.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const port = 4332, key = Buffer.alloc(32, 7), instance = 'run-cccccccccccccccc';
const skip = !existsSync(join(repo, 'dist/app/server/entry.mjs'))
  && 'Astro output missing; run npm run build:app to enable integration coverage.';
const column = (name, action) => `/settings/board/columns/${name}/${action}`;
const lease = '/settings/board/lease';

async function fixture(t) {
  const { handler } = await import('../dist/app/server/entry.mjs');
  t.mock.property(process, 'env', { ...process.env, CAIRN_LANGUAGE: 'en' });
  const dataDir = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-08T12:00:00Z');
  const options = { dataDir, home, env: {}, clock };
  initDataDir(dataDir, options);
  const open = () => openContext({ mode: 'read', ...options });
  const openWrite = () => openContext({ mode: 'write', actor: 'web:owner', ...options });
  const settings = createSettings({ key, port, open, openWrite });
  const { writable } = createWrites({ key, port, routes: settings.routes });
  const app = createApp({ root: repo, handler, guard: createGuard({ port, key, instance, writable }),
    writes: settings.handle, locals: { settings } });
  const configFile = join(dataDir, '.cairn/config.json');
  const session = mintCookie(key, port);
  // Exercise the real built page and settings view without binding a socket or opening a browser.
  const page = async (path = '/settings', fields) => {
    const req = new IncomingMessage(new Socket());
    const host = `${siteHost(key)}:${port}`;
    const headers = { host, cookie: `${cookieName(port)}=${session}` };
    const data = fields && Buffer.from(new URLSearchParams({ csrf: csrfToken(key, port, session),
      revision: revision(readFileSync(configFile)), ...fields }).toString());
    if (data) {
      Object.assign(headers, { origin: `http://${host}`, 'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded', 'content-length': String(data.length) });
      req.push(data);
    }
    Object.assign(req, { url: path, method: data ? 'POST' : 'GET', headers });
    req.push(null);
    let output = '';
    const socket = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } });
    const res = new ServerResponse(req);
    res.useChunkedEncodingByDefault = false;
    res.assignSocket(socket);
    const finished = new Promise((resolve) => res.once('finish', resolve));
    await app(req, res);
    await finished;
    return { status: res.statusCode, body: output.slice(output.indexOf('\r\n\r\n') + 4) };
  };
  return { dataDir, configFile, session, open, page };
}

function boardMarkup(body) {
  const panel = body.match(/<div class="settings" data-settings-panel>[^]*?<p class="settings-last">/u)?.[0];
  assert.ok(panel, 'the shared settings panel renders');
  const board = panel.match(/<section id="settings-board"[^]*?<\/section>/u)?.[0];
  assert.ok(board, 'the board is inside the shared panel');
  return board;
}

test('Board renders the default columns with one native POST form per allowed action', { skip }, async (t) => {
  const f = await fixture(t);
  const { status, body } = await f.page();
  assert.equal(status, 200);
  assert.equal([...body.matchAll(/id="settings-board"/gu)].length, 1);
  assert.ok(body.indexOf('id="settings-features"') < body.indexOf('id="settings-board"'));
  assert.ok(body.indexOf('id="settings-board"') < body.indexOf('id="settings-shadow"'));
  const board = boardMarkup(body);
  const forms = [...board.matchAll(/<form method="post" action="([^"]+)"[^>]*>([^]*?)<\/form>/gu)];
  const expected = [
    column('backlog', 'label'), column('backlog', 'down'),
    column('doing', 'label'), column('doing', 'up'), column('doing', 'down'),
    column('review', 'label'), column('review', 'hidden'), column('review', 'up'), column('review', 'down'),
    column('done', 'label'), column('done', 'up'), lease,
  ];
  assert.deepEqual(forms.map((form) => form[1]), expected);
  const current = revision(readFileSync(f.configFile));
  for (const [, action, form] of forms) {
    const token = form.match(/type="hidden" name="csrf" value="([^"]+)"/u)?.[1];
    assert.ok(verifyCsrf(key, port, f.session, token), action);
    assert.ok(form.includes(`type="hidden" name="revision" value="${current}"`), action);
    const extra = { label: ['label'], hidden: ['value'], lease: ['minutes'] }[action.split('/').at(-1)] ?? [];
    assert.deepEqual([...form.matchAll(/\bname="([^"]+)"/gu)].map((match) => match[1]),
      ['csrf', 'revision', ...extra], action);
  }
  assert.match(board, /<input type="text" name="label" value="Backlog" required/u);
  assert.match(board, /<input type="number" name="minutes" value="120" step="1" required aria-label="Claim lease"/u);
  assert.doesNotMatch(board, /\s(?:maxlength|min|max)=|id="settings-lease-title"/u);
  assert.match(board, /<input type="hidden" name="value" value="on"/u);
  assert.match(board, /To do · <code>backlog<\/code>/u);
  const rows = [...board.matchAll(/<li class="settings-item">([^]*?)<\/li>/gu)].map((row) => row[1]);
  assert.deepEqual(rows.map((row) => row.includes('This is the first column of its role. It stays visible.')),
    [true, true, false, true, false]);
  assert.doesNotMatch(board, /<button[^>]*disabled|role="switch"|<style\b|\sstyle=|<script\b/u);
});

test('Board localizes labels and saved status without translating stored column names', { skip }, async (t) => {
  const f = await fixture(t);
  for (const [language, heading, rename, move, hide, saveLease, saved, note, range] of [
    ['en', 'Board', 'Save name', 'Move down', 'Hide', 'Save lease', 'Saved',
      'This is the first column of its role. It stays visible.', 'from 5 to 1440'],
    ['tr', 'Pano', 'Adı kaydet', 'Aşağı taşı', 'Gizle', 'Süreyi kaydet', 'Kaydedildi',
      'Bu rolün ilk sütunu. Görünür kalır.', '5 ile 1440 arası'],
  ]) {
    process.env.CAIRN_LANGUAGE = language;
    const { body } = await f.page('/settings?saved=board');
    const board = boardMarkup(body);
    for (const snippet of [
      `<h2 id="settings-board-title">${heading}</h2>`, `<h3>Backlog</h3>`,
      `aria-label="${rename}: Backlog"`, `aria-label="${move}: Backlog"`,
      `aria-label="${hide}: Review"`, `>${saveLease}</button>`, note, range,
    ]) assert.ok(board.includes(snippet), snippet);
    assert.match(body, new RegExp(`role="status"[^>]*>${saved}: ${heading}`, 'u'));
  }
});

test('Board escapes stored names and offers only the actions allowed for hidden or legacy columns', { skip },
  async (t) => {
    const f = await fixture(t);
    const config = JSON.parse(readFileSync(f.configFile, 'utf8'));
    const legacyKey = `a${'b'.repeat(64)}`;
    config.columns[2].label = '<script> & "Review"';
    config.columns[2].hidden = true;
    config.columns.push({ key: legacyKey, label: 'Later', role: 'done' });
    config.leaseMinutes = 45;
    writeFileSync(f.configFile, JSON.stringify(config));
    const board = boardMarkup((await f.page()).body);
    assert.match(board, /<h3>&lt;script&gt; &amp; &quot;Review&quot;<\/h3>/u);
    // Angle brackets are safe inside a quoted attribute, whose quotes must be escaped.
    assert.match(board, /name="label" value="(?:<|&lt;)script(?:>|&gt;) &amp; &quot;Review&quot;"/u);
    assert.doesNotMatch(board.replace(/"[^"]*"/gu, '""'), /<script\b/u);
    assert.ok(board.includes('Hidden: its cards are in the archive.'));
    assert.ok(board.includes('Changing visibility or order requires the first column of each role to be visible.'));
    assert.match(board, /name="value" value="off"/u);
    assert.doesNotMatch(board, /action="\/settings\/board\/columns\/review\/up"/u);
    assert.ok(board.includes(`<code>${legacyKey}</code>`));
    assert.ok(board.includes('The column key is too long for editing in Settings.'));
    assert.ok(!board.includes(`/settings/board/columns/${legacyKey}/`));
    assert.match(board, /name="minutes" value="45"/u);
  });

test('Board accepts a 40-code-point name and shows the server error at 41', { skip }, async (t) => {
  const f = await fixture(t);
  const path = column('review', 'label');
  const label = '🪴'.repeat(40);
  assert.equal((await f.page(path, { label })).status, 303);
  assert.ok(boardMarkup((await f.page()).body).includes(`name="label" value="${label}" required`));
  for (const [language, message] of [
    ['en', 'The column name can be at most 40 characters long.'],
    ['tr', 'Sütun adı en çok 40 karakter olabilir.'],
  ]) {
    process.env.CAIRN_LANGUAGE = language;
    const response = await f.page(path, { label: `${label}🪴` });
    assert.equal(response.status, 400);
    assert.ok(response.body.includes(`<p>${message}</p>`));
  }
  assert.equal(JSON.parse(readFileSync(f.configFile, 'utf8')).columns[2].label, label);
});

test('Board shows out-of-range stored leases and lets the server validate submissions', { skip }, async (t) => {
  const f = await fixture(t);
  const config = JSON.parse(readFileSync(f.configFile, 'utf8'));
  for (const minutes of [3, 5000]) {
    writeFileSync(f.configFile, JSON.stringify({ ...config, leaseMinutes: minutes }));
    const board = boardMarkup((await f.page()).body);
    assert.ok(board.includes(`name="minutes" value="${minutes}" step="1" required`));
    const response = await f.page(lease, { minutes });
    assert.equal(response.status, 400);
    assert.ok(response.body.includes('<p>The claim lease must be a whole number of minutes from 5 to 1440.</p>'));
  }
  assert.equal((await f.page(lease, { minutes: 120 })).status, 303);
  assert.equal(JSON.parse(readFileSync(f.configFile, 'utf8')).leaseMinutes, 120);
});

test('Board forms are absent while settings are busy or invalid', { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.open();
  const locks = join(f.dataDir, '.cairn/locks');
  mkdirSync(locks, { recursive: true });
  writeFileSync(join(locks, '_config.lock'), JSON.stringify({ host: ctx.host, pid: process.pid,
    instance: 'another-run', ts: '2026-11-08T12:00:00Z' }));
  const busy = await f.page();
  assert.equal(busy.status, 503);
  assert.doesNotMatch(busy.body, /id="settings-board"|<form\b/u);
  writeFileSync(f.configFile, '{}');
  const invalid = await f.page();
  assert.equal(invalid.status, 200);
  assert.match(invalid.body, /Invalid configuration/u);
  assert.doesNotMatch(invalid.body, /id="settings-board"|<form\b/u);
});
