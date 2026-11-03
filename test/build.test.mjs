import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from '../core/fsx.mjs';
import { cliInvocation } from '../core/agent.mjs';
import { runCli } from './support/cli.mjs';
import { tempDir } from './support/env.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('bundle is standalone, matches source schema and runs from quoted Unicode paths', async (t) => {
  const home = tempDir(t), env = { ...process.env, HOME: home, USERPROFILE: home, CAIRN_ACTOR: '', CAIRN_DATA: '' };
  execFileSync(process.execPath, ['scripts/build-cli.mjs'], { cwd: root, env });
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
