import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openContext } from '../core/context.mjs';
import { outlinks } from '../core/index.mjs';
import { wikiIndex, formatCatalog } from '../core/wiki.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { runCli } from './support/cli.mjs';
import { copyVault, snapshot, assertUnchanged } from './support/vault.mjs';

const clock = fixedClock('2026-11-01T12:00:00Z');
const open = (data, home, preset) => openContext({ mode: 'read', dataDir: data, home, env: {}, clock, platform: process.platform, preset });
const cli = (data, home, args) => runCli([...args, '--data', data, '--preset', 'tr-wiki'], { home, cwd: home, clock });

function files(t, entries) {
  const dir = tempDir(t);
  for (const [path, text] of Object.entries(entries)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

test('wikiIndex lists wiki pages only, with first sentence and link counts', (t) => {
  const data = copyVault(t), home = tempDir(t);
  const before = snapshot(data);
  const entries = wikiIndex(open(data, home, 'tr-wiki'));
  assert.deepEqual(entries.map((entry) => entry.path), [
    'wiki/kavramlar/acme-kavrami.md', 'wiki/kavramlar/bos-kaynak.md', 'wiki/kavramlar/bozuk-yaml.md',
    'wiki/projeler/ornek-proje/mimari.md', 'wiki/kavramlar/sistem-1-sistem-2.md', 'wiki/genel-bakis.md',
    'wiki/sorgular/acme-neden.md', 'wiki/projeler/ornek-proje/sorular.md', 'wiki/araclar/zorblax-araci.md']);
  assert.equal(entries.some((entry) => ['kok-notu.md', 'pano.md', 'gorevler.md'].includes(entry.path)), false);
  assert.deepEqual(entries.map((entry) => entry.kind), ['concept', 'concept', 'concept', 'concept', 'concept',
    'overview', 'query', 'query', 'tool']);
  const acme = entries[0];
  assert.deepEqual({ title: acme.title, summary: acme.summary, out: acme.out, in: acme.in },
    { title: 'Acme kavramı', summary: 'Kavram, Zorblax aracı ile birlikte kullanılır.', out: 3, in: 6 });
  const overview = entries.find((entry) => entry.kind === 'overview');
  assert.equal(overview.summary, 'Kasa küçük ve kurmacadır.');
  assert.equal(overview.out, 3);
  assert.equal(entries.find((entry) => entry.path.endsWith('bozuk-yaml.md')).out, 1);
  assert.deepEqual(wikiIndex(open(data, home, 'tr-wiki'), { kind: 'tool' }).map((entry) => entry.path), ['wiki/araclar/zorblax-araci.md']);
  assertUnchanged(before, data);
});

test('summary is the first sentence of the first paragraph after the title, at most 200 characters', (t) => {
  const long = `${'uzun '.repeat(80)}biter. Ikinci cümle.`;
  const data = files(t, {
    'wiki/kavramlar/a.md': '---\ntur: kavram\n---\n# A\n\n## Alt başlık\n\n```\nkod. burada.\n```\n\nİlk cümle [[x|görünen]] ile! İkinci.\nDevam.\n',
    'wiki/kavramlar/b.md': `---\ntur: kavram\n---\n# B\n\n${long}\n`,
    'wiki/kavramlar/c.md': '---\ntur: kavram\n---\n# C\n',
  });
  const entries = new Map(wikiIndex(open(data, tempDir(t), 'tr-wiki')).map((entry) => [entry.title, entry]));
  assert.equal(entries.get('A').summary, 'İlk cümle görünen ile!');
  assert.ok(entries.get('B').summary.length <= 200);
  assert.equal(entries.get('C').summary, '');
});

test('formatCatalog groups by kind with value aliases in tr-wiki and canonical names in default', (t) => {
  const data = copyVault(t), home = tempDir(t);
  const ctx = open(data, home, 'tr-wiki');
  const text = formatCatalog(wikiIndex(ctx), ctx);
  assert.match(text, /^## kavram\n- \[\[acme-kavrami\]\] — Kavram, Zorblax aracı ile birlikte kullanılır\.\n/mu);
  assert.match(text, /^## genel-bakis\n- \[\[genel-bakis\]\] — Kasa küçük ve kurmacadır\.$/mu);
  assert.match(text, /^## sorgu$/mu);
  assert.match(text, /^## arac$/mu);
  assert.match(text, /^- \[\[bos-kaynak\]\] — Kaynağı olmayan kavram sayfası\.$/mu);
  assert.match(text, /^- \[\[mimari\]\] — Örnek projenin mimarisi\.$/mu);
  assert.equal(text.includes('## concept'), false);
  const plain = files(t, { 'wiki/concepts/x.md': '---\nkind: concept\n---\n# X\n\nBir. İki.\n', 'wiki/queries/y.md': '# Y\n' });
  const ctx2 = open(plain, tempDir(t), 'default');
  assert.equal(formatCatalog(wikiIndex(ctx2), ctx2), '## concept\n- [[x]] — Bir.\n\n## query\n- [[y]]\n');
});

test('wiki index command: json envelope, kind filter, markdown, invalid options', async (t) => {
  const data = copyVault(t), home = tempDir(t);
  const before = snapshot(data);
  const all = await cli(data, home, ['wiki', 'index', '--json']);
  assert.equal(all.code, 0, all.stderr);
  assert.equal(all.json.data.items.length, 9);
  const first = all.json.data.items[0];
  assert.deepEqual(Object.keys(first).sort(), ['content', 'in', 'kind', 'out', 'path']);
  assert.deepEqual(first.content, { title: 'Acme kavramı', summary: 'Kavram, Zorblax aracı ile birlikte kullanılır.' });
  assert.equal(JSON.stringify(all.json).includes('"tur"'), false);
  const tools = await cli(data, home, ['wiki', 'index', '--kind', 'tool', '--json']);
  assert.deepEqual(tools.json.data.items.map((item) => item.path), ['wiki/araclar/zorblax-araci.md']);
  const md = await cli(data, home, ['wiki', 'index', '--format', 'markdown']);
  assert.equal(md.code, 0, md.stderr);
  assert.match(md.stdout, /^## kavram\n- \[\[acme-kavrami\]\]/u);
  const mdJson = await cli(data, home, ['wiki', 'index', '--format', 'markdown', '--json']);
  assert.equal(mdJson.json.data.markdown, md.stdout);
  const human = await cli(data, home, ['wiki', 'index']);
  assert.equal(human.code, 0, human.stderr);
  for (const args of [['--kind', 'note'], ['--kind', 'nope'], ['--format', 'xml']]) {
    const bad = await cli(data, home, ['wiki', 'index', ...args, '--json']);
    assert.equal(bad.code, 5, args.join(' '));
    assert.equal(bad.json.error.code, 'validation');
  }
  assertUnchanged(before, data);
});

test('note show adds links and backlinks as paths and counts, no page text beyond the link', async (t) => {
  const data = copyVault(t), home = tempDir(t);
  const before = snapshot(data);
  const shown = await cli(data, home, ['note', 'show', '@wiki/kavramlar/acme-kavrami', '--json']);
  assert.equal(shown.code, 0, shown.stderr);
  const { meta } = shown.json.data;
  assert.deepEqual(meta.links, [
    { expr: '[[zorblax-araci|Zorblax aracı]]', target_path: 'wiki/araclar/zorblax-araci.md', status: 'resolved', line: 9 },
    { expr: '[[acme-makalesi]]', target_path: 'wiki/kaynaklar/acme-makalesi.md', status: 'resolved', line: 5 },
    { expr: '[[acme-makalesi]]', target_path: 'wiki/kaynaklar/acme-makalesi.md', status: 'resolved', line: 13 },
  ].sort((a, b) => a.line - b.line));
  assert.deepEqual(meta.backlinks.map((item) => item.src_path), ['kok-notu.md', 'wiki/araclar/zorblax-araci.md',
    'wiki/genel-bakis.md', 'wiki/gunluk-loglar/2026-10-28.md', 'wiki/kavramlar/bos-kaynak.md', 'wiki/sorgular/acme-neden.md']);
  assert.ok(meta.backlinks.every((item) => Object.keys(item).sort().join() === 'line,src_path'));
  assert.equal(meta.kind, 'concept');
  const unresolved = await cli(data, home, ['note', 'show', '@wiki/kavramlar/sistem-1-sistem-2', '--json']);
  assert.deepEqual(unresolved.json.data.meta.links.map((item) => [item.expr, item.status, item.target_path]),
    [['[[Acme Kavramı]]', 'unresolved', null]]);
  assertUnchanged(before, data);
});

test('note kind is note for an unrecognised kind value in list and show', async (t) => {
  const data = copyVault(t), home = tempDir(t);
  const list = await cli(data, home, ['note', 'list', '--json']);
  assert.equal(list.json.data.items.find((item) => item.path === 'pano.md').meta.kind, 'note');
  const shown = await cli(data, home, ['note', 'show', '@pano', '--json']);
  assert.equal(shown.json.data.meta.kind, 'note');
});

test('link resolution matches file names only (NFC, case-insensitive) and never slugs', (t) => {
  const data = files(t, {
    'Sistem 1 Sistem 2.md': '# Sistem\n', 'sistem-1-sistem-2.md': '# Slug\n', 'x.md': '# X\n', 'Ajanlarla İnceleme.md': '# Ajan\n',
    'wiki/a/Dup.md': '# D1\n', 'wiki/b/dup.md': '# D2\n',
    'src.md': '# Src\n\n[[Sistem 1 Sistem 2]] [[sistem 1 sistem 2]] [[x.md]] [[x|görünen]] [[ajanlarla i̇nceleme]] [[AJANLARLA İNCELEME]] '
      + '[[Sistem-1-Sistem-2]] [[wiki/a/dup]] [[dup]] [[yok]]\n',
  });
  const links = outlinks(open(data, tempDir(t), 'default'), 'src.md');
  const got = links.map((link) => [link.expr, link.status, link.target_path ?? null]);
  assert.deepEqual(got, [
    ['[[Sistem 1 Sistem 2]]', 'resolved', 'Sistem 1 Sistem 2.md'],
    ['[[sistem 1 sistem 2]]', 'resolved', 'Sistem 1 Sistem 2.md'],
    ['[[x.md]]', 'resolved', 'x.md'],
    ['[[x|görünen]]', 'resolved', 'x.md'],
    ['[[ajanlarla i̇nceleme]]', 'resolved', 'Ajanlarla İnceleme.md'],
    ['[[AJANLARLA İNCELEME]]', 'resolved', 'Ajanlarla İnceleme.md'],
    ['[[Sistem-1-Sistem-2]]', 'resolved', 'sistem-1-sistem-2.md'],
    ['[[wiki/a/dup]]', 'resolved', 'wiki/a/Dup.md'],
    ['[[dup]]', 'ambiguous', null],
    ['[[yok]]', 'unresolved', null],
  ]);
  assert.deepEqual(links.find((link) => link.status === 'ambiguous').candidates, ['wiki/a/Dup.md', 'wiki/b/dup.md']);
});
