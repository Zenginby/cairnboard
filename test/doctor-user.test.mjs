import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as fs from '../core/fsx.mjs';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { refresh } from '../core/index.mjs';
import { checkData } from '../core/doctor.mjs';
import { tempDir, fixedClock } from './support/env.mjs';
import { runCli } from './support/cli.mjs';

function fixture(t) {
  const home = tempDir(t), dataDir = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(dataDir, { home, env: {}, clock });
  const opts = { dataDir, home, env: {}, clock };
  return { ...opts, opts, config: join(dataDir, '.cairn/config.json'), check: () => checkData(opts) };
}

function snapshot(root, prefix = '') {
  return fs.readdirSync(join(root, prefix)).sort().flatMap((name) => {
    const path = prefix ? `${prefix}/${name}` : name;
    if (/^\.cairn\/index\.db(?:-wal|-shm|-journal)?$/u.test(path)) return [];
    const stat = fs.lstatSync(join(root, path));
    return stat.isDirectory() ? [[path], ...snapshot(root, path)] : [[path, stat.mtimeMs,
      stat.isSymbolicLink() ? fs.readlinkSync(join(root, path)) : fs.readFileSync(join(root, path), 'hex')]];
  });
}

test('doctor reports healthy initialized data without changing sources or metadata', async (t) => {
  const f = fixture(t), before = snapshot(f.dataDir);
  assert.ok(f.check().every((check) => check.ok));
  const result = await runCli(['doctor', '--json'], { home: f.home, data: f.dataDir, clock: f.clock });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.json.ok, true);
  assert.deepEqual(snapshot(f.dataDir), before);
});

test('doctor catches malformed, newer and older configs without migration or recovery', async (t) => {
  const f = fixture(t), config = JSON.parse(fs.readFileSync(f.config, 'utf8'));
  for (const text of ['{bad', JSON.stringify({ ...config, formatVersion: 2 }), JSON.stringify({ ...config, formatVersion: 0 })]) {
    fs.writeFileSync(f.config, text);
    const before = snapshot(f.dataDir);
    const checks = f.check();
    assert.ok(checks.some((check) => !check.ok && check.hint));
    const result = await runCli(['doctor', '--json'], { home: f.home, data: f.dataDir, clock: f.clock });
    assert.equal(result.code, 5, result.stdout);
    assert.equal(result.json.ok, true);
    assert.ok(Array.isArray(result.json.data.checks));
    assert.deepEqual(snapshot(f.dataDir), before);
  }
});

test('doctor reports duplicates, unknown columns, pending intents and lock owners', (t) => {
  const f = fixture(t);
  fs.mkdirSync(join(f.dataDir, 'cards'));
  for (const name of ['acme', 'zorblax']) fs.writeFileSync(join(f.dataDir, `cards/${name}.md`), '---\nid: c-000000\ncolumn: absent\n---\n# Work\n');
  fs.writeFileSync(join(f.dataDir, '.cairn/pending/acme.json'), '{}');
  fs.writeFileSync(join(f.dataDir, '.cairn/locks/acme.lock'), JSON.stringify({ host: 'acme', pid: 1, instance: 'acme', ts: '2026-10-01T00:00:00Z' }));
  const before = snapshot(f.dataDir), checks = f.check();
  for (const name of ['duplicate_id', 'unknown_column', 'pending', 'locks']) assert.ok(checks.some((check) => check.name === name && !check.ok), name);
  assert.match(checks.find((check) => check.name === 'locks').hint, /acme.*2026-10-01/u);
  assert.deepEqual(snapshot(f.dataDir), before);
});

test('doctor reports a stale index and a corrupt database before refreshing it', (t) => {
  const f = fixture(t);
  const ctx = openContext({ ...f.opts, mode: 'read' });
  refresh(ctx);
  fs.mkdirSync(join(f.dataDir, 'notes'));
  fs.writeFileSync(join(f.dataDir, 'notes/acme.md'), '# Acme\n');
  assert.ok(f.check().some((check) => check.name === 'index_fresh' && !check.ok));
  fs.writeFileSync(join(f.dataDir, '.cairn/index.db'), 'broken');
  assert.ok(f.check().some((check) => check.name === 'index_check' && !check.ok));
});

test('doctor reports symlinks without following them', (t) => {
  const f = fixture(t), target = tempDir(t);
  try { fs.symlinkSync(target, join(f.dataDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Symlinks unavailable.');
    throw error;
  }
  const before = snapshot(f.dataDir);
  assert.ok(f.check().some((check) => check.name === 'symlinks' && !check.ok && check.hint.includes('linked')));
  assert.deepEqual(snapshot(f.dataDir), before);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('doctor reports a symlink index as checks instead of throwing', (t) => {
  const f = fixture(t), target = join(f.home, 'index.db');
  fs.writeFileSync(target, 'Keep');
  try { fs.symlinkSync(target, join(f.dataDir, '.cairn/index.db')); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Symlinks unavailable.');
    throw error;
  }
  const checks = f.check();
  assert.ok(checks.some((check) => check.name === 'index_check' && !check.ok));
  assert.equal(fs.readFileSync(target, 'utf8'), 'Keep');
});
