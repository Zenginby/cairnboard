import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfig, loadConfig, migrate, needsMigration } from '../core/config.mjs';
import { __setFsHooks } from '../core/fsx.mjs';
import { fixedClock, tempData } from './support/env.mjs';

function fixture(t, config = defaultConfig('en')) {
  const root = realpathSync(tempData());
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.cairn'));
  writeFileSync(join(root, '.cairn', 'config.json'), JSON.stringify(config));
  return root;
}

test('default config has stable keys, roles, localized labels and lease', () => {
  for (const [language, labels] of [['en', ['Backlog', 'Doing', 'Review', 'Done']], ['tr', ['Bekleyen', 'Yapılıyor', 'İncelemede', 'Bitti']]]) {
    const config = defaultConfig(language);
    assert.deepEqual(config, {
      formatVersion: 1,
      language,
      columns: ['backlog', 'doing', 'review', 'done'].map((key, index) => ({ key, label: labels[index], role: ['todo', 'doing', 'doing', 'done'][index] })),
      leaseMinutes: 120,
    });
  }
  const config = defaultConfig('en');
  config.columns[0].label = 'Changed';
  assert.equal(defaultConfig('en').columns[0].label, 'Backlog');
  assert.throws(() => defaultConfig('xx'), { code: 'validation' });
});

test('config loads only valid schema and rejects future versions distinctly', (t) => {
  const root = fixture(t);
  assert.deepEqual(loadConfig(root), defaultConfig('en'));
  const file = join(root, '.cairn', 'config.json');
  const valid = defaultConfig('en');
  for (const invalid of [null, [], { ...valid, formatVersion: -1 }, { ...valid, formatVersion: 1.5 },
    { ...valid, language: 'xx' }, { ...valid, columns: [] }, { ...valid, leaseMinutes: 0 },
    { ...valid, leaseMinutes: '120' }, { ...valid, columns: [{ key: 'a', label: 'A', role: 'other' }] },
    { ...valid, columns: [valid.columns[0], valid.columns[0]] }]) {
    writeFileSync(file, JSON.stringify(invalid));
    assert.throws(() => loadConfig(root), { code: 'validation' });
  }
  writeFileSync(file, '{');
  assert.throws(() => loadConfig(root), { code: 'validation' });
  writeFileSync(file, JSON.stringify({ formatVersion: 2 }));
  assert.throws(() => loadConfig(root), { code: 'format_too_new' });
});

test('migration backs up exact config bytes and never overwrites an earlier attempt', (t) => {
  const old = { ...defaultConfig('en'), formatVersion: 0 };
  const root = fixture(t, old);
  const file = join(root, '.cairn', 'config.json');
  const bytes = JSON.stringify(old, null, 4) + '\n';
  writeFileSync(file, bytes);
  const clock = fixedClock('2026-11-01T10:20:30Z');
  const migrations = { 0: (config) => ({ ...config, formatVersion: 1, leaseMinutes: 60 }) };
  assert.ok(needsMigration(loadConfig(root)));
  const first = migrate(root, { migrations, clock });
  assert.equal(first.from, 0);
  assert.equal(first.to, 1);
  assert.equal(first.backup, join(root, '.cairn', 'backup', '2026-11-01T102030-v0'));
  assert.equal(readFileSync(join(first.backup, 'config.json'), 'utf8'), bytes);
  assert.equal(loadConfig(root).leaseMinutes, 60);
  assert.equal(needsMigration(loadConfig(root)), false);
  assert.deepEqual(migrate(root, { migrations, clock }), { from: 1, to: 1, backup: null });
  writeFileSync(file, bytes);
  const second = migrate(root, { migrations, clock });
  assert.notEqual(second.backup, first.backup);
  assert.equal(readFileSync(join(first.backup, 'config.json'), 'utf8'), bytes);
});

test('failed or missing migrations preserve the original configuration', (t) => {
  const root = fixture(t, { ...defaultConfig('en'), formatVersion: 0 });
  const file = join(root, '.cairn', 'config.json');
  const before = readFileSync(file, 'utf8');
  const clock = fixedClock('2026-11-01T10:20:30Z');
  for (const migrations of [{}, { 0() { throw new Error('failed'); } }, { 0: () => ({ formatVersion: 1 }) }]) {
    assert.throws(() => migrate(root, { migrations, clock }));
    assert.equal(readFileSync(file, 'utf8'), before);
  }
});

test('rename failures leave original bytes intact and clean up temporary files', (t) => {
  const root = fixture(t, { ...defaultConfig('en'), formatVersion: 0 });
  const file = join(root, '.cairn', 'config.json');
  const before = readFileSync(file, 'utf8');
  t.after(() => __setFsHooks({}));
  __setFsHooks({ rename(from, to) {
    if (to === file) throw new Error('rename failed');
    renameSync(from, to);
  } });
  assert.throws(() => migrate(root, {
    migrations: { 0: (config) => ({ ...config, formatVersion: 1 }) },
    clock: fixedClock('2026-11-01T10:20:30Z'),
  }), /rename failed/);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(readdirSync(join(root, '.cairn')).sort(), ['backup', 'config.json']);
});

test('migration detects an external edit before replacing configuration', (t) => {
  const root = fixture(t, { ...defaultConfig('en'), formatVersion: 0 });
  const file = join(root, '.cairn', 'config.json');
  const edited = JSON.stringify({ ...defaultConfig('tr'), formatVersion: 0 });
  assert.throws(() => migrate(root, {
    migrations: { 0(config) {
      writeFileSync(file, edited);
      return { ...config, formatVersion: 1 };
    } },
    clock: fixedClock('2026-11-01T10:20:30Z'),
  }), { code: 'conflict' });
  assert.equal(readFileSync(file, 'utf8'), edited);
  assert.deepEqual(readdirSync(join(root, '.cairn')).sort(), ['backup', 'config.json']);
});
