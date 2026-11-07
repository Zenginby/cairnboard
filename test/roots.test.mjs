import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { fixedClock, tempDir } from './support/env.mjs';
import { findDataDir, findProjectLink, findRepoRoot, initDataDir, stateDir, writeProjectLink } from '../core/roots.mjs';
import { PRESETS } from '../core/presets.mjs';

function fixture(t) {
  const home = tempDir(t, 'cairn-home-');
  return { home, platform: 'darwin', clock: fixedClock('2026-11-01T10:20:30Z') };
}

test('state directories follow each platform convention on any host', () => {
  assert.equal(stateDir({ platform: 'darwin', home: '/acme', env: {} }),
    posix.join('/acme', 'Library', 'Application Support', 'Cairnboard'));
  assert.equal(stateDir({ platform: 'linux', home: '/acme', env: {} }), posix.join('/acme', '.local', 'state', 'cairnboard'));
  assert.equal(stateDir({ platform: 'linux', home: '/acme', env: { XDG_STATE_HOME: '/state' } }), posix.join('/state', 'cairnboard'));
  assert.equal(stateDir({ platform: 'win32', home: 'C:\\acme', env: { LOCALAPPDATA: 'C:\\state' } }), win32.join('C:\\state', 'Cairnboard'));
  assert.equal(stateDir({ platform: 'win32', home: 'C:\\acme', env: {} }), win32.join('C:\\acme', 'AppData', 'Local', 'Cairnboard'));
});

test('data discovery prefers flag, environment, state, then default', (t) => {
  const options = fixture(t);
  const state = stateDir({ ...options, env: {} });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'state.json'), JSON.stringify({ data: join(options.home, 'saved') }));
  const env = { CAIRN_DATA: join(options.home, 'env') };
  assert.deepEqual(findDataDir({ ...options, env, flag: join(options.home, 'flag') }), { path: join(options.home, 'flag'), source: 'flag' });
  assert.deepEqual(findDataDir({ ...options, env }), { path: env.CAIRN_DATA, source: 'env' });
  assert.deepEqual(findDataDir({ ...options, env: {} }), { path: join(options.home, 'saved'), source: 'state' });
  rmSync(join(state, 'state.json'));
  assert.deepEqual(findDataDir({ ...options, env: {} }), { path: join(options.home, 'Cairn'), source: 'default' });
});

test('init and discovery use the same custom XDG state directory', (t) => {
  const options = fixture(t);
  const root = join(options.home, 'data');
  const env = { XDG_STATE_HOME: join(options.home, 'state') };
  initDataDir(root, { ...options, platform: 'linux', env });
  assert.deepEqual(findDataDir({ home: options.home, platform: 'linux', env }), { path: root, source: 'state' });
  assert.deepEqual(JSON.parse(readFileSync(join(env.XDG_STATE_HOME, 'cairnboard', 'state.json'), 'utf8')), { data: root });
});

test('init creates only private metadata and discovery state, and preserves config', (t) => {
  const options = fixture(t);
  const root = join(options.home, 'data');
  const config = initDataDir(root, { ...options, language: 'tr' });
  assert.equal(config.language, 'tr');
  assert.deepEqual(readdirSync(root), ['.cairn']);
  assert.equal(Object.hasOwn(config, 'schema'), false);
  for (const rel of ['.cairn/events', '.cairn/history',
    '.cairn/pending', '.cairn/trash', '.cairn/locks', '.cairn/backup']) {
    assert.ok(statSync(join(root, rel)).isDirectory(), rel);
  }
  if (process.platform !== 'win32') {
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(join(root, '.cairn')).mode & 0o777, 0o700);
  }
  assert.equal(readFileSync(join(root, '.cairn', '.gitignore'), 'utf8'),
    'index.db*\nhistory/\nshadow/\nagents/\npending/\ntrash/\nlocks/\nbackup/\n');
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir({ ...options, env: {} }), 'state.json'), 'utf8')), { data: root });
  const file = join(root, '.cairn', 'config.json');
  const bytes = JSON.stringify({ ...config, leaseMinutes: 45 }, null, 4) + '\n';
  writeFileSync(file, bytes);
  assert.equal(initDataDir(root, { ...options, language: 'en', preset: 'tr-wiki' }).leaseMinutes, 45);
  assert.equal(readFileSync(file, 'utf8'), bytes);
});

test('wiki init saves the preset without creating content folders and preserves existing config bytes', (t) => {
  const options = fixture(t);
  const root = join(options.home, 'data');
  const config = initDataDir(root, { ...options, preset: 'tr-wiki' });
  assert.deepEqual(readdirSync(root), ['.cairn']);
  assert.deepEqual(config.schema, PRESETS['tr-wiki']);
  const file = join(root, '.cairn', 'config.json');
  const bytes = readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(bytes).schema, PRESETS['tr-wiki']);
  assert.deepEqual(initDataDir(root, { ...options, preset: 'default' }), config);
  assert.equal(readFileSync(file, 'utf8'), bytes);
  const invalid = join(options.home, 'invalid');
  assert.throws(() => initDataDir(invalid, { ...options, preset: 'other' }), { code: 'validation' });
  assert.equal(existsSync(invalid), false);
});

test('init preserves existing root permissions and supports spaces, Turkish and NFD paths', (t) => {
  const options = fixture(t);
  const root = join(options.home, 'Proje Notları İş'.normalize('NFD'));
  mkdirSync(root, { mode: 0o750 });
  initDataDir(root, options);
  if (process.platform !== 'win32') assert.equal(statSync(root).mode & 0o777, 0o750);
  const found = findDataDir({ ...options, env: {} });
  assert.equal(found.path.normalize('NFC'), root.normalize('NFC'));
  assert.equal(found.source, 'state');
});

test('init refuses home, filesystem roots, protected paths and unwritable folders', (t) => {
  const options = fixture(t);
  for (const root of [options.home, '/', '/etc', '/private/etc/acme', '/usr/acme', '/bin', '/System', '/Library',
    'C:\\', 'C:\\Windows', 'C:\\Program Files']) {
    assert.throws(() => initDataDir(root, options), { code: 'validation' }, root);
  }
  // Windows ignores POSIX modes, so a read-only folder cannot be built this way there.
  if (process.platform === 'win32') return;
  const root = join(options.home, 'readonly');
  mkdirSync(root, { mode: 0o500 });
  try {
    assert.throws(() => initDataDir(join(root, 'data'), options), { code: 'validation' });
  } finally {
    chmodSync(root, 0o700);
  }
});

test('init rejects a home alias and non-directory metadata with validation errors', (t) => {
  const options = fixture(t);
  symlinkSync(options.home, join(options.home, 'alias'), 'dir');
  assert.throws(() => initDataDir(join(options.home, 'alias'), options), { code: 'validation' });
  const root = join(options.home, 'data');
  mkdirSync(root);
  writeFileSync(join(root, '.cairn'), 'project = p-abc123\n');
  assert.throws(() => initDataDir(root, options), { code: 'validation' });
  assert.equal(readFileSync(join(root, '.cairn'), 'utf8'), 'project = p-abc123\n');
});

test('init refuses a symlink metadata directory without writing outside the data root', (t) => {
  const options = fixture(t);
  const root = join(options.home, 'data');
  const outside = join(options.home, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  symlinkSync(outside, join(root, '.cairn'), 'dir');
  assert.throws(() => initDataDir(root, options), { code: 'unsafe_path' });
});

test('project links are files, directory markers are skipped, nearest link wins', (t) => {
  const { home } = fixture(t);
  const repo = join(home, 'repo');
  const nested = join(repo, 'nested');
  const leaf = join(nested, 'leaf');
  mkdirSync(leaf, { recursive: true });
  assert.equal(findProjectLink(leaf), null);
  writeProjectLink(repo, 'p-abc123');
  assert.equal(readFileSync(join(repo, '.cairn'), 'utf8'), 'project = p-abc123\n');
  mkdirSync(join(nested, '.cairn'));
  assert.equal(findProjectLink(leaf), 'p-abc123');
  assert.throws(() => writeProjectLink(nested, 'p-abc123'), { code: 'validation' });
  writeProjectLink(leaf, 'p-xyz789');
  assert.equal(findProjectLink(leaf), 'p-xyz789');
  assert.throws(() => writeProjectLink(repo, '../oops'), { code: 'validation' });
});

test('repository root uses the nearest git file or directory, otherwise cwd', (t) => {
  const { home } = fixture(t);
  const leaf = join(home, 'repo', 'nested');
  mkdirSync(leaf, { recursive: true });
  assert.equal(findRepoRoot(leaf), leaf);
  mkdirSync(join(home, '.git'));
  assert.equal(findRepoRoot(leaf), home);
  writeFileSync(join(home, 'repo', '.git'), 'gitdir: acme\n');
  assert.equal(findRepoRoot(leaf), join(home, 'repo'));
});
