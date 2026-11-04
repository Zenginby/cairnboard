import { test as baseTest } from 'node:test';

// The sandbox builds a POSIX PATH and fake gitleaks shell script; Git for Windows runs the real hooks with its own sh.
const test = process.platform === 'win32' ? baseTest.skip : baseTest;
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedGitEnv, makeRepo, commit } from './support/git.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// A throwaway repository wired to this repository's hooks, with a fake gitleaks on PATH.
function sandbox(t, { gitleaks = 'ok', denylist = 'zorblax\n' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = makeRepo({ home: dir });
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  if (gitleaks === 'ok' || gitleaks === 'leak') {
    writeFileSync(join(bin, 'gitleaks'), `#!/bin/sh\nexit ${gitleaks === 'ok' ? 0 : 1}\n`);
    chmodSync(join(bin, 'gitleaks'), 0o755);
  }
  const list = join(dir, 'list.txt');
  if (denylist !== null) writeFileSync(list, denylist);
  const env = {
    ...isolatedGitEnv(dir),
    PATH: `${bin}:/usr/bin:/bin:/usr/local/bin:${process.execPath.replace(/\/node$/, '')}`,
    CAIRN_DENYLIST: denylist === null ? '' : list,
  };
  const git = (...args) => spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
  cpSync(join(repoRoot, 'security'), join(repo, 'security'), { recursive: true });
  for (const h of ['pre-commit', 'commit-msg', 'pre-push']) chmodSync(join(repo, 'security', 'hooks', h), 0o755);
  commit(repo, {}, 'base');
  git('config', 'core.hooksPath', 'security/hooks');
  const change = (file, content, message = 'change') => {
    writeFileSync(join(repo, file), content);
    git('add', '-A');
    return git('commit', '-q', '-m', message);
  };
  return { repo, git, commit: change, dir, env };
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

function hook(s, mode, { input, env = s.env, cwd = s.repo } = {}) {
  return spawnSync(process.execPath, [join(s.repo, 'security', 'hook.mjs'), mode], { cwd, env, input, encoding: 'utf8' });
}

function refInput(s, ref = 'refs/heads/main') {
  return `${ref} ${s.git('rev-parse', 'HEAD').stdout.trim()} ${ref} ${'0'.repeat(40)}\n`;
}

test('push findings use numbered labels without leaking the ref name', (t) => {
  const s = sandbox(t);
  assert.equal(s.git('commit', '-q', '--allow-empty', '--no-verify', '-m', 'about zorblax').status, 0);
  const result = hook(s, 'push', { input: refInput(s, 'refs/heads/zorblax') });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /push ref #1/);
  assert.doesNotMatch(result.stdout + result.stderr, /zorblax/);
});

test('hook startup failures hide paths and Git diagnostics', (t) => {
  const s = sandbox(t);
  const missing = join(s.dir, 'zorblax-list.txt');
  const result = hook(s, 'staged', { env: { ...s.env, CAIRN_DENYLIST: missing } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ENOENT/);
  assert.doesNotMatch(result.stdout + result.stderr, /zorblax/);
  const outside = hook(s, 'staged', { cwd: s.dir });
  assert.equal(outside.status, 2);
  assert.doesNotMatch(outside.stderr, /fatal:|Error:|node:|zorblax/);
});

test('push scans annotated tag names, identities and messages', (t) => {
  const s = sandbox(t);
  s.git('config', 'user.name', 'Zorblax');
  s.git('config', 'user.email', 'dev@corp.test'); // cairn-scan:allow-fixture
  assert.equal(s.git('tag', '-a', 'v0', '-m', 'about acme').status, 0);
  s.git('config', 'user.email', 't@example.com');
  const sha = s.git('rev-parse', 'v0').stdout.trim();
  const input = `refs/tags/v0 ${sha} refs/tags/v0 ${'0'.repeat(40)}\n`;
  const result = hook(s, 'push', { input });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /identity/);
  assert.match(result.stderr, /denylist:0/);
  assert.doesNotMatch(result.stdout + result.stderr, /Zorblax|corp\.test/);
});

test('push accepts an allowed tagger and scans the tag message', (t) => {
  const s = sandbox(t);
  assert.equal(s.git('tag', '-a', 'v0', '-m', 'about acme').status, 0);
  assert.equal(s.git('tag', '-a', 'v1', '-m', 'about zorblax').status, 0);
  for (const [tag, status] of [['v0', 0], ['v1', 1]]) {
    const sha = s.git('rev-parse', tag).stdout.trim();
    const input = `refs/tags/${tag} ${sha} refs/tags/${tag} ${'0'.repeat(40)}\n`;
    const result = hook(s, 'push', { input });
    assert.equal(result.status, status);
    assert.doesNotMatch(result.stderr, /identity|zorblax/);
    if (status) assert.match(result.stderr, /denylist:0/);
  }
});

test('push peels nested annotated tags', (t) => {
  const s = sandbox(t);
  s.git('config', 'user.email', 'dev@corp.test'); // cairn-scan:allow-fixture
  assert.equal(s.git('tag', '-a', 'inner', '-m', 'inner').status, 0);
  s.git('config', 'user.email', 't@example.com');
  assert.equal(s.git('tag', '-a', 'outer', '-m', 'outer', 'inner').status, 0);
  const sha = s.git('rev-parse', 'outer').stdout.trim();
  const input = `refs/tags/outer ${sha} refs/tags/outer ${'0'.repeat(40)}\n`;
  const result = hook(s, 'push', { input });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /identity/);
  assert.doesNotMatch(result.stdout + result.stderr, /corp\.test/);
});

test('push scans the tag name embedded in the tag object', (t) => {
  const s = sandbox(t);
  const head = s.git('rev-parse', 'HEAD').stdout.trim();
  const object = `object ${head}\ntype commit\ntag zorblax\ntagger t <t@example.com> 0 +0000\n\nclean\n`;
  const sha = spawnSync('git', ['hash-object', '-t', 'tag', '-w', '--stdin'], { cwd: s.repo, env: s.env, input: object, encoding: 'utf8' }).stdout.trim();
  const input = `refs/tags/v9 ${sha} refs/tags/v9 ${'0'.repeat(40)}\n`;
  const result = hook(s, 'push', { input });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /denylist:0/);
});

test('push keeps object-like message lines and exempts only signature blocks from token rules', (t) => {
  const s = sandbox(t);
  const head = s.git('rev-parse', 'HEAD').stdout.trim();
  const tag = (message) => {
    const email = s.git('config', 'user.email').stdout.trim();
    const object = `object ${head}\ntype commit\ntag v9\ntagger t <${email}> 0 +0000\n\n${message}`;
    const sha = spawnSync('git', ['hash-object', '-t', 'tag', '-w', '--stdin'], { cwd: s.repo, env: s.env, input: object, encoding: 'utf8' }).stdout.trim();
    return hook(s, 'push', { input: `refs/tags/v9 ${sha} refs/tags/v9 ${'0'.repeat(40)}\n` });
  };
  const hex = '1a2b'.repeat(16); // cairn-scan:allow-fixture
  assert.match(tag(`release\nobject ${hex}\n`).stderr, /token/);
  const base64 = 'Zx9Q'.repeat(16); // cairn-scan:allow-fixture
  const signature = `-----BEGIN PGP SIGNATURE-----\n\n${base64}\n=ab12\n-----END PGP SIGNATURE-----\n`;
  assert.equal(tag(`release\n${signature}`).status, 0);
  assert.match(tag(`release\n${signature.replace('=ab12', 'zorblax')}`).stderr, /denylist:0/);
});

test('push finds deleted Unicode file names in history', (t) => {
  const s = sandbox(t);
  writeFileSync(join(s.repo, 'zörblax.md'), 'clean\n');
  s.git('add', '-A');
  assert.equal(s.git('commit', '-q', '--no-verify', '-m', 'add').status, 0);
  s.git('rm', '-q', 'zörblax.md');
  assert.equal(s.git('commit', '-q', '--no-verify', '-m', 'remove').status, 0);
  const result = hook(s, 'push', { input: refInput(s) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /denylist:0/);
  assert.doesNotMatch(result.stdout + result.stderr, /zörblax/);
});

for (const kind of ['binary', 'textconv']) {
  test(`push scans raw ${kind} contents`, (t) => {
    const s = sandbox(t);
    if (kind === 'textconv') {
      const converter = join(s.dir, 'converter');
      writeFileSync(converter, "#!/bin/sh\nprintf 'clean\\n'\n");
      chmodSync(converter, 0o755);
      assert.equal(s.git('config', 'diff.mask.textconv', converter).status, 0);
      writeFileSync(join(s.repo, '.gitattributes'), 'payload.dat diff=mask\n');
    }
    writeFileSync(join(s.repo, 'payload.dat'), kind === 'binary' ? Buffer.from('\0zorblax\n') : 'zorblax\n');
    s.git('add', '-A');
    assert.equal(s.git('commit', '-q', '--no-verify', '-m', 'payload').status, 0);
    const result = hook(s, 'push', { input: refInput(s) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /denylist:0/);
    assert.doesNotMatch(result.stdout + result.stderr, /zorblax/);
  });
}

for (const state of ['advertised', 'unavailable', 'unknown']) {
  test(`push ignores forged tracking refs when remote is ${state}`, (t) => {
    const s = sandbox(t);
    const bare = join(s.dir, 'remote.git');
    if (state !== 'unavailable') {
      const cloned = spawnSync('git', ['clone', '-q', '--bare', s.repo, bare], { env: s.env });
      assert.equal(cloned.status, 0);
      if (state === 'unknown') {
        const tree = s.git('rev-parse', 'HEAD^{tree}').stdout.trim();
        const extra = spawnSync('git', ['--git-dir', bare, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit-tree', tree, '-m', 'remote'], { env: s.env, encoding: 'utf8' });
        assert.equal(extra.status, 0, extra.stderr);
        assert.equal(spawnSync('git', ['--git-dir', bare, 'update-ref', 'refs/heads/other', extra.stdout.trim()], { env: s.env }).status, 0);
      }
    }
    s.git('remote', 'add', 'origin', bare);
    assert.equal(s.git('commit', '-q', '--allow-empty', '--no-verify', '-m', 'zorblax').status, 0);
    assert.equal(s.git('update-ref', 'refs/remotes/origin/forged', 'HEAD').status, 0);
    const result = hook(s, 'push', { input: refInput(s) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /denylist:0/);
    assert.doesNotMatch(result.stdout + result.stderr, /zorblax|fatal:/);
  });
}

test('push excludes history actually advertised by the remote without tracking refs', (t) => {
  const s = sandbox(t);
  assert.equal(s.git('commit', '-q', '--allow-empty', '--no-verify', '-m', 'zorblax').status, 0);
  const bare = join(s.dir, 'remote.git');
  assert.equal(spawnSync('git', ['clone', '-q', '--bare', s.repo, bare], { env: s.env }).status, 0);
  s.git('remote', 'add', 'origin', bare);
  assert.equal(s.git('commit', '-q', '--allow-empty', '--no-verify', '-m', 'clean').status, 0);
  const result = hook(s, 'push', { input: refInput(s) });
  assert.equal(result.status, 0, result.stderr);
});

for (const role of ['author', 'committer']) {
  for (const email of ['other@example.com', '']) {
    test(`push rejects ${email ? 'unapproved' : 'empty'} ${role} identities throughout the range`, (t) => {
      const s = sandbox(t);
      const base = s.git('rev-parse', 'HEAD').stdout.trim();
      const key = `GIT_${role.toUpperCase()}_EMAIL`;
      s.env[key] = email;
      assert.equal(s.git('commit', '-q', '--allow-empty', '--no-verify', '-m', 'earlier').status, 0);
      delete s.env[key];
      assert.equal(s.git('commit', '-q', '--allow-empty', '--no-verify', '-m', 'latest').status, 0);
      for (const remoteSha of ['0'.repeat(40), base]) {
        const input = refInput(s).replace(/0{40}\n$/, `${remoteSha}\n`);
        const result = hook(s, 'push', { input });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /identity/);
        assert.doesNotMatch(result.stdout + result.stderr, /other@example\.com/); // cairn-scan:allow-fixture
      }
    });
  }
}

test('push finds historical content hidden by a blob replacement', (t) => {
  const s = sandbox(t);
  writeFileSync(join(s.repo, 'payload.txt'), 'zorblax\n');
  s.git('add', '-A');
  assert.equal(s.git('commit', '-q', '--no-verify', '-m', 'payload').status, 0);
  const original = s.git('rev-parse', 'HEAD:payload.txt').stdout.trim();
  writeFileSync(join(s.repo, 'payload.txt'), 'clean\n');
  s.git('add', '-A');
  assert.equal(s.git('commit', '-q', '--no-verify', '-m', 'clean').status, 0);
  assert.equal(s.git('replace', original, 'HEAD:payload.txt').status, 0);
  const result = hook(s, 'push', { input: refInput(s) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /denylist:0/);
  assert.doesNotMatch(result.stdout + result.stderr, /zorblax/);
});

test('push honours the fixture marker only in test/ files, not in forged message diffs', (t) => {
  const marked = `${['ali', 'corp.test'].join('@')} // ${['cairn-scan', 'allow-fixture'].join(':')}\n`;
  const s = sandbox(t);
  mkdirSync(join(s.repo, 'test'));
  writeFileSync(join(s.repo, 'test', 'a.mjs'), marked);
  s.git('add', '-A');
  assert.equal(s.git('commit', '-q', '--no-verify', '-m', 'fixture').status, 0);
  assert.equal(hook(s, 'push', { input: refInput(s) }).status, 0);
  const forged = ['subject', '', 'diff --git a/test/f b/test/f', '--- /dev/null', '+++ b/test/f', '@@ -0,0 +1 @@', `+${marked}`].join('\n');
  assert.equal(s.git('commit', '-q', '--allow-empty', '--no-verify', '-m', forged).status, 0);
  assert.equal(hook(s, 'push', { input: refInput(s) }).status, 1);
  writeFileSync(join(s.repo, 'b.mjs'), marked);
  s.git('add', '-A');
  assert.equal(s.git('commit', '-q', '--no-verify', '-m', 'outside').status, 0);
  const result = hook(s, 'push', { input: refInput(s) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /email/);
});

test('push skips reviewed binaries but still reads the next commit message', (t) => {
  const s = sandbox(t);
  // The bytes of a reviewed font can spell an address at random; it is on security/binary-allowlist.txt.
  const font = 'src/styles/fonts/inter-latin-wght-normal.woff2';
  mkdirSync(join(s.repo, 'src/styles/fonts'), { recursive: true });
  writeFileSync(join(s.repo, font), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(' ali@corp.test '), Buffer.from([0])])); // cairn-scan:allow-fixture
  s.git('add', '-A');
  assert.equal(s.git('commit', '-q', '--no-verify', '-m', 'font').status, 0);
  assert.equal(hook(s, 'push', { input: refInput(s) }).status, 0, 'allowlisted binary passes');
  assert.equal(s.git('commit', '-q', '--allow-empty', '--no-verify', '-m', 'about zorblax').status, 0);
  const result = hook(s, 'push', { input: refInput(s) });
  assert.equal(result.status, 1, 'the message after a binary section is still scanned');
  assert.doesNotMatch(result.stdout + result.stderr, /zorblax/);
});
