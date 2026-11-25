import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeAppPortable } from '../scripts/lib/package-paths.mjs';
import { tempDir } from './support/env.mjs';

test('the portable build preserves the client and server layout in an external output folder', (t) => {
  const scratch = tempDir(t), root = join(scratch, 'build root'), out = join(scratch, 'outside build');
  const server = join(out, 'server');
  mkdirSync(root);
  mkdirSync(server, { recursive: true });
  const manifest = join(server, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({
    root: pathToFileURL(root).href + '/',
    client: pathToFileURL(join(out, 'client')).href + '/',
    server: pathToFileURL(server).href + '/',
    sources: [root.replaceAll('\\', '/'), root.replaceAll('/', '\\')],
  }));
  makeAppPortable(root, out);
  const built = JSON.parse(readFileSync(manifest, 'utf8'));
  assert.equal(built.root, 'file:///C:/cairnboard/');
  assert.equal(built.client, 'file:///C:/cairnboard/dist/app/client/');
  assert.equal(built.server, 'file:///C:/cairnboard/dist/app/server/');
  assert.deepEqual(built.sources, ['/C:/cairnboard', 'C:\\cairnboard']);
  const onWindows = (url) => fileURLToPath(url, { windows: true });
  assert.equal(win32.relative(onWindows(built.server), onWindows(built.client)), '..\\client');
});

test('the build fails if a client file still refers to the build root', (t) => {
  const root = tempDir(t), out = join(root, 'dist/app');
  mkdirSync(join(out, 'server'), { recursive: true });
  mkdirSync(join(out, 'client'));
  writeFileSync(join(out, 'client/main.js'), pathToFileURL(root).href);
  assert.throws(() => makeAppPortable(root, out), /Local build or home path found in client[\\/]main\.js/u);
});

test('the tarball guard checks required entry points and scans even binary files for the home path', (t) => {
  const scratch = tempDir(t), home = tempDir(t), pkg = join(scratch, 'package');
  const archive = join(scratch, 'fixture.tgz');
  mkdirSync(join(pkg, 'dist/app/server'), { recursive: true });
  const smoke = fileURLToPath(new URL('../scripts/pack-smoke.mjs', import.meta.url));
  const check = () => {
    execFileSync('tar', ['-czf', archive, '-C', scratch, 'package']);
    return spawnSync(process.execPath, [smoke, '--tarball', archive], {
      env: { ...process.env, HOME: home, USERPROFILE: home, npm_execpath: join(scratch, 'unused.mjs') },
      encoding: 'utf8', timeout: 10_000,
    });
  };
  const missing = check();
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /Tarball is missing dist\/cairn\.mjs/u);
  for (const file of ['cairn.mjs', 'cairnboard.mjs', 'app/server/entry.mjs']) {
    writeFileSync(join(pkg, 'dist', file), '');
  }
  writeFileSync(join(pkg, 'leak.bin'), Buffer.concat([Buffer.of(255), Buffer.from(home)]));
  const leak = check();
  assert.equal(leak.status, 1, leak.stderr);
  assert.match(leak.stderr, /Local build or home path found in package[\\/]leak\.bin/u);
});
