import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PRESETS } from '../core/presets.mjs';
import { classify, destination, fingerprint, isRawPath, physicalPatch, readCanonical, resolveSchema } from '../core/schema.mjs';
import { parseFile, setFields } from '../core/frontmatter.mjs';

const wiki = () => resolveSchema({ schema: PRESETS['tr-wiki'] });

test('presets contain the specified roots, defaults and journal entry labels', () => {
  assert.deepEqual(resolveSchema({}), PRESETS.default);
  assert.deepEqual(PRESETS.default.roots, {
    note: { path: ['notes', 'wiki'], flat: false },
    research: { path: 'research', flat: true }, project: { path: 'projects', flat: true },
    journal: { path: 'journal', flat: true }, card: { path: 'cards', flat: true },
  });
  for (const schema of Object.values(PRESETS)) {
    assert.equal(schema.schemaVersion, 1);
    assert.deepEqual(schema.entryTypes, {
      decision: ['Karar', 'Decision'], discovery: ['Keşif', 'Discovery'],
      pitfall: ['Tuzak', 'Pitfall'], lesson: ['Ders', 'Lesson'],
    });
  }
  assert.equal(PRESETS['tr-wiki'].catalog, 'index.md');
  const schema = resolveSchema({});
  schema.roots.note.path.push('extra');
  assert.deepEqual(PRESETS.default.roots.note.path, ['notes', 'wiki']);
});

test('canonical reads preserve unknown fields, prefer canonical names and map exact values', () => {
  const schema = wiki();
  assert.deepEqual(readCanonical(schema, { tur: 'kavram', etiketler: ['a'] }), { kind: 'concept', tags: ['a'] });
  assert.deepEqual(readCanonical(schema, {
    kind: 'tool', tur: 'sorgu', tags: null, etiketler: ['a'], title: 'A', 'x-extra': true,
    guncelleme: '2026-11-01', kaynaklar: ['a'], ham: 'raw/a.md', kaynak_tarihi: '2026-10-31',
  }), {
    kind: 'tool', tags: null, title: 'A', 'x-extra': true, updated: '2026-11-01',
    sources: ['a'], raw: 'raw/a.md', sourceDate: '2026-10-31',
  });
  assert.deepEqual(readCanonical(schema, { tur: 'Kavram' }), { kind: 'Kavram' });
  assert.deepEqual(readCanonical(schema, null), {});
});

test('physical patches keep existing keys and use preset names and aliases for new fields', () => {
  const schema = wiki();
  assert.deepEqual(physicalPatch(schema, { etiketler: ['a'] }, { tags: ['b'] }), { etiketler: ['b'] });
  assert.deepEqual(physicalPatch(schema, {}, { tags: ['b'], kind: 'concept' }), { etiketler: ['b'], tur: 'kavram' });
  assert.deepEqual(physicalPatch(schema, { tags: ['a'], kind: 'note' }, { tags: ['b'], kind: 'concept' }),
    { tags: ['b'], kind: 'concept' });
  assert.deepEqual(physicalPatch(schema, { tur: 'sorgu' }, { kind: 'tool' }), { tur: 'arac' });
  assert.deepEqual(physicalPatch(schema, null, { kind: 'Concept', title: 'A', tags: undefined }),
    { tur: 'Concept', title: 'A', etiketler: undefined });
  assert.deepEqual(physicalPatch(resolveSchema({}), {}, { tags: ['b'], kind: 'concept' }), { tags: ['b'], kind: 'concept' });
  assert.deepEqual(physicalPatch(schema, {}, { constructor: 'a' }), { constructor: 'a' });
  for (const patch of [{ tags: ['b'] }, { title: 'A' }]) {
    assert.throws(() => physicalPatch(schema, { tags: [], etiketler: [] }, patch), {
      code: 'validation', details: { reason: 'alias_conflict', field: 'tags' },
    });
  }
});

test('physical patches compose with byte-preserving frontmatter edits', () => {
  const schema = wiki();
  const text = '\uFEFF---\r\ntur: kavram # keep\r\netiketler: [a]\r\nx-extra: yes\r\n---\r\n# Başlık\r\n\r\nGövde 😀\r\n';
  const before = parseFile(text);
  const after = setFields(text, physicalPatch(schema, before.data, { kind: 'tool', tags: ['b'] }));
  assert.equal(after, text.replace('kavram # keep', 'arac # keep').replace('[a]', '[b]'));
  assert.equal(parseFile(after).body, before.body);
  assert.deepEqual(classify(schema, 'wiki/kavramlar/a.md', parseFile(after).data), { entity: 'note', kind: 'tool' });
});

test('schema validation rejects duplicate aliases, unsafe paths, raw roots and future versions', () => {
  const invalid = [
    (s) => { s.fields.tags = 'tur'; },
    (s) => { s.roots.note.path = 'raw/pages'; },
    (s) => { s.kindFolders.concept = 'INCELEMELER/pages'; },
    (s) => { s.roots.card.path = ['cards', 'raw']; },
    (s) => { s.roots.note.path = '../notes'; },
    (s) => { s.kindFolders.tool = '/tools'; },
    (s) => { s.sourceRoots = ['../raw']; },
    (s) => { s.roots.card.path = []; },
    (s) => { s.schemaVersion = 0; },
    (s) => { s.schemaVersion = '2'; },
  ];
  for (const change of invalid) {
    const schema = wiki();
    change(schema);
    assert.throws(() => resolveSchema({ schema }), { code: 'validation' });
  }
  const schema = wiki();
  schema.schemaVersion = 2;
  assert.throws(() => resolveSchema({ schema }), { code: 'format_too_new' });
  assert.throws(() => resolveSchema({ schema: null }), { code: 'validation' });
});

test('fingerprints use canonical object ordering and preserve array order', () => {
  const schema = wiki();
  const reorder = (value) => Array.isArray(value) ? value.map(reorder)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
  assert.match(fingerprint(schema), /^[a-f0-9]{16}$/u);
  assert.equal(fingerprint(schema), fingerprint(reorder(schema)));
  assert.notEqual(fingerprint(schema), fingerprint(PRESETS.default));
  assert.equal(fingerprint({ b: 2, a: 1 }), createHash('sha256').update('{"a":1,"b":2}').digest('hex').slice(0, 16));
  const changed = wiki();
  changed.sourceRoots.reverse();
  assert.notEqual(fingerprint(schema), fingerprint(changed));
});

test('destinations choose first roots, note kind folders and fixed overview paths', () => {
  for (const [schema, entity, kind, expected] of [
    [wiki(), 'note', 'note', 'a.md'],
    [wiki(), 'note', 'concept', 'wiki/kavramlar/a.md'],
    [wiki(), 'note', 'overview', 'wiki/genel-bakis.md'],
    [wiki(), 'project', null, 'wiki/projeler/a.md'],
    [wiki(), 'research', 'source', 'wiki/kaynaklar/a.md'],
    [PRESETS.default, 'note', 'note', 'notes/a.md'],
    [PRESETS.default, 'note', 'overview', 'wiki/overview.md'],
    [PRESETS.default, 'card', null, 'cards/a.md'],
  ]) assert.equal(destination(schema, entity, kind, 'a'), expected);
  const schema = wiki();
  schema.roots.project.path = ['projects', 'archive'];
  assert.equal(destination(schema, 'project', null, 'a'), 'projects/a.md');
  for (const slug of ['../escape', 'a/b', '/absolute', 'CON', '']) {
    assert.throws(() => destination(schema, 'note', 'note', slug), { code: 'validation' }, slug);
  }
});

test('raw paths include configured source roots with case and Unicode normalization', () => {
  const schema = wiki();
  schema.sourceRoots.push('kaynak/öğe');
  for (const rel of ['raw/a.md', 'RAW/deep/a.md', 'incelemeler/a.md', 'kaynak/öğe/a.md'.normalize('NFD')]) {
    assert.equal(isRawPath(schema, rel), true, rel);
  }
  for (const rel of ['rawish/a.md', 'wiki/raw/a.md', 'incelemeler-x/a.md', 'notes/a.md']) {
    assert.equal(isRawPath(schema, rel), false, rel);
  }
});

test('quick notes sit at the data root only when the note root holds the kind folders', () => {
  const custom = structuredClone(PRESETS['tr-wiki']);
  custom.roots.note.path = 'kasa';
  custom.kindFolders = { concept: 'kasa/kavramlar' };
  assert.equal(destination(resolveSchema({ schema: custom }), 'note', 'note', 'a'), 'a.md');
  custom.kindFolders = { concept: 'sayfalar/kavramlar' };
  assert.equal(destination(resolveSchema({ schema: custom }), 'note', 'note', 'a'), 'kasa/a.md');
});
