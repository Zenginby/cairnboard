import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { openContext } from '../core/context.mjs';
import { defaultConfig } from '../core/config.mjs';
import { PRESETS } from '../core/presets.mjs';
import { evaluateHook } from '../core/hook.mjs';
import { parseJournal } from '../core/links.mjs';
import { analyzePage, extractClaims, normalizeForEvidence, unsupported } from '../core/evidence.mjs';
import { buildContext } from '../core/context-pack.mjs';
import { mentionCandidates, outlinks, rows, search, withIndex } from '../core/index.mjs';
import { mentions, linkMention } from '../core/mentions.mjs';
import { lint } from '../core/lint.mjs';
import { wikiIndex } from '../core/wiki.mjs';
import { codeFile } from '../core/code-drift.mjs';
import { ingest, MAX_INPUT } from '../core/ingest.mjs';
import { recordRepo } from '../core/roots.mjs';
import { fixedClock, seedDataDir, tempDir } from './support/env.mjs';
import { runCli } from './support/cli.mjs';

const clock = fixedClock('2026-11-01T12:00:00Z');
const concept = (body = '# Topic\n', extra = '') => `---\nkind: concept\ntags: [a]\nupdated: 2026-10-30\n${extra}---\n${body}`;

function fixture(t, entries = {}, preset = 'default') {
  const data = tempDir(t), home = tempDir(t);
  seedDataDir(data, { home, env: {}, clock, preset });
  const put = (path, text) => {
    fs.mkdirSync(dirname(join(data, path)), { recursive: true });
    fs.writeFileSync(join(data, path), text);
  };
  for (const [path, text] of Object.entries(entries)) put(path, text);
  const ctx = openContext({ mode: 'write', dataDir: data, home, env: {}, clock, actor: 'cli:acme' });
  const run = (args, extra) => runCli([...args, '--json'], { home, data, clock, ...extra });
  return { data, home, ctx, put, run };
}

const findings = (ctx, only, extra = {}) => lint(ctx, { only, ...extra }).findings;
const child = (source, { env = {}, timeout = 10000 } = {}) => spawnSync(process.execPath, ['--input-type=module', '-e', source], {
  encoding: 'utf8', timeout, env: { ...process.env, ...env },
});
const succeeded = (result) => assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);

test('hook classifies proposed Write and Edit frontmatter before applying note rules', (t) => {
  const f = fixture(t, { 'cards/x.md': '---\nkind: project\n---\n# X\n' });
  f.ctx.config = { ...defaultConfig('en'), rules: { required: 'error', links: 'error' } };
  const write = (path, content) => evaluateHook(f.ctx, { tool_name: 'Write', tool_input: { file_path: join(f.data, path), content } });
  for (const path of ['cards/x.md', 'projects/rfc.md']) assert.equal(write(path, concept('[[ghost]]\n')).decision, 'deny');
  assert.equal(write('wiki/p.md', '---\nkind: project\n---\n[[ghost]]\n').decision, 'allow');
  assert.equal(evaluateHook(f.ctx, { tool_name: 'Edit', tool_input: {
    file_path: join(f.data, 'cards/x.md'), old_string: 'kind: project', new_string: 'kind: concept',
  } }).decision, 'deny');
  assert.equal(write('wiki/bad.md', '---\nkind: [\n---\n[[ghost]]\n').decision, 'deny');
  assert.equal(write('cards/bad.md', '---\nkind: [\n---\n[[ghost]]\n').decision, 'allow');
});

test('journal prefixes fold English capitals and Turkish NFC/NFD alike', () => {
  const prefixes = ['DECISION', 'PITFALL', 'DISCOVERY', 'KARAR', 'Keşif', 'KEŞİF'.normalize('NFD')];
  assert.deepEqual(parseJournal(`## Work\n${prefixes.map((name) => `- ${name}: x`).join('\n')}`, PRESETS.default.entryTypes)
    .map((entry) => entry.type), ['decision', 'pitfall', 'discovery', 'decision', 'discovery', 'discovery']);
});

test('evidence folds all I variants without discarding accents', () => {
  assert.deepEqual(unsupported(extractClaims('"it is a useful quote"'), [normalizeForEvidence('It is a useful quote')]), []);
  assert.equal(normalizeForEvidence('I ı İ i I\u0307'), 'i i i i i');
  assert.notEqual(normalizeForEvidence('café'), normalizeForEvidence('cafe'));
});

test('context accepts a path reference to an idless project', async (t) => {
  const f = fixture(t, { 'wiki/projeler/x.md': '---\nkind: project\n---\n# X\n',
    'cards/a.md': '---\nproject: "@wiki/projeler/x"\npriority: urgent\n---\n# Task\n' });
  const result = await f.run(['context', '--project', '@wiki/projeler/x']);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /Task/u);
});

test('dot folders supply targets but never pages, links, search, context or lint', (t) => {
  const paths = ['.trash/a.md', 'wiki/.drafts/b.md', '.obsidian/c.md'];
  const f = fixture(t, Object.fromEntries(paths.map((path) => [path, concept('[[ghost]] secretword\n')])));
  f.put('notes/live.md', '[[a]] [[b]] [[c]]');
  assert.deepEqual(rows(f.ctx).map((row) => row.path), ['notes/live.md']);
  assert.deepEqual(search(f.ctx, 'secretword'), []);
  assert.deepEqual(outlinks(f.ctx, 'notes/live.md').map((link) => link.status), ['resolved', 'resolved', 'resolved']);
  assert.equal(withIndex(f.ctx, (db) => db.prepare('SELECT COUNT(*) AS n FROM links WHERE src_path != ?').get('notes/live.md').n), 0);
  assert.deepEqual(findings(f.ctx, ['broken_link', 'orphan']), []);
  assert.ok(!JSON.stringify(buildContext(f.ctx)).includes('secretword'));
});

test('empty folded mention names return no candidates with or without the index', (t) => {
  const f = fixture(t, { 'notes/\u00ad.md': '\u00ad', 'notes/a.md': '# Other' });
  for (const names of [[], ['\u00ad'], ['']]) assert.deepEqual(mentionCandidates(f.ctx, 'notes/\u00ad.md', names), []);
  const fallback = { ...f.ctx, indexPath: join(f.data, 'blocked.db') };
  fs.symlinkSync(f.ctx.indexPath, fallback.indexPath);
  assert.deepEqual(mentionCandidates(fallback, 'notes/\u00ad.md', []), []);
  assert.deepEqual(mentions(f.ctx, '@notes/\u00ad'), []);
});

test('indented code is never a mention or editable, while list continuations remain prose', (t) => {
  const f = fixture(t, { 'notes/target.md': '# Borealis',
    'notes/a.md': '# Text\n\n    Borealis\n\tBorealis\n\nBorealis\n- item\n\n    Borealis\n\n1. item\n\n\tBorealis\n' });
  assert.deepEqual(mentions(f.ctx, '@notes/target').map((item) => item.line), [6, 9, 13]);
  const before = fs.readFileSync(join(f.data, 'notes/a.md'), 'utf8');
  for (const line of [3, 4]) assert.throws(() => linkMention(f.ctx, '@notes/target', `notes/a.md:${line}`), { code: 'validation' });
  assert.equal(fs.readFileSync(join(f.data, 'notes/a.md'), 'utf8'), before);
});

test('mention linking uses a full path when basename trimming would change the target', (t) => {
  const f = fixture(t, { 'notes/ topic.md': '# Borealis', 'notes/topic.md': '# Other', 'notes/a.md': 'Borealis' });
  linkMention(f.ctx, '@notes/ topic', 'notes/a.md:1');
  assert.equal(fs.readFileSync(join(f.data, 'notes/a.md'), 'utf8'), '[[notes/ topic|Borealis]]');
  assert.equal(outlinks(f.ctx, 'notes/a.md')[0].target_path, 'notes/ topic.md');
});

test('mention linking preserves a basename ending in whitespace', (t) => {
  const f = fixture(t, { 'notes/topic .md': '# Borealis', 'notes/topic.md': '# Other', 'notes/a.md': 'Borealis' });
  linkMention(f.ctx, '@notes/topic .md', 'notes/a.md:1');
  assert.equal(outlinks(f.ctx, 'notes/a.md')[0].target_path, 'notes/topic .md');
});

test('Sources heading matching is equivalent and linear on hostile whitespace', () => {
  succeeded(child(`
    import assert from 'node:assert/strict';
    import { SOURCE_HEADING } from './core/rules.mjs';
    const old = /^ {0,3}##[ \\t]+(?:sources|kaynaklar)[ \\t]*#*[ \\t]*$/u;
    for (const indent of ['', ' ', '   ', '    ']) for (const gap of [' ', '\\t', '  '])
      for (const name of ['sources', 'kaynaklar', 'source', 'Sources'])
        for (const tail of ['', '#', '##', ' ', '\\t', ' # ', '\\t##\\t', '# x', ' # #']) {
          const text = indent + '##' + gap + name + tail;
          assert.equal(SOURCE_HEADING.test(text), old.test(text), JSON.stringify(text));
        }
    const text = '## sources' + ' '.repeat(100000) + 'x';
    const start = performance.now();
    assert.equal(SOURCE_HEADING.test(text), false);
    assert.ok(performance.now() - start < 200);
  `));
});

test('evidence link blanking stays linear on unmatched brackets', () => {
  succeeded(child(`
    import assert from 'node:assert/strict';
    import { analyzePage } from './core/evidence.mjs';
    const text = '['.repeat(100000);
    const start = performance.now();
    assert.equal(analyzePage(text).claimText, text);
    assert.ok(performance.now() - start < 200);
  `));
});

test('CRLF blank lines split claims and CRLF Sources headings suppress them', () => {
  assert.deepEqual(extractClaims('"one two\r\n\r\nthree four"'), []);
  const page = analyzePage('# T\r\n5%\r\n## Sources\r\n99%\r\n');
  assert.deepEqual(extractClaims(page.claimText).map((item) => item.value), ['5%']);
});

test('evidence ignores multi-backtick and multiline code spans', () => {
  const page = analyzePage('# T\n``a ` 90% ` b``\n``across\n80% ` b``\n7%\n');
  assert.deepEqual(extractClaims(page.claimText).map((item) => item.value), ['7%']);
});

test('FIFO raw sources are rejected without blocking readers or lint', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t, { 'research/a.md': '---\nkind: source\nraw: raw/pipe.md\n---\n# A\n5%' });
  fs.mkdirSync(join(f.data, 'raw'), { recursive: true });
  assert.equal(spawnSync('mkfifo', [join(f.data, 'raw/pipe.md')]).status, 0);
  succeeded(child(`
    import assert from 'node:assert/strict';
    import { openContext } from './core/context.mjs';
    import { openForRead } from './core/paths.mjs';
    import { lint } from './core/lint.mjs';
    const ctx = openContext({ mode: 'read', dataDir: ${JSON.stringify(f.data)}, home: ${JSON.stringify(f.home)}, env: {} });
    assert.throws(() => openForRead(ctx.root, 'raw/pipe.md'), { code: 'unsafe_path' });
    assert.deepEqual(lint(ctx, { only: ['raw_missing', 'evidence_missing'], evidence: true }).findings.map(f => f.code), ['raw_missing']);
  `));
});

for (const invalid of ['too-large', 'bad_encoding']) test(`wiki summaries, wakeup and wakeup_budget skip ${invalid} pages`, (t) => {
  const body = '---\nkind: overview\n---\n# Topic\n## Wake-up\n';
  const text = invalid === 'too-large' ? body + 'word '.repeat(MAX_INPUT / 5 + 1)
    : Buffer.concat([Buffer.from(body + 'word '.repeat(400)), Buffer.from([0xff])]);
  const f = fixture(t, { 'wiki/a.md': text });
  rows(f.ctx); // Warm the bounded index reader before guarding all subsequent whole-file reads.
  const rejected = fs.statSync(join(f.data, 'wiki/a.md')).ino;
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    const stat = typeof path === 'number' ? fs.fstatSync(path) : fs.statSync(path);
    assert.ok(stat.ino !== rejected, 'unbounded page read');
    return read(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(wikiIndex(f.ctx).map((item) => item.summary), ['']);
    assert.ok(!buildContext(f.ctx).sections.some((item) => item.name === 'wakeup'));
    assert.deepEqual(findings(f.ctx, ['wakeup_budget']), []);
    if (invalid === 'bad_encoding') assert.equal(findings(f.ctx, ['invalid_encoding']).length, 1);
    else assert.ok(f.ctx.warnings.includes('too-large'));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('directories and nonregular code paths are missing', (t) => {
  const root = tempDir(t);
  fs.mkdirSync(join(root, 'src'));
  assert.deepEqual(codeFile(root, 'src'), { missing: true });
  if (process.platform !== 'win32') {
    assert.equal(spawnSync('mkfifo', [join(root, 'pipe')]).status, 0);
    assert.deepEqual(codeFile(root, 'pipe'), { missing: true });
  }
});

for (const [tz, updated, mtime, expected] of [
  ['Etc/GMT-3', '2026-10-30T23:30:00Z', '2026-10-31T00:30:00Z', false],
  ['Etc/GMT+8', '2026-10-31T01:00:00Z', '2026-10-31T12:00:00Z', true],
]) test(`code drift compares local days in ${tz}`, (t) => {
  const f = fixture(t, { 'projects/x.md': '---\nid: p-abc234\n---\n# X',
    'wiki/a.md': concept('# A', `project: p-abc234\ncode: [code.mjs]\n`).replace('2026-10-30', updated) });
  const root = tempDir(t);
  fs.writeFileSync(join(root, 'code.mjs'), 'x');
  fs.utimesSync(join(root, 'code.mjs'), new Date(mtime), new Date(mtime));
  recordRepo(f.ctx.stateDir, 'p-abc234', root);
  const check = (expect) => child(`
    import assert from 'node:assert/strict';
    import { openContext } from './core/context.mjs';
    import { lint } from './core/lint.mjs';
    const ctx = openContext({ mode: 'read', dataDir: ${JSON.stringify(f.data)}, home: ${JSON.stringify(f.home)}, env: {} });
    assert.equal(lint(ctx, { only: ['code_changed'], code: true }).findings.length > 0, ${expect});
  `, { env: { TZ: tz } });
  succeeded(check(expected));
  f.put('wiki/a.md', concept('# A', 'project: p-abc234\ncode: [code.mjs]\n'));
  succeeded(check(true)); // A bare date stays a local calendar date in either zone.
});

test('invalid UTF-8 raw sources cannot generate evidence_missing', (t) => {
  const f = fixture(t, { 'raw/a.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9]),
    'research/a.md': '---\nkind: source\nraw: raw/a.txt\n---\n# A\n"café is a nice word" 99%' });
  assert.deepEqual(findings(f.ctx, ['evidence_missing'], { evidence: true }), []);
});

test('ingest bounds stored bytes including the multibyte source header', (t) => {
  const f = fixture(t);
  const url = 'https://example.com/é';
  const header = `Source: ${url}\nDate: 2026-11-01\n\n`;
  const length = MAX_INPUT - Buffer.byteLength(header);
  assert.throws(() => ingest(f.ctx, { title: 'Too large', bytes: Buffer.alloc(length + 1, 'x'), url }, { dryRun: true }), { code: 'validation' });
  const result = ingest(f.ctx, { title: 'Boundary', bytes: Buffer.from('needle ' + 'x'.repeat(length - 7)), url });
  assert.equal(fs.statSync(join(f.data, result.raw.path)).size, MAX_INPUT);
  assert.equal(search(f.ctx, 'needle', { type: 'raw' })[0].path, result.raw.path);
});

test('fallback search excludes invalid UTF-8 titles just like FTS', (t) => {
  const f = fixture(t, { 'notes/a.md': Buffer.concat([Buffer.from('# Needle\n'), Buffer.from([0xff])]) });
  assert.deepEqual(search(f.ctx, 'Needle'), []);
  const fallback = { ...f.ctx, indexPath: join(f.data, 'blocked.db'), warnings: [] };
  fs.symlinkSync(f.ctx.indexPath, fallback.indexPath);
  assert.deepEqual(search(fallback, 'Needle'), []);
  assert.deepEqual(fallback.warnings, ['index_unavailable']);
});

for (const preset of ['default', 'tr-wiki']) test(`repeated sources and code survive CLI add/update with ${preset} field mapping`, async (t) => {
  const f = fixture(t, {}, preset);
  for (const type of ['note', 'research']) {
    const added = await f.run([type, 'add', '--title', 'Topic', '--sources', '[[one]]', '--sources', '[[two]]',
      ...(type === 'note' ? ['--code', 'a.mjs', '--code', 'b.mjs'] : []), '--actor', 'acme']);
    assert.equal(added.code, 0, added.stdout);
    assert.deepEqual(added.json.data.content.sources, ['[[one]]', '[[two]]']);
    if (type === 'note') assert.deepEqual(added.json.data.content.code, ['a.mjs', 'b.mjs']);
    const updated = await f.run([type, 'update', added.json.data.ref, '--sources', '[[three]]', '--sources', '[[four]]',
      ...(type === 'note' ? ['--code', 'c.mjs', '--code', 'd.mjs'] : []), '--actor', 'acme']);
    assert.equal(updated.code, 0, updated.stdout);
    assert.deepEqual(updated.json.data.content.sources, ['[[three]]', '[[four]]']);
    if (type === 'note') assert.deepEqual(updated.json.data.content.code, ['c.mjs', 'd.mjs']);
    const text = fs.readFileSync(join(f.data, added.json.data.path), 'utf8');
    assert.match(text, preset === 'tr-wiki' ? /\nkaynaklar:/u : /\nsources:/u);
  }
});

test('ambiguous catalog links list no candidate and emit ambiguous_link', (t) => {
  const f = fixture(t, { 'index.md': '[[same]]', 'wiki/a/same.md': concept(), 'wiki/b/same.md': concept() }, 'tr-wiki');
  const result = findings(f.ctx, ['index_mismatch', 'ambiguous_link']);
  assert.deepEqual(result.filter((item) => item.code === 'index_mismatch').map((item) => item.path), ['wiki/a/same.md', 'wiki/b/same.md']);
  assert.deepEqual(result.filter((item) => item.code === 'ambiguous_link').map((item) => [item.path, item.line, item.candidates]),
    [['index.md', 1, ['wiki/a/same.md', 'wiki/b/same.md']]]);
});
