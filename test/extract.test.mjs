import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract } from '../core/extract.mjs';
import { PRESETS } from '../core/presets.mjs';

const schema = PRESETS.default;

test('extract uses visible headings and acceptance items, with stable references', () => {
  const row = extract(schema, 'cards/acme.md', '```md\n# Hidden\n```\n# Visible\n## Acceptance\n- [x] Done\n~~~\n- [ ] Hidden\n~~~\n- [ ] Open\n');
  assert.deepEqual(row, {
    path: 'cards/acme.md', type: 'card', kind: null, id: null, ref: '@cards/acme', title: 'Visible',
    data: {}, body: '```md\n# Hidden\n```\n# Visible\n## Acceptance\n- [x] Done\n~~~\n- [ ] Hidden\n~~~\n- [ ] Open\n',
    acceptance: { done: 1, total: 2 }, error: null, untitled: false, conflicts: [],
  });
  assert.equal(extract(schema, 'notes/fallback.md', 'Text').title, 'fallback');
  assert.equal(extract(schema, 'notes/fallback.md', 'Text').untitled, true);
  assert.deepEqual(extract(PRESETS['tr-wiki'], 'wiki/kavramlar/a.md', '---\ntur: kavram\nkind: concept\n---\n').conflicts, ['kind']);
  assert.equal(extract(schema, 'notes/a.md', '---\nid: n-acme12\ntitle: Named\n---\n# Other').ref, 'n-acme12');
});

test('extract canonicalizes the schema, preserves malformed pages and excludes ignored paths', () => {
  const row = extract(PRESETS['tr-wiki'], 'wiki/kavramlar/a.md', '---\ntur: kavram\netiketler: [acme]\n---\n# Title');
  assert.equal(row.kind, 'concept');
  assert.deepEqual(row.data, { kind: 'concept', tags: ['acme'] });
  assert.equal(extract(schema, 'raw/a.md', '# Hidden'), null);
  assert.equal(extract(schema, 'other/a.md', '# Visible').type, 'note');
  assert.equal(extract(schema, 'notes/a.png', 'image'), null);
  const broken = extract(schema, 'notes/a.md', '---\nsources: ["[[x]]"\n---\n# Still visible');
  assert.equal(broken.title, 'Still visible');
  assert.equal(broken.error, 'invalid_frontmatter');
  assert.equal(extract(schema, 'notes/a.md', '---\nkind: board\n---\n').unknownKind, 'board');
});

test('titles preserve hash characters and accept BOM, CRLF and tilde fences', () => {
  assert.equal(extract(schema, 'notes/a.md', '\uFEFF~~~md\r\n# Hidden\r\n~~~\r\n# C#\r\n').title, 'C#');
  assert.equal(extract(schema, 'notes/a.md', '# Title ###').title, 'Title');
});
