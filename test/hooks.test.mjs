import { test as baseTest } from 'node:test';

// The sandbox builds a POSIX PATH and fake gitleaks shell script; Git for Windows runs the real hooks with its own sh.
const test = process.platform === 'win32' ? baseTest.skip : baseTest;
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// A throwaway repository wired to this repository's hooks, with a fake gitleaks on PATH.
function sandbox(t, { gitleaks = 'ok', denylist = 'zorblax\n' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  if (gitleaks === 'ok' || gitleaks === 'leak') {
    writeFileSync(join(bin, 'gitleaks'), `#!/bin/sh\nexit ${gitleaks === 'ok' ? 0 : 1}\n`);
    chmodSync(join(bin, 'gitleaks'), 0o755);
  }
  const list = join(dir, 'list.txt');
  if (denylist !== null) writeFileSync(list, denylist);
  const env = {
    PATH: `${bin}:/usr/bin:/bin:/usr/local/bin:${process.execPath.replace(/\/node$/, '')}`,
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: '1',
    ...(denylist !== null ? { CAIRN_DENYLIST: list } : {}),
  };
  const git = (...args) => spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
  spawnSync('git', ['init', '-q', '-b', 'main', repo], { env });
  cpSync(join(repoRoot, 'security'), join(repo, 'security'), { recursive: true });
  for (const h of ['pre-commit', 'commit-msg', 'pre-push']) chmodSync(join(repo, 'security', 'hooks', h), 0o755);
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@example.com');
  git('add', 'security');
  assert.equal(git('commit', '-q', '-m', 'base').status, 0, 'base commit');
  git('config', 'core.hooksPath', 'security/hooks');
  const commit = (file, content, message = 'change') => {
    writeFileSync(join(repo, file), content);
    git('add', '-A');
    return git('commit', '-q', '-m', message);
  };
  return { repo, git, commit, dir, env };
}

test('clean commit passes', (t) => {
  const s = sandbox(t);
  assert.equal(s.commit('a.txt', 'hello\n').status, 0);
});

test('denylisted content, file name or message is blocked without echoing the term', (t) => {
  const s = sandbox(t);
  for (const [file, content, message] of [['a.txt', 'Zorblax notes\n', 'x'], ['zorblax plan.txt', 'x\n', 'x'], ['b.txt', 'x\n', 'about zorblax']]) {
    const r = s.commit(file, content, message);
    assert.notEqual(r.status, 0, file);
    assert.doesNotMatch(r.stderr + r.stdout, /zorblax/i);
    s.git('reset', '-q', '--hard', 'HEAD');
    s.git('clean', '-qfd');
  }
});

test('personal data patterns are blocked', (t) => {
  const s = sandbox(t);
  assert.notEqual(s.commit('a.txt', 'mail ali@corp.test\n').status, 0); // cairn-scan:allow-fixture
});

test('missing denylist or gitleaks blocks every commit', (t) => {
  assert.notEqual(sandbox(t, { denylist: null }).commit('a.txt', 'x\n').status, 0);
  assert.notEqual(sandbox(t, { gitleaks: 'none' }).commit('a.txt', 'x\n').status, 0);
  assert.notEqual(sandbox(t, { gitleaks: 'leak' }).commit('a.txt', 'x\n').status, 0);
});

test('pre-push scans every outgoing commit, including ones made with --no-verify', (t) => {
  const s = sandbox(t);
  const bare = join(s.dir, 'remote.git');
  spawnSync('git', ['init', '-q', '--bare', bare], { env: s.env });
  s.git('remote', 'add', 'origin', bare);
  assert.equal(s.git('push', '-q', 'origin', 'main').status, 0, 'clean push');
  writeFileSync(join(s.repo, 'c.txt'), 'zorblax\n');
  s.git('add', '-A');
  assert.equal(s.git('commit', '-q', '--no-verify', '-m', 'sneaky').status, 0);
  const r = s.git('push', '-q', 'origin', 'main');
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, /zorblax/i);
});

test('content introduced only by a merge commit is scanned on push', (t) => {
  const s = sandbox(t);
  const bare = join(s.dir, 'remote.git');
  spawnSync('git', ['init', '-q', '--bare', bare], { env: s.env });
  s.git('remote', 'add', 'origin', bare);
  assert.equal(s.git('push', '-q', 'origin', 'main').status, 0, 'clean push');
  s.git('checkout', '-q', '-b', 'side');
  assert.equal(s.commit('side.txt', 'side\n').status, 0);
  s.git('checkout', '-q', 'main');
  assert.equal(s.commit('main.txt', 'main\n').status, 0);
  s.git('merge', '-q', '--no-ff', '--no-commit', 'side');
  writeFileSync(join(s.repo, 'evil.txt'), 'zorblax\n');
  s.git('add', 'evil.txt');
  assert.equal(s.git('commit', '-q', '--no-verify', '-m', 'merge').status, 0);
  assert.notEqual(s.git('push', '-q', 'origin', 'main').status, 0);
});
