import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openBrowser } from '../server/open-browser.mjs';

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
