import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import * as fs from '../core/fsx.mjs';
import { openContext } from '../core/context.mjs';
import { readFile } from '../core/store.mjs';
import { refresh } from '../core/index.mjs';
import { parseFile } from '../core/frontmatter.mjs';
import * as note from '../core/note.mjs';
import { create, update, remove, resolve } from '../core/entity.mjs';
import { fixedClock, seedDataDir, tempDir } from './support/env.mjs';

function fixture(t, preset = 'default') {
  const root = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  seedDataDir(root, { home, env: {}, clock, preset });
  return openContext({ mode: 'write', dataDir: root, home, env: {}, clock });
}

function put(ctx, path, text) {
  fs.mkdirSync(dirname(join(ctx.root, path)), { recursive: true });
  fs.writeFileSync(join(ctx.root, path), text);
  refresh(ctx);
}

for (const preset of ['default', 'tr-wiki']) {
  test(`${preset} routes note kinds and lists quick notes separately`, (t) => {
    const ctx = fixture(t, preset);
    const concept = note.create(ctx, { title: 'Acme', kind: 'concept' }).entity;
    assert.equal(concept.path, preset === 'default' ? 'wiki/concepts/acme.md' : 'wiki/kavramlar/acme.md');
    assert.equal(concept.kind, 'concept');
    assert.equal(concept.data.kind, 'concept');
    assert.equal(concept.data.pinned, false);
    assert.deepEqual(concept.data.tags, []);
    if (preset === 'tr-wiki') {
      assert.match(readFile(ctx, concept.path).text, /tur: kavram\n/u);
      assert.equal(Object.hasOwn(concept.data, 'tur'), false);
    }
    const quick = note.create(ctx, { title: 'Quick' }).entity;
    assert.equal(quick.path, preset === 'default' ? 'notes/quick.md' : 'quick.md');
    note.create(ctx, { title: 'Tool', kind: 'tool', pinned: true });
    assert.deepEqual(note.list(ctx).map(({ kind }) => kind), ['note']);
    assert.deepEqual(note.list(ctx, { kind: 'tool' }).map(({ kind }) => kind), ['tool']);
    assert.equal(note.list(ctx, { all: true }).length, 3);
    const overview = note.create(ctx, { title: 'Overview', kind: 'overview' }).entity;
    assert.equal(overview.path, preset === 'default' ? 'wiki/overview.md' : 'wiki/genel-bakis.md');
    assert.throws(() => note.create(ctx, { title: 'Other', kind: 'overview' }), { code: 'validation' });
    assert.throws(() => note.update(ctx, quick.id, { kind: 'overview' }), { code: 'validation' });
  });
}

test('physical aliases update in place and alias conflicts block updates and deletion', (t) => {
  const ctx = fixture(t, 'tr-wiki');
  put(ctx, 'manual.md', '---\netiketler: [old] # keep\nx-extra: yes\n---\n# Manual\r\nText\r\n');
  const ref = note.show(ctx, '@manual').ref;
  note.update(ctx, ref, { tags: ['new'] });
  const text = readFile(ctx, 'manual.md').text;
  assert.match(text, /etiketler: \[new\]\n/u);
  assert.doesNotMatch(text, /^tags:/mu);
  assert.doesNotMatch(text, /^id:/mu);
  assert.equal(note.show(ctx, ref).ref, ref);
  assert.equal(note.show(ctx, ref).id, null);
  assert.match(text, /x-extra: yes\n/u);
  assert.equal(parseFile(text).body, '# Manual\r\nText\r\n');
  put(ctx, 'conflict.md', '---\ntags: []\netiketler: []\n---\n# Conflict\n');
  for (const mutate of [() => note.update(ctx, '@conflict', { tags: ['new'] }), () => note.remove(ctx, '@conflict')]) {
    assert.throws(mutate, (error) => error.code === 'validation' && error.details.reason === 'alias_conflict');
  }
});

for (const preset of ['default', 'tr-wiki']) {
  test(`${preset} note updates preserve external ids and path-derived keys`, (t) => {
    const ctx = fixture(t, preset);
    put(ctx, 'notes/external.md', '---\nid: zettel-42 # external\n---\n# External\n');
    const before = note.show(ctx, '@notes/external');
    assert.equal(before.id, null);
    assert.match(before.ref, /^n-[0-9a-f]{16}$/u);
    note.update(ctx, before.ref, { title: 'Updated' }, { body: 'New body' });
    const after = note.show(ctx, before.ref);
    assert.equal(after.ref, before.ref);
    assert.equal(after.id, null);
    assert.equal(after.data.id, 'zettel-42');
    assert.equal(after.title, 'Updated');
    assert.equal(after.body, 'New body');
    assert.match(readFile(ctx, before.path).text, /^id: zettel-42 # external$/mu);
  });
}

test('other entity updates assign missing ids but never overwrite existing ones', (t) => {
  const ctx = fixture(t);
  for (const [type, folder] of [['project', 'projects'], ['card', 'cards'], ['research', 'research']]) {
    const path = `${folder}/manual.md`, ref = `@${folder}/manual`;
    put(ctx, path, '# Manual\n');
    update(ctx, type, ref, { title: 'Updated' });
    assert.ok(resolve(ctx, type, ref).id);
    put(ctx, path, '---\nid: zettel-42\n---\n# Manual\n');
    update(ctx, type, ref, { title: 'Updated' });
    assert.match(readFile(ctx, path).text, /^id: zettel-42$/mu);
    for (const value of ['42', 'null', '']) {
      const text = `---\nid: ${value}\n---\n# Manual\n`;
      put(ctx, path, text);
      assert.throws(() => update(ctx, type, ref, { title: 'Updated' }), { code: 'validation' });
      assert.equal(readFile(ctx, path).text, text);
    }
  }
});

test('ephemeral root notes use the external cache without writing into the source root', (t) => {
  const root = tempDir(t), home = tempDir(t);
  fs.writeFileSync(join(root, 'manual.md'), '# Manual\n');
  const ctx = openContext({ mode: 'read', dataDir: root, home, env: {}, preset: 'tr-wiki' });
  assert.match(note.list(ctx)[0].ref, /^n-[0-9a-f]{16}$/u);
  assert.equal(note.show(ctx, '@manual').body, '# Manual\n');
  assert.deepEqual(fs.readdirSync(root), ['manual.md']);
});

test('raw sources cannot be created, updated or removed as entities', (t) => {
  const ctx = fixture(t);
  put(ctx, 'raw/x.md', '# Raw\n');
  for (const type of ['note', 'research']) {
    assert.throws(() => resolve(ctx, type, '@raw/x'), { code: 'not_found' });
    assert.throws(() => update(ctx, type, '@raw/x', { title: 'New' }), { code: 'validation' });
    assert.throws(() => remove(ctx, type, '@raw/x'), { code: 'validation' });
    const schema = structuredClone(ctx.schema);
    schema.roots[type].path = 'raw';
    if (type === 'note') schema.quickNotes = 'raw';
    assert.throws(() => create({ ...ctx, schema }, type, { title: 'X' }), { code: 'validation' });
  }
  assert.equal(readFile(ctx, 'raw/x.md').text, '# Raw\n');
});
