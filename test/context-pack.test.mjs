import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openContext } from '../core/context.mjs';
import { buildContext, formatContext } from '../core/context-pack.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { initDataDir } from '../core/roots.mjs';
import { runCli } from './support/cli.mjs';

const clock = () => fixedClock('2026-11-01T12:00:00Z');
const names = (pack) => pack.sections.map((section) => section.name);
const text = (pack, name) => pack.sections.find((section) => section.name === name)?.content.text;

function make(t, entries, { actor = null, preset = 'default' } = {}) {
  const dir = tempDir(t);
  for (const [path, body] of Object.entries(entries)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  const ctx = openContext({ mode: 'read', dataDir: dir, home: tempDir(t), env: {}, clock: clock(),
    platform: process.platform, preset, actor });
  return { dir, ctx };
}

const overview = (wake) => `---\nkind: overview\ntags: [a]\nupdated: 2026-10-30\n---\n# Genel\n\n## Uyanış (2026-10-30)\n${wake}\n\n## Other\nx\n`;
const concept = (title, body = '') => `---\nkind: concept\ntags: [a]\nupdated: 2026-10-30\n---\n# ${title}\n${body}\n`;

async function full(t) {
  const data = tempDir(t), home = tempDir(t);
  const opts = { home, data, clock: clock() };
  const run = async (args, extra) => {
    const r = await runCli([...args, '--json'], { ...opts, ...extra });
    assert.equal(r.code, 0, `${args.join(' ')} ${r.stdout}${r.stderr}`);
    return r.json.data;
  };
  initDataDir(data, { home, env: {}, clock: clock() });
  return { data, home, run, opts };
}

test('sections come in priority order with sources and a cleaned, bounded shape', async (t) => {
  const { data, run, opts } = await full(t);
  mkdirSync(join(data, 'wiki'), { recursive: true });
  writeFileSync(join(data, 'wiki/genel.md'), overview('Bugün: derle.'));
  writeFileSync(join(data, 'wiki/a.md'), concept('Hub A', 'x'));
  writeFileSync(join(data, 'wiki/b.md'), concept('Kenar', '[[a]]'));
  writeFileSync(join(data, 'wiki/c.md'), concept('Kenar 2', '[[a]]'));
  await run(['project', 'add', '--title', 'acme', '--actor', 'codex']);
  const urgent = await run(['card', 'add', '--title', 'acil is', '--priority', 'urgent', '--actor', 'codex']);
  const mine = await run(['card', 'add', '--title', 'benim', '--actor', 'codex']);
  await run(['card', 'add', '--title', 'dusuk', '--priority', 'low', '--actor', 'codex']);
  await run(['card', 'claim', mine.id, '--actor', 'codex']);
  await run(['journal', 'add', '--title', 't', '--label', 'l', '--date', '2026-10-30', '--decision', 'Sürüm sabit', '--actor', 'codex']);
  const ctx = openContext({ mode: 'read', dataDir: data, home: opts.home, env: {}, clock: clock(), platform: process.platform,
    actor: 'cli:codex' });
  const pack = buildContext(ctx, {});
  assert.deepEqual(names(pack), ['wakeup', 'projects', 'my_cards', 'urgent_cards', 'decisions', 'hubs', 'pending']);
  assert.equal(pack.sections[0].source.path, 'wiki/genel.md');
  assert.match(pack.sections[0].source.revision, /^[0-9a-f]{16}$/u);
  assert.equal(text(pack, 'wakeup'), 'Bugün: derle.');
  assert.match(text(pack, 'my_cards'), /benim/u);
  assert.equal(text(pack, 'my_cards').includes('acil is'), false);
  assert.match(text(pack, 'urgent_cards'), new RegExp(urgent.id, 'u'));
  assert.equal(text(pack, 'urgent_cards').includes('dusuk'), false);
  assert.match(text(pack, 'decisions'), /Sürüm sabit/u);
  assert.equal(text(pack, 'hubs'), '- Hub A (wiki/a.md)');
  assert.match(text(pack, 'pending'), /unprocessed_sources: 0/u);
  assert.ok(pack.sections.every((section) => section.truncated === false));
  assert.deepEqual(pack.warnings, []);
  assert.match(formatContext(pack), /^# wakeup \(wiki\/genel\.md\)\nBugün: derle\.\n\n# projects\n/u);
  // Without an actor there is no my_cards section.
  const anonymous = buildContext(openContext({ mode: 'read', dataDir: data, home: opts.home, env: {}, clock: clock(),
    platform: process.platform }), {});
  assert.equal(names(anonymous).includes('my_cards'), false);
  const cli = await runCli(['context', '--data', data, '--json'], opts);
  assert.equal(cli.code, 0, cli.stderr);
  assert.deepEqual(Object.keys(cli.json.data), ['sections']);
});

test('over budget trims from pending backwards and marks truncated', (t) => {
  const { ctx } = make(t, { 'wiki/g.md': overview('kısa uyanış'), 'wiki/a.md': concept('A'), 'wiki/b.md': concept('B', '[[a]]') });
  const roomy = buildContext(ctx, { budget: 1200 });
  const total = roomy.sections.reduce((sum, section) => sum + section.content.text.length, 0);
  const tight = buildContext(ctx, { budget: Math.ceil((total - 10) / 4) });
  assert.equal(text(tight, 'wakeup'), 'kısa uyanış');
  assert.equal(tight.sections.find((section) => section.name === 'pending').truncated, true);
  assert.equal(tight.sections.find((section) => section.name === 'wakeup').truncated, false);
  assert.ok(tight.sections.reduce((sum, section) => sum + section.content.text.length, 0) <= Math.ceil((total - 10) / 4) * 4);
  assert.deepEqual(tight.warnings, []);
});

test('a 17 KB wake-up is cut with a warning', (t) => {
  const { ctx } = make(t, { 'wiki/g.md': overview('a'.repeat(17 * 1024)) });
  const pack = buildContext(ctx, { budget: 100_000 });
  const wake = pack.sections[0];
  assert.equal(wake.truncated, true);
  assert.equal(Buffer.byteLength(wake.content.text), 16 * 1024);
  assert.deepEqual(pack.warnings, ['section_cut:wakeup']);
});

test('a wake-up over budget warns but is not trimmed', (t) => {
  const { ctx } = make(t, { 'wiki/g.md': overview('b'.repeat(2000)) });
  const pack = buildContext(ctx, { budget: 100 });
  assert.equal(text(pack, 'wakeup').length, 2000);
  assert.equal(pack.sections[0].truncated, false);
  assert.deepEqual(pack.warnings, ['wakeup_over_budget']);
  assert.equal(pack.sections.slice(1).every((section) => section.content.text === '' && section.truncated), true);
});

test('two overviews: alphabetically first wins and a warning is given', (t) => {
  const { ctx } = make(t, { 'wiki/z.md': overview('ZZZ'), 'wiki/b.md': overview('BBB') });
  const pack = buildContext(ctx, {});
  assert.equal(text(pack, 'wakeup'), 'BBB');
  assert.equal(pack.sections[0].source.path, 'wiki/b.md');
  assert.deepEqual(pack.warnings, ['overview_multiple']);
});

test('an empty data directory gives a short valid pack', async (t) => {
  const { ctx } = make(t, {});
  const pack = buildContext(ctx, {});
  assert.deepEqual(names(pack), ['pending']);
  assert.deepEqual(pack.warnings, []);
  const dir = tempDir(t);
  const cli = await runCli(['context', '--data', dir, '--preset', 'default', '--json'], { home: dir, clock: clock() });
  assert.equal(cli.code, 0, cli.stderr);
});

test('hidden characters are stripped from page text', (t) => {
  const { ctx } = make(t, { 'wiki/g.md': overview('gizli​metin‮') });
  assert.equal(text(buildContext(ctx, {}), 'wakeup'), 'gizlimetin');
});

test('invalid budget is a validation error', async (t) => {
  const { ctx } = make(t, {});
  assert.throws(() => buildContext(ctx, { budget: -1 }), { code: 'validation' });
  const dir = tempDir(t);
  const cli = await runCli(['context', '--budget', 'x', '--data', dir, '--preset', 'default', '--json'], { home: dir, clock: clock() });
  assert.equal(cli.code, 5);
});

test('a project without a status field counts as active', (t) => {
  const { ctx } = make(t, { 'wiki/projeler/yeni.md': '---\ntur: proje\n---\n# Yeni\n' }, { preset: 'tr-wiki' });
  const pack = buildContext(ctx, {});
  assert.match(text(pack, 'projects') ?? '', /Yeni/u);
});
