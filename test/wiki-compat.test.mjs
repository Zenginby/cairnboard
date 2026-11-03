import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openContext } from '../core/context.mjs';
import { rows } from '../core/index.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { runCli } from './support/cli.mjs';
import { VAULT, copyVault, snapshot, assertUnchanged } from './support/vault.mjs';

function opened(t) {
  const data = copyVault(t), home = tempDir(t);
  const cli = (args, extra) => runCli([...args, '--data', data, '--preset', 'tr-wiki', '--json'],
    { home, cwd: home, clock: fixedClock('2026-11-01T12:00:00Z'), ...extra });
  return { data, home, cli };
}

// Expected classification (wiki spec §2), path -> [entity type, kind].
const expected = {
  'kok-notu.md': ['note', 'note'],
  'pano.md': ['note', 'note'],
  'gorevler.md': ['note', 'note'],
  'wiki/genel-bakis.md': ['note', 'overview'],
  'wiki/kavramlar/acme-kavrami.md': ['note', 'concept'],
  'wiki/kavramlar/sistem-1-sistem-2.md': ['note', 'concept'],
  'wiki/kavramlar/bos-kaynak.md': ['note', 'concept'],
  'wiki/kavramlar/bozuk-yaml.md': ['note', 'concept'],
  'wiki/araclar/zorblax-araci.md': ['note', 'tool'],
  'wiki/sorgular/acme-neden.md': ['note', 'query'],
  'wiki/kaynaklar/acme-makalesi.md': ['research', 'source'],
  'wiki/kaynaklar/acme-incelemesi.md': ['research', 'source'],
  'wiki/projeler/ornek-proje.md': ['project', 'project'],
  'wiki/projeler/ornek-proje/mimari.md': ['note', 'concept'],
  'wiki/projeler/ornek-proje/sorular.md': ['note', 'query'],
  'wiki/projeler/ornek-proje/turlesiz.md': ['note', 'note'],
  'wiki/gunluk-loglar/2026-10-28.md': ['journal', 'journal'],
};
const notEntities = ['CLAUDE.md', 'AGENTS.md', 'log.md', 'index.md', 'graf/x.md', 'raw/fikirler/x.md', 'raw/arastirma/x.md',
  'incelemeler/2026-10-20-acme/2026-10-20-acme.md'];

test('vault fixture keeps its raw bytes and fictional shape', () => {
  assert.match(readFileSync(join(VAULT, 'raw/arastirma/x.md'), 'utf8'), /\r\n/u);
  assert.equal(readFileSync(join(VAULT, 'wiki/gunluk-loglar/2026-10-28.md'), 'utf8').includes('date:'), false);
  assert.match(readFileSync(join(VAULT, 'wiki/genel-bakis.md'), 'utf8'), /^## Uyanış \(2026-10-28\)$/mu);
  assert.equal(snapshot(VAULT).has('.cairn/config.json'), false);
});

test('note list --all classifies the vault in transient read mode', async (t) => {
  const { data, cli } = opened(t);
  const before = snapshot(data);
  const all = await cli(['note', 'list', '--all']);
  assert.equal(all.code, 0, all.stderr);
  const items = new Map(all.json.data.items.map((item) => [item.path, item.meta.kind]));
  const noteExpected = Object.entries(expected).filter(([, [type]]) => type === 'note');
  assert.deepEqual([...items.keys()].sort(), noteExpected.map(([path]) => path).sort());
  // Unrecognised `tur` values (pano, gorevler) classify as kind note, in the CLI output too.
  for (const [path, [, kind]] of noteExpected) assert.equal(items.get(path), kind, path);
  for (const path of notEntities) assert.equal(items.has(path), false, path);
  const quick = await cli(['note', 'list']);
  assert.deepEqual(quick.json.data.items.map((item) => item.path).sort(), ['gorevler.md', 'kok-notu.md', 'pano.md']
    .concat('wiki/projeler/ornek-proje/turlesiz.md').sort());
  assertUnchanged(before, data);
});

test('every vault page gets the entity type and kind the spec table gives', (t) => {
  const data = copyVault(t), home = tempDir(t);
  const before = snapshot(data);
  const ctx = openContext({ mode: 'read', dataDir: data, home, env: {}, clock: fixedClock('2026-11-01T12:00:00Z'),
    platform: process.platform, preset: 'tr-wiki' });
  const actual = new Map(rows(ctx).map((row) => [row.path, [row.type, row.kind]]));
  assert.deepEqual([...actual.keys()].sort(), Object.keys(expected).sort());
  for (const [path, want] of Object.entries(expected)) assert.deepEqual(actual.get(path), want, path);
  for (const path of notEntities) assert.equal(actual.has(path), false, path);
  assertUnchanged(before, data);
});

test('assertUnchanged detects edits, additions, removals and a .cairn folder', async (t) => {
  const { writeFileSync, rmSync, mkdirSync } = await import('node:fs');
  const data = copyVault(t);
  const before = snapshot(data);
  assertUnchanged(before, data);
  writeFileSync(join(data, 'kok-notu.md'), '# Kök notu\n');
  assert.throws(() => assertUnchanged(before, data));
  writeFileSync(join(data, 'kok-notu.md'), readFileSync(join(VAULT, 'kok-notu.md')));
  assertUnchanged(before, data);
  writeFileSync(join(data, 'yeni.md'), 'x');
  assert.throws(() => assertUnchanged(before, data));
  rmSync(join(data, 'yeni.md'));
  rmSync(join(data, 'log.md'));
  assert.throws(() => assertUnchanged(before, data));
  writeFileSync(join(data, 'log.md'), readFileSync(join(VAULT, 'log.md')));
  mkdirSync(join(data, '.cairn'));
  assert.throws(() => assertUnchanged(before, data), /\.cairn/u);
});

test('wiki lint on the vault reports the expected findings and nothing it should not', async (t) => {
  const { data, cli } = opened(t);
  const before = snapshot(data);
  const result = await cli(['wiki', 'lint']);
  assert.equal(result.code, 0, result.stderr);
  const findings = result.json.data.findings;
  const at = (code) => findings.filter((finding) => finding.code === code);
  const where = (code) => at(code).map((finding) => finding.path).sort();
  assert.deepEqual(where('invalid_frontmatter'), ['wiki/kavramlar/bozuk-yaml.md']);
  assert.deepEqual(at('unknown_kind').map((finding) => [finding.path, finding.content.excerpt]).sort(),
    [['gorevler.md', 'gorevler'], ['pano.md', 'pano']]);
  // `ham: incelemeler/…` is a valid source root, and `[[CLAUDE]]` / `[[log]]` resolve to files outside the pages.
  assert.deepEqual(where('raw_missing'), []);
  assert.deepEqual(where('raw_changed'), []);
  assert.equal(at('broken_link').some((finding) => ['CLAUDE', 'log'].includes(finding.target)), false);
  assert.ok(at('broken_link').some((finding) => finding.path === 'wiki/kavramlar/sistem-1-sistem-2.md' && finding.target === 'Acme Kavramı'));
  // The journal has no date field and is not in the catalog, and is exempt from orphan and catalog checks.
  for (const code of ['orphan', 'index_mismatch', 'missing_frontmatter']) {
    assert.equal(at(code).some((finding) => finding.path.includes('gunluk-loglar')), false, code);
  }
  assert.ok(at('orphan').some((finding) => finding.path === 'wiki/kavramlar/bos-kaynak.md'));
  assert.equal(at('orphan').some((finding) => ['pano.md', 'wiki/genel-bakis.md'].includes(finding.path)), false);
  assert.deepEqual(where('unprocessed_lesson').length > 0, true);
  // Only the kanban board lacks a title (no heading, no field); every other page carries what its kind needs.
  assert.deepEqual(at('missing_frontmatter').map((finding) => [finding.path, finding.target]), [['pano.md', 'title']]);
  assert.deepEqual(where('wakeup_budget'), []);
  assert.ok(at('index_mismatch').some((finding) => finding.path === 'index.md' && finding.target === 'sistem 1 sistem 2'));
  assert.ok(at('index_mismatch').some((finding) => finding.path === 'wiki/sorgular/acme-neden.md'));
  const order = ['error', 'warn', 'info'];
  assert.deepEqual(findings.map((finding) => order.indexOf(finding.severity)), findings.map((finding) => order.indexOf(finding.severity)).sort());
  const strict = await cli(['wiki', 'lint', '--strict', '--only', 'unknown_kind']);
  assert.equal(strict.code, 0);
  assert.equal((await cli(['wiki', 'lint', '--strict', '--only', 'broken_link'])).code, 5);
  assertUnchanged(before, data);
});

test('context on the vault gives the wake-up, hubs and pending counts without touching files', async (t) => {
  const { data, cli } = opened(t);
  const before = snapshot(data);
  const result = await cli(['context']);
  assert.equal(result.code, 0, result.stderr);
  const sections = new Map(result.json.data.sections.map((section) => [section.name, section]));
  assert.equal(sections.get('wakeup').source.path, 'wiki/genel-bakis.md');
  assert.ok(sections.get('wakeup').content.text.length > 0);
  assert.match(sections.get('pending').content.text, /unprocessed_lessons: [1-9]/u);
  assert.ok(sections.has('hubs'));
  assert.match(sections.get('projects').content.text, /ornek-proje|Örnek/iu);
  assert.deepEqual(result.json.warnings, []);
  const human = await runCli(['context', '--data', data, '--preset', 'tr-wiki'], { home: tempDir(t), clock: fixedClock('2026-11-01T12:00:00Z') });
  assert.match(human.stdout, /^# wakeup \(wiki\/genel-bakis\.md\)\n/u);
  assertUnchanged(before, data);
});
