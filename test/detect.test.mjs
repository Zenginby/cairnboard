import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import * as fs from '../core/fsx.mjs';
import { detectSchema } from '../core/detect.mjs';
import { PRESETS } from '../core/presets.mjs';
import { classify } from '../core/schema.mjs';
import { tempDir } from './support/env.mjs';

function vault(t) {
  const root = tempDir(t);
  const put = (path, text = '# Page\n') => {
    fs.mkdirSync(dirname(join(root, path)), { recursive: true });
    fs.writeFileSync(join(root, path), text);
  };
  return { root, put, detect: (options) => detectSchema(root, options) };
}

for (const [name, notePaths, files] of [
  ['plain', ['Ideas', 'notes', 'Reading/books', 'wiki'], 11],
  ['tagged', ['notes', 'Topics', 'wiki'], 8],
]) test(`${name} fixture proposes only notes, without interpreting tags or task bodies`, () => {
  const result = detectSchema(new URL(`./fixtures/vaults/${name}`, import.meta.url));
  assert.deepEqual(result.schema.roots, { note: { path: notePaths, flat: false } });
  assert.deepEqual(result.schema.fields, {});
  assert.deepEqual(result.schema.values, {});
  assert.deepEqual(result.schema.sourceRoots, []);
  assert.deepEqual(result.suggestions.map(({ target, path }) => [target, path]), [['note', '.']]);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.scanned.files, files);
  assert.equal(classify(result.schema, 'Root.md', {}).entity, 'note');
});

test('daily fixture maps dates, projects and templates with explicit evidence', () => {
  const result = detectSchema(new URL('./fixtures/vaults/daily', import.meta.url));
  assert.deepEqual(result.schema.roots, {
    journal: { path: 'Daily', flat: true }, project: { path: 'Projects', flat: true },
    note: { path: 'Archive', flat: false },
  });
  assert.deepEqual(result.schema.ignore, [...PRESETS.default.ignore, 'Templates/**']);
  assert.deepEqual(result.suggestions.map(({ target, path, confidence }) => [target, path, confidence]), [
    ['ignore', 'Templates', 0.95], ['journal', 'Daily', 1], ['project', 'Projects', 0.9], ['note', '.', 1],
  ]);
  assert.match(result.suggestions.find(({ target }) => target === 'journal').reason, /3\/3/u);
  assert.deepEqual(result.warnings, []);
});

test('journal detection uses at least two files and a 70% filename majority, independent of folder names', (t) => {
  const f = vault(t);
  for (const folder of ['Arbitrary', 'Günlük', 'gunluk-loglar']) {
    for (const day of ['01', '02', '03']) f.put(`${folder}/2026-11-${day}.md`);
    f.put(`${folder}/Extra.md`);
  }
  f.put('Daily/One.md');
  f.put('Single/2026-11-01.md');
  const result = f.detect();
  assert.deepEqual(result.schema.roots.journal.path, ['Arbitrary', 'Günlük', 'gunluk-loglar']);
  assert.equal(result.suggestions.find(({ path }) => path === 'Arbitrary').confidence, 0.75);
  assert.ok(result.warnings.includes('uncertain:Single'));
  assert.ok(!result.suggestions.some(({ path }) => path === 'Daily'));
});

test('project declarations and Turkish field majority map tr-wiki without relying on folder names', (t) => {
  const f = vault(t);
  f.put('Work/A.md', '---\ntur: proje\netiketler: [a]\nguncelleme: today\n---\nBody');
  f.put('Work/B.md', '---\ntur: proje\nkaynaklar: [b]\n---\nBody');
  f.put('Work/C.md', '---\ntype: project\n---\n');
  f.put('Work/D.md');
  f.put('Projeler/E.md');
  f.put('cards/F.md');
  const result = f.detect();
  assert.deepEqual(result.schema.roots.project.path, ['Projeler', 'Work']);
  assert.deepEqual(result.schema.roots.card, { path: 'cards', flat: true });
  assert.deepEqual(result.schema.fields, PRESETS['tr-wiki'].fields);
  assert.deepEqual(result.schema.values, PRESETS['tr-wiki'].values);
  assert.equal(classify(result.schema, 'Work/A.md', { tur: 'proje' }).entity, 'project');
  assert.ok(result.suggestions.every(({ confidence, reason }) => confidence >= 0.7 && reason));
});

test('canonical field ties keep fields and values empty; cards require an explicit cards folder', (t) => {
  const f = vault(t);
  f.put('Tasks/A.md', '---\ntags: [a]\netiketler: [b]\n---\n- [ ] Task');
  assert.deepEqual(f.detect().schema.fields, {});
  assert.deepEqual(f.detect().schema.values, {});
  assert.equal(f.detect().schema.roots.card, undefined);
});

test('raw captures and research records are distinct; uncertain source folders receive warnings', (t) => {
  const f = vault(t);
  f.put('raw/A.md');
  f.put('Clippings/B.md');
  for (const name of ['A', 'B']) {
    f.put(`References/${name}.md`, '---\nurl: https://example.test\n---\n');
    f.put(`kaynaklar/${name}.md`, '---\ntur: kaynak\nham: raw/A.md\n---\n');
    f.put(`Research/${name}.md`, '---\nkind: analysis\n---\n');
    f.put(`sources/${name}.md`);
  }
  const result = f.detect();
  assert.deepEqual(result.schema.sourceRoots, ['Clippings', 'raw', 'References']);
  assert.deepEqual(result.schema.roots.research.path, ['kaynaklar', 'Research']);
  assert.ok(result.warnings.includes('uncertain:sources'));
  assert.equal(classify(result.schema, 'References/A.md', {}).ignored, true);
  assert.equal(classify(result.schema, 'kaynaklar/A.md', {}).entity, 'research');
  assert.match(result.suggestions.find(({ path }) => path === 'References').reason, /raw/u);
  assert.match(result.suggestions.find(({ path }) => path === 'kaynaklar').reason, /records/u);
});

test('competing type evidence and weak majorities do not produce a folder mapping', (t) => {
  const f = vault(t);
  for (const day of ['01', '02', '03']) f.put(`Projects/2026-11-${day}.md`);
  f.put('Mixed/2026-11-01.md');
  f.put('Mixed/2026-11-02.md');
  f.put('Mixed/Other.md');
  f.put('raw/Record.md', '---\nkind: analysis\n---\n');
  f.put('raw/Second.md', '---\nkind: source\n---\n');
  const result = f.detect();
  assert.equal(result.schema.roots.project, undefined);
  assert.equal(result.schema.roots.journal, undefined);
  assert.equal(result.schema.roots.research, undefined);
  assert.ok(!result.suggestions.some(({ path }) => ['Projects', 'Mixed', 'raw'].includes(path)));
  assert.ok(result.warnings.includes('ambiguous:Projects:journal,project'));
  assert.ok(result.warnings.includes('uncertain:Mixed'));
  assert.ok(result.warnings.some((warning) => warning.startsWith('ambiguous:raw:')));
});

test('hidden folders, skipped directories, templates and symlinks are never traversed', (t) => {
  const f = vault(t), outside = vault(t);
  outside.put('2026-11-01.md');
  outside.put('2026-11-02.md');
  for (const folder of ['.hidden', '.obsidian', 'node_modules', '.git', '.cairn', 'Şablonlar', 'templates']) {
    f.put(`${folder}/2026-11-01.md`);
    f.put(`${folder}/2026-11-02.md`);
  }
  f.put('Visible.md');
  fs.symlinkSync(outside.root, join(f.root, 'Daily'), 'dir');
  fs.symlinkSync(join(outside.root, '2026-11-01.md'), join(f.root, 'Link.md'));
  const result = f.detect();
  assert.equal(result.scanned.files, 1);
  assert.equal(result.schema.roots.journal, undefined);
  assert.ok(result.schema.ignore.includes('Şablonlar/**'));
  assert.ok(result.schema.ignore.includes('templates/**'));
});

test('frontmatter reads stop at the delimiter and do not read Markdown bodies or non-Markdown files', (t) => {
  const f = vault(t);
  const prefix = '---\ntags: [a]\n---\n';
  f.put('Page.md', prefix + 'x'.repeat(100000));
  f.put('Blob.txt', 'x'.repeat(100000));
  assert.equal(f.detect().scanned.bytes, Buffer.byteLength(prefix));
});

test('scan limits warn and suppress specialized inferences instead of trusting a partial sample', (t) => {
  const f = vault(t);
  f.put('Projects/A.md', '---\nkind: project\n---\n');
  f.put('Projects/B.md', '---\nkind: project\n---\n');
  for (const limits of [{ files: 1 }, { entries: 1 }, { depth: 0 }, { totalBytes: 5 }]) {
    const result = f.detect({ limits });
    assert.equal(result.scanned.limited, true);
    assert.equal(result.schema.roots.project, undefined);
    assert.ok(result.warnings.some((warning) => warning.includes('limit')));
  }
  const sized = f.detect({ limits: { fileBytes: 1 } });
  assert.equal(sized.scanned.bytes, 0);
  assert.ok(sized.warnings.includes('file_size_limit:Projects/A.md'));
  const header = f.detect({ limits: { frontmatterBytes: 5 } });
  assert.ok(header.warnings.includes('frontmatter_limit_or_unclosed:Projects/A.md'));
});

test('malformed frontmatter is reported without guessing a metadata type', (t) => {
  const f = vault(t);
  f.put('Work/A.md', '---\nkind: [invalid\n---\n');
  f.put('Work/B.md', '---\nkind: [invalid\n---\n');
  const result = f.detect();
  assert.equal(result.schema.roots.project, undefined);
  assert.ok(result.warnings.includes('invalid_frontmatter:Work/A.md'));
});


test('a date-dominated notes folder is never mapped to both journal and note', (t) => {
  const f = vault(t);
  f.put('notes/2026-11-01.md');
  f.put('notes/2026-11-02.md');
  const result = f.detect();
  assert.equal(result.schema.roots.journal.path, 'notes');
  assert.notEqual(result.schema.roots.note.path, 'notes');
  assert.equal(classify(result.schema, 'notes/2026-11-01.md', {}).entity, 'journal');
});

test('detection rejects missing directories, files and a symlink root', (t) => {
  const f = vault(t);
  f.put('Page.md');
  fs.symlinkSync(f.root, join(f.root, 'Link'), 'dir');
  for (const name of ['Missing', 'Page.md', 'Link']) {
    assert.throws(() => detectSchema(join(f.root, name)), { code: 'validation' });
  }
});
