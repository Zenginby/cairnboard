import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openContext } from '../core/context.mjs';
import { defaultConfig } from '../core/config.mjs';
import { openIndex, refresh, search } from '../core/index.mjs';
import { lint, CHECKS } from '../core/lint.mjs';
import { wikiIndex } from '../core/wiki.mjs';
import { filenameOk, requiredFields } from '../core/rules.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { runCli } from './support/cli.mjs';

const clock = () => fixedClock('2026-11-01T12:00:00Z');
const sha = (text) => createHash('sha256').update(text).digest('hex');

// A small throw-away data directory; `config` writes `.cairn/config.json` on top of the default configuration.
function make(t, entries, { preset = 'default', config } = {}) {
  const dir = tempDir(t);
  for (const [path, text] of Object.entries(entries)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  if (config) {
    mkdirSync(join(dir, '.cairn'));
    writeFileSync(join(dir, '.cairn/config.json'), JSON.stringify({ ...defaultConfig('en'), ...config }));
  }
  const ctx = openContext({ mode: 'read', dataDir: dir, home: tempDir(t), env: {}, clock: clock(),
    platform: process.platform, preset: config ? undefined : preset });
  return { dir, ctx };
}

const found = (result, code) => result.findings.filter((finding) => finding.code === code);
const paths = (result, code) => found(result, code).map((finding) => finding.path);
const page = (kind, extra = '', body = '# T\n') => `---\nkind: ${kind}\ntags: [a]\nupdated: 2026-10-30\n${extra}---\n${body}`;

test('CHECKS lists every non-W8 spec code with its default severity', () => {
  const table = Object.fromEntries(CHECKS.map((check) => [check.code, check.defaultSeverity]));
  assert.deepEqual(table, {
    orphan: 'warn', broken_link: 'warn', ambiguous_link: 'warn', missing_page: 'info', missing_frontmatter: 'warn',
    invalid_frontmatter: 'warn', unknown_kind: 'info', invalid_encoding: 'info', unclassified: 'info', alias_conflict: 'error', stale: 'info',
    unprocessed_lesson: 'info', unprocessed_source: 'info', raw_missing: 'error', raw_changed: 'error',
    wakeup_budget: 'warn', overview_multiple: 'warn', index_mismatch: 'info', filename: 'off',
  });
});

test('orphan: pages nobody links to, except journals, overviews and quick notes', (t) => {
  const { ctx } = make(t, {
    'wiki/concepts/lonely.md': page('concept'),
    'wiki/concepts/linked.md': page('concept'),
    'wiki/concepts/hub.md': page('concept', '', '# Hub\n[[linked]] [[hub]]\n'),
    'wiki/overview.md': page('overview'),
    'notes/quick.md': '# Quick\n',
    'journal/2026-10-30.md': '# Day\n',
    'research/paper.md': '---\nkind: source\n---\n# Paper\n',
    'projects/ornek.md': '---\nkind: project\n---\n# Ornek\n',
  });
  assert.deepEqual(paths(lint(ctx), 'orphan'), ['projects/ornek.md', 'research/paper.md', 'wiki/concepts/hub.md', 'wiki/concepts/lonely.md']);
  const finding = found(lint(ctx), 'orphan')[0];
  assert.deepEqual({ code: finding.code, severity: finding.severity }, { code: 'orphan', severity: 'warn' });
});

test('broken, ambiguous and missing-page links', (t) => {
  const { ctx } = make(t, {
    'notes/a.md': 'Bkz. [[yok]] ve [[ayni]] ve [[tek]].\n[[yok-iki]]\n',
    'notes/b.md': 'Bkz. [[yok]] ve [[Yok-Iki]].\n',
    'notes/ayni.md': '# 1\n',
    'wiki/ayni.md': '# 2\n',
    'notes/tek.md': '# Tek\n',
  });
  const result = lint(ctx);
  assert.deepEqual(found(result, 'broken_link').map((f) => [f.path, f.line, f.target]),
    [['notes/a.md', 1, 'yok'], ['notes/a.md', 2, 'yok-iki'], ['notes/b.md', 1, 'yok'], ['notes/b.md', 1, 'Yok-Iki']]);
  assert.equal(found(result, 'broken_link')[0].content.excerpt, '[[yok]]');
  const ambiguous = found(result, 'ambiguous_link');
  assert.equal(ambiguous.length, 1);
  assert.deepEqual(ambiguous[0].candidates, ['notes/ayni.md', 'wiki/ayni.md']);
  assert.deepEqual(found(result, 'missing_page').map((f) => f.target).sort(), ['yok', 'yok-iki']);
});

test('missing_page needs two different linking pages', (t) => {
  const { ctx } = make(t, { 'notes/a.md': '[[yok]] [[yok]]\n', 'notes/b.md': '[[bir-kez]]\n' });
  assert.deepEqual(found(lint(ctx), 'missing_page'), []);
});

test('missing_frontmatter follows the required fields of each kind', (t) => {
  assert.deepEqual(requiredFields({}, 'note', 'concept'), ['title', 'tags', 'updated']);
  assert.deepEqual(requiredFields({}, 'research', 'source'), ['title', 'raw', 'sourceDate']);
  assert.deepEqual(requiredFields({}, 'journal', 'journal'), ['date']);
  assert.deepEqual(requiredFields({}, 'card', null), []);
  const { ctx } = make(t, {
    'wiki/concepts/none.md': '---\nkind: concept\n---\nGövde başlıksız.\n',
    'wiki/concepts/ok.md': '---\nkind: concept\ntags: [x]\nupdated: 2026-10-01\n---\n# Var\n',
    'wiki/concepts/fenced.md': '---\nkind: concept\ntags: [x]\nupdated: 2026-10-01\n---\n```\n# kod\n```\n',
    'wiki/concepts/empty-tags.md': '---\nkind: concept\ntags: []\nupdated: 2026-10-01\ntitle: T\n---\n',
    'wiki/tools/t.md': '---\nkind: tool\ntitle: Araç\n---\n',
    'wiki/queries/q.md': '---\nkind: query\ntags: [x]\nupdated: 2026-10-01\n---\n# Q\n',
    'research/src.md': '---\nkind: source\n---\n# S\n',
    'research/rev.md': '---\nkind: review\n---\n# R\n',
    'journal/2026-10-30.md': '## iş\n- madde\n',
    'journal/bad-name.md': '---\nkind: journal\n---\n',
    'notes/plain.md': 'başlıksız\n',
    'projects/p.md': '---\nkind: project\n---\n# P\n',
  });
  const missing = found(lint(ctx), 'missing_frontmatter').map((f) => `${f.path}:${f.target}`).sort();
  assert.deepEqual(missing, [
    'journal/bad-name.md:date', 'notes/plain.md:title',
    'research/src.md:raw', 'research/src.md:sourceDate',
    'wiki/concepts/empty-tags.md:tags',
    'wiki/concepts/fenced.md:title',
    'wiki/concepts/none.md:tags', 'wiki/concepts/none.md:title', 'wiki/concepts/none.md:updated',
    'wiki/tools/t.md:tags', 'wiki/tools/t.md:updated',
  ]);
});

test('missing_frontmatter reads physical tr-wiki names and skips unreadable frontmatter', (t) => {
  const { ctx } = make(t, {
    'wiki/kavramlar/ok.md': '---\ntur: kavram\netiketler: [a]\nguncelleme: 2026-10-01\n---\n# Tamam\n',
    'wiki/kavramlar/eksik.md': '---\ntur: kavram\netiketler: [a]\n---\n# Eksik\n',
    'wiki/kavramlar/bozuk.md': '---\ntur: kavram\netiketler: [a\n---\n# Bozuk\n',
    'wiki/kaynaklar/k.md': '---\ntur: kaynak\nham: raw/x.md\nkaynak_tarihi: 2026-10-01\n---\n# K\n',
    'wiki/gunluk-loglar/2026-10-28.md': '## Acme: iş\n- **Ders:** x\n',
  }, { preset: 'tr-wiki' });
  const result = lint(ctx);
  assert.deepEqual(found(result, 'missing_frontmatter').map((f) => `${f.path}:${f.target}`),
    ['wiki/kavramlar/eksik.md:updated']);
  assert.deepEqual(paths(result, 'invalid_frontmatter'), ['wiki/kavramlar/bozuk.md']);
});

test('invalid_frontmatter, unknown_kind, unclassified and alias_conflict', (t) => {
  const { ctx } = make(t, {
    'notes/bad.md': '---\ntitle: [unclosed\n---\n# Bad\n[[notes/good]]\n',
    'notes/good.md': '---\nkind: pano\n---\n# Good\n',
    'docs/loose.md': '# Loose\n',
    'notes/fine.md': '# Fine\n',
  });
  const result = lint(ctx);
  assert.deepEqual(paths(result, 'invalid_frontmatter'), ['notes/bad.md']);
  assert.deepEqual(found(result, 'unknown_kind').map((f) => [f.path, f.content.excerpt]), [['notes/good.md', 'pano']]);
  assert.deepEqual(paths(result, 'unclassified'), ['docs/loose.md']);
  const tr = make(t, {
    'wiki/kavramlar/c.md': '---\ntur: kavram\nkind: concept\ntags: [a]\netiketler: [b]\nupdated: 2026-10-01\n---\n# C\n',
  }, { preset: 'tr-wiki' });
  const conflicts = found(lint(tr.ctx), 'alias_conflict');
  assert.deepEqual(conflicts.map((f) => [f.path, f.severity, f.target]), [['wiki/kavramlar/c.md', 'error', 'kind'], ['wiki/kavramlar/c.md', 'error', 'tags']]);
});

test('stale looks at updated only and can be tuned or disabled', (t) => {
  const entries = {
    'wiki/concepts/old.md': '---\nkind: concept\ntags: [a]\nupdated: 2026-06-01\n---\n# Old\n',
    'wiki/concepts/new.md': '---\nkind: concept\ntags: [a]\nupdated: 2026-10-30\n---\n# New\n',
    'wiki/concepts/undated.md': '---\nkind: concept\ntags: [a]\n---\n# U\n',
  };
  assert.deepEqual(paths(lint(make(t, entries).ctx), 'stale'), []);
  assert.deepEqual(paths(lint(make(t, entries, { config: { lint: { staleDays: 30 } } }).ctx), 'stale'), ['wiki/concepts/old.md']);
  const older = { 'wiki/concepts/ancient.md': '---\nkind: concept\ntags: [a]\nupdated: 2025-01-01\n---\n# A\n' };
  assert.deepEqual(paths(lint(make(t, older).ctx), 'stale'), ['wiki/concepts/ancient.md']);
  assert.deepEqual(paths(lint(make(t, older, { config: { lint: { staleDays: 0 } } }).ctx), 'stale'), []);
});

test('unprocessed_lesson covers the last 30 days; unprocessed_source reads processed: false', (t) => {
  const { ctx } = make(t, {
    'journal/2026-10-28.md': '# G\n## Acme: iş\n- **Ders:** işlenmemiş ders\n- **Keşif:** işli → [[acme]]\n- **Karar:** karar\n',
    'journal/2026-08-01.md': '# G\n## Eski\n- **Ders:** çok eski\n',
    'notes/acme.md': '# Acme\n',
    'research/a.md': '---\nkind: source\nprocessed: false\n---\n# A\n',
    'research/b.md': '---\nkind: source\nprocessed: "[[acme]]"\n---\n# B\n',
  });
  const result = lint(ctx);
  assert.deepEqual(found(result, 'unprocessed_lesson').map((f) => [f.path, f.line, f.content.excerpt]),
    [['journal/2026-10-28.md', 3, 'işlenmemiş ders']]);
  assert.deepEqual(paths(result, 'unprocessed_source'), ['research/a.md']);
});

test('raw_missing and raw_changed compare the linked source file', async (t) => {
  const text = 'ham metin\n';
  const { dir, ctx } = make(t, {
    'raw/ok.md': text, 'raw/changed.md': 'yeni içerik\n', 'outside/x.md': 'x',
    'research/ok.md': `---\nkind: source\nraw: raw/ok.md\nraw_sha256: ${sha(text)}\n---\n# Ok\n`,
    'research/nosum.md': '---\nkind: source\nraw: raw/ok.md\n---\n# NoSum\n',
    'research/missing.md': '---\nkind: source\nraw: raw/yok.md\n---\n# Missing\n',
    'research/changed.md': `---\nkind: source\nraw: raw/changed.md\nraw_sha256: ${sha('eski içerik\n')}\n---\n# Changed\n`,
    'research/outside.md': '---\nkind: source\nraw: outside/x.md\n---\n# Outside\n',
    'research/escape.md': '---\nkind: source\nraw: ../x.md\n---\n# Escape\n',
  });
  for (const verify of [false, true]) {
    const result = lint(ctx, { verify });
    assert.deepEqual(paths(result, 'raw_missing'), ['research/escape.md', 'research/missing.md', 'research/outside.md']);
    assert.deepEqual(paths(result, 'raw_changed'), ['research/changed.md']);
    assert.equal(found(result, 'raw_changed')[0].severity, 'error');
  }
  // A changed raw file is noticed on the next run, with or without --verify.
  writeFileSync(join(dir, 'raw/ok.md'), 'başka\n');
  utimesSync(join(dir, 'raw/ok.md'), new Date(2026, 5, 1), new Date(2026, 5, 1));
  assert.deepEqual(paths(lint(ctx), 'raw_changed'), ['research/changed.md', 'research/ok.md']);
  assert.deepEqual(paths(lint(ctx, { verify: true }), 'raw_changed'), ['research/changed.md', 'research/ok.md']);
});

test('wakeup_budget counts the first Uyanış or Wake-up section', (t) => {
  const words = (n) => Array.from({ length: n }, (_, i) => `k${i}`).join(' ');
  const overview = (heading, n) => `---\nkind: overview\n---\n# Genel\n\n## ${heading}\n\n${words(n)}\n\n## Diğer\n\n${words(500)}\n`;
  assert.deepEqual(paths(lint(make(t, { 'wiki/overview.md': overview('Wake-up (2026-10-28)', 350) }).ctx), 'wakeup_budget'), []);
  assert.deepEqual(paths(lint(make(t, { 'wiki/overview.md': overview('Wake-up (2026-10-28)', 351) }).ctx), 'wakeup_budget'), ['wiki/overview.md']);
  assert.deepEqual(paths(lint(make(t, { 'wiki/genel-bakis.md': overview('Uyanış', 400) }, { preset: 'tr-wiki' }).ctx), 'wakeup_budget'), ['wiki/genel-bakis.md']);
  assert.deepEqual(paths(lint(make(t, { 'wiki/overview.md': '---\nkind: overview\n---\n# Genel\n' }).ctx), 'wakeup_budget'), []);
});

test('overview_multiple reports every overview after the first', (t) => {
  const { ctx } = make(t, {
    'wiki/overview.md': page('overview'), 'notes/ikinci.md': page('overview'), 'notes/ucuncu.md': page('overview'),
  });
  const result = found(lint(ctx), 'overview_multiple');
  assert.deepEqual(result.map((f) => f.path), ['notes/ucuncu.md', 'wiki/overview.md']);
  assert.deepEqual(result[0].candidates, ['notes/ikinci.md', 'notes/ucuncu.md', 'wiki/overview.md']);
  assert.deepEqual(found(lint(make(t, { 'wiki/overview.md': page('overview') }).ctx), 'overview_multiple'), []);
});

test('index_mismatch compares the catalog with the pages, journals aside', (t) => {
  const entries = {
    'index.md': '# Katalog\n[[a]]\n[[gone]]\n[[log]]\n',
    'log.md': '# Log\n',
    'wiki/kavramlar/a.md': '---\ntur: kavram\n---\n# A\n',
    'wiki/kavramlar/b.md': '---\ntur: kavram\n---\n# B\n',
    'wiki/gunluk-loglar/2026-10-28.md': '## iş\n- x\n',
  };
  const result = lint(make(t, entries, { preset: 'tr-wiki' }).ctx);
  const mismatch = found(result, 'index_mismatch');
  assert.deepEqual(mismatch.map((f) => [f.path, f.target ?? null]).sort(), [['index.md', 'gone'], ['wiki/kavramlar/b.md', null]]);
  assert.equal(found(lint(make(t, { 'notes/a.md': '# A\n' }).ctx), 'index_mismatch').length, 0);
});

test('filename is off by default, info in tr-wiki and configurable', (t) => {
  const entries = { 'notes/Bad Name.md': '# Bad\n', 'notes/good-name.md': '# Good\n' };
  assert.equal(filenameOk('notes/good-name.md'), true);
  assert.equal(filenameOk('notes/Bad Name.md'), false);
  assert.equal(filenameOk('notes/a_b.md'), false);
  assert.deepEqual(found(lint(make(t, entries).ctx), 'filename'), []);
  const tr = found(lint(make(t, { 'Bad Name.md': '# Bad\n', 'ok.md': '# Ok\n' }, { preset: 'tr-wiki' }).ctx), 'filename');
  assert.deepEqual(tr.map((f) => [f.path, f.severity]), [['Bad Name.md', 'info']]);
  const warned = lint(make(t, entries, { config: { lint: { filename: 'warn' } } }).ctx);
  assert.deepEqual(found(warned, 'filename').map((f) => [f.path, f.severity]), [['notes/Bad Name.md', 'warn']]);
});

test('config.lint sets severities, off skips, results are ordered and --only filters', (t) => {
  const entries = {
    'wiki/concepts/a.md': '---\nkind: concept\n---\n[[yok]]\n',
    'wiki/concepts/b.md': '---\nkind: concept\n---\n[[yok]]\n',
  };
  const base = lint(make(t, entries).ctx);
  assert.deepEqual(base.findings.map((f) => f.severity), [...base.findings.map((f) => f.severity)].sort(
    (a, b) => ['error', 'warn', 'info'].indexOf(a) - ['error', 'warn', 'info'].indexOf(b)));
  assert.ok(found(base, 'orphan').length && found(base, 'broken_link').length);
  const tuned = lint(make(t, entries, { config: { lint: { orphan: 'off', broken_link: 'error', missing_page: 'warn' } } }).ctx);
  assert.deepEqual(found(tuned, 'orphan'), []);
  assert.ok(found(tuned, 'broken_link').every((f) => f.severity === 'error'));
  assert.equal(tuned.findings[0].severity, 'error');
  const only = lint(make(t, entries).ctx, { only: ['broken_link', 'orphan'] });
  assert.deepEqual([...new Set(only.findings.map((f) => f.code))].sort(), ['broken_link', 'orphan']);
  assert.deepEqual(lint(make(t, entries).ctx, { only: ['stale'] }).findings, []);
  // Evidence and code checks arrive with W8; their flags select nothing yet.
  assert.deepEqual(lint(make(t, entries).ctx, { evidence: true, code: true, only: ['evidence_missing', 'code_changed'] }).findings, []);
});

test('page text in findings is cleaned of hidden characters', (t) => {
  const { ctx } = make(t, { 'notes/a.md': 'Bkz. [[ya​nlis]]\n' });
  const finding = found(lint(ctx), 'broken_link')[0];
  assert.equal(finding.target, 'yanlis');
  assert.equal(finding.content.excerpt, '[[yanlis]]');
});

test('empty vault and unexpected files: no crash, no findings for an empty vault', (t) => {
  assert.deepEqual(lint(make(t, {}).ctx).findings, []);
  const { dir, ctx } = make(t, { 'notes/empty.md': '' });
  writeFileSync(join(dir, 'notes/crlf.md'), '﻿---\r\nkind: concept\r\ntags: [a]\r\nupdated: 2026-10-30\r\n---\r\n# CRLF\r\n[[yok]]\r\n');
  writeFileSync(join(dir, 'notes/latin.md'), Buffer.from([0x23, 0x20, 0x54, 0xFF, 0xFE, 0x0A, 0xE7, 0x0A]));
  const result = lint(ctx);
  assert.deepEqual(found(result, 'broken_link').map((f) => f.path), ['notes/crlf.md']);
  assert.equal(found(result, 'missing_frontmatter').some((f) => f.path === 'notes/crlf.md'), false);
});

test('busy or unavailable index raises index_unavailable and never scans files', (t) => {
  const { dir, ctx } = make(t, { 'notes/a.md': '# A\n[[b]]\n', 'notes/b.md': '# B\n' }, { config: {} });
  ctx.indexTimeoutMs = 10;
  refresh(ctx);
  const blocker = new DatabaseSync(join(dir, '.cairn/index.db'));
  t.after(() => { if (blocker.isOpen) blocker.close(); });
  blocker.exec('BEGIN IMMEDIATE');
  writeFileSync(join(dir, 'notes/c.md'), '# C\n');
  const stale = openContext({ mode: 'read', dataDir: dir, home: tempDir(t), env: {}, clock: clock(), platform: process.platform });
  stale.indexTimeoutMs = 10;
  assert.throws(() => lint(stale), (error) => error.code === 'index_unavailable' && error.exit === 1);
  assert.throws(() => wikiIndex(stale), (error) => error.code === 'index_unavailable');
  blocker.exec('ROLLBACK');
  assert.doesNotThrow(() => lint(stale));
});

test('wiki lint over the CLI: findings, --only, --strict and a busy index', async (t) => {
  const { dir } = make(t, { 'wiki/concepts/a.md': '---\nkind: concept\n---\n# A\n[[yok]]\n' });
  const home = tempDir(t);
  const cli = (args) => runCli(['wiki', 'lint', ...args, '--data', dir, '--preset', 'default', '--json'], { home, cwd: home, clock: clock() });
  const all = await cli([]);
  assert.equal(all.code, 0, all.stderr);
  assert.ok(all.json.data.findings.length > 0);
  const only = await cli(['--only', 'broken_link']);
  assert.deepEqual(only.json.data.findings.map((f) => f.code), ['broken_link']);
  assert.equal((await cli(['--strict'])).code, 5);
  assert.equal((await cli(['--only', 'stale', '--strict'])).code, 0);
  assert.equal((await cli(['--only', 'nope'])).code, 5);
  const info = await cli(['--only', 'missing_page', '--strict']);
  assert.equal(info.code, 0);
});

test('wiki lint and wiki index exit 1 with index_unavailable when the cache is locked', async (t) => {
  const { dir, ctx } = make(t, { 'wiki/concepts/a.md': page('concept') }, { config: {} });
  refresh(ctx);
  const blocker = new DatabaseSync(join(dir, '.cairn/index.db'));
  t.after(() => { if (blocker.isOpen) blocker.close(); });
  blocker.exec('BEGIN IMMEDIATE');
  writeFileSync(join(dir, 'wiki/concepts/b.md'), page('concept'));
  const home = tempDir(t);
  for (const command of [['wiki', 'lint'], ['wiki', 'index']]) {
    const result = await runCli([...command, '--data', dir, '--json'], { home, cwd: home, clock: clock() });
    assert.equal(result.code, 1, command.join(' '));
    assert.equal(result.json.error.code, 'index_unavailable');
  }
});

test('wiki index reads only through the strict cache callback, never the fallback readers', () => {
  const source = readFileSync(new URL('../core/wiki.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(rows|outlinks|backlinks)\(/u);
  assert.match(source, /withIndex\(ctx, \(db\)/u);
});

test('a second lint run reuses the cached raw digest; --verify recomputes it', (t) => {
  const text = 'ham\n';
  const { ctx } = make(t, { 'raw/a.md': text,
    'research/a.md': `---\nkind: source\nraw: raw/a.md\nraw_sha256: ${sha(text)}\n---\n# A\n` });
  assert.deepEqual(paths(lint(ctx), 'raw_changed'), []);
  const index = openIndex(ctx);
  try {
    assert.equal(index.db.prepare('SELECT COUNT(*) AS n FROM raw_digests').get().n, 1);
    index.db.prepare('UPDATE raw_digests SET sha256 = ?').run('f'.repeat(64));
  } finally { index.close(); }
  // The planted digest is served from the cache for the unchanged file, and replaced when verifying.
  assert.deepEqual(paths(lint(ctx), 'raw_changed'), ['research/a.md']);
  assert.deepEqual(paths(lint(ctx, { verify: true }), 'raw_changed'), []);
  assert.deepEqual(paths(lint(ctx), 'raw_changed'), []);
});

test('a non-UTF-8 page gets invalid_encoding and stays out of search; nothing crashes', (t) => {
  const { dir, ctx } = make(t, { 'notes/ok.md': '# Tamam\nkelime\n' });
  writeFileSync(join(dir, 'notes/latin.md'), Buffer.concat([Buffer.from('# Latin kelime '), Buffer.from([0xE7, 0xFF]), Buffer.from('\n')]));
  assert.doesNotThrow(() => refresh(ctx));
  assert.deepEqual(paths(lint(ctx), 'invalid_encoding'), ['notes/latin.md']);
  assert.equal(found(lint(ctx), 'invalid_encoding')[0].severity, 'info');
  assert.deepEqual(search(ctx, 'kelime').map((hit) => hit.path), ['notes/ok.md']);
  assert.deepEqual(paths(lint(make(t, { 'notes/a.md': '# A\n' }).ctx), 'invalid_encoding'), []);
});
