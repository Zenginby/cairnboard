import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS } from '../core/presets.mjs';
import { classify, resolveSchema } from '../core/schema.mjs';

const wiki = () => resolveSchema({ schema: PRESETS['tr-wiki'] });

test('wiki paths, explicit kinds and flat roots follow classification precedence', () => {
  for (const [rel, data, expected] of [
    ['wiki/kavramlar/x.md', null, { entity: 'note', kind: 'concept' }],
    ['wiki/projeler/a.md', null, { entity: 'project', kind: null }],
    ['wiki/projeler/a/b.md', null, { entity: 'note', kind: 'note' }],
    ['wiki/projeler/a/b.md', { tur: 'sorgu' }, { entity: 'note', kind: 'query' }],
    ['wiki/kaynaklar/k.md', null, { entity: 'research', kind: null }],
    ['pano.md', { tur: 'pano' }, { entity: 'note', kind: 'note', unknownKind: 'pano' }],
    ['kok-notu.md', null, { entity: 'note', kind: 'note' }],
    ['incelemeler/x/y.md', { tur: 'kavram' }, { ignored: true }],
    ['CLAUDE.md', null, { ignored: true }],
    ['graf/z.md', null, { ignored: true }],
    ['rastgele/klasor/q.md', null, { entity: 'note', kind: 'note' }],
  ]) assert.deepEqual(classify(wiki(), rel, data), expected, rel);
});

test('default roots and note folders classify with the longest matching path', () => {
  const schema = resolveSchema({});
  for (const [rel, expected] of [
    ['notes/a.md', { entity: 'note', kind: 'note' }],
    ['wiki/tools/t.md', { entity: 'note', kind: 'tool' }],
    ['research/r.md', { entity: 'research', kind: null }],
    ['cards/a.md', { entity: 'card', kind: null }],
    ['cards/a/b.md', { entity: 'note', kind: 'note' }],
    ['journal/a.md', { entity: 'journal', kind: null }],
    ['journal/a/b.md', { entity: 'note', kind: 'note' }],
    ['projects/a/b.md', { entity: 'note', kind: 'note' }],
    ['wiki/overview.md', { entity: 'note', kind: 'overview' }],
    ['wiki/overview.md/other.md', { entity: 'note', kind: 'note' }],
    ['notes/image.png', { unclassified: true }],
  ]) assert.deepEqual(classify(schema, rel, null), expected, rel);
  schema.roots.project = { path: 'wiki/tools/projects', flat: true };
  assert.deepEqual(classify(schema, 'wiki/tools/projects/a.md', null), { entity: 'project', kind: null });
  assert.deepEqual(classify(schema, 'wiki/tools/projects/a/b.md', null), { entity: 'note', kind: 'note' });
  delete schema.roots.project.flat;
  assert.deepEqual(classify(schema, 'wiki/tools/projects/a/b.md', null), { entity: 'note', kind: 'note' });
  schema.roots.project.flat = false;
  assert.deepEqual(classify(schema, 'wiki/tools/projects/a/b.md', null), { entity: 'project', kind: null });
  schema.kindFolders.query = 'wiki/tools/projects/a';
  assert.deepEqual(classify(schema, 'wiki/tools/projects/a/b.md', null), { entity: 'note', kind: 'query' });
});

test('kind aliases are exact while path comparisons fold case and Unicode form', () => {
  const schema = wiki();
  assert.deepEqual(classify(schema, 'WIKI/KAVRAMLAR/X.MD', null), { entity: 'note', kind: 'concept' });
  assert.deepEqual(classify(schema, 'x.md', { tur: 'Kavram' }), { entity: 'note', kind: 'note', unknownKind: 'Kavram' });
  assert.deepEqual(classify(schema, 'x.md', { kind: 'tool', tur: 'sorgu' }), { entity: 'note', kind: 'tool' });
  assert.deepEqual(classify(schema, 'x.md', { tur: null }), { entity: 'note', kind: 'note', unknownKind: 'null' });
  for (const kind of ['note', 'concept', 'tool', 'query', 'overview', 'source', 'review', 'analysis', 'project', 'journal']) {
    const entity = ['source', 'review', 'analysis'].includes(kind) ? 'research'
      : ['project', 'journal'].includes(kind) ? kind : 'note';
    assert.deepEqual(classify(schema, 'other/deep/x.md', { kind }), { entity, kind });
  }
  schema.kindFolders.concept = 'wiki/öğeler';
  assert.deepEqual(classify(schema, 'WIKI/ÖĞELER/x.md'.normalize('NFD'), null), { entity: 'note', kind: 'concept' });
});

test('ignore supports star and globstar with component boundaries', () => {
  const schema = wiki();
  schema.ignore.push('drafts/*.md', '**/scratch/**');
  schema.catalog = 'catalog.md';
  for (const rel of ['.cairn/x.md', '.git/x.md', '.obsidian/x.md', 'node_modules/x.md', 'INDEX.MD',
    'catalog.md', 'drafts/a.md', 'scratch/a.md', 'wiki/scratch/nested/a.md']) {
    assert.deepEqual(classify(schema, rel, { kind: 'note' }), { ignored: true }, rel);
  }
  for (const rel of ['drafts/nested/a.md', 'mydrafts/a.md', 'wiki/scratches/a.md']) {
    assert.deepEqual(classify(schema, rel, { kind: 'note' }), { entity: 'note', kind: 'note' }, rel);
  }
});
