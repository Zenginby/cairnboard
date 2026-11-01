import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseCheck } from '../security/release-check.mjs';
import { formatFindings } from '../security/scan.mjs';

// Isolate every git call from the real user configuration.
const home = mkdtempSync(join(tmpdir(), 'cairn-home-'));
process.env.HOME = home;
process.env.GIT_CONFIG_NOSYSTEM = '1';
for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_DIR', 'GIT_WORK_TREE']) {
  delete process.env[key];
}

const cli = fileURLToPath(new URL('../security/release-check.mjs', import.meta.url));
const denylist = join(home, 'denylist.txt');
writeFileSync(denylist, '# fixture terms\nzorblax\n');

const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function makeRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'cairn-repo-'));
  run(cwd, 'init', '-q', '-b', 'main');
  run(cwd, 'config', 'user.name', 't');
  run(cwd, 'config', 'user.email', 't@example.com');
  writeFileSync(join(cwd, 'README.md'), '# acme\n');
  run(cwd, 'add', '.');
  run(cwd, 'commit', '-q', '-m', 'init');
  return cwd;
}

const check = (cwd, options = {}) => releaseCheck({ cwd, denylistPath: denylist, privateRoots: [], allowIdentities: ['t@example.com'], github: false, ...options });
const rules = (result) => result.findings.map((f) => f.rule);

function runCli(cwd, env) {
  const base = { ...process.env };
  delete base.CAIRN_DENYLIST;
  delete base.CAIRN_PRIVATE_ROOTS;
  delete base.CAIRN_ALLOW_IDENTITIES;
  return spawnSync(process.execPath, [cli], { cwd, env: { ...base, ...env }, encoding: 'utf8' });
}

test('clean repository has no findings and exits 0', () => {
  const cwd = makeRepo();
  const result = check(cwd);
  assert.deepEqual(result, { findings: [], errors: [] });
  const proc = runCli(cwd, { CAIRN_DENYLIST: denylist });
  assert.equal(proc.status, 0, proc.stderr);
});

test('denylisted term in a commit message is found without being printed', () => {
  const cwd = makeRepo();
  run(cwd, 'commit', '-q', '--allow-empty', '-m', 'Add Zorblax board');
  const result = check(cwd);
  assert.deepEqual(rules(result), ['denylist:0']);
  assert.doesNotMatch(formatFindings(result.findings), /zorblax/i);
  const proc = runCli(cwd, { CAIRN_DENYLIST: denylist });
  assert.equal(proc.status, 1);
  assert.doesNotMatch(proc.stdout + proc.stderr, /zorblax/i);
});

test('denylisted term in file contents, file paths and history is found', () => {
  const cwd = makeRepo();
  mkdirSync(join(cwd, 'docs'));
  writeFileSync(join(cwd, 'docs', 'zorblax.md'), 'plain\n');
  run(cwd, 'add', '.');
  run(cwd, 'commit', '-q', '-m', 'docs');
  const result = check(cwd);
  assert.ok(result.findings.length > 0);
  assert.ok(rules(result).every((rule) => rule === 'denylist:0'));
  assert.doesNotMatch(formatFindings(result.findings), /zorblax/i);
});

test('denylisted term in a branch name is found', () => {
  const cwd = makeRepo();
  run(cwd, 'branch', 'feature/zorblax-x');
  const result = check(cwd);
  assert.deepEqual(rules(result), ['denylist:0']);
  assert.doesNotMatch(formatFindings(result.findings), /zorblax/i);
});

test('denylisted term in a git note is found', () => {
  const cwd = makeRepo();
  run(cwd, 'notes', 'add', '-m', 'see zorblax', 'HEAD');
  const result = check(cwd);
  assert.deepEqual(rules(result), ['denylist:0']);
  assert.doesNotMatch(formatFindings(result.findings), /zorblax/i);
});

test('author email outside the allowed identities is reported', () => {
  const cwd = makeRepo();
  run(cwd, 'commit', '-q', '--allow-empty', '--author', 'Dev <dev@corp.test>', '-m', 'work'); // cairn-scan:allow-fixture
  const result = check(cwd);
  assert.ok(rules(result).includes('identity'));
  assert.doesNotMatch(formatFindings(result.findings), /corp\.test/);
  const allowed = check(cwd, { allowIdentities: ['t@example.com', 'dev@corp.test'] }); // cairn-scan:allow-fixture
  assert.equal(rules(allowed).includes('identity'), false);
});

test('repository local user.email is the default allowed identity', () => {
  const cwd = makeRepo();
  const proc = runCli(cwd, { CAIRN_DENYLIST: denylist });
  assert.equal(proc.status, 0, proc.stdout + proc.stderr);
});

test('root commit listed in CAIRN_PRIVATE_ROOTS is reported', () => {
  const cwd = makeRepo();
  const root = run(cwd, 'rev-list', '--max-parents=0', 'HEAD').trim();
  assert.deepEqual(rules(check(cwd, { privateRoots: [root] })), ['private-root']);
  const proc = runCli(cwd, { CAIRN_DENYLIST: denylist, CAIRN_PRIVATE_ROOTS: `deadbeef,${root}` });
  assert.equal(proc.status, 1);
  assert.match(proc.stdout + proc.stderr, /private-root/);
});

test('binary file is reported until it is on the binary allowlist', () => {
  const cwd = makeRepo();
  writeFileSync(join(cwd, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  run(cwd, 'add', '.');
  run(cwd, 'commit', '-q', '-m', 'image');
  assert.deepEqual(rules(check(cwd)), ['binary']);
  mkdirSync(join(cwd, 'security'));
  writeFileSync(join(cwd, 'security', 'binary-allowlist.txt'), '# reviewed binaries\na.png\n');
  run(cwd, 'add', '.');
  run(cwd, 'commit', '-q', '-m', 'allow image');
  assert.deepEqual(check(cwd), { findings: [], errors: [] });
});

test('missing CAIRN_DENYLIST exits 2', () => {
  const cwd = makeRepo();
  const proc = runCli(cwd, {});
  assert.equal(proc.status, 2);
  assert.match(proc.stderr, /CAIRN_DENYLIST is required/);
});

test('annotated tag messages are scanned', (t) => {
  const repo = makeRepo(t);
  run(repo, 'tag', '-a', 'v0', '-m', 'about zorblax');
  const { findings } = check(repo);
  assert.ok(findings.some((f) => f.file.startsWith('tag#')));
});

test('content introduced only by a merge commit is found in history', (t) => {
  const repo = makeRepo(t);
  run(repo, 'checkout', '-q', '-b', 'side');
  writeFileSync(join(repo, 'side.txt'), 'side\n');
  run(repo, 'add', '-A');
  run(repo, 'commit', '-q', '-m', 'side');
  run(repo, 'checkout', '-q', 'main');
  run(repo, 'merge', '-q', '--no-ff', '--no-commit', 'side');
  writeFileSync(join(repo, 'evil.txt'), 'zorblax\n');
  run(repo, 'add', 'evil.txt');
  run(repo, 'commit', '-q', '-m', 'merge');
  run(repo, 'rm', '-q', 'evil.txt');
  run(repo, 'commit', '-q', '-m', 'remove');
  assert.ok(check(repo).findings.some((f) => f.file.startsWith('commit:')));
});

test('binary blobs removed from the index are still found in history', (t) => {
  const repo = makeRepo(t);
  writeFileSync(join(repo, 'img.bin'), Buffer.from([1, 0, 2]));
  run(repo, 'add', '-A');
  run(repo, 'commit', '-q', '-m', 'add');
  run(repo, 'rm', '-q', 'img.bin');
  run(repo, 'commit', '-q', '-m', 'remove');
  assert.ok(check(repo).findings.some((f) => f.rule === 'binary'));
});

test('earlier note versions are scanned', (t) => {
  const repo = makeRepo(t);
  run(repo, 'notes', 'add', '-m', 'about zorblax', 'HEAD');
  run(repo, 'notes', 'add', '-f', '-m', 'clean', 'HEAD');
  assert.ok(check(repo).findings.some((f) => f.file.startsWith('notes-history')));
});

test('error output carries only the step name', (t) => {
  const repo = makeRepo(t);
  const { errors } = releaseCheck({ cwd: join(repo, 'missing-dir'), denylistPath: denylist, privateRoots: [], allowIdentities: [], github: false });
  for (const e of errors) assert.match(e, /^[\w ]+: failed$/);
});
