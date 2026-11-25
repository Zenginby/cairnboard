import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from '../core/fsx.mjs';
import { cliInvocation, packageVersion } from '../core/agent.mjs';
import { findDataDir, initDataDir } from '../core/roots.mjs';
import { runCli } from './support/cli.mjs';
import { tempDir } from './support/env.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
before(() => execFileSync(process.execPath, ['scripts/build-cli.mjs'], { cwd: root }));

test('bundle is standalone, matches source schema and runs from quoted Unicode paths', async (t) => {
  const home = tempDir(t), env = { ...process.env, HOME: home, USERPROFILE: home, CAIRN_ACTOR: '', CAIRN_DATA: '' };
  const source = await runCli(['schema', '--json'], { home });
  const bundled = JSON.parse(execFileSync(process.execPath, ['dist/cairn.mjs', 'schema', '--json'], { cwd: root, env, encoding: 'utf8' }));
  assert.deepEqual(bundled, source.json);
  assert.match(fs.readFileSync(join(root, 'dist/cairn.mjs'), 'utf8'), /^#!\/usr\/bin\/env node\n/u);
  const repoRoot = join(tempDir(t), 'Proje Notları'.normalize('NFD'));
  fs.mkdirSync(join(repoRoot, 'dist'), { recursive: true });
  for (const name of ['cairn.mjs', 'cairn-main.mjs']) fs.copyFileSync(join(root, 'dist', name), join(repoRoot, 'dist', name));
  const command = `${cliInvocation(repoRoot)} schema --json`;
  const output = process.platform === 'win32'
    ? execFileSync(process.execPath, [join(repoRoot, 'dist/cairn.mjs'), 'schema', '--json'], { env, encoding: 'utf8' })
    : execFileSync('sh', ['-c', command], { env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), source.json);
  if (process.platform !== 'win32') {
    const specialRoot = join(dirname(repoRoot), 'acme "$`');
    fs.mkdirSync(join(specialRoot, 'dist'), { recursive: true });
    for (const name of ['cairn.mjs', 'cairn-main.mjs']) fs.copyFileSync(join(root, 'dist', name), join(specialRoot, 'dist', name));
    assert.deepEqual(JSON.parse(execFileSync('sh', ['-c', `${cliInvocation(specialRoot)} schema --json`], { env, encoding: 'utf8' })), source.json);
  }
  const refused = await runCli(['agent', 'install', '--json'], { home });
  assert.equal(refused.code, 7, refused.stdout + refused.stderr);
  const preview = await runCli(['agent', 'install', '--dry-run', '--json'], { home });
  assert.equal(preview.code, 0, preview.stdout + preview.stderr);
  assert.deepEqual(fs.readdirSync(home), []);
  const installed = await runCli(['agent', 'install', '--json'], { home, isTTY: true, stdin: 'yes\n' });
  assert.equal(installed.code, 0, installed.stdout + installed.stderr);
  assert.equal(installed.json.data.length, 2);
  assert.match(installed.stderr, /new/u);
  assert.ok(installed.stderr.indexOf('(new)') < installed.stderr.indexOf('Type yes'));
  assert.equal((await runCli(['agent', 'install', '--target', 'unknown', '--dry-run', '--json'], { home })).code, 2);
  const otherHome = tempDir(t);
  const response = JSON.parse(execFileSync(process.execPath, [join(repoRoot, 'dist/cairn.mjs'), 'agent', 'print', '--json'], {
    env: { ...env, HOME: otherHome, USERPROFILE: otherHome }, encoding: 'utf8',
  }));
  assert.ok(response.data.includes(cliInvocation(repoRoot)));
  fs.renameSync(join(repoRoot, 'dist/cairn.mjs'), join(repoRoot, 'dist/moved.mjs'));
  const missing = spawnSync(process.execPath, [join(repoRoot, 'dist/cairn-main.mjs'), 'agent', 'install', '--json'], {
    env: { ...env, HOME: otherHome, USERPROFILE: otherHome }, encoding: 'utf8',
  });
  assert.equal(missing.status, 5, missing.stdout + missing.stderr);
  assert.equal(JSON.parse(missing.stdout).error.code, 'validation');
  assert.ok(JSON.parse(missing.stdout).error.message.includes('npm run build:cli'));
  assert.deepEqual(fs.readdirSync(otherHome), []);
});

function launcher(t, { built = true, cached = false } = {}) {
  const cwd = tempDir(t), home = tempDir(t);
  const installed = cached ? join(cwd, '_npx', 'cache', 'node_modules', 'cairnboard') : join(cwd, 'cairnboard');
  const dist = join(installed, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  for (const name of ['cairn.mjs', 'cairnboard.mjs', 'cairn-main.mjs']) {
    fs.copyFileSync(join(root, 'dist', name), join(dist, name));
  }
  if (process.platform !== 'win32') fs.symlinkSync('cairnboard.mjs', join(dist, 'cairnboard'));
  if (built) {
    fs.mkdirSync(join(dist, 'app/server'), { recursive: true });
    fs.writeFileSync(join(dist, 'app/server/entry.mjs'), '');
    fs.mkdirSync(join(installed, 'server'));
    fs.writeFileSync(join(installed, 'server/start.mjs'), `
console.log(JSON.stringify({ data: process.env.CAIRN_DATA, args: process.argv.slice(2) }));
process.exitCode = 23;
`);
  }
  const run = (args, { bin = 'cairn.mjs', locale = 'en-US', env = {} } = {}) => {
    // ICU gets the default locale from different places on different operating systems.
    const setup = `Intl.DateTimeFormat.prototype.resolvedOptions = () => ({ locale: ${JSON.stringify(locale)} });`;
    return spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(setup)}`,
      join(dist, bin), ...args], { cwd, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, CAIRN_DATA: undefined, CAIRN_ACTOR: undefined,
        XDG_STATE_HOME: undefined, LOCALAPPDATA: undefined, ...env } });
  };
  return { cwd, home, path: join(home, 'Cairn'), run };
}

const childOutput = (result) => JSON.parse(result.stdout.trimEnd().split('\n').at(-1));
const languageAt = (path) => JSON.parse(fs.readFileSync(join(path, '.cairn/config.json'), 'utf8')).language;

test('start initializes and registers the default folder, forwards flags and returns the server exit code', (t) => {
  const { home, path, run } = launcher(t);
  const started = run(['start', '--no-open', '--language', 'tr']);
  assert.equal(started.status, 23, started.stderr);
  assert.deepEqual(childOutput(started), { data: path, args: ['--no-open'] });
  assert.deepEqual(findDataDir({ home, env: {} }), { path, source: 'state' });
  assert.equal(languageAt(path), 'tr');
  const [created] = started.stdout.split('\n');
  assert.ok(created.includes(path));
  assert.match(created, /--data <path>/u);
  const restarted = run(['start', '--language', 'en']);
  assert.equal(restarted.status, 23, restarted.stderr);
  assert.doesNotMatch(restarted.stdout, /Created/u);
  assert.equal(languageAt(path), 'tr');
});

test('no-argument cairnboard dispatches to start and picks the language from the locale', (t) => {
  for (const [locale, language] of [['tr-TR', 'tr'], ['de-DE', 'en']]) {
    const { home, path, run } = launcher(t);
    const bin = process.platform === 'win32' ? 'cairnboard.mjs' : 'cairnboard';
    const version = run(['--version'], { bin });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), packageVersion);
    const help = run([]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^Usage: cairn/u);
    assert.deepEqual(fs.readdirSync(home), []);
    const started = run([], { bin, locale });
    assert.equal(started.status, 23, started.stderr);
    assert.deepEqual(childOutput(started), { data: path, args: [] });
    assert.equal(languageAt(path), language);
  }
});

test('start checks for the prebuilt app before creating any data', (t) => {
  const { home, run } = launcher(t, { built: false });
  const result = run(['start']);
  assert.equal(result.status, 5, result.stderr);
  assert.match(result.stderr, /npm run build:app/u);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('start leaves a non-Cairnboard default folder untouched and advises using --data', (t) => {
  const { home, path, run } = launcher(t);
  fs.mkdirSync(path);
  fs.writeFileSync(join(path, 'keep.md'), 'Keep this.');
  const result = run(['start']);
  assert.equal(result.status, 5, result.stderr);
  assert.match(result.stderr, /already exists.*--data/u);
  assert.deepEqual(fs.readdirSync(home), ['Cairn']);
  assert.deepEqual(fs.readdirSync(path), ['keep.md']);
  assert.equal(fs.readFileSync(join(path, 'keep.md'), 'utf8'), 'Keep this.');
});

test('start prefers an explicit data path and does not register it as the default', (t) => {
  const { cwd, home, run } = launcher(t);
  const data = join(cwd, 'my data');
  initDataDir(data, { home, register: false });
  const started = run(['start', '--data', 'my data'], { env: { CAIRN_DATA: 'fallback' } });
  assert.equal(started.status, 23, started.stderr);
  assert.deepEqual(childOutput(started), { data, args: [] });
  const fromEnv = run(['start'], { env: { CAIRN_DATA: 'my data' } });
  assert.equal(fromEnv.status, 23, fromEnv.stderr);
  assert.deepEqual(childOutput(fromEnv), { data, args: [] });
  assert.deepEqual(fs.readdirSync(home), []);
});

test('agent setup from an npx cache exits 2 before previewing or writing skills and hooks', (t) => {
  const { home, run } = launcher(t, { cached: true });
  for (const args of [['install'], ['install', '--hooks'], ['check']]) {
    const result = run(['agent', ...args, '--json']);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    const { error } = JSON.parse(result.stdout);
    assert.equal(error.code, 'usage');
    assert.match(error.message, /npm i -g cairnboard.*cairn agent install/u);
    assert.equal(result.stderr, '');
    assert.deepEqual(fs.readdirSync(home), []);
  }
});
