import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedGitEnv, makeRepo } from './support/git.mjs';

const scanner = fileURLToPath(new URL('../security/ci-scan.mjs', import.meta.url));
const privateEmail = ['a', 'b.com'].join('@');
const corporateEmail = ['dev', 'corp.test'].join('@');
const noreply = '1+zorblax@users.noreply.github.com';

function repository(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-scan-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, 'home');
  mkdirSync(home);
  const cwd = makeRepo({ home });
  const env = {
    ...isolatedGitEnv(home),
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: noreply,
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: noreply,
  };
  const git = (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
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

test('ci-scan accepts a clean index and ignores untracked files', (t) => {
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

test('ci-scan checks annotated tagger identities', (t) => {
  const repo = repository(t);
  repo.commit();
  repo.env.GIT_COMMITTER_EMAIL = corporateEmail;
  repo.git('tag', '-a', 'v0', '-m', 'release');
  check(repo.scan(), 1, 'identity', [corporateEmail]);
});

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

test('shared Git helpers support input and buffers without leaking stderr', (t) => {
  const repo = repository(t);
  const module = new URL('../security/git.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { git, gitBuffer } from ${JSON.stringify(module)};
    const cwd = process.cwd();
    const args = ['hash-object', '--stdin'];
    const hash = git(args, { cwd, input: 'acme' });
    assert.equal(hash, git(args, { input: Buffer.from('acme') }));
    assert.ok(Buffer.isBuffer(gitBuffer(['show', 'HEAD:README.md'], { cwd })));
    assert.equal(gitBuffer(['show', 'HEAD:README.md']).toString(), '# acme\\n');
    for (const run of [git, gitBuffer]) assert.throws(() => run(['show', 'missing-ref'], { cwd }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: repo.cwd, env: repo.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('shared Git helpers ignore replace objects', (t) => {
  const repo = repository(t);
  repo.write('original\n');
  repo.commit();
  const original = repo.git('rev-parse', 'HEAD:fixture.txt').trim();
  repo.write('replacement\n');
  repo.commit();
  repo.git('replace', original, 'HEAD:fixture.txt');
  const module = new URL('../security/git.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { git, gitBuffer } from ${JSON.stringify(module)};
    for (const run of [git, gitBuffer]) {
      assert.equal(run(['cat-file', 'blob', ${JSON.stringify(original)}]).toString(), 'original\\n');
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: repo.cwd, env: repo.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('ci-scan finds historical content hidden by a blob replacement', (t) => {
  const repo = repository(t);
  repo.write(privateEmail);
  repo.commit();
  const original = repo.git('rev-parse', 'HEAD:fixture.txt').trim();
  repo.write('clean\n');
  repo.commit();
  repo.git('replace', original, 'HEAD:fixture.txt');
  check(repo.scan(), 1, 'email', [privateEmail]);
});
