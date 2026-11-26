import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import * as fs from '../core/fsx.mjs';
import { initDataDir, writeProjectLink } from '../core/roots.mjs';
import { tempDir, fixedClock, seedDataDir } from './support/env.mjs';
import { runCli, spawnCli } from './support/cli.mjs';
import { parse } from '../cli/args.mjs';
import { commands } from '../cli/registry.mjs';
import { confirm } from '../cli/confirm.mjs';
import { toJson } from '../cli/output.mjs';
import { revision } from '../core/store.mjs';
import { PRESETS } from '../core/presets.mjs';
import { CairnError, ERRORS } from '../core/errors.mjs';

function fixture(t, initialized = true) {
  const home = tempDir(t), data = tempDir(t), cwd = tempDir(t);
  const clock = fixedClock('2026-11-01T12:00:00Z');
  if (initialized) seedDataDir(data, { home, env: {}, clock });
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
  const expected = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
  // Keep the existing command snapshot frozen; assert the additive detection contract here.
  const init = expected.commands.find(({ name }) => name === 'init');
  init.options.detect = { type: 'string',
    summary: 'Detect an existing vault schema; preview with --dry-run, confirm with --yes.' };
  init.options.yes = { type: 'boolean', summary: 'Apply a detected schema without prompting; only with --detect.' };
  expected.commands.splice(expected.commands.findIndex(({ name }) => name === 'context') + 1, 0, {
    name: 'changes', summary: 'List recorded changes and optional line diffs.', args: [],
    options: { ...expected.commands.find(({ name }) => name === 'home').options,
      since: { type: 'string', summary: 'Include changes after a sequence or at an ISO timestamp.' },
      target: { type: 'string', summary: 'Filter by entity id or path.' },
      diff: { type: 'boolean', summary: 'Show bounded line diffs.' },
      actor: { type: 'string', summary: 'Filter by event actor.' },
      limit: { type: 'string', summary: 'Maximum changes, from 1 to 200 (default: 20).' } },
    mode: 'read', needsData: true, dangerous: false,
  });
  const common = expected.commands.find(({ name }) => name === 'agent print').options;
  expected.commands.splice(expected.commands.findIndex(({ name }) => name === 'doctor'), 0,
    { name: 'config', summary: 'Show feature settings, shadow size and last change.', args: [], options: common,
      mode: 'read', needsData: true, dangerous: false },
    { name: 'config get', summary: 'Get one feature setting or the language.', args: ['<feature>'], options: common,
      mode: 'read', needsData: true, dangerous: false },
    { name: 'config set', summary: 'Enable or disable a feature, or set the language.',
      args: ['<feature>', '<value>'], options: common,
      mode: 'write', needsData: true, dangerous: false, actor: false, agentVisible: false },
    { name: 'config clear-shadow',
      summary: 'Delete stored shadow content blobs while keeping change-trail revisions.',
      args: [], options: common, mode: 'write', needsData: true, dangerous: false, actor: false,
      agentVisible: false });
  // Additive: a card's one-line status fields (now, next, needs) and their add and update options.
  expected.fields.card.push('now', 'next', 'needs');
  for (const name of ['card add', 'card update']) {
    Object.assign(expected.commands.find((item) => item.name === name).options, {
      now: { type: 'string', summary: 'Set the one-line "now" status; an empty value removes it.' },
      next: { type: 'string', summary: 'Set the one-line "next" status; an empty value removes it.' },
      needs: { type: 'string', summary: 'Set what the owner is needed for, one line; an empty value removes it.' },
    });
  }
  // Additive: a research record's one-line category and its add and update options.
  expected.fields.research.push('category');
  for (const name of ['research add', 'research update']) {
    expected.commands.find((item) => item.name === name).options.category = { type: 'string',
      summary: 'Set the one-line research category; an empty value removes it.' };
  }
  // Additive: a journal day's summary field and the option that writes it.
  expected.fields.journal.push('summary');
  expected.commands.find((item) => item.name === 'journal add').options.summary = { type: 'string',
    summary: 'Set the day summary, one line; an empty value removes it. May be given without --title.' };
  assert.deepEqual(response.json.data, expected);
  assert.deepEqual(response.json.data.errors, Object.entries(ERRORS).map(([code, exit]) => ({ code, exit })));
  const commands = response.json.data.commands;
  assert.ok(commands.filter((item) => item.mode === 'read' && !item.writeOption).every((item) => item.dangerous === false));
  assert.deepEqual(commands.filter((item) => item.dangerous !== false).map((item) => [item.name, item.dangerous]),
    [['mentions', { option: 'link' }], ['project rm', true], ['card claim', { option: 'steal' }], ['init', { option: 'set-default' }], ['link', true], ['agent install', true]]);
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

test('help lists registry commands before initialization and supports text and JSON aliases', async (t) => {
  const f = fixture(t, false);
  const before = tree(f.data);
  const visible = commands.filter((item) => !item.hidden);
  for (const args of [['help'], ['--help'], ['-h']]) {
    const response = await f.run(args);
    assert.equal(response.code, 0);
    assert.equal(response.stderr, '');
    for (const command of visible) assert.match(response.stdout, new RegExp(`^  ${command.name} +${command.summary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'mu'));
    assert.ok(!response.stdout.includes('wiki hook'));
    const json = await f.run([...args, '--json']);
    assert.equal(json.code, 0);
    assert.deepEqual(Object.keys(json.json), ['v', 'ok', 'data', 'warnings']);
    assert.equal(json.json.ok, true);
    assert.deepEqual(json.json.warnings, []);
    assert.deepEqual(json.json.data.commands.map(({ name }) => name), visible.map(({ name }) => name));
  }
  assert.deepEqual(tree(f.data), before);
  const executable = await spawnCli(['help'], f.opts);
  assert.equal(executable.code, 0);
  assert.match(executable.stdout, /Usage: cairn/u);
});

test('command help skips required arguments, actors, data and confirmation and follows registry options', async (t) => {
  const f = fixture(t, false);
  for (const command of commands) {
    const args = command.name.split(' ');
    const named = await f.run(['help', ...args, '--json']);
    assert.equal(named.code, 0, named.stdout);
    assert.equal(named.json.data.name, command.name);
    for (const [name, option] of Object.entries(command.options)) assert.deepEqual(named.json.data.options[name], option);
    for (const flag of ['--help', '-h']) {
      const response = await f.run([...args, flag, '--json']);
      assert.deepEqual(response.json, named.json);
      assert.equal(response.code, 0);
    }
  }
  const text = await f.run(['project', 'rm', '--help', '--assignee', 'me']);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /--actor/u);
  const options = await f.run(['help', 'card', 'add']);
  assert.match(options.stdout, /--title <value>/u);
  for (const args of [['card', 'update', 'c-000001', '--body', '-', '--help', '--json'], ['help', 'card', 'add', '--help', '--json']]) {
    const response = await f.run(args);
    assert.equal(response.code, 0, response.stdout);
    assert.equal(response.json.data.name, args[0] === 'help' ? 'card add' : 'card update');
  }
  for (const args of [['absent'], ['help', 'absent'], ['absent', '--help']]) {
    const response = await f.run([...args, '--json']);
    assert.equal(response.code, 2);
    assert.match(response.json.error.message, /Run `cairn help`$/u);
  }
  assert.deepEqual(tree(f.data), []);
});

test('project flags resolve ids, paths, exact titles and aliases across reads and writes', async (t) => {
  const f = fixture(t);
  f.put('projects/sample.md', '---\nid: p-000001\ntitle: Sample Project\naliases: [Short, SAMPLE PROJECT]\n---\n');
  f.put('projects/other.md', '---\nid: p-000002\ntitle: Other\n---\n');
  for (const [type, folder] of [['card', 'cards'], ['note', 'notes'], ['research', 'research']]) {
    f.put(`${folder}/selected.md`, `---\ntitle: Selected\nproject: p-000001\n---\n`);
    f.put(`${folder}/other.md`, `---\ntitle: Excluded\nproject: p-000002\n---\n`);
    for (const project of ['p-000001', '@projects/sample', 'sAmPlE pRoJeCt', 'SHORT']) {
      const response = await f.run([type, 'list', '--project', project, '--json']);
      assert.equal(response.code, 0, response.stdout);
      assert.deepEqual(response.json.data.items.map((item) => item.content.title), ['Selected']);
    }
  }
  for (const project of ['Sample Project', 'short']) {
    const response = await f.run(['context', '--project', project, '--json']);
    assert.equal(response.code, 0, response.stdout);
    assert.ok(!response.stdout.includes('Excluded'));
    const added = await f.run(['card', 'add', '--title', 'New', '--project', project, '--actor', 'owner', '--json']);
    assert.equal(added.code, 0, added.stdout);
    assert.equal(added.json.data.content.project, 'p-000001');
  }
  for (const project of ['Sample', 'missing', 'p-999999']) {
    const response = await f.run(['card', 'list', '--project', project, '--json']);
    assert.equal(response.code, 3);
    assert.match(response.json.error.message, /id or name/u);
  }
  f.put('projects/duplicate.md', '---\nid: p-000003\ntitle: SAMPLE PROJECT\naliases: [short]\n---\n');
  for (const project of ['sample project', 'SHORT']) {
    for (const args of [['card', 'list'], ['note', 'list'], ['research', 'list'], ['context'],
      ['card', 'add', '--title', 'New', '--actor', 'owner']]) {
      const response = await f.run([...args, '--project', project, '--json']);
      assert.equal(response.code, 5, response.stdout);
      assert.match(response.json.error.message, /Ambiguous project name/u);
      assert.match(response.json.error.message, /p-000001/u);
      assert.match(response.json.error.message, /p-000003/u);
    }
  }
  assert.equal((await f.run(['context', '--project', 'p-000001', '--json'])).code, 0);
});

test('project flags fold Turkish letters in titles and aliases', async (t) => {
  const f = fixture(t);
  f.put('projects/light.md', '---\nid: p-000001\ntitle: Işık\naliases: [Çığlık]\n---\n');
  f.put('cards/selected.md', '---\ntitle: Selected\nproject: p-000001\n---\n');
  for (const project of ['ışık', 'IŞIK', 'çığlık', 'ÇIĞLIK']) {
    const response = await f.run(['card', 'list', '--project', project, '--json']);
    assert.equal(response.code, 0, response.stdout);
    assert.deepEqual(response.json.data.items.map((item) => item.content.title), ['Selected']);
    const added = await f.run(['note', 'add', '--title', 'New', '--project', project, '--actor', 'owner', '--json']);
    assert.equal(added.code, 0, added.stdout);
    assert.equal(added.json.data.content.project, 'p-000001');
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
  assert.deepEqual(clean.json.data.meta, { kind: 'note', pinned: true, acceptance: { done: 0, total: 0 }, backlinks: [] });
  assert.deepEqual(clean.json.data.content.links, []);
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
  for (const args of [['journal', 'list'], ['journal', 'show', '2026-11-01'], ['trash', 'list'], ['status'], ['search', 'Acme'], ['mentions', '@notes/acme']]) {
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

// Include empty directories, contents and timestamps so dry-run cannot hide metadata or discovery writes.
function detectionTree(root, prefix = '') {
  const path = join(root, prefix), stat = fs.lstatSync(path);
  if (!stat.isDirectory()) return [[prefix, stat.mtimeMs, fs.readFileSync(path).toString('base64')]];
  return [[prefix, stat.mtimeMs, 'directory'], ...fs.readdirSync(path).sort()
    .flatMap((name) => detectionTree(root, prefix ? `${prefix}/${name}` : name))];
}

for (const name of ['daily', 'plain', 'tagged']) {
  test(`init --detect ${name} preview is read-only and new notes use the default folder`, async (t) => {
    const f = fixture(t, false);
    fs.cpSync(new URL(`./fixtures/vaults/${name}`, import.meta.url), f.data, { recursive: true });
    const before = detectionTree(f.data), home = detectionTree(f.home);
    const response = await f.run(['init', '--actor', 'acme', '--detect', f.data, '--dry-run', '--json']);
    assert.equal(response.code, 0, response.stdout);
    assert.equal(response.json.data.written, false);
    assert.equal(response.json.data.revision, null);
    assert.deepEqual(detectionTree(f.data), before);
    assert.deepEqual(detectionTree(f.home), home);
    const table = await f.run(['init', '--actor', 'acme', '--detect', f.data, '--dry-run']);
    assert.equal(table.code, 0, table.stderr);
    assert.match(table.stdout, /Target\tPath\tConfidence\tReason/u);
    assert.match(table.stdout, /^New notes: notes\//mu);
    assert.match(table.stdout, /^  note → notes, wiki \(flat: false\)/mu);
    assert.match(table.stdout, /Dry run; no files written/u);
    assert.deepEqual(response.json.data.schema.roots.note, { path: ['notes', 'wiki'], flat: false });
    assert.equal(response.json.data.schema.quickNotes, 'notes');
    assert.deepEqual(detectionTree(f.data), before);
    assert.deepEqual(detectionTree(f.home), home);
    const initialized = await f.run(['init', '--actor', 'acme', '--detect', f.data, '--yes', '--json']);
    assert.equal(initialized.code, 0, initialized.stdout);
    assert.deepEqual(initialized.json.data.config.schema.roots.note, { path: ['notes', 'wiki'], flat: false });
    const added = await f.run(['note', 'add', '--title', 'Fresh note', '--actor', 'acme', '--json']);
    assert.equal(added.code, 0, added.stdout);
    assert.equal(added.json.data.path, 'notes/fresh-note.md');
    assert.equal(fs.existsSync(join(f.data, 'notes/fresh-note.md')), true);
    assert.equal(fs.existsSync(join(f.data, 'Archive/fresh-note.md')), false);
  });
}

test('init detection requires confirmation and exposes existing pages through normal readers', async (t) => {
  const f = fixture(t, false);
  fs.cpSync(new URL('./fixtures/vaults/daily', import.meta.url), f.data, { recursive: true });
  const before = detectionTree(f.data), home = detectionTree(f.home);
  const refused = await f.run(['init', '--actor', 'acme', '--detect', f.data, '--json']);
  assert.equal(refused.code, 7, refused.stdout);
  assert.equal(refused.json.error.code, 'confirmation_required');
  assert.match(refused.json.error.message, /--yes/u);
  assert.equal(refused.json.error.current.schema.roots.journal.path, 'Daily');
  assert.deepEqual(detectionTree(f.data), before);
  const declined = await f.run(['init', '--actor', 'acme', '--detect', f.data, '--json'],
    { isTTY: true, stdin: 'no\n' });
  assert.equal(declined.code, 7);
  assert.deepEqual(detectionTree(f.data), before);
  const saved = await f.run(['init', '--actor', 'acme', '--detect', f.data, '--language', 'tr', '--yes', '--json']);
  assert.equal(saved.code, 0, saved.stdout);
  assert.equal(saved.json.data.config.language, 'tr');
  assert.equal(saved.json.data.written, true);
  assert.equal(saved.json.data.revision, revision(fs.readFileSync(join(f.data, '.cairn/config.json'))));
  const projects = await f.run(['project', 'list', '--json']);
  assert.equal(projects.code, 0, projects.stdout);
  assert.deepEqual(projects.json.data.items.map(({ path }) => path).sort(),
    ['Projects/Beacon.md', 'Projects/Drift.md', 'Projects/Kite.md']);
  const journal = await f.run(['journal', 'list', '--json']);
  assert.equal(journal.code, 0, journal.stdout);
  assert.deepEqual(journal.json.data.items.map(({ path }) => path).sort(),
    ['Daily/2026-11-05.md', 'Daily/2026-11-06.md', 'Daily/2026-11-07.md']);
  const context = await f.run(['context', '--json']);
  assert.equal(context.code, 0, context.stdout);
  assert.match(context.stdout, /Projects\/Beacon.md/u);
  assert.match(context.stdout, /Try a smaller lantern/u);
  const notes = await f.run(['note', 'list', '--json']);
  assert.equal(notes.code, 0, notes.stdout);
  assert.deepEqual(notes.json.data.items.map(({ path }) => path).sort(), ['Archive/Old.md', 'Start.md']);
  assert.deepEqual(detectionTree(f.data).filter(([path]) => path && !path.startsWith('.cairn')),
    before.filter(([path]) => path));
  assert.deepEqual(detectionTree(f.home), home);
});

test('detection shows config differences before confirmation and preserves unrelated settings', async (t) => {
  const f = fixture(t);
  f.put('Daily/2026-11-01.md', '# Day\n');
  f.put('Daily/2026-11-02.md', '# Day\n');
  const file = join(f.data, '.cairn/config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.leaseMinutes = 45;
  config.custom = { retained: true };
  fs.writeFileSync(file, JSON.stringify(config));
  const before = detectionTree(f.data);
  const preview = await f.run(['init', '--actor', 'acme', '--detect', f.data, '--dry-run', '--json']);
  assert.equal(preview.code, 0, preview.stdout);
  assert.deepEqual(preview.json.data.changes.map(({ field }) => field), ['schema']);
  assert.deepEqual(preview.json.data.changes[0].before, null);
  assert.equal(preview.json.data.changes[0].after.roots.journal.path, 'journal');
  assert.ok(preview.json.warnings.includes('existing_type:journal:Daily'));
  assert.deepEqual(detectionTree(f.data), before);
  for (const dry of [[], ['--dry-run']]) {
    const stale = await f.run(['init', '--actor', 'acme', '--detect', f.data,
      '--yes', '--if-revision', 'stale', ...dry, '--json']);
    assert.equal(stale.code, 4, stale.stdout);
    assert.equal(stale.json.error.current.revision, preview.json.data.revision);
    assert.deepEqual(detectionTree(f.data), before);
  }
  const saved = await f.run(['init', '--actor', 'acme', '--detect', f.data,
    '--if-revision', preview.json.data.revision],
    { isTTY: true, stdin: 'yes\n' });
  assert.equal(saved.code, 0, saved.stderr);
  assert.ok(saved.stderr.indexOf('Config changes:') < saved.stderr.indexOf('Type yes:'));
  const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(loaded.leaseMinutes, 45);
  assert.deepEqual(loaded.columns, config.columns);
  assert.deepEqual(loaded.custom, config.custom);
  assert.equal(loaded.schema.roots.journal.path, 'journal');
});

test('detection rejects a config changed while confirmation is pending', async (t) => {
  const f = fixture(t);
  const file = join(f.data, '.cairn/config.json');
  const changed = { ...JSON.parse(fs.readFileSync(file, 'utf8')), leaseMinutes: 75 };
  const stdin = new Readable({ read() {
    fs.writeFileSync(file, JSON.stringify(changed));
    this.push('yes\n');
    this.push(null);
  } });
  const response = await f.run(['init', '--actor', 'acme', '--detect', f.data, '--json'], { isTTY: true, stdin });
  assert.equal(response.code, 4, response.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), changed);
});

test('detection validates incompatible flags and preserves init actor requirements', async (t) => {
  const f = fixture(t, false), before = detectionTree(f.data);
  for (const args of [['--preset', 'default'], ['--preset', 'tr-wiki'], [f.cwd], ['--set-default']]) {
    const response = await f.run(['init', '--actor', 'acme', '--detect', f.data, ...args, '--dry-run', '--json']);
    assert.equal(response.json.error.code, 'validation', response.stdout);
  }
  assert.equal((await f.run(['init', '--actor', 'acme', '--yes', '--json'])).json.error.code, 'validation');
  assert.equal((await f.run(['init', '--dry-run', '--json'])).json.error.code, 'actor_required');
  const missingActor = await f.run(['init', '--detect', f.data, '--dry-run', '--json']);
  assert.equal(missingActor.json.error.code, 'actor_required');
  assert.equal((await f.run(['init', '--actor', 'BAD', '--json'])).json.error.code, 'usage');
  const help = await f.run(['help', 'init']);
  assert.match(help.stdout, /--detect <value>/u);
  assert.match(help.stdout, /--yes/u);
  assert.deepEqual(detectionTree(f.data), before);
});

test('human detection diff separates roots, ignores and fields while JSON keeps structured changes', async (t) => {
  const f = fixture(t, false);
  for (const name of ['A', 'B']) f.put(`Work/${name}.md`, '---\ntur: proje\netiketler: [a]\n---\n');
  f.put('Templates/Example.md', '# Template\n');
  const args = ['init', '--actor', 'acme', '--detect', f.data, '--dry-run'];
  const json = await f.run([...args, '--json']);
  const human = await f.run(args);
  assert.equal(json.code, 0, json.stdout);
  assert.equal(human.code, 0, human.stderr);
  assert.deepEqual(json.json.data.changes.map(({ field }) => field), ['schema', 'language']);
  assert.equal(json.json.data.changes[0].after.roots.project.path, 'Work');
  assert.equal(json.json.data.changes[0].after.fields.kind, 'tur');
  assert.match(human.stdout, /^  project → Work \(flat: true\); was \(none\)$/mu);
  assert.match(human.stdout, /^  schema.ignore \+ Templates\/\*\*$/mu);
  assert.match(human.stdout, /^  schema.fields.kind: \(none\) → tur$/mu);
  assert.match(human.stdout, /^  schema.fields.tags: \(none\) → etiketler$/mu);
  assert.ok(!human.stdout.includes('"schemaVersion"'));
});


for (const replacement of ['symlink', 'directory']) {
  test(`detection rejects a root replaced by a ${replacement} during confirmation without writes`, async (t) => {
    const f = fixture(t, false), holder = tempDir(t), target = tempDir(t);
    const moved = join(holder, 'moved');
    f.put('Projects/A.md', '# Project\n');
    const before = detectionTree(f.data), untouched = detectionTree(target), home = detectionTree(f.home);
    let replacementBefore;
    const stdin = new Readable({ read() {
      fs.renameSync(f.data, moved);
      if (replacement === 'symlink') fs.symlinkSync(target, f.data, 'dir');
      else fs.mkdirSync(f.data);
      replacementBefore = detectionTree(replacement === 'symlink' ? target : f.data);
      this.push('yes\n');
      this.push(null);
    } });
    const result = await f.run(['init', '--detect', f.data, '--actor', 'acme', '--json'], { isTTY: true, stdin });
    assert.equal(result.code, 4, result.stdout);
    assert.equal(result.json.error.code, 'conflict');
    assert.match(result.json.error.message, /directory changed/u);
    assert.deepEqual(detectionTree(moved), before);
    assert.deepEqual(detectionTree(replacement === 'symlink' ? target : f.data), replacementBefore);
    assert.deepEqual(detectionTree(target), untouched);
    assert.deepEqual(detectionTree(f.home), home);
  });
}

test('detection retains the effective default schema and a single journal day across later writes', async (t) => {
  const f = fixture(t);
  const first = await f.run(['journal', 'add', '--title', 'Before detection', '--date', '2026-11-01',
    '--item', 'Keep this entry', '--actor', 'acme', '--json']);
  assert.equal(first.code, 0, first.stdout);
  const bytes = fs.readFileSync(join(f.data, 'journal/2026-11-01.md'));
  const saved = await f.run(['init', '--detect', f.data, '--yes', '--actor', 'acme', '--json']);
  assert.equal(saved.code, 0, saved.stdout);
  assert.equal(saved.json.data.schema.roots.journal.path, 'journal');
  assert.deepEqual(fs.readFileSync(join(f.data, 'journal/2026-11-01.md')), bytes);
  const days = await f.run(['journal', 'list', '--json']);
  assert.equal(days.code, 0, days.stdout);
  assert.deepEqual(days.json.data.items.map(({ path }) => path), ['journal/2026-11-01.md']);
  const second = await f.run(['journal', 'add', '--title', 'After detection', '--date', '2026-11-02',
    '--item', 'New entry', '--actor', 'acme', '--json']);
  assert.equal(second.code, 0, second.stdout);
  assert.equal(second.json.data.path, 'journal/2026-11-02.md');
});

for (const [field, value] of [['tur', 'Proje'], ['kind', 'Project']]) {
  test(`detection writes exact aliases for ${field}: ${value} and lists both projects`, async (t) => {
    const f = fixture(t, false);
    for (const name of ['A', 'B']) f.put(`Work/${name}.md`, `---\n${field}: ${value}\n---\n# ${name}\n`);
    const before = detectionTree(f.data);
    const saved = await f.run(['init', '--detect', f.data, '--yes', '--actor', 'acme', '--json']);
    assert.equal(saved.code, 0, saved.stdout);
    assert.equal(saved.json.data.schema.values.kind[value], 'project');
    const projects = await f.run(['project', 'list', '--json']);
    assert.equal(projects.code, 0, projects.stdout);
    assert.deepEqual(projects.json.data.items.map(({ path }) => path).sort(), ['Work/A.md', 'Work/B.md']);
    assert.deepEqual(detectionTree(f.data).filter(([path]) => path && !path.startsWith('.cairn')),
      before.filter(([path]) => path));
  });
}


test('detection previews preserved schema separately from non-overlapping additions', async (t) => {
  const f = fixture(t);
  const file = join(f.data, '.cairn/config.json'), config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.schema = { ...structuredClone(PRESETS.default),
    roots: { note: { path: 'Archive', flat: false }, journal: { path: 'Log', flat: true } } };
  fs.writeFileSync(file, JSON.stringify(config));
  f.put('Projects/A.md', '# Project\n');
  f.put('Archive/Projects/B.md', '# Nested project\n');
  f.put('Templates/Example.md', '# Template\n');
  const result = await f.run(['init', '--detect', f.data, '--dry-run', '--actor', 'acme']);
  assert.equal(result.code, 0, result.stderr);
  const preserved = result.stdout.indexOf('Preserved schema:');
  const added = result.stdout.indexOf('Added schema entries:');
  assert.ok(preserved >= 0 && added > preserved);
  assert.match(result.stdout.slice(preserved, added), /^  journal → Log \(flat: true\)$/mu);
  assert.match(result.stdout.slice(preserved, added), /^  note → Archive \(flat: false\)$/mu);
  assert.match(result.stdout.slice(added), /^  project → Projects \(flat: true\)/mu);
  assert.match(result.stdout.slice(added), /^  schema.ignore \+ Templates\/\*\*$/mu);
  assert.match(result.stderr, /root_conflict:project:Archive\/Projects/u);
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(config));
});

test('detection does not ignore an existing Templates content root', async (t) => {
  const f = fixture(t);
  const file = join(f.data, '.cairn/config.json'), config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.schema = structuredClone(PRESETS.default);
  config.schema.roots.note = { path: 'Templates', flat: false };
  fs.writeFileSync(file, JSON.stringify(config));
  f.put('Templates/Kept.md', '# Kept note\n');
  const result = await f.run(['init', '--detect', f.data, '--yes', '--actor', 'acme', '--json']);
  assert.equal(result.code, 0, result.stdout);
  assert.ok(!result.json.data.schema.ignore.includes('Templates/**'));
  assert.ok(result.json.warnings.includes('ignore_conflict:Templates/**'));
  assert.ok(!result.json.data.suggestions.some(({ target, path }) => target === 'ignore' && path === 'Templates'));
  const notes = await f.run(['note', 'list', '--json']);
  assert.equal(notes.code, 0, notes.stdout);
  assert.deepEqual(notes.json.data.items.map(({ path }) => path), ['Templates/Kept.md']);
  assert.equal(fs.readFileSync(join(f.data, 'Templates/Kept.md'), 'utf8'), '# Kept note\n');
});

test('detection retains a Clippings quick-note destination and leaves it writable', async (t) => {
  const f = fixture(t);
  const file = join(f.data, '.cairn/config.json'), config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.schema = { ...structuredClone(PRESETS.default), quickNotes: 'Clippings' };
  fs.writeFileSync(file, JSON.stringify(config));
  f.put('Clippings/Existing.md', '# Existing note\n');
  for (const flags of [['--dry-run'], ['--yes']]) {
    const result = await f.run(['init', '--detect', f.data, '--actor', 'acme', '--json', ...flags]);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.json.data.schema.quickNotes, 'Clippings');
    assert.ok(!result.json.data.schema.sourceRoots.includes('Clippings'));
    assert.ok(result.json.warnings.includes('root_conflict:sourceRoots:Clippings'));
  }
  const added = await f.run(['note', 'add', '--title', 'Fresh note', '--actor', 'acme', '--json']);
  assert.equal(added.code, 0, added.stdout);
  assert.equal(added.json.data.path, 'Clippings/fresh-note.md');
});

test('detection maps Project in a configured category field and lists both projects', async (t) => {
  const f = fixture(t);
  const file = join(f.data, '.cairn/config.json'), config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.schema = { ...structuredClone(PRESETS.default), fields: { kind: 'category' } };
  fs.writeFileSync(file, JSON.stringify(config));
  for (const name of ['A', 'B']) f.put(`Work/${name}.md`, `---\ncategory: Project\n---\n# ${name}\n`);
  const result = await f.run(['init', '--detect', f.data, '--yes', '--actor', 'acme', '--json']);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.json.data.schema.fields.kind, 'category');
  assert.equal(result.json.data.schema.values.kind.Project, 'project');
  assert.equal(result.json.data.schema.roots.project.path, 'projects');
  const projects = await f.run(['project', 'list', '--json']);
  assert.equal(projects.code, 0, projects.stdout);
  assert.deepEqual(projects.json.data.items.map(({ path }) => path).sort(), ['Work/A.md', 'Work/B.md']);
});
