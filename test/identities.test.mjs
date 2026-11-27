import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedGitEnv } from './support/git.mjs';

const reader = new URL('../security/identities.mjs', import.meta.url).href;

function setup(t) {
  const home = mkdtempSync(join(tmpdir(), 'cairn-ident-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = join(home, 'repo');
  const env = isolatedGitEnv(home);
  const git = (...args) => execFileSync('git', args, { cwd: home, env, encoding: 'utf8' });
  git('init', '-q', repo);
  const load = (options, extraEnv = {}) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { loadIdentities } = await import(${JSON.stringify(reader)});
     const r = loadIdentities(${JSON.stringify({ cwd: repo, ...options })});
     console.log(JSON.stringify({ local: r.local, allowed: [...r.allowed].sort() }));`],
  { cwd: repo, env: { ...env, ...extraEnv }, encoding: 'utf8' }));
  return { home, repo, git, load };
}

test('hooks accept a global-only commit identity; release:check reads only the repository setting', (t) => {
  const { git, load } = setup(t);
  git('config', '--global', 'user.email', 'g@users.noreply.github.com');
  assert.deepEqual(load({ anyScope: true }).allowed, ['g@users.noreply.github.com']);
  assert.deepEqual(load({}).allowed, []);
});

test('an included repository identity stays allowed when a broader setting overrides it', (t) => {
  const { home, repo, git, load } = setup(t);
  const include = join(home, 'inc.cfg');
  writeFileSync(include, '[user]\n\temail = r@users.noreply.github.com\n');
  git('-C', repo, 'config', '--local', 'include.path', include);
  // A command-scope setting stands in for any override above the repository file (worktree, -c, wrappers).
  const override = {
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.email', GIT_CONFIG_VALUE_0: 'w@users.noreply.github.com',
  };
  const result = load({ anyScope: true }, override);
  assert.deepEqual(result.allowed, ['r@users.noreply.github.com', 'w@users.noreply.github.com']);
});

test('an inherited GIT_CONFIG does not block the repository lookup', (t) => {
  const { home, repo, git, load } = setup(t);
  git('-C', repo, 'config', '--local', 'user.email', 'r@users.noreply.github.com');
  git('config', '--global', 'user.email', 'g@users.noreply.github.com');
  const override = {
    GIT_CONFIG: join(home, 'empty.cfg'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.email', GIT_CONFIG_VALUE_0: 'w@users.noreply.github.com',
  };
  const expected = ['r@users.noreply.github.com', 'w@users.noreply.github.com'];
  assert.deepEqual(load({ anyScope: true }, override).allowed, expected);
});
