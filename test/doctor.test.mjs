import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from '../security/doctor.mjs';

function list(t, text = 'zorblax\n') {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'list.txt');
  writeFileSync(path, text);
  return path;
}

// Fake command runner: answers git config and gitleaks lookups from a table.
function fakeExec(answers) {
  return (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    if (!(key in answers)) throw new Error(`not found: ${key}`);
    return answers[key];
  };
}

const healthy = {
  'git config core.hooksPath': 'security/hooks\n',
  'git config user.email': '1+zorblax@users.noreply.github.com\n',
  'gitleaks version': '8.30.1\n',
};

const byName = (checks) => Object.fromEntries(checks.map((c) => [c.name, c]));

test('all checks pass on a healthy setup', (t) => {
  const checks = doctor({ env: { CAIRN_DENYLIST: list(t) }, exec: fakeExec(healthy), nodeVersion: '22.23.4' });
  assert.deepEqual(checks.map((c) => c.name), ['node-version', 'hooks-path', 'denylist', 'gitleaks', 'git-identity', 'sqlite']);
  for (const c of checks) assert.equal(c.ok, true, c.name);
});

test('each failing check says what to do', (t) => {
  const c = byName(doctor({
    env: {},
    exec: fakeExec({ 'git config user.email': 'dev@corp.test\n' }), // cairn-scan:allow-fixture
    nodeVersion: '22.12.9',
  }));
  for (const name of ['node-version', 'hooks-path', 'denylist', 'gitleaks', 'git-identity']) {
    assert.equal(c[name].ok, false, name);
    assert.ok(c[name].hint.length > 0, name);
  }
});

test('unreadable or invalid denylist fails without printing its content', (t) => {
  const short = byName(doctor({ env: { CAIRN_DENYLIST: list(t, 'zorblax\nab\n') }, exec: fakeExec(healthy), nodeVersion: '24.0.0' }));
  assert.equal(short.denylist.ok, false);
  assert.doesNotMatch(short.denylist.hint, /zorblax/);
  const missing = byName(doctor({ env: { CAIRN_DENYLIST: '/nonexistent/list.txt' }, exec: fakeExec(healthy), nodeVersion: '24.0.0' }));
  assert.equal(missing.denylist.ok, false);
});

test('node version comparison is numeric', () => {
  const ok = (v) => byName(doctor({ env: {}, exec: fakeExec(healthy), nodeVersion: v }))['node-version'].ok;
  assert.equal(ok('22.23.4'), true);
  assert.equal(ok('22.23.3'), false); // the Astro 7.4 floor, a 22 LTS security release
  assert.equal(ok('22.15.1'), false);
  assert.equal(ok('22.100.0'), true);
  assert.equal(ok('23.0.0'), true);
  assert.equal(ok('22.9.0'), false);
});
