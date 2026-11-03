import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openContext } from '../core/context.mjs';
import { lint } from '../core/lint.mjs';
import { normalizeForEvidence, extractClaims } from '../core/evidence.mjs';
import { fixedClock, tempDir } from './support/env.mjs';

function make(t, entries, { preset = 'default' } = {}) {
  const dir = tempDir(t);
  for (const [path, text] of Object.entries(entries)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const ctx = openContext({ mode: 'read', dataDir: dir, home: tempDir(t), env: {}, clock: fixedClock('2026-11-01T12:00:00Z'),
    platform: process.platform, preset });
  return { dir, ctx };
}
const found = (ctx, opts = { evidence: true }) => lint(ctx, opts).findings.filter((item) => item.code === 'evidence_missing');
const concept = (body, extra = '') => `---\nkind: concept\ntags: [a]\nupdated: 2026-10-30\n${extra}---\n${body}`;

test('normalizeForEvidence folds marks, quotes, dashes, spacing, case and Unicode form', () => {
  assert.equal(normalizeForEvidence('**Bold**  _text_\n> “Quoted” – ‘it’s’ — `x` | [a](b) #h'), 'bold text "quoted" - \'it\'s\' - x ab h');
  assert.equal(normalizeForEvidence('İSTANBUL ISPARTA'), 'istanbul ısparta');
  assert.equal(normalizeForEvidence('é'), 'é');
  assert.equal(normalizeForEvidence('„alıntı”'), '"alıntı"');
});

test('extractClaims finds quotes of at least four words and number patterns with their lines', () => {
  const text = 'He said "the quick brown fox" today.\nShort "too few words" here.\nStats: 11.2k users, %35 growth, 20 MB, 5% drop, 2026-09-28, 300ms.\n“Curly quotes make four words”\n';
  assert.deepEqual(extractClaims(text).map(({ line, kind, value }) => [line, kind, value]), [
    [1, 'quote', 'the quick brown fox'],
    [3, 'number', '11.2k'], [3, 'number', '%35'], [3, 'number', '20 MB'], [3, 'number', '5%'], [3, 'number', '2026-09-28'], [3, 'number', '300ms'],
    [4, 'quote', 'Curly quotes make four words'],
  ]);
});

test('a quote or number found in the raw source is no finding, one that is missing is', (t) => {
  const { ctx } = make(t, {
    'raw/paper.md': 'The **quick** brown fox\njumps over; users: 11,2k and 20MB.\n',
    'research/paper.md': '---\nkind: source\nraw: raw/paper.md\n---\n# Paper\nHe wrote "the quick brown fox jumps".\nAnd "a lazy dog sleeps there" with 20 MB and 99k.\n',
  });
  const result = found(ctx);
  assert.deepEqual(result.map((item) => [item.path, item.line, item.target, item.content.excerpt, item.severity]), [
    ['research/paper.md', 7, 'quote', 'a lazy dog sleeps there', 'warn'],
    ['research/paper.md', 7, 'number', '99k', 'warn'],
  ]);
});

test('markup, curly quotes and dashes in the raw text cause no false alarm', (t) => {
  const { ctx } = make(t, {
    'raw/a.md': '> “Memory   is *not*\n> a **database** – it is a cache”\n\nThe 2026–09–28 release.\n',
    'research/a.md': '---\nkind: source\nraw: raw/a.md\n---\n# A\n"memory is not a database - it is a cache" and 2026-09-28.\n',
  });
  assert.deepEqual(found(ctx), []);
});

test('evidence is only checked with --evidence', (t) => {
  const { ctx } = make(t, {
    'raw/a.md': 'nothing here\n',
    'research/a.md': '---\nkind: source\nraw: raw/a.md\n---\n# A\n"an invented quote of words" 50%\n',
  });
  assert.deepEqual(found(ctx, {}), []);
  assert.equal(found(ctx).length, 2);
});

test('a wiki page is checked against the raw files of the research it links in sources or the Sources section', (t) => {
  const { ctx } = make(t, {
    'raw/one.md': 'the real quote of four words, 40%\n', 'raw/two.md': 'second source says 75%\n', 'raw/other.md': 'unrelated 12k\n',
    'research/one.md': '---\nkind: source\nraw: raw/one.md\n---\n# One\n',
    'research/two.md': '---\nkind: source\nraw: raw/two.md\n---\n# Two\n',
    'research/other.md': '---\nkind: source\nraw: raw/other.md\n---\n# Other\n',
    'wiki/concepts/a.md': concept('Says "the real quote of four words" and 40%, 75%, 12k.\n## Sources\n- [[two]] 2026-01-02\n', 'sources: ["[[one]]"]\n'),
    'wiki/concepts/b.md': concept('Claim 75% and 2026-09-28.\n\n```\n"code fence words are ignored here" 9MB\n```\n## Sources\n- [[two]] 2026-01-02\n'),
  });
  const result = found(ctx);
  assert.deepEqual(result.map((item) => [item.path, item.line, item.content.excerpt]),
    [['wiki/concepts/a.md', 7, '12k'], ['wiki/concepts/b.md', 6, '2026-09-28']]);
});

test('a wiki page without readable linked raw sources gets no finding; ambiguous or binary raw is skipped', (t) => {
  const { dir, ctx } = make(t, {
    'research/noraw.md': '---\nkind: source\n---\n# NoRaw\n',
    'wiki/concepts/a.md': concept('Claim 75%.\n## Sources\n- [[noraw]]\n- [[missing]]\n'),
    'raw/bin.pdf': 'x',
    'research/bin.md': '---\nkind: source\nraw: raw/bin.pdf\n---\n# Bin\n"some quote with words" 3k\n',
  });
  writeFileSync(join(dir, 'raw/bin.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 1, 2, 3]));
  assert.deepEqual(found(ctx), []);
});

test('raw files are opened safely: outside, symlinked and escaping paths contribute nothing', (t) => {
  const { dir, ctx } = make(t, {
    'outside/x.md': 'quote words inside here 5%\n', 'raw/real.md': 'fine\n',
    'research/out.md': '---\nkind: source\nraw: outside/x.md\n---\n# Out\n"quote words inside here" 5%\n',
    'research/esc.md': '---\nkind: source\nraw: ../x.md\n---\n# Esc\n5%\n',
    'research/link.md': '---\nkind: source\nraw: raw/link.md\n---\n# Link\n5%\n',
  });
  symlinkSync(join(dir, 'outside/x.md'), join(dir, 'raw/link.md'));
  assert.deepEqual(found(ctx), []);
});

test('the tr-wiki preset reads its physical sources field and Kaynaklar section', (t) => {
  const { ctx } = make(t, {
    'raw/k.md': 'kaynakta %35 artış var\n',
    'wiki/kaynaklar/k.md': '---\ntur: kaynak\nham: raw/k.md\nkaynak_tarihi: 2026-10-01\n---\n# K\nMetinde %35 ve %80 geçer.\n',
    'wiki/kavramlar/a.md': '---\ntur: kavram\netiketler: [a]\nguncelleme: 2026-10-30\nkaynaklar: ["[[k]]"]\n---\n# A\n%35 artış ve %90.\n',
    'wiki/kavramlar/b.md': '---\ntur: kavram\netiketler: [a]\nguncelleme: 2026-10-30\n---\n# B\n%35 artış.\n## Kaynaklar\n- [[k]] 2026-10-02\n',
  }, { preset: 'tr-wiki' });
  assert.deepEqual(found(ctx).map((item) => [item.path, item.content.excerpt]), [['wiki/kavramlar/a.md', '%90'], ['wiki/kaynaklar/k.md', '%80']]);
});

test('claim extraction stays linear on hostile text and honours the limit', () => {
  const shapes = ['"a b c d e" ', '\u201cx ', '\u201ex ', '"x ', '12 MB '];
  for (const shape of shapes) {
    const text = shape.repeat(Math.ceil(400_000 / shape.length));
    const started = Date.now();
    extractClaims(text, 200);
    extractClaims(text);
    assert.ok(Date.now() - started < 2000, `slow for ${JSON.stringify(shape)}`);
  }
  const many = '"one two three four" 5%\n'.repeat(1000);
  assert.equal(extractClaims(many, 10).length, 10);
  assert.deepEqual(extractClaims('a\n\n"one two three four"\n9 MB').map(({ line, kind }) => [line, kind]), [[3, 'quote'], [4, 'number']]);
  assert.deepEqual(extractClaims('"one two\n\nthree four"'), []);
});
