import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultConfig, loadConfig } from '../core/config.mjs';
import { openContext } from '../core/context.mjs';
import { checkPage } from '../core/check.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { runCli } from './support/cli.mjs';
import { copyVault, snapshot, assertUnchanged } from './support/vault.mjs';

const clock = fixedClock('2026-11-01T12:00:00Z');

// A throw-away data directory with `config` laid over the default configuration.
function make(t, entries = {}, { rules, language = 'en', preset } = {}) {
  const dir = tempDir(t), home = tempDir(t);
  mkdirSync(join(dir, '.cairn'));
  writeFileSync(join(dir, '.cairn/config.json'), JSON.stringify({ ...defaultConfig(language), ...(rules ? { rules } : {}) }));
  for (const [path, text] of Object.entries(entries)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const ctx = openContext({ mode: 'read', dataDir: dir, home, env: {}, clock, platform: process.platform, preset });
  const run = (args, stdin) => runCli([...args, '--data', dir, '--actor', 'acme', '--json'], { home, cwd: home, clock, stdin });
  return { dir, home, ctx, run };
}

const concept = (extra = '', body = '# T\n') => `---\nkind: concept\ntags: [a]\nupdated: 2026-10-30\n${extra}---\n${body}`;
const names = (list) => list.map((item) => item.rule);
const check = (f, path, text, opts) => checkPage(f.ctx, { path, text, ...opts });

test('required: title and kind fields are reported, each only when missing', (t) => {
  const f = make(t);
  assert.deepEqual(names(check(f, 'wiki/concepts/x.md', '---\nkind: concept\n---\nno heading\n').warnings.filter((w) => w.rule === 'required')),
    ['required', 'required', 'required']);
  const passed = check(f, 'wiki/concepts/x.md', concept('sources: [a]\n'));
  assert.deepEqual(passed, { errors: [], warnings: [] });
  const missing = check(f, 'wiki/concepts/x.md', '---\nkind: concept\ntags: [a]\nsources: [a]\n---\n# T\n').warnings;
  assert.deepEqual(missing.map((item) => item.field), ['updated']);
  // The title may come from the first heading or from the frontmatter.
  assert.deepEqual(check(f, 'notes/a.md', '---\ntitle: Hi\n---\nbody\n').warnings, []);
  assert.deepEqual(names(check(f, 'notes/a.md', 'body only\n').warnings), ['required']);
});

test('required: a journal needs only date, which its file name satisfies; research source needs raw and sourceDate', (t) => {
  const f = make(t);
  assert.deepEqual(check(f, 'journal/2026-10-30.md', 'text\n'), { errors: [], warnings: [] });
  assert.deepEqual(check(f, 'journal/notes.md', 'text\n').warnings.map((w) => w.field), ['date']);
  assert.deepEqual(check(f, 'research/a.md', '---\nkind: source\n---\n# A\n').warnings.map((w) => w.field), ['raw', 'sourceDate']);
  assert.deepEqual(check(f, 'research/a.md', '---\nkind: review\n---\n# A\n').warnings, []);
});

test('sources: a field or a heading satisfies it, an empty list or code fence does not', (t) => {
  const f = make(t);
  const sources = (text) => check(f, 'wiki/concepts/x.md', text).warnings.filter((item) => item.rule === 'sources');
  assert.equal(sources(concept()).length, 1);
  assert.equal(sources(concept('sources: []\n')).length, 1);
  assert.equal(sources(concept('sources: [a]\n')).length, 0);
  assert.equal(sources(concept('', '# T\n\n## Sources\n- a\n')).length, 0);
  assert.equal(sources(concept('', '# T\n\n## Kaynaklar\n- a\n')).length, 0);
  assert.equal(sources(concept('', '# T\n\n```\n## Sources\n```\n')).length, 1);
  // Plain notes and other kinds never need sources.
  assert.deepEqual(check(f, 'notes/a.md', '# A\n').warnings, []);
  assert.equal(check(f, 'wiki/overview.md', '---\nkind: overview\n---\n# O\n').warnings.length, 0);
});

test('sources: the expected heading is Kaynaklar in a Turkish configuration or tr-wiki schema', (t) => {
  const tr = make(t, {}, { language: 'tr' });
  assert.match(check(tr, 'wiki/concepts/x.md', concept()).warnings.find((w) => w.rule === 'sources').detail, /## Kaynaklar/u);
  const en = make(t);
  assert.match(check(en, 'wiki/concepts/x.md', concept()).warnings.find((w) => w.rule === 'sources').detail, /## Sources/u);
  const wiki = openContext({ mode: 'read', dataDir: copyVault(t), home: tempDir(t), env: {}, clock, platform: process.platform, preset: 'tr-wiki' });
  const warnings = checkPage(wiki, { path: 'wiki/kavramlar/x.md', text: '---\ntur: kavram\netiketler: [a]\nguncelleme: 2026-10-30\nkaynaklar: []\n---\n# T\n' }).warnings;
  assert.match(warnings.find((w) => w.rule === 'sources').detail, /## Kaynaklar/u);
});

test('links: unresolved links are reported with line and target under content; resolved and ambiguous are not', (t) => {
  const f = make(t, { 'notes/real.md': '# Real\n', 'a/dup.md': '# D\n', 'b/dup.md': '# D\n' });
  const text = '# T\n\n[[real]] [[dup]] [[ghost|label]] `[[code]]`\n[[Self]]\n';
  const { warnings } = check(f, 'notes/self.md', text);
  assert.deepEqual(warnings.map((item) => [item.rule, item.line, item.content?.target]), [['links', 3, 'ghost']]);
});

test('links: a stdin draft is parsed from its text, not from the file on disk', (t) => {
  const f = make(t, { 'notes/page.md': '# P\n[[ghost]]\n' });
  assert.deepEqual(check(f, 'notes/page.md', '# P\nclean\n').warnings, []);
  assert.equal(check(f, 'notes/page.md', '# P\n[[ghost]]\n').warnings.length, 1);
});

test('filename: off by default, info-level in tr-wiki is not an error or warning, and config sets it', (t) => {
  const f = make(t);
  assert.deepEqual(check(f, 'notes/Bad Name.md', '# A\n'), { errors: [], warnings: [] });
  const strict = make(t, {}, { rules: { filename: 'error' } });
  assert.deepEqual(names(check(strict, 'notes/Bad Name.md', '# A\n').errors), ['filename']);
  assert.deepEqual(check(strict, 'notes/good-name.md', '# A\n'), { errors: [], warnings: [] });
  const warn = make(t, {}, { rules: { filename: 'warn' } });
  assert.deepEqual(names(check(warn, 'notes/Bad Name.md', '# A\n').warnings), ['filename']);
});

test('severities: config.rules turns a rule into an error or off', (t) => {
  const f = make(t, {}, { rules: { required: 'error', sources: 'off', links: 'error' } });
  const result = check(f, 'wiki/concepts/x.md', '---\nkind: concept\n---\n[[ghost]]\n');
  assert.deepEqual(names(result.errors), ['required', 'required', 'required', 'links']);
  assert.deepEqual(result.warnings, []);
});

test('config.rules is validated', (t) => {
  const dir = tempDir(t);
  mkdirSync(join(dir, '.cairn'));
  for (const rules of [[], 'warn', { nope: 'warn' }, { links: 'info' }, { links: 3 }]) {
    writeFileSync(join(dir, '.cairn/config.json'), JSON.stringify({ ...defaultConfig('en'), rules }));
    assert.throws(() => loadConfig(dir), { code: 'validation' });
  }
  writeFileSync(join(dir, '.cairn/config.json'), JSON.stringify({ ...defaultConfig('en'), rules: { links: 'error', filename: 'off' } }));
  assert.deepEqual(loadConfig(dir).rules, { links: 'error', filename: 'off' });
});

test('note add: an error rule refuses the write with exit 5 and writes nothing', async (t) => {
  const f = make(t, {}, { rules: { required: 'error' } });
  const response = await f.run(['note', 'add', '--kind', 'concept', '--title', 'Untagged']);
  assert.equal(response.code, 5, response.stdout);
  assert.equal(response.json.error.code, 'validation');
  assert.deepEqual(response.json.error.rules.map((item) => item.field), ['tags']);
  assert.equal(existsSync(join(f.dir, 'wiki/concepts/untagged.md')), false);
  const dry = await f.run(['note', 'add', '--kind', 'concept', '--title', 'Untagged', '--dry-run']);
  assert.equal(dry.code, 5);
});

test('note add: a warn rule writes and reports rule:<name>; a clean page has no rule warnings', async (t) => {
  const f = make(t);
  const response = await f.run(['note', 'add', '--kind', 'concept', '--title', 'Loose', '--body', '-'], '[[ghost]]\n');
  assert.equal(response.code, 0, response.stdout + response.stderr);
  assert.deepEqual(response.json.warnings, ['rule:required', 'rule:sources', 'rule:links']);
  assert.ok(existsSync(join(f.dir, 'wiki/concepts/loose.md')));
  const plain = await f.run(['note', 'add', '--title', 'Plain']);
  assert.deepEqual(plain.json.warnings, []);
});

test('note update and research add check the text that will be written', async (t) => {
  const f = make(t, { 'notes/a.md': '# A\n' }, { rules: { links: 'error' } });
  const refused = await f.run(['note', 'update', '@notes/a', '--body', '-'], '# A\n[[ghost]]\n');
  assert.equal(refused.code, 5);
  assert.equal(readFileSync(join(f.dir, 'notes/a.md'), 'utf8'), '# A\n');
  const fixed = await f.run(['note', 'update', '@notes/a', '--body', '-'], '# A\n[[a]]\n');
  assert.equal(fixed.code, 0, fixed.stdout);
  const research = await f.run(['research', 'add', '--title', 'Src', '--body', '-'], '[[ghost]]\n');
  assert.equal(research.code, 5);
  assert.equal(existsSync(join(f.dir, 'research/src.md')), false);
  const reviewed = await f.run(['research', 'add', '--kind', 'review', '--title', 'Rev']);
  assert.equal(reviewed.code, 0, reviewed.stdout);
  assert.deepEqual(reviewed.json.warnings, []);
});

test('wiki check: a file, a stdin draft with --path, exit 5 on error, usage without --path', async (t) => {
  const f = make(t, { 'wiki/concepts/x.md': concept('sources: [a]\n') }, { rules: { links: 'error' } });
  const ok = await f.run(['wiki', 'check', 'wiki/concepts/x.md']);
  assert.equal(ok.code, 0, ok.stdout);
  assert.deepEqual(ok.json.data, { errors: [], warnings: [] });
  const draft = await f.run(['wiki', 'check', '-', '--path', 'wiki/concepts/y.md'], '---\nkind: concept\n---\n# Y\n[[ghost]]\n');
  assert.equal(draft.code, 5);
  assert.deepEqual(draft.json.data.errors.map((item) => [item.rule, item.line, item.content.target]), [['links', 5, 'ghost']]);
  assert.deepEqual(draft.json.data.warnings.map((item) => item.rule), ['required', 'required', 'sources']);
  assert.equal(existsSync(join(f.dir, 'wiki/concepts/y.md')), false);
  assert.equal((await f.run(['wiki', 'check', '-'], 'x')).code, 2);
  assert.equal((await f.run(['wiki', 'check', 'wiki/concepts/x.md', '--path', 'a.md'])).code, 2);
  assert.equal((await f.run(['wiki', 'check', 'nope.md'])).code, 3);
});

test('wiki check classifies a tr-wiki draft by --path and leaves the vault untouched', async (t) => {
  const data = copyVault(t), home = tempDir(t);
  const before = snapshot(data);
  const run = (args, stdin) => runCli([...args, '--data', data, '--preset', 'tr-wiki', '--json'], { home, cwd: home, clock, stdin });
  const draft = await run(['wiki', 'check', '-', '--path', 'wiki/kavramlar/x.md'], '# Yeni\n[[acme-kavrami]] [[yok-boyle-sayfa]]\n');
  assert.equal(draft.code, 0, draft.stdout);
  assert.deepEqual(draft.json.data.warnings.map((item) => item.rule), ['required', 'required', 'sources', 'links']);
  assert.deepEqual(draft.json.data.warnings.at(-1).content, { target: 'yok-boyle-sayfa' });
  const real = await run(['wiki', 'check', 'wiki/kavramlar/acme-kavrami.md']);
  assert.deepEqual(real.json.data, { errors: [], warnings: [] });
  assertUnchanged(before, data);
});
