import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser, openLogin } from '../server/open-browser.mjs';
import { tempDir } from './support/env.mjs';

const url = 'http://127.0.0.1:4321/';

test('openBrowser uses argument arrays without a shell on each supported platform', () => {
  for (const [platform, command, args] of [
    ['darwin', 'open', [url]], ['linux', 'xdg-open', [url]],
    ['win32', 'C:\\Windows\\System32\\rundll32.exe', ['url.dll,FileProtocolHandler', url]],
  ]) {
    let unref = false;
    openBrowser(url, { platform, env: {}, spawn: (...actual) => {
      assert.deepEqual(actual, [command, args, { shell: false, detached: true, stdio: 'ignore' }]);
      return Object.assign(new EventEmitter(), { unref: () => { unref = true; } });
    } });
    assert.equal(unref, true);
  }
});

test('Windows browser launching resolves rundll32 from the injected system root', () => {
  openBrowser(url, { platform: 'win32', env: { SystemRoot: 'D:\\Windows' }, spawn: (command, args) => {
    assert.equal(command, 'D:\\Windows\\System32\\rundll32.exe');
    assert.deepEqual(args, ['url.dll,FileProtocolHandler', url]);
    return Object.assign(new EventEmitter(), { unref() {} });
  } });
});

test('openBrowser refuses non-loopback or malformed URLs before spawning', () => {
  for (const bad of ['https://127.0.0.1:4321/', 'http://localhost:4321/', 'http://0.0.0.0:4321/',
    'http://127.0.0.1/', 'http://127.0.0.1:0/', 'http://127.0.0.1:65536/',
    'http://127.0.0.1:4321@example.com/', 'http://127.0.0.1:4321/\n', 'file:///tmp/page', null]) {
    assert.throws(() => openBrowser(bad, { spawn: () => assert.fail('must not spawn') }), TypeError);
  }
  openBrowser('http://127.0.0.1:80/path?x=1', { platform: 'linux', spawn: () => Object.assign(new EventEmitter(), { unref() {} }) });
});

test('browser launch failures warn with the URL without crashing', () => {
  for (const failure of ['throw', 'error', 'exit', 'unsupported']) {
    let warning = '';
    const child = Object.assign(new EventEmitter(), { unref() {} });
    openBrowser(url, { platform: failure === 'unsupported' ? 'unknown' : 'linux',
      stderr: { write: (text) => { warning += text; } }, spawn: () => {
        if (failure === 'throw') throw new Error('unavailable');
        return child;
      } });
    if (failure === 'error') child.emit('error', new Error('unavailable'));
    if (failure === 'exit') child.emit('exit', 1);
    assert.match(warning, /warning:/u);
    assert.ok(warning.includes(url));
  }
});

const login = 'http://127.0.0.1:4321/auth?t=AAAAAAAAAAAAAAAAAAAAAA.1800000060000.secretmacsecretmac';
const child = () => Object.assign(new EventEmitter(), { unref() {} });

test('login links never go through openBrowser', () => {
  assert.throws(() => openBrowser(login, { spawn: () => assert.fail('must not spawn') }), /openLogin/u);
});

test('openLogin hands the opener a private redirect file, never the token', (t) => {
  const dir = join(tempDir(t), 'state');
  for (const platform of ['darwin', 'linux', 'win32']) {
    let args;
    const file = openLogin(login, { dir, platform, env: {}, spawn: (command, actual) => { args = [command, ...actual]; return child(); } });
    assert.ok(args.includes(file), platform);
    assert.ok(args.every((arg) => !arg.includes('secretmac')), 'token must not be on a command line');
    const html = readFileSync(file, 'utf8');
    assert.ok(html.includes(`<meta http-equiv="refresh" content="0;url=${login}">`));
    assert.ok(html.includes('<meta name="referrer" content="no-referrer">'));
    assert.doesNotMatch(html, /<script|style=/u);
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
    }
  }
});

test('openLogin warnings never print the token, and old launcher files are removed', (t) => {
  const dir = tempDir(t);
  const stale = join(dir, `open-${'a'.repeat(32)}.html`);
  const other = join(dir, 'session.key');
  writeFileSync(stale, 'old');
  writeFileSync(other, 'keep');
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(stale, old, old);
  let warning = '';
  const failing = child();
  openLogin(login, { dir, platform: 'linux', stderr: { write: (text) => { warning += text; } }, spawn: () => failing });
  failing.emit('exit', 1);
  assert.match(warning, /cairn open/u);
  assert.doesNotMatch(warning, /secretmac|auth\?t=/u);
  const names = readdirSync(dir);
  assert.equal(names.includes(`open-${'a'.repeat(32)}.html`), false);
  assert.equal(names.includes('session.key'), true);
  assert.throws(() => openLogin('http://127.0.0.1:4321/auth?t=x"><script>', { dir }), TypeError);
  assert.throws(() => openLogin(login, {}), TypeError);
});

test('openLogin accepts the private site name and nothing that only looks like it', (t) => {
  const dir = tempDir(t);
  const site = 'http://abcdefghijklmnopqrstuvwxyz.cairnboard.localhost:4321/auth?t=x';
  openLogin(site, { dir, platform: 'linux', spawn: () => child() });
  for (const bad of ['http://cairnboard.localhost:4321/auth?t=x', 'http://ABCDEFGHIJKLMNOPQRSTUVWXYZ.cairnboard.localhost:4321/',
    'http://abcdefghijklmnopqrstuvwxyz.cairnboard.localhost.evil.test:4321/', 'http://evil.test/abcdefghijklmnopqrstuvwxyz.cairnboard.localhost:4321/']) {
    assert.throws(() => openLogin(bad, { dir, spawn: () => assert.fail('must not spawn') }), TypeError, bad);
  }
});
