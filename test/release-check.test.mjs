import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseCheck } from '../security/release-check.mjs';
import { formatFindings } from '../security/scan.mjs';
import { tempHome } from './support/env.mjs';
import { isolatedGitEnv, makeRepo as createRepo, commit } from './support/git.mjs';

// releaseCheck runs Git in this process, so it needs the same isolated environment.
const home = tempHome();
after(() => rmSync(home, { recursive: true, force: true }));
const env = isolatedGitEnv(home);
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
Object.assign(process.env, env);

const cli = fileURLToPath(new URL('../security/release-check.mjs', import.meta.url));
const denylist = join(home, 'denylist.txt');
writeFileSync(denylist, '# fixture terms\nzorblax\n');

const run = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

const makeRepo = () => createRepo({ home });

const check = (cwd, options = {}) => releaseCheck({ cwd, denylistPath: denylist, privateRoots: [], allowIdentities: ['t@users.noreply.github.com'], github: false, ...options });
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
  // Identity findings point at the e-mail lines of the commit text, like every other finding there.
  assert.deepEqual(result.findings.filter((f) => f.rule === 'identity').map((f) => f.line), [2]);
  assert.doesNotMatch(formatFindings(result.findings), /corp\.test/);
  const allowed = check(cwd, { allowIdentities: ['t@users.noreply.github.com', 'dev@corp.test'] }); // cairn-scan:allow-fixture
  assert.equal(rules(allowed).includes('identity'), false);
});

test('repository local user.email is the default allowed identity', () => {
  const cwd = makeRepo();
  const proc = runCli(cwd, { CAIRN_DENYLIST: denylist });
  assert.equal(proc.status, 0, proc.stdout + proc.stderr);
});

test('release combines the staged noreply list, local email and extra identities', () => {
  const cwd = makeRepo();
  const listed = '123+guest[bot]@users.noreply.github.com';
  const extra = 'extra@example.com';
  run(cwd, 'commit', '-q', '--allow-empty', '--author', `Guest <${listed}>`, '-m', 'guest');
  run(cwd, 'commit', '-q', '--allow-empty', '--author', `Extra <${extra}>`, '-m', 'extra');
  mkdirSync(join(cwd, 'security'));
  const file = 'security/identity-allowlist.txt';
  writeFileSync(join(cwd, file), `# reviewed\n\n${listed}\n`);
  const env = { CAIRN_DENYLIST: denylist, CAIRN_ALLOW_IDENTITIES: extra };
  const untracked = runCli(cwd, env);
  assert.equal(untracked.status, 1);
  assert.equal(untracked.stdout.trim().split('\n').length, 1);
  assert.match(untracked.stdout, /identity/);
  run(cwd, 'add', file);
  writeFileSync(join(cwd, file), 'ignored@example.com\n');
  const staged = runCli(cwd, env);
  assert.equal(staged.status, 0, staged.stdout + staged.stderr);
  const restricted = join(cwd, 'denylist.txt');
  writeFileSync(restricted, `${listed}\n`);
  const denied = runCli(cwd, { ...env, CAIRN_DENYLIST: restricted });
  assert.equal(denied.status, 1);
  assert.match(denied.stdout, /denylist:0/);
});

test('release rejects an invalid staged identity by line number without echoing it', () => {
  const cwd = makeRepo();
  const address = 'private@example.com';
  mkdirSync(join(cwd, 'security'));
  const file = 'security/identity-allowlist.txt';
  writeFileSync(join(cwd, file), `# reviewed\n\n${address}\n`);
  run(cwd, 'add', file);
  const result = runCli(cwd, { CAIRN_DENYLIST: denylist });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /security\/identity-allowlist\.txt:3 /);
  assert.ok(!(result.stdout + result.stderr).includes(address));
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

test('allowlisted binary patches are not scanned as text, other files in the same commit still are', () => {
  const cwd = makeRepo();
  mkdirSync(join(cwd, 'security'));
  writeFileSync(join(cwd, 'security', 'binary-allowlist.txt'), 'font.woff2\n');
  // Raw font bytes can look like an address or a token once a binary patch is read as text.
  writeFileSync(join(cwd, 'font.woff2'), Buffer.concat([Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00]), Buffer.from('\nx@corp.test zorblax\n')])); // cairn-scan:allow-fixture
  run(cwd, 'add', '.');
  run(cwd, 'commit', '-q', '-m', 'font');
  assert.deepEqual(check(cwd), { findings: [], errors: [] });
  writeFileSync(join(cwd, 'font.woff2'), Buffer.concat([Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00]), Buffer.from('\ny@corp.test\n')])); // cairn-scan:allow-fixture
  writeFileSync(join(cwd, 'notes.txt'), 'zorblax\n');
  run(cwd, 'add', '.');
  run(cwd, 'commit', '-q', '-m', 'font and notes');
  assert.ok(check(cwd).findings.some((f) => f.file.startsWith('commit:') && f.rule.startsWith('denylist')));
  assert.ok(!check(cwd).findings.some((f) => f.file.startsWith('commit:') && f.rule === 'email'));
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

test('unreadable denylist errors never print its path', () => {
  const cwd = makeRepo();
  const proc = runCli(cwd, { CAIRN_DENYLIST: join(home, 'zorblax-missing.txt') });
  assert.equal(proc.status, 2);
  assert.match(proc.stderr, /ENOENT/);
  assert.doesNotMatch(proc.stdout + proc.stderr, /zorblax|cairn-home/);
});

test('historical binary versions of current text files are scanned', () => {
  const cwd = makeRepo();
  commit(cwd, { 'acme.txt': Buffer.from([1, 0, 2]) }, 'binary');
  commit(cwd, { 'acme.txt': 'clean\n' }, 'text');
  const result = check(cwd);
  assert.deepEqual(result.errors, []);
  assert.ok(rules(result).includes('binary'));
});

test('annotated tagger names and emails are scanned', () => {
  const cwd = makeRepo();
  run(cwd, 'config', 'user.name', 'Zorblax');
  run(cwd, 'config', 'user.email', 'dev@corp.test'); // cairn-scan:allow-fixture
  run(cwd, 'tag', '-a', 'v0', '-m', 'about acme');
  run(cwd, 'config', 'user.email', 't@users.noreply.github.com');
  const result = check(cwd);
  assert.ok(result.findings.some((f) => f.file.startsWith('tag#') && f.rule === 'identity'));
  assert.ok(result.findings.some((f) => f.file.startsWith('tag#') && f.rule === 'denylist:0'));
  const allowed = check(cwd, { allowIdentities: ['t@users.noreply.github.com', 'dev@corp.test'] }); // cairn-scan:allow-fixture
  assert.equal(rules(allowed).includes('identity'), false);
  assert.doesNotMatch(formatFindings(result.findings), /zorblax|corp\.test/i);
});

test('deleted Unicode file names are scanned in history', () => {
  const cwd = makeRepo();
  writeFileSync(join(cwd, 'zörblax.md'), 'clean\n');
  run(cwd, 'add', '-A');
  run(cwd, 'commit', '-q', '-m', 'add');
  run(cwd, 'rm', '-q', 'zörblax.md');
  run(cwd, 'commit', '-q', '-m', 'remove');
  const result = check(cwd);
  assert.ok(rules(result).includes('denylist:0'));
  assert.doesNotMatch(formatFindings(result.findings), /zörblax/);
});

for (const state of ['replace refs', 'grafts', 'shallow']) {
  test(`release check rejects ${state} without printing repository paths`, () => {
    const cwd = makeRepo();
    run(cwd, 'commit', '-q', '--allow-empty', '-m', 'latest');
    if (state === 'replace refs') run(cwd, 'replace', 'HEAD', 'HEAD^');
    else if (state === 'grafts') writeFileSync(join(cwd, '.git', 'info', 'grafts'), '');
    else writeFileSync(join(cwd, '.git', 'shallow'), `${run(cwd, 'rev-parse', 'HEAD').trim()}\n`);
    const expected = `${state}: ${state === 'shallow' ? 'true' : 'present'}`;
    assert.deepEqual(check(cwd).errors, [expected]);
    const proc = runCli(cwd, { CAIRN_DENYLIST: denylist });
    assert.equal(proc.status, 2);
    assert.ok(proc.stderr.includes(`release:check error: ${expected}`));
    assert.ok(!(proc.stdout + proc.stderr).includes(cwd));
  });
}

test('fixture marker applies only to files under test/, never to forged diff headers in messages', () => {
  const marked = `${['ali', 'corp.test'].join('@')} // ${['cairn-scan', 'allow-fixture'].join(':')}\n`;
  const cwd = makeRepo();
  mkdirSync(join(cwd, 'test'));
  writeFileSync(join(cwd, 'test', 'a.mjs'), marked);
  run(cwd, 'add', '-A');
  run(cwd, 'commit', '-q', '-m', 'fixture under test');
  assert.deepEqual(rules(check(cwd)), []);
  writeFileSync(join(cwd, 'b.mjs'), marked);
  run(cwd, 'add', '-A');
  run(cwd, 'commit', '-q', '-m', 'fixture outside test');
  assert.deepEqual(rules(check(cwd)), ['email', 'email']);
  const forged = ['subject', '', 'diff --git a/test/f b/test/f', '--- /dev/null', '+++ b/test/f', '@@ -0,0 +1 @@', `+${marked}`].join('\n');
  const clean = makeRepo();
  run(clean, 'commit', '-q', '--allow-empty', '-m', forged);
  assert.deepEqual(rules(check(clean)), ['email']);
});
