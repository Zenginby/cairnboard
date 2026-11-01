import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('../security/ci-scan.mjs', import.meta.url));
const privateEmail = ['a', 'b.com'].join('@');
const corporateEmail = ['dev', 'corp.test'].join('@');
const noreply = '1+zorblax@users.noreply.github.com';

function repository(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-scan-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = join(directory, 'repo');
  const home = join(directory, 'home');
  mkdirSync(cwd);
  mkdirSync(home);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, 'config'),
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: noreply,
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: noreply,
  });
  const git = (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--initial-branch=main');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@example.com');
  const write = (text, file = 'fixture.txt') => writeFileSync(join(cwd, file), text);
  const commit = (message = 'fixture') => {
    git('add', '--all');
    git('commit', '--quiet', '--allow-empty', '-m', message);
  };
  const scan = () => spawnSync(process.execPath, [scanner], { cwd, env, encoding: 'utf8' });
  return { cwd, env, git, write, commit, scan };
}

function check(result, status, rule, hidden = []) {
  assert.equal(result.status, status);
  const output = result.stdout + result.stderr;
  if (rule) assert.ok(output.includes(` ${rule}`));
  else assert.equal(output, '');
  for (const value of hidden) assert.ok(!output.includes(value));
}

test('ci-scan accepts a clean index without commits and ignores untracked files', (t) => {
  const repo = repository(t);
  repo.write('zorblax acme\n');
  repo.git('add', 'fixture.txt');
  repo.write(privateEmail, 'untracked.txt');
  check(repo.scan(), 0);
});

test('ci-scan checks current tracked contents and redacts source names', (t) => {
  const repo = repository(t);
  repo.write('clean\n', privateEmail);
  repo.commit();
  repo.write(privateEmail, privateEmail);
  check(repo.scan(), 1, 'email', [privateEmail]);
});

test('ci-scan checks each generic content rule', (t) => {
  const repo = repository(t);
  repo.write('clean');
  repo.git('add', 'fixture.txt');
  for (const [rule, value] of [
    ['ipv4', [10, 0, 0, 5].join('.')],
    ['home-path', ['', 'home', 'acme', 'file'].join('/')],
    ['token', 'a1'.repeat(20)], // gitleaks:allow (fake test token)
  ]) {
    repo.write(value);
    check(repo.scan(), 1, rule, [value]);
  }
});

test('ci-scan checks removed contents across all refs', (t) => {
  const repo = repository(t);
  repo.write('clean');
  repo.commit();
  repo.git('checkout', '--quiet', '-b', 'acme');
  repo.write(privateEmail);
  repo.commit();
  repo.git('rm', '--quiet', 'fixture.txt');
  repo.commit();
  repo.git('checkout', '--quiet', 'main');
  check(repo.scan(), 1, 'email', [privateEmail]);
});

test('ci-scan checks commit messages', (t) => {
  const repo = repository(t);
  repo.commit(privateEmail);
  check(repo.scan(), 1, 'email', [privateEmail]);
});

test('ci-scan checks historical source names without printing them', (t) => {
  const repo = repository(t);
  repo.write('clean', privateEmail);
  repo.commit();
  repo.git('rm', '--quiet', privateEmail);
  repo.commit();
  check(repo.scan(), 1, 'email', [privateEmail]);
});

test('ci-scan checks ref names without printing them', (t) => {
  const repo = repository(t);
  repo.commit();
  repo.git('tag', privateEmail);
  check(repo.scan(), 1, 'email', [privateEmail]);
});

for (const role of ['author', 'committer']) {
  test(`ci-scan rejects a non-noreply ${role} identity`, (t) => {
    const repo = repository(t);
    repo.env[`GIT_${role.toUpperCase()}_EMAIL`] = corporateEmail;
    repo.commit();
    check(repo.scan(), 1, 'identity', [corporateEmail]);
  });
}

test('ci-scan rejects empty identities', (t) => {
  const repo = repository(t);
  repo.env.GIT_AUTHOR_EMAIL = '';
  repo.commit();
  check(repo.scan(), 1, 'identity');
});

test('ci-scan checks generic patterns in public identity names', (t) => {
  const repo = repository(t);
  repo.env.GIT_AUTHOR_NAME = privateEmail;
  repo.commit();
  check(repo.scan(), 1, 'email', [privateEmail]);
});

test('ci-scan rejects placeholder identities even when content rules allow them', (t) => {
  const repo = repository(t);
  repo.env.GIT_AUTHOR_EMAIL = 't@example.com';
  repo.commit();
  check(repo.scan(), 1, 'identity', ['t@example.com']);
});

test('ci-scan allows both public noreply identities and ignores structural hashes', (t) => {
  const repo = repository(t);
  repo.env.GIT_COMMITTER_EMAIL = 'noreply@anthropic.com';
  repo.write('zorblax acme\n');
  repo.commit();
  repo.write('acme zorblax\n');
  repo.commit();
  check(repo.scan(), 0);
});

test('ci-scan does not follow tracked symlinks', { skip: process.platform === 'win32' }, (t) => {
  const repo = repository(t);
  symlinkSync('missing', join(repo.cwd, 'fixture.txt'));
  repo.git('add', 'fixture.txt');
  check(repo.scan(), 0);
});

test('ci-scan rejects symlinks in parent directories', { skip: process.platform === 'win32' }, (t) => {
  const repo = repository(t);
  const directory = join(repo.cwd, 'acme');
  mkdirSync(directory);
  repo.write('clean', 'acme/fixture.txt');
  repo.git('add', '--all');
  rmSync(directory, { recursive: true });
  symlinkSync(repo.env.HOME, directory);
  const result = repo.scan();
  assert.equal(result.status, 1);
  assert.ok(result.stderr === 'ci-scan failed\n');
});

test('ci-scan fails closed without exposing Git errors', (t) => {
  const repo = repository(t);
  rmSync(join(repo.cwd, '.git'), { recursive: true });
  const result = repo.scan();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr === 'ci-scan failed\n');
});
