import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as fs from '../core/fsx.mjs';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { readEvents } from '../core/events.mjs';
import { revision } from '../core/store.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { runCli } from './support/cli.mjs';

function fixture(t) {
  const home = tempDir(t), data = tempDir(t), clock = fixedClock('2026-11-15T12:00:00Z');
  initDataDir(data, { home, env: {}, clock });
  const file = join(data, '.cairn/config.json');
  const open = () => openContext({ mode: 'write', dataDir: data, home, env: {}, clock, actor: 'cli:owner' });
  const run = (args, extra) => runCli(args, { home, data, clock, ...extra });
  const owner = (args, word) => run([...args, '--json'], { isTTY: true, stdin: `${word}\n` });
  const stored = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { data, file, open, run, owner, stored };
}

function tree(root, prefix = '') {
  return fs.readdirSync(join(root, prefix)).sort().flatMap((name) => {
    const path = prefix ? `${prefix}/${name}` : name;
    const stat = fs.statSync(join(root, path));
    return stat.isDirectory() ? tree(root, path) : [[path, fs.readFileSync(join(root, path), 'utf8')]];
  });
}

const DEFAULT_COLUMNS = [
  { key: 'backlog', label: 'Backlog', role: 'todo', hidden: false },
  { key: 'doing', label: 'Doing', role: 'doing', hidden: false },
  { key: 'review', label: 'Review', role: 'doing', hidden: false },
  { key: 'done', label: 'Done', role: 'done', hidden: false },
];

test('config get reports the claim lease and the board columns as text and JSON', async (t) => {
  const f = fixture(t);
  const all = await f.run(['config', '--json']);
  assert.equal(all.code, 0, all.stdout);
  assert.equal(all.json.data.leaseMinutes, 120);
  assert.deepEqual(all.json.data.columns, DEFAULT_COLUMNS);
  const summary = await f.run(['config']);
  assert.doesNotMatch(summary.stdout, /lease|backlog/u, 'the summary text stays as it was');

  assert.equal((await f.run(['config', 'get', 'lease-minutes'])).stdout, '120\n');
  const lease = await f.run(['config', 'get', 'lease-minutes', '--json']);
  assert.deepEqual(lease.json.data, { name: 'lease-minutes', value: 120, revision: all.json.data.revision });

  assert.equal((await f.run(['config', 'get', 'columns'])).stdout,
    'backlog\tBacklog\ttodo\ndoing\tDoing\tdoing\nreview\tReview\tdoing\ndone\tDone\tdone\n');
  const columns = await f.run(['config', 'get', 'columns', '--json']);
  assert.deepEqual(columns.json.data, { name: 'columns', value: DEFAULT_COLUMNS, revision: all.json.data.revision });

  // A hand-written label with a line break and a hidden column print on one line with the hidden marker.
  const config = f.stored();
  config.columns[2] = { ...config.columns[2], label: 'Re\nview​', hidden: true };
  fs.writeFileSync(f.file, JSON.stringify(config, null, 2) + '\n');
  const lines = (await f.run(['config', 'get', 'columns'])).stdout.split('\n');
  assert.equal(lines[2], 'review\tRe view\tdoing\thidden');

  for (const name of ['column.doing.label', 'columns-order', 'leaseMinutes']) {
    const bad = await f.run(['config', 'get', name, '--json']);
    assert.equal(bad.code, 5, name);
    assert.equal(bad.json.error.code, 'validation');
  }
});

test('config set writes the four board settings with typed confirmation and cli:owner', async (t) => {
  const f = fixture(t);
  const cases = [
    [['lease-minutes', '45'], { value: 45, fields: ['leaseMinutes'] }, 'lease-minutes: 45',
      (config) => assert.equal(config.leaseMinutes, 45)],
    [['column.doing.label', '  In progress  '], { value: 'In progress', fields: ['columns.label'] },
      'column.doing.label: In progress', (config) => assert.equal(config.columns[1].label, 'In progress')],
    [['column.review.hidden', 'on'], { value: true, fields: ['columns.hidden'] }, 'column.review.hidden: on',
      (config) => assert.equal(config.columns[2].hidden, true)],
    [['columns-order', 'doing,backlog,review,done'], { value: ['doing', 'backlog', 'review', 'done'],
      fields: ['columns.order'] }, 'columns-order: doing,backlog,review,done',
    (config) => assert.deepEqual(config.columns.map(({ key }) => key), ['doing', 'backlog', 'review', 'done'])],
  ];
  for (const [[name, value], expected, text, check] of cases) {
    const set = await f.owner(['config', 'set', name, value], name);
    assert.equal(set.code, 0, set.stdout + set.stderr);
    assert.match(set.stderr, new RegExp(`Type ${name.replaceAll('.', '\\.')}:`, 'u'));
    assert.deepEqual(Object.keys(set.json.data), ['name', 'value', 'changed', 'revision', 'fields']);
    assert.deepEqual(set.json.data, { name, ...expected, changed: true, revision: revision(fs.readFileSync(f.file)),
      fields: expected.fields });
    check(f.stored());
    const event = readEvents(f.open()).at(-1);
    assert.deepEqual([event.op, event.actor, event.fields, event.rev], ['config.change', 'cli:owner',
      expected.fields, set.json.data.revision]);

    const same = await f.run(['config', 'set', name, value], { isTTY: true, stdin: `${name}\n` });
    assert.equal(same.code, 0, same.stderr);
    assert.equal(same.stdout, `${text} (unchanged)\n`);
    const again = await f.owner(['config', 'set', name, value], name);
    assert.equal(again.json.data.changed, false);
    assert.deepEqual(again.json.data.fields, []);
  }
  assert.equal(readEvents(f.open()).length, 4, 'an unchanged write records nothing');

  const shown = await f.owner(['config', 'set', 'column.review.hidden', 'off'], 'column.review.hidden');
  assert.equal(shown.json.data.value, false);
  const review = f.stored().columns.find(({ key }) => key === 'review');
  assert.equal(Object.hasOwn(review, 'hidden'), false, 'off removes the flag');
  const text = await f.run(['config', 'set', 'lease-minutes', '60', '--actor', 'alice'],
    { isTTY: true, stdin: 'lease-minutes\n' });
  assert.equal(text.stdout, 'lease-minutes: 60\n');
  assert.equal(readEvents(f.open()).at(-1).actor, 'cli:alice');
  const log = JSON.stringify(readEvents(f.open()));
  assert.equal(log.includes('In progress'), false, 'events carry field names only');
});

test('board settings keep the owner gate and leave the disk alone without the typed name', async (t) => {
  const f = fixture(t);
  const before = tree(f.data);
  for (const [name, value] of [['lease-minutes', '30'], ['column.doing.label', 'Busy'],
    ['column.review.hidden', 'on'], ['columns-order', 'doing,backlog,review,done']]) {
    const args = ['config', 'set', name, value];
    const nonTty = await f.run([...args, '--json']);
    assert.equal(nonTty.code, 2, nonTty.stdout);
    assert.equal(nonTty.json.error.code, 'owner_only');
    const stdinNotTty = await f.run([...args, '--json'],
      { isTTY: true, stdin: Object.assign(Readable.from([`${name}\n`]), { isTTY: false }) });
    assert.equal(stdinNotTty.json.error.code, 'owner_only');
    const agent = await f.run([...args, '--json'], { isTTY: true, stdin: `${name}\n`, env: { CLAUDECODE: '1' } });
    assert.equal(agent.code, 2);
    assert.equal(agent.json.error.code, 'owner_only');
    for (const input of ['yes\n', `${value}\n`, 'columns\n', '']) {
      const mismatch = await f.run([...args, '--json'], { isTTY: true, stdin: input });
      assert.equal(mismatch.code, 2, mismatch.stdout);
      assert.equal(mismatch.json.error.code, 'usage');
    }
  }
  assert.deepEqual(tree(f.data), before);
});

test('board dry-run previews without the gate and --if-revision refuses a stale revision', async (t) => {
  const f = fixture(t);
  const before = tree(f.data);
  const rev = revision(fs.readFileSync(f.file));
  const dry = await f.run(['config', 'set', 'column.done.label', 'Shipped', '--dry-run', '--json']);
  assert.equal(dry.code, 0, dry.stdout);
  assert.deepEqual(dry.json.data, { name: 'column.done.label', value: 'Shipped', changed: true, revision: rev,
    fields: ['columns.label'] });
  const dryText = await f.run(['config', 'set', 'columns-order', 'doing,backlog,review,done', '--dry-run']);
  assert.equal(dryText.stdout, 'columns-order: doing,backlog,review,done (dry-run)\n');
  const same = await f.run(['config', 'set', 'lease-minutes', '120', '--dry-run', '--json']);
  assert.deepEqual([same.json.data.changed, same.json.data.fields], [false, []]);
  const refused = await f.run(['config', 'set', 'column.doing.hidden', 'on', '--dry-run', '--json']);
  assert.equal(refused.code, 5, refused.stdout);
  assert.equal(refused.json.error.message, 'Invalid setting: columns.hidden');
  const staleDry = await f.run(['config', 'set', 'lease-minutes', '30', '--dry-run', '--if-revision',
    '0000000000000000', '--json']);
  assert.equal(staleDry.code, 4);
  assert.equal(staleDry.json.error.code, 'conflict');
  assert.deepEqual(tree(f.data), before, 'dry-run writes nothing');

  const stale = await f.run(['config', 'set', 'lease-minutes', '30', '--if-revision', '0000000000000000', '--json'],
    { isTTY: true, stdin: 'lease-minutes\n' });
  assert.equal(stale.code, 4);
  assert.equal(stale.json.error.code, 'conflict');
  const current = await f.owner(['config', 'set', 'lease-minutes', '30', '--if-revision', rev], 'lease-minutes');
  assert.equal(current.code, 0, current.stdout);
  assert.equal(f.stored().leaseMinutes, 30);
});

test('board settings reject malformed names, unknown columns and invalid values', async (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file, 'utf8');
  const cases = [
    [['column.Doing.label', 'X'], 'Unknown setting.'],
    [['column..label', 'X'], 'Unknown setting.'],
    [['column.doing.role', 'todo'], 'Unknown setting.'],
    [['columns', 'backlog'], 'Unknown setting.'],
    [['leaseMinutes', '30'], 'Unknown setting.'],
    [['column.missing.label', 'X'], 'Invalid setting: columns.label'],
    [['column.missing.hidden', 'on'], 'Invalid setting: columns.hidden'],
    [['column.doing.hidden', 'yes'], 'Invalid column value. Use on or off.'],
    [['column.doing.hidden', 'on'], 'Invalid setting: columns.hidden'],
    [['column.doing.label', ''], 'Invalid setting: columns.label'],
    [['column.doing.label', 'Two\tparts'], 'Invalid setting: columns.label'],
    [['column.doing.label', 'x'.repeat(41)], 'Invalid setting: columns.label'],
    [['column.doing.label', 'DONE'], 'Invalid setting: columns.label'],
    [['columns-order', 'backlog,doing,review'], 'Invalid setting: columns.order'],
    [['columns-order', 'backlog,doing,doing,done'], 'Invalid setting: columns.order'],
    [['columns-order', 'backlog,doing,review,done,extra'], 'Invalid setting: columns.order'],
    ...['4', '1441', '1.5', 'abc', '', '0x10', '1e2'].map((value) => [['lease-minutes', value],
      'Invalid setting: leaseMinutes']),
  ];
  for (const [[name, value], message] of cases) {
    const bad = await f.run(['config', 'set', name, value, '--json'], { isTTY: true, stdin: `${name}\n` });
    assert.equal(bad.code, 5, `${name} ${value}: ${bad.stdout}`);
    assert.equal(bad.json.error.code, 'validation');
    assert.ok(bad.json.error.message.startsWith(message), `${name} ${value}: ${bad.json.error.message}`);
  }
  // A malformed name or lease fails before the owner gate asks anything.
  const early = await f.run(['config', 'set', 'lease-minutes', '4', '--json']);
  assert.equal(early.code, 5, early.stdout);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.deepEqual(readEvents(f.open()), []);
});
