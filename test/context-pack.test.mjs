import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openContext } from '../core/context.mjs';
import { buildContext, formatContext } from '../core/context-pack.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { initDataDir } from '../core/roots.mjs';
import { runCli } from './support/cli.mjs';
import { reconcileExternal } from '../core/changes.mjs';
import { appendEvent, readEvents } from '../core/events.mjs';
import { withLock } from '../core/lock.mjs';
import { readSettings, setFeature } from '../core/settings.mjs';
import { revision } from '../core/store.mjs';

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

function ownerFixture(t) {
  const data = tempDir(t), home = tempDir(t);
  initDataDir(data, { home, env: {}, clock: clock() });
  mkdirSync(join(data, 'notes'));
  const ctx = openContext({ mode: 'write', dataDir: data, home, env: {}, clock: clock(), actor: 'cli:acme' });
  reconcileExternal(ctx);
  const edit = (name) => {
    writeFileSync(join(data, `notes/${name}.md`), `# ${name}`);
    reconcileExternal(ctx);
    return readEvents(ctx).at(-1);
  };
  return { data, home, ctx, edit };
}

test('context lists owner changes since actor cursor', (t) => {
  const f = ownerFixture(t), first = f.edit('first');
  mkdirSync(join(f.data, '.cairn/agents'));
  writeFileSync(join(f.data, '.cairn/agents/cursors.json'), JSON.stringify({ 'cli:acme': first.seq }));
  const second = f.edit('second');
  const pack = buildContext(f.ctx);
  assert.match(text(pack, 'owner_changes'), new RegExp(`- ${second.seq} .* create notes/second.md`, 'u'));
  assert.equal(text(pack, 'owner_changes').includes('first.md'), false);
});

test('context advances cursor', async (t) => {
  const f = ownerFixture(t), event = f.edit('owner');
  const opts = { home: f.home, data: f.data, clock: clock() };
  const first = await runCli(['context', '--actor', 'acme', '--json'], opts);
  assert.equal(first.code, 0, first.stdout);
  assert.ok(first.json.data.sections.some(({ name }) => name === 'owner_changes'));
  const cursors = JSON.parse(readFileSync(join(f.data, '.cairn/agents/cursors.json'), 'utf8'));
  assert.equal(cursors['cli:acme'], event.seq);
  const second = await runCli(['context', '--actor', 'acme', '--json'], opts);
  assert.equal(second.json.data.sections.some(({ name }) => name === 'owner_changes'), false);
});

test('context without actor shows last 24h', (t) => {
  const f = ownerFixture(t);
  for (const [tx, ts, path] of [['x-old', '2026-10-30T00:00:00Z', 'notes/old.md'],
    ['x-new', '2026-11-01T11:00:00Z', 'notes/new.md']]) {
    appendEvent(f.ctx, { tx, ts, op: 'external.change', actor: 'owner:external', target: path,
      rev: 'a', change: 'modify', targets: [{ path, target: path, rev: 'a' }] });
  }
  const pack = buildContext({ ...f.ctx, actor: null });
  assert.match(text(pack, 'owner_changes'), /notes\/new.md/u);
  assert.equal(text(pack, 'owner_changes').includes('old.md'), false);
  assert.equal(existsSync(join(f.data, '.cairn/agents/cursors.json')), false);
});

test('owner_changes trimmed under budget', (t) => {
  const f = ownerFixture(t);
  f.edit('owner');
  const pack = buildContext(f.ctx, { budget: 0 });
  const section = pack.sections.find(({ name }) => name === 'owner_changes');
  assert.equal(section.content.text, '');
  assert.equal(section.truncated, true);
});

test('owner changes are capped at ten and cursor writes are best effort', (t) => {
  const f = ownerFixture(t);
  for (let i = 0; i < 12; i++) appendEvent(f.ctx, { tx: `x-${i}`, op: 'external.change',
    actor: 'owner:external', target: 'a.md', rev: 'a', change: 'modify',
    targets: [{ path: 'a.md', target: 'a.md', rev: 'a' }] });
  withLock(f.ctx, '_cursors', () => {
    const pack = buildContext(f.ctx);
    const value = text(pack, 'owner_changes');
    assert.equal(value.split('\n').filter((line) => line.startsWith('- ')).length, 10);
    assert.match(value, /and 2 more; run changes --since 10/u);
    assert.ok(pack.warnings.includes('cursor_write_failed'));
  });
});

test('settings section is omitted when features are enabled or only liveUpdates is off', (t) => {
  const f = ownerFixture(t);
  assert.equal(names(buildContext(f.ctx)).includes('settings'), false);

  const { revision: rev } = readSettings(f.ctx);
  setFeature({ ...f.ctx, actor: 'web:owner' }, { name: 'liveUpdates', value: false, expectedRevision: rev });
  assert.equal(names(buildContext(f.ctx)).includes('settings'), false);
});

test('settings section reports disabled changeTrail and skips redundant changeContent line', async (t) => {
  const f = ownerFixture(t);
  mkdirSync(join(f.data, 'wiki'), { recursive: true });
  writeFileSync(join(f.data, 'wiki/genel.md'), overview('Bugün: derle.'));
  const readCtx = () => openContext({
    mode: 'read', dataDir: f.data, home: f.home, env: {}, clock: clock(), actor: 'cli:acme',
  });

  const { revision: rev1 } = readSettings(f.ctx);
  const { revision: rev2 } = setFeature({ ...f.ctx, actor: 'web:owner' },
    { name: 'changeTrail', value: false, expectedRevision: rev1 });
  const pack = buildContext(readCtx());
  assert.deepEqual(names(pack).slice(0, 2), ['wakeup', 'settings']);
  assert.equal(
    text(pack, 'settings'),
    'Change trail is off since 2026-11-01T12:00:00.000Z (web:owner): owner edits are not visible to you.',
  );

  // When changeTrail is already off, disabling changeContent adds no duplicate line.
  setFeature({ ...f.ctx, actor: 'cli:owner' }, { name: 'changeContent', value: false, expectedRevision: rev2 });
  const both = buildContext(readCtx());
  assert.equal(text(both, 'settings').includes('Change content is off'), false);
  // The later changeContent change must not re-date or re-attribute the trail.
  assert.match(text(both, 'settings'), /^Change trail is off since 2026-11-01T12:00:00\.000Z: /u);

  const cli = await runCli(['context', '--json'], { home: f.home, data: f.data, clock: clock() });
  assert.equal(cli.code, 0, cli.stderr);
  assert.ok(cli.json.warnings.includes('trail_disabled'));
  assert.ok(cli.json.data.sections.some(({ name, content }) => name === 'settings'
    && content.text.startsWith('Change trail is off since ')));

  // Fallback when no prior lastChange record is available.
  const cfgRev = revision(readFileSync(join(f.data, '.cairn/config.json')));
  const statePath = join(f.data, '.cairn/settings-state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  writeFileSync(statePath, JSON.stringify({ ...state, rev: cfgRev, lastChange: null, trailOffSince: null }) + '\n');
  assert.equal(
    text(buildContext(readCtx()), 'settings'),
    'Change trail is off since unknown: owner edits are not visible to you.',
  );
});

test('settings section reports disabled changeContent and mentions without liveUpdates', (t) => {
  const f = ownerFixture(t);
  let rev = readSettings(f.ctx).revision;
  for (const name of ['changeContent', 'mentions', 'liveUpdates']) {
    rev = setFeature({ ...f.ctx, actor: 'web:owner' }, { name, value: false, expectedRevision: rev }).revision;
  }
  const pack = buildContext(f.ctx);
  assert.equal(
    text(pack, 'settings'),
    'Change content is off: cairn changes --diff shows no diffs.\nUnlinked mentions are off.',
  );
  assert.match(
    formatContext(pack),
    /^# settings\nChange content is off: cairn changes --diff shows no diffs\.\nUnlinked mentions are off\.\n/mu,
  );
});

test('settings read failure warns without failing buildContext', (t) => {
  const f = ownerFixture(t);
  withLock(f.ctx, '_config', () => {
    const pack = buildContext(f.ctx);
    assert.equal(names(pack).includes('settings'), false);
    assert.ok(pack.warnings.includes('settings_read_failed'));
  });
});
