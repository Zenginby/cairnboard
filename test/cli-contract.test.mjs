import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import * as fs from '../core/fsx.mjs';
import { initDataDir, writeProjectLink } from '../core/roots.mjs';
import { tempDir, fixedClock } from './support/env.mjs';
import { runCli, spawnCli } from './support/cli.mjs';
import { parse } from '../cli/args.mjs';
import { commands } from '../cli/registry.mjs';
import { confirm } from '../cli/confirm.mjs';
import { toJson } from '../cli/output.mjs';
import { CairnError, ERRORS } from '../core/errors.mjs';

function fixture(t, initialized = true) {
  const home = tempDir(t), data = tempDir(t), cwd = tempDir(t);
  const clock = fixedClock('2026-11-01T12:00:00Z');
  if (initialized) initDataDir(data, { home, env: {}, clock });
  const opts = { home, data, cwd, clock };
  const put = (path, text) => {
    fs.mkdirSync(dirname(join(data, path)), { recursive: true });
    fs.writeFileSync(join(data, path), text);
  };
  return { ...opts, opts, put, run: (args, extra) => runCli(args, { ...opts, ...extra }) };
}

function tree(root, skipCache = false, prefix = '') {
  return fs.readdirSync(join(root, prefix)).sort().flatMap((name) => {
    const path = prefix ? `${prefix}/${name}` : name;
    if (skipCache && /^\.cairn\/index\.db(?:-wal|-shm|-journal)?$/u.test(path)) return [];
    const stat = fs.statSync(join(root, path));
    return stat.isDirectory() ? tree(root, skipCache, path) : [[path, stat.size, stat.mtimeMs]];
  });
}

test('schema needs no data and matches the public snapshot', async (t) => {
  const f = fixture(t, false);
  const response = await f.run(['schema', '--json', '--data', join(f.data, 'missing')]);
  assert.equal(response.code, 0);
  assert.deepEqual(Object.keys(response.json), ['v', 'ok', 'data', 'warnings']);
  assert.equal(response.json.v, 1);
  assert.equal(response.json.ok, true);
  assert.deepEqual(response.json.warnings, []);
  assert.equal(response.stderr, '');
  const snapshot = new URL('./fixtures/schema.json', import.meta.url);
  if (process.env.UPDATE_SNAPSHOTS === '1') fs.writeFileSync(snapshot, `${JSON.stringify(response.json.data, null, 2)}\n`);
  assert.deepEqual(response.json.data, JSON.parse(fs.readFileSync(snapshot, 'utf8')));
  assert.deepEqual(response.json.data.errors, Object.entries(ERRORS).map(([code, exit]) => ({ code, exit })));
  const commands = response.json.data.commands;
  assert.ok(commands.filter((item) => item.mode === 'read').every((item) => item.dangerous === false));
  assert.deepEqual(commands.filter((item) => item.dangerous !== false).map((item) => [item.name, item.dangerous]),
    [['project rm', true], ['card claim', { option: 'steal' }], ['init', { option: 'set-default' }], ['link', true], ['agent install', true]]);
});

test('strict parsing accepts common flags anywhere and rejects invalid input', () => {
  const parsed = parse(['--json', '--actor', 'acme', 'card', 'list', '--dry-run', '--if-revision', 'abc']);
  assert.equal(parsed.command.name, 'card list');
  assert.equal(parsed.opts['max-bytes'], 65536);
  assert.equal(parsed.opts.actor, 'acme');
  for (const argv of [[], ['absent'], ['card'], ['status', 'extra'], ['note', 'show'],
    ['status', '--yes'], ['status', '--all'], ['note', 'list', '--kind'], ['status', '--max-bytes', '-1'],
    ['status', '--max-bytes', '1.5'], ['status', '--max-bytes', 'NaN']]) {
    assert.throws(() => parse(argv), { code: 'usage' });
  }
});

test('errors use stable exit codes and separate stdout from diagnostics', async (t) => {
  const f = fixture(t);
  for (const [args, code, error] of [
    [['card', 'show', 'c-000000'], 3, 'not_found'],
    [['journal', 'show', '2026-02-30'], 5, 'validation'],
    [['status', '--unknown'], 2, 'usage'],
    [['card', 'list', '--assignee', 'me'], 2, 'actor_required'],
  ]) {
    const json = await f.run([...args, '--json']);
    assert.equal(json.code, code);
    assert.equal(json.json.ok, false);
    assert.equal(json.json.error.code, error);
    assert.equal(json.stderr, '');
    assert.deepEqual(json.json.warnings, []);
    const human = await f.run(args);
    assert.equal(human.code, code);
    assert.equal(human.stdout, '');
    assert.equal(human.stderr.trim().split('\n').length, 1);
  }
});

test('reads need no actor and never consume stdin', async (t) => {
  const f = fixture(t);
  const stdin = new Readable({ read() { throw new Error('stdin must stay unread'); } });
  t.after(() => stdin.destroy());
  assert.equal((await f.run(['card', 'list', '--json'], { stdin })).code, 0);
  assert.equal((await f.run(['status', '--actor', 'acme', '--dry-run', '--if-revision', 'abc', '--json'])).code, 0);
});

test('ephemeral wiki reads leave all source files unchanged and split quick notes from wiki kinds', async (t) => {
  const f = fixture(t, false);
  f.put('quick.md', '# Quick\n');
  f.put('wiki/kavramlar/acme.md', '# Acme\n');
  const before = tree(f.data);
  const quick = await f.run(['note', 'list', '--preset', 'tr-wiki', '--json']);
  assert.equal(quick.code, 0);
  assert.deepEqual(quick.json.data.items.map((item) => item.path), ['quick.md']);
  const all = await f.run(['note', 'list', '--all', '--preset', 'tr-wiki', '--json']);
  assert.equal(all.json.data.items.length, 2);
  assert.equal(all.json.data.items.find((item) => item.path.includes('kavramlar')).meta.kind, 'concept');
  const concepts = await f.run(['note', 'list', '--kind', 'concept', '--preset', 'tr-wiki', '--json']);
  assert.equal(concepts.json.data.items.length, 1);
  assert.deepEqual(tree(f.data), before);
});

test('compact cards have six safe tab separated fields and include manual cards', async (t) => {
  const f = fixture(t);
  f.put('cards/manual.md', '---\ntitle: "Acme\\n\\twork"\ncolumn: backlog\n---\n## Acceptance\n- [x] One\n- [ ] Two\n');
  const response = await f.run(['card', 'list', '--unassigned', '--column-role', 'todo', '--compact', '--json']);
  assert.equal(response.code, 0);
  assert.deepEqual(response.json.data.items, ['@cards/manual\tbacklog\t-\t-\t1/2\tAcme  work']);
  const human = await f.run(['card', 'list', '--compact']);
  assert.equal(human.stdout, `${response.json.data.items[0]}\n`);
  assert.deepEqual((await f.run(['card', 'show', '@cards/manual', '--compact', '--json'])).json.data.items, response.json.data.items);
});

test('file strings stay in content and are recursively cleaned, including keys', async (t) => {
  const f = fixture(t);
  f.put('notes/acme.md', '---\ntitle: Acme\nkind: note\npinned: true\ntags: ["a\u200bb"]\nassignee: "bad\u200b name"\nx-extra:\n  "a\u200bb": "c\u200bd"\n---\nBody\u200b\n');
  const clean = await f.run(['note', 'show', '@notes/acme', '--json']);
  assert.deepEqual(clean.json.data.meta, { kind: 'note', pinned: true, acceptance: { done: 0, total: 0 } });
  assert.deepEqual(clean.json.data.content['x-extra'], { ab: 'cd' });
  assert.deepEqual(clean.json.data.content.tags, ['ab']);
  assert.equal(clean.json.data.content.assignee, 'bad name');
  assert.ok(!clean.stdout.includes('\u200b'));
  const raw = await f.run(['note', 'show', '@notes/acme', '--raw', '--json']);
  assert.ok(raw.stdout.includes('\u200b'));
  assert.equal(raw.json.data.meta.assignee, undefined);
});

test('compact output tolerates malformed owner fields', async (t) => {
  const f = fixture(t);
  f.put('cards/acme.md', '---\ncolumn: backlog\nassignee: {toString: bad}\n---\n# Acme\n');
  const response = await f.run(['card', 'list', '--compact', '--json']);
  assert.equal(response.code, 0);
  assert.deepEqual(response.json.data.items, ['@cards/acme\tbacklog\t-\t-\t0/0\tAcme']);
});

test('meta accepts only validated fields and configured columns', () => {
  const item = { type: 'card', title: 'Acme', data: { column: 'absent', status: 'hack', tone: 9,
    position: 'a0\u200b', priority: 'do this', pinned: 'yes', kind: 'alien', date: '2026-02-30',
    created: '2026-11-01T12:00:00Z', updated: 'not a date', assignee: 'acme', aliases: ['Acme'] },
  acceptance: { done: 0, total: 1 } };
  const result = toJson(item, { columns: [{ key: 'backlog' }] });
  assert.deepEqual(result.meta, { created: '2026-11-01T12:00:00Z', assignee: 'acme', acceptance: { done: 0, total: 1 } });
  assert.equal(result.content.column, 'absent');
  assert.deepEqual(result.content.aliases, ['Acme']);
});

test('body limits count UTF-8 bytes without splitting code points', async (t) => {
  const f = fixture(t);
  f.put('notes/acme.md', '---\ntitle: Acme\n---\n' + '🙂'.repeat(8));
  const response = await f.run(['note', 'show', '@notes/acme', '--max-bytes', '10', '--json']);
  assert.equal(response.json.data.content.body, '🙂🙂');
  assert.deepEqual(response.json.warnings, ['truncated']);
  assert.ok(Buffer.byteLength(response.json.data.content.body) <= 10);
});

test('status counts effective columns; external cards appear on subsequent reads', async (t) => {
  const f = fixture(t);
  f.put('projects/acme.md', '# Acme\n');
  f.put('notes/acme.md', '# Acme\n');
  f.put('research/acme.md', '# Acme\n');
  f.put('cards/acme.md', '---\ncolumn: absent\n---\n# Acme\n');
  const status = await f.run(['status', '--json']);
  assert.equal(status.json.data.dataDir, fs.realpathSync(f.data));
  assert.equal(status.json.data.ephemeral, false);
  assert.deepEqual(status.json.data.counts, { projects: 1, notes: 1, research: 1,
    cards: { backlog: 1, doing: 0, review: 0, done: 0 } });
  assert.ok(status.json.warnings.includes('unknown_column'));
  assert.ok((await f.run(['card', 'show', '@cards/acme', '--json'])).json.warnings.includes('unknown_column'));
  assert.equal((await f.run(['card', 'list', '--json'])).json.data.items.length, 1);
  f.put('cards/new.md', '# New\n');
  assert.equal((await f.run(['card', 'list', '--json'])).json.data.items.length, 2);
});

test('card filters, actor precedence and project links match the core contract', async (t) => {
  const f = fixture(t);
  f.put('projects/acme.md', '---\nid: p-000000\n---\n# Acme\n');
  f.put('cards/acme.md', '---\nproject: p-000000\ncolumn: backlog\nassignee: acme\npriority: low\ntags: [work]\n---\n# Acme\n');
  f.put('cards/done.md', '---\ncolumn: done\n---\n# Done\n');
  writeProjectLink(f.cwd, 'p-000000');
  const selected = await f.run(['card', 'list', '--assignee', 'me', '--actor', 'acme', '--priority', 'low', '--tag', 'work', '--json'],
    { env: { CAIRN_ACTOR: 'zorblax' } });
  assert.equal(selected.json.data.items.length, 1);
  assert.equal((await f.run(['card', 'list', '--column', 'doing', '--json'])).json.data.items.length, 0);
  assert.equal((await f.run(['card', 'list', '--all', '--json'], { cwd: f.home })).json.data.items.length, 2);
});

test('all read commands preserve sources and metadata except the index cache', async (t) => {
  const f = fixture(t);
  for (const folder of ['projects', 'cards', 'notes', 'research']) f.put(`${folder}/acme.md`, '# Acme\nBody\n');
  f.put('journal/2026-11-01.md', '---\ndate: 2026-11-01\n---\n## Acme: Work\n- **Decision:** Keep\n- **Lesson:** Learn\n');
  const before = tree(f.data, true);
  for (const type of ['project', 'card', 'note', 'research']) {
    assert.equal((await f.run([type, 'list', '--json'])).code, 0);
    const folder = type === 'research' ? type : `${type}s`;
    assert.equal((await f.run([type, 'show', `@${folder}/acme`, '--json'])).json.data.content.title, 'Acme');
  }
  for (const args of [['journal', 'list'], ['journal', 'show', '2026-11-01'], ['trash', 'list'], ['status'], ['search', 'Acme']]) {
    const response = await f.run([...args, '--json'], { env: { CAIRN_DEBUG: '1' } });
    assert.equal(response.code, 0, `${args.join(' ')}: ${response.stdout}${response.stderr}`);
  }
  const entries = await f.run(['journal', 'list', '--type', 'lesson', '--unprocessed', '--since', '2026-11-01', '--json']);
  assert.equal(entries.json.data.items.length, 1);
  assert.equal(entries.json.data.items[0].content.text, 'Learn');
  const limited = await f.run(['journal', 'list', '--type', 'lesson', '--max-bytes', '2', '--json']);
  assert.equal(limited.json.data.items[0].content.text, 'Le');
  assert.deepEqual(limited.json.warnings, ['truncated']);
  const search = await f.run(['search', 'Body', '--json']);
  assert.ok(search.json.data.items.length > 0);
  assert.equal(typeof search.json.data.items[0].content.snippet, 'string');
  assert.deepEqual(tree(f.data, true), before);
});

test('NO_COLOR and CI do not change output', async (t) => {
  const f = fixture(t);
  f.put('notes/acme.md', '# Acme\n');
  for (const flags of [[], ['--json'], ['--compact']]) {
    const plain = await f.run(['note', 'list', ...flags]);
    const ci = await f.run(['note', 'list', ...flags], { env: { NO_COLOR: '1', CI: '1' } });
    assert.equal(plain.stdout, ci.stdout);
  }
});

test('confirmation uses stderr, requires a TTY and accepts only yes', async () => {
  await assert.rejects(confirm({ isTTY: false }, 'Proceed?'), { code: 'confirmation_required' });
  for (const [answer, expected] of [['yes\n', true], ['y\n', false], ['no\n', false], ['', false]]) {
    let stderr = '';
    assert.equal(await confirm({ isTTY: true, stdin: Readable.from([answer]),
      stderr: { write: (text) => { stderr += text; } } }, 'Proceed?'), expected);
    assert.match(stderr, /Proceed\?/u);
  }
});

test('main enforces write actor, confirmation and dry-run before opening context', async (t) => {
  const f = fixture(t, false);
  let called = 0;
  const command = { name: 'fixture', summary: 'Fixture command.', args: [], options: {}, mode: 'write', needsData: false,
    dangerous: { option: 'steal' }, run: (ctx, args, opts) => { called++; assert.equal(ctx, null); return { data: opts.actor }; } };
  command.options.steal = { type: 'boolean', summary: 'Require confirmation.' };
  commands.push(command);
  t.after(() => commands.splice(commands.indexOf(command), 1));
  assert.equal((await f.run(['fixture', '--json'])).json.error.code, 'actor_required');
  assert.equal((await f.run(['fixture', '--actor', 'BAD', '--json'])).code, 2);
  assert.equal((await f.run(['fixture', '--actor', 'acme', '--steal', '--json'])).code, 7);
  assert.equal(called, 0);
  assert.equal((await f.run(['fixture', '--actor', 'acme', '--steal', '--dry-run', '--json'])).code, 0);
  assert.equal(called, 1);
  command.dangerous = true;
  assert.equal((await f.run(['fixture', '--actor', 'acme', '--json'], { isTTY: true, stdin: 'no\n' })).code, 7);
  const confirmed = await f.run(['fixture', '--actor', 'acme', '--json'], { isTTY: true, stdin: 'yes\n' });
  assert.equal(confirmed.code, 0);
  assert.match(confirmed.stderr, /Type yes/u);
  assert.equal(confirmed.json.ok, true);
  assert.equal(called, 2);
  initDataDir(f.data, { home: f.home, env: {}, clock: f.clock });
  command.needsData = true;
  command.run = (ctx) => ({ data: { actor: ctx.actor, mode: ctx.mode, now: ctx.clock.now().toISOString() } });
  const before = tree(f.data);
  const dry = await f.run(['fixture', '--dry-run', '--json'], { env: { CAIRN_ACTOR: 'zorblax' } });
  assert.deepEqual(dry.json.data, { actor: 'cli:zorblax', mode: 'dry-run', now: '2026-11-01T12:00:00.000Z' });
  assert.deepEqual(tree(f.data), before);
});

test('main maps current conflicts and hides internal errors unless debug is enabled', async (t) => {
  const f = fixture(t, false);
  const command = { name: 'fixture', summary: 'Fixture command.', args: [], options: {}, mode: 'read', needsData: false,
    dangerous: false, run: () => { throw new CairnError('conflict', 'Changed\nfile', { current: { title: 'Acme\u200b' } }); } };
  commands.push(command);
  t.after(() => commands.splice(commands.indexOf(command), 1));
  const conflict = await f.run(['fixture', '--json']);
  assert.equal(conflict.code, 4);
  assert.deepEqual(conflict.json.error.current, { title: 'Acme' });
  command.run = () => { throw new Error('private detail'); };
  const internal = await f.run(['fixture', '--json']);
  assert.equal(internal.code, 1);
  assert.equal(internal.json.error.code, 'internal');
  assert.ok(!internal.stdout.includes('private detail'));
  assert.equal(internal.stderr, '');
  const debug = await f.run(['fixture', '--json'], { env: { CAIRN_DEBUG: '1' } });
  assert.match(debug.stderr, /private detail/u);
  assert.deepEqual(debug.json, internal.json);
});

test('executable returns a parseable envelope and exit code with diagnostics on stderr', async (t) => {
  const f = fixture(t);
  const success = await spawnCli(['schema', '--json'], f.opts);
  assert.equal(success.code, 0);
  assert.equal(success.json.ok, true);
  const missing = await spawnCli(['card', 'show', 'c-000000', '--json'], f.opts);
  assert.equal(missing.code, 3);
  assert.equal(missing.json.error.code, 'not_found');
  const human = await spawnCli(['status', '--unknown'], f.opts);
  assert.equal(human.code, 2);
  assert.equal(human.stdout, '');
  assert.match(human.stderr, /usage/u);
  const unsupported = await spawnCli(['schema', '--json'], { ...f.opts, env: { NODE_OPTIONS: '--no-experimental-sqlite' } });
  assert.equal(unsupported.code, 5);
  assert.equal(unsupported.json.error.code, 'runtime_unsupported');
});
