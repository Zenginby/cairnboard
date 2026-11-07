import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import * as fs from '../core/fsx.mjs';
import { DETECT_LIMITS, detectSchema, extendDetection } from '../core/detect.mjs';
import { PRESETS } from '../core/presets.mjs';
import { classify, destination, resolveSchema } from '../core/schema.mjs';
import { tempDir } from './support/env.mjs';

function vault(t) {
  const root = tempDir(t);
  const put = (path, text = '# Page\n') => {
    fs.mkdirSync(dirname(join(root, path)), { recursive: true });
    fs.writeFileSync(join(root, path), text);
  };
  return { root, put, detect: (options) => detectSchema(root, options) };
}

for (const [name, files] of [
  ['plain', 11], ['tagged', 8],
]) test(`${name} fixture proposes only notes, without interpreting tags or task bodies`, () => {
  const result = detectSchema(new URL(`./fixtures/vaults/${name}`, import.meta.url));
  assert.deepEqual(result.schema.roots, { note: { path: ['notes', 'wiki'], flat: false } });
  assert.deepEqual(result.schema.fields, {});
  assert.deepEqual(result.schema.values, {});
  assert.deepEqual(result.schema.sourceRoots, []);
  assert.deepEqual(result.suggestions.map(({ target, path }) => [target, path]), [['note', 'notes'], ['note', 'wiki']]);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.scanned.files, files);
  assert.equal(classify(result.schema, 'Root.md', {}).entity, 'note');
});

test('daily fixture maps dates, projects and templates with explicit evidence', () => {
  const result = detectSchema(new URL('./fixtures/vaults/daily', import.meta.url));
  assert.deepEqual(result.schema.roots, {
    journal: { path: 'Daily', flat: true }, project: { path: 'Projects', flat: true },
    note: { path: ['notes', 'wiki'], flat: false },
  });
  assert.deepEqual(result.schema.ignore, [...PRESETS.default.ignore, 'Templates/**']);
  assert.deepEqual(result.suggestions.map(({ target, path, confidence }) => [target, path, confidence]), [
    ['ignore', 'Templates', 0.95], ['journal', 'Daily', 1], ['project', 'Projects', 0.9],
    ['note', 'notes', 1], ['note', 'wiki', 1],
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

test('reads a bounded Markdown prefix and parses only frontmatter, never body or non-Markdown metadata', (t) => {
  const f = vault(t);
  const prefix = '---\ntags: [a]\n---\n';
  f.put('Page.md', prefix + '---\ntur: proje\n---\n' + 'x'.repeat(100000));
  f.put('Blob.txt', 'x'.repeat(100000));
  const result = f.detect();
  assert.equal(result.scanned.bytes, DETECT_LIMITS.frontmatterBytes);
  assert.deepEqual(result.schema.fields, {});
  assert.deepEqual(result.warnings, []);
  assert.equal(f.detect({ limits: { frontmatterBytes: 32 } }).scanned.bytes, 32);
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

test('root note paths are unsupported; default folders and the note destination stay consistent', () => {
  for (const path of ['', '.']) {
    const schema = structuredClone(PRESETS.default);
    schema.roots.note = { path, flat: false };
    assert.throws(() => resolveSchema({ schema }), { code: 'validation' });
  }
  for (const name of ['daily', 'plain', 'tagged']) {
    const { schema, suggestions } = detectSchema(new URL(`./fixtures/vaults/${name}`, import.meta.url));
    assert.deepEqual(schema.roots.note, PRESETS.default.roots.note);
    assert.equal(schema.quickNotes, 'notes');
    assert.equal(destination(schema, 'note', 'note', 'new-note'), 'notes/new-note.md');
    assert.deepEqual(suggestions.filter(({ target }) => target === 'note').map(({ path }) => path),
      schema.roots.note.path);
  }
});

test('block reads preserve BOM, Unicode, CRLF and closing delimiters at EOF', (t) => {
  const f = vault(t);
  const text = '\uFEFF---\r\n# ' + 'x'.repeat(8192) + '\r\ntur: proje\r\netiketler: [ışık]\r\n---';
  f.put('Page.md', text);
  const result = f.detect();
  assert.deepEqual(result.schema.fields, PRESETS['tr-wiki'].fields);
  assert.equal(result.scanned.bytes, Buffer.byteLength(text));
  assert.deepEqual(result.warnings, []);
});

test('block reads honor the total byte budget and reject a delimiter cut at the prefix boundary', (t) => {
  const f = vault(t);
  const text = '---\ntur: proje\n---unfinished\n';
  f.put('Page.md', text);
  const total = f.detect({ limits: { totalBytes: 2 } });
  assert.equal(total.scanned.bytes, 2);
  assert.equal(total.scanned.limited, true);
  assert.deepEqual(total.warnings, ['total_bytes_limit']);
  const frontmatter = f.detect({ limits: { frontmatterBytes: Buffer.byteLength('---\ntur: proje\n---') } });
  assert.deepEqual(frontmatter.schema.fields, {});
  assert.deepEqual(frontmatter.warnings, ['frontmatter_limit_or_unclosed:Page.md']);
});


test('extending detection preserves configured entries and adds only missing roots and aliases', (t) => {
  const f = vault(t);
  for (const name of ['A', 'B']) f.put(`Work/${name}.md`, '---\ntur: Proje\netiketler: [a]\n---\n');
  f.put('Clippings/Source.md');
  f.put('Archive/Clippings/Hidden.md');
  f.put('Templates/Example.md');
  const existing = { ...structuredClone(PRESETS.default),
    roots: { note: { path: 'Archive', flat: false }, journal: { path: 'Log', flat: true } },
    kindFolders: { concept: 'Concepts' }, fields: { tags: 'labels' }, values: { kind: { custom: 'concept' } },
    sourceRoots: ['Captures'], catalog: 'Index.md', ignore: ['Private/**'], quickNotes: 'Archive',
  };
  const original = structuredClone(existing);
  const result = extendDetection(f.detect(), existing);
  assert.deepEqual(existing, original);
  assert.deepEqual(result.schema.roots.note, existing.roots.note);
  assert.deepEqual(result.schema.roots.journal, existing.roots.journal);
  assert.equal(result.schema.roots.project.path, 'Work');
  assert.deepEqual(result.schema.kindFolders, existing.kindFolders);
  assert.equal(result.schema.fields.tags, 'labels');
  assert.equal(result.schema.fields.kind, 'tur');
  assert.equal(result.schema.values.kind.custom, 'concept');
  assert.equal(result.schema.values.kind.Proje, 'project');
  assert.deepEqual(result.schema.sourceRoots, ['Captures', 'Clippings']);
  assert.equal(result.schema.catalog, 'Index.md');
  assert.equal(result.schema.quickNotes, 'Archive');
  assert.ok(result.schema.ignore.includes('Private/**'));
  assert.ok(result.schema.ignore.includes('Templates/**'));
  assert.ok(result.warnings.includes('root_conflict:sourceRoots:Archive/Clippings'));
  assert.ok(!result.suggestions.some(({ target }) => ['note', 'journal'].includes(target)));
});

for (const [reserved, proposed] of [['Work', 'Work'], ['Work', 'Work/Projects'], ['Work/Nested', 'Work']]) {
  test(`extending detection rejects overlap between ${reserved} and ${proposed}`, (t) => {
    const f = vault(t);
    for (const name of ['A', 'B']) f.put(`${proposed}/${name}.md`, '---\nkind: project\n---\n');
    const existing = { ...structuredClone(PRESETS.default), roots: { note: { path: reserved, flat: false } } };
    const result = extendDetection(f.detect(), existing);
    assert.equal(result.schema.roots.project, undefined);
    assert.ok(result.warnings.includes(`root_conflict:project:${proposed}`));
    assert.ok(!result.suggestions.some(({ target }) => target === 'project'));
  });
}

test('existing kind aliases win conflicts and conflicting type suggestions are suppressed', (t) => {
  const f = vault(t);
  for (const name of ['A', 'B']) f.put(`Work/${name}.md`, '---\nkind: Project\n---\n');
  const existing = { ...structuredClone(PRESETS.default), roots: { note: { path: 'notes', flat: false } },
    values: { kind: { Project: 'concept' } } };
  const result = extendDetection(f.detect(), existing);
  assert.equal(result.schema.values.kind.Project, 'concept');
  assert.equal(result.schema.roots.project, undefined);
  assert.ok(result.warnings.includes('value_conflict:kind:Project'));
  assert.ok(!result.suggestions.some(({ path }) => path === 'Project'));
});

for (const [field, value] of [['tur', 'Proje'], ['kind', 'Project']]) {
  test(`observed ${field}: ${value} spelling classifies exactly through the detected schema`, (t) => {
    const f = vault(t);
    for (const name of ['A', 'B']) f.put(`Work/${name}.md`, `---\n${field}: ${value}\n---\n`);
    const result = f.detect();
    assert.equal(result.schema.roots.project.path, 'Work');
    assert.equal(result.schema.values.kind[value], 'project');
    assert.equal(classify(result.schema, 'Work/A.md', { [field]: value }).entity, 'project');
  });
}

for (const [type, path, folder] of [
  ['note', 'Templates', 'Templates'], ['journal', 'Templates/Days', 'Templates'],
  ['project', 'Notes', 'Notes/Templates'],
]) {
  test(`new ignore ${folder}/** cannot cover preserved ${type} root ${path}`, (t) => {
    const f = vault(t);
    f.put(`${folder}/Page.md`);
    const existing = { ...structuredClone(PRESETS.default), roots: { [type]: { path, flat: false } } };
    const result = extendDetection(f.detect(), existing);
    assert.ok(!result.schema.ignore.includes(`${folder}/**`));
    assert.ok(result.warnings.includes(`ignore_conflict:${folder}/**`));
    assert.ok(!result.suggestions.some(({ target, path }) => target === 'ignore' && path === folder));
    assert.deepEqual(resolveSchema({ schema: result.schema }), result.schema);
  });
}

for (const settings of [
  { quickNotes: 'Templates' }, { quickNotes: '' },
  { kindFolders: { concept: 'Templates/Concepts' } }, { catalog: 'Templates/Index.md' },
]) {
  test(`new template ignores respect preserved paths ${JSON.stringify(settings)}`, (t) => {
    const f = vault(t);
    f.put('Templates/Page.md');
    const existing = { ...structuredClone(PRESETS.default), ...settings };
    const result = extendDetection(f.detect(), existing);
    assert.ok(!result.schema.ignore.includes('Templates/**'));
    assert.ok(result.warnings.includes('ignore_conflict:Templates/**'));
    for (const field of Object.keys(settings)) assert.deepEqual(result.schema[field], existing[field]);
  });
}

for (const [settings, folder, type] of [
  [{ quickNotes: 'Clippings' }, 'Clippings', 'sourceRoots'],
  [{ quickNotes: 'Clippings/Notes' }, 'Clippings', 'sourceRoots'],
  [{ kindFolders: { concept: 'Clippings/Concepts' } }, 'Clippings', 'sourceRoots'],
  [{ catalog: 'Clippings/Index.md' }, 'Clippings', 'sourceRoots'],
  [{ quickNotes: 'Work' }, 'Work', 'project'],
  [{ kindFolders: { concept: 'Work/Concepts' } }, 'Work', 'project'],
  [{ catalog: 'Work/Index.md' }, 'Work', 'project'],
]) {
  test(`new ${type} path ${folder} respects ${JSON.stringify(settings)}`, (t) => {
    const f = vault(t);
    for (const name of ['A', 'B']) f.put(`${folder}/${name}.md`,
      type === 'project' ? '---\nkind: project\n---\n' : '# Capture\n');
    const existing = { ...structuredClone(PRESETS.default),
      roots: { note: { path: 'Notes', flat: false } }, ...settings };
    const result = extendDetection(f.detect(), existing);
    if (type === 'sourceRoots') assert.ok(!result.schema.sourceRoots.includes(folder));
    else assert.equal(result.schema.roots.project, undefined);
    assert.ok(result.warnings.includes(`root_conflict:${type}:${folder}`));
    assert.deepEqual(resolveSchema({ schema: result.schema }), result.schema);
  });
}

test('invalid combined additions fall back to the valid configured schema with a warning', (t) => {
  const f = vault(t);
  f.put('Projects/A.md');
  const existing = { ...structuredClone(PRESETS.default), roots: { note: { path: 'Notes', flat: false } } };
  const detection = f.detect();
  detection.schema.roots.project.flat = 'invalid';
  const result = extendDetection(detection, existing);
  assert.deepEqual(result.schema, existing);
  assert.deepEqual(result.suggestions, []);
  assert.ok(result.warnings.includes('schema_additions_invalid'));
});

test('configured kind fields supply folder evidence and exact observed aliases', (t) => {
  const f = vault(t);
  for (const name of ['A', 'B']) f.put(`Work/${name}.md`, '---\ncategory: Project\n---\n');
  const existing = { ...structuredClone(PRESETS.default), roots: { note: { path: 'Notes', flat: false } },
    fields: { kind: 'category' } };
  const detection = f.detect({ existingSchema: existing });
  assert.equal(detection.schema.roots.project.path, 'Work');
  assert.equal(detection.schema.values.kind.Project, 'project');
  const result = extendDetection(detection, existing);
  assert.equal(result.schema.fields.kind, 'category');
  assert.equal(classify(result.schema, 'Work/A.md', { category: 'Project' }).entity, 'project');
});


test('unusable ignore prefixes are skipped with a warning instead of aborting extension', (t) => {
  const f = vault(t);
  const existing = structuredClone(PRESETS.default), detection = f.detect();
  detection.schema.ignore.push('Other:Templates/**');
  assert.deepEqual(resolveSchema({ schema: detection.schema }), detection.schema);
  const result = extendDetection(detection, existing);
  assert.deepEqual(result.schema, existing);
  assert.ok(result.warnings.includes('ignore_conflict:Other:Templates/**'));
});
