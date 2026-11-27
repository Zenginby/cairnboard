import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openSync } from 'node:fs';
import * as fs from '../core/fsx.mjs';
import { loadConfig } from '../core/config.mjs';
import { openContext } from '../core/context.mjs';
import { initDataDir } from '../core/roots.mjs';
import { readEvents } from '../core/events.mjs';
import { revision } from '../core/store.mjs';
import { withLock } from '../core/lock.mjs';
import * as entity from '../core/entity.mjs';
import { addCard, claimCard } from '../core/card.mjs';
import { CONFIG_LIMITS, checkConfigDrift, previewConfig, readSettings, setConfig,
  setFeature } from '../core/settings.mjs';
import { fixedClock, tempDir } from './support/env.mjs';

const FIELD_NAMES = ['columns.hidden', 'columns.label', 'columns.order', 'home.hiddenProjects', 'language',
  'leaseMinutes'];
const KEYS = ['backlog', 'doing', 'review', 'done'];

function fixture(t) {
  const root = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-08T12:00:00Z');
  initDataDir(root, { home, env: {}, clock });
  const open = () => openContext({ mode: 'write', dataDir: root, home, env: {}, clock, actor: 'cli:owner' });
  const ctx = open();
  const file = join(root, '.cairn/config.json'), stateFile = join(root, '.cairn/settings-state.json');
  const bytes = () => fs.readFileSync(file);
  const rev = () => revision(bytes());
  // A hand edit: compact JSON, so the bytes always differ from what the writer stores.
  const edit = (patch) => fs.writeFileSync(file, JSON.stringify({ ...loadConfig(root), ...patch }));
  const editColumns = (fn) => edit({ columns: fn(loadConfig(root).columns.map((column) => ({ ...column }))) });
  const set = (changes, extra = {}) => setConfig(ctx, { changes, expectedRevision: rev(), ...extra });
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const events = () => readEvents(ctx);
  const refused = (changes, field, reason) => {
    const before = bytes(), count = events().length;
    assert.throws(() => set(changes), (error) => {
      assert.equal(error.code, 'validation');
      assert.equal(error.message, `Invalid setting: ${field}`);
      assert.deepEqual(error.details, reason ? { field, reason } : { field });
      return true;
    }, JSON.stringify(changes));
    assert.deepEqual(bytes(), before);
    assert.equal(events().length, count);
  };
  return { ctx, root, open, file, stateFile, bytes, rev, edit, editColumns, set, state, events, refused };
}

function tree(root, prefix = '') {
  return fs.readdirSync(join(root, prefix)).sort().flatMap((name) => {
    if (!prefix && name === '.cairn') return [];
    const path = prefix ? `${prefix}/${name}` : name;
    return fs.statSync(join(root, path)).isDirectory() ? tree(root, path)
      : [[path, fs.readFileSync(join(root, path)).toString('base64')]];
  });
}

const deepFreeze = (value) => {
  if (value && typeof value === 'object') Object.values(Object.freeze(value)).forEach(deepFreeze);
  return value;
};

test('the limits are frozen and exported', () => {
  assert.deepEqual(CONFIG_LIMITS, { labelMax: 40, leaseMin: 5, leaseMax: 1440 });
  assert.ok(Object.isFrozen(CONFIG_LIMITS));
});

test('every field writes the file, the context and the revision and keeps everything else', (t) => {
  const f = fixture(t);
  fs.mkdirSync(join(f.root, 'projects'), { recursive: true });
  fs.writeFileSync(join(f.root, 'projects/one.md'), '---\nid: p-000001\ntitle: One\n---\n');
  f.edit({ lint: { orphan: 'off' }, rules: { filename: 'warn' }, home: { featuredProject: 'p-000009' } });
  f.editColumns((columns) => columns.map((column) => column.key === 'review'
    ? { key: 'review', tint: 'amber', label: 'Review', role: 'doing', note: { a: [1] } } : column));
  const base = loadConfig(f.root);
  const cases = [
    [{ language: 'tr' }, ['language'], (config) => ({ ...config, language: 'tr' })],
    [{ leaseMinutes: 45 }, ['leaseMinutes'], (config) => ({ ...config, leaseMinutes: 45 })],
    [{ columns: { labels: { review: 'Checking' } } }, ['columns.label'], (config) => ({ ...config,
      columns: config.columns.map((column) => column.key === 'review' ? { ...column, label: 'Checking' } : column) })],
    [{ columns: { order: ['backlog', 'review', 'doing', 'done'] } }, ['columns.order'], (config) => ({ ...config,
      columns: ['backlog', 'review', 'doing', 'done'].map((key) => config.columns.find((c) => c.key === key)) })],
    [{ columns: { move: { key: 'done', by: -1 } } }, ['columns.order'], (config) => ({ ...config,
      columns: ['backlog', 'review', 'done', 'doing'].map((key) => config.columns.find((c) => c.key === key)) })],
    [{ columns: { hidden: { doing: true } } }, ['columns.hidden'], (config) => ({ ...config,
      columns: config.columns.map((column) => column.key === 'doing' ? { ...column, hidden: true } : column) })],
    [{ homeProjects: { listed: ['p-000001'], shown: [] } }, ['home.hiddenProjects'], (config) => ({ ...config,
      home: { featuredProject: 'p-000009', hiddenProjects: ['p-000001'] } })],
  ];
  let expected = base;
  for (const [changes, fields, next] of cases) {
    const before = f.rev();
    const result = f.set(changes);
    expected = next(expected);
    assert.deepEqual(result, { changed: true, revision: f.rev(), fields }, JSON.stringify(changes));
    assert.notEqual(result.revision, before);
    assert.deepEqual(loadConfig(f.root), expected);
    assert.deepEqual(f.ctx.config, expected);
    assert.equal(f.bytes().toString('utf8'), JSON.stringify(expected, null, 2) + '\n');
  }
  // Unknown column properties and their order survive every kind of column write.
  const review = loadConfig(f.root).columns.find((column) => column.key === 'review');
  assert.deepEqual(Object.keys(review), ['key', 'tint', 'label', 'role', 'note']);
  assert.deepEqual(review.note, { a: [1] });
  assert.deepEqual(loadConfig(f.root).lint, { orphan: 'off' });
  // Several fields in one write give one event and the sorted names.
  const many = f.set({ leaseMinutes: 60, language: 'en', columns: { labels: { done: 'Shipped' },
    hidden: { doing: false } } });
  assert.deepEqual(many.fields, ['columns.hidden', 'columns.label', 'language', 'leaseMinutes']);
  assert.equal(Object.hasOwn(loadConfig(f.root).columns.find((column) => column.key === 'doing'), 'hidden'), false);
  assert.equal(f.events().length, cases.length + 1);
  assert.equal(f.events().some(({ op }) => op === 'config.external'), false);
  assert.equal(checkConfigDrift(f.open()), false);
  assert.equal(f.state().pending, undefined);
  assert.equal(f.state().rev, f.rev());
});

test('writing the stored values changes nothing: same bytes, no event, no state write', (t) => {
  const f = fixture(t);
  f.edit({ home: { hiddenProjects: [] } });
  readSettings(f.ctx);
  const bytes = f.bytes(), state = fs.readFileSync(f.stateFile), count = f.events().length;
  for (const changes of [{ language: 'en' }, { leaseMinutes: 120 }, { columns: { labels: { doing: '  Doing ' } } },
    { columns: { hidden: { doing: false } } }, { columns: { order: KEYS } }, { columns: { labels: {} } },
    { homeProjects: { listed: [], shown: [] } },
    { language: 'en', leaseMinutes: 120, columns: { labels: { done: 'Done' }, hidden: { done: false } } }]) {
    assert.deepEqual(f.set(changes), { changed: false, revision: revision(bytes), fields: [] },
      JSON.stringify(changes));
    assert.deepEqual(f.bytes(), bytes, 'the hand-formatted file is not rewritten');
  }
  assert.equal(f.events().length, count);
  assert.deepEqual(fs.readFileSync(f.stateFile), state);
});

test('a stale revision conflicts; an edit before the rename conflicts, stays on disk and clears the intent', (t) => {
  const f = fixture(t);
  const stored = f.bytes();
  assert.throws(() => setConfig(f.ctx, { changes: { leaseMinutes: 30 }, expectedRevision: '0123456789abcdef' }),
    { code: 'conflict' });
  assert.throws(() => setConfig(f.ctx, { changes: { leaseMinutes: 30 }, expectedRevision: undefined }),
    { code: 'conflict' });
  assert.deepEqual(f.bytes(), stored);
  assert.deepEqual(f.events(), []);

  const expectedRevision = readSettings(f.ctx).revision;
  let seen = null;
  t.after(() => fs.__setFsHooks());
  // The intent record is already durable when the configuration's temporary file is created; the hook edits the
  // file by hand at that point, before the comparison that precedes the rename.
  fs.__setFsHooks({ openSync(path, ...args) {
    if (String(path).includes('.tmp-') && f.state().pending) {
      seen = f.state().pending;
      fs.__setFsHooks();
      f.edit({ language: 'tr' });
    }
    return openSync(path, ...args);
  } });
  assert.throws(() => setConfig(f.ctx, { changes: { leaseMinutes: 30 }, expectedRevision }), { code: 'conflict' });
  assert.deepEqual(seen.fields, ['leaseMinutes']);
  assert.match(seen.tx, /^s-/u);
  assert.equal(loadConfig(f.root).language, 'tr', 'the outside edit is what stays');
  assert.equal(loadConfig(f.root).leaseMinutes, 120);
  assert.equal(f.state().pending, undefined);
  assert.deepEqual(f.events(), []);
  // The outside edit is then audited as a hand edit, not as our write.
  assert.equal(checkConfigDrift(f.open()), true);
  assert.deepEqual(f.events().map(({ op, fields }) => [op, fields]), [['config.external', ['language']]]);
});

test('a held config lock is reported and nothing is written', (t) => {
  const f = fixture(t);
  const expectedRevision = readSettings(f.ctx).revision, stored = f.bytes();
  withLock({ ...f.ctx, instance: 'other' }, '_config', () => {
    assert.throws(() => setConfig(f.ctx, { changes: { leaseMinutes: 30 }, expectedRevision }),
      { code: 'locked', exit: 6 });
  });
  assert.deepEqual(f.bytes(), stored);
  assert.deepEqual(f.events(), []);
  assert.equal(setConfig(f.ctx, { changes: { leaseMinutes: 30 }, expectedRevision }).changed, true);
});

test('the shape of changes is checked before the lock', (t) => {
  const f = fixture(t);
  class Changes { language = 'tr'; }
  for (const changes of [undefined, null, 'language', 7, [], [{ language: 'tr' }], {}, { foo: 1 },
    { language: 'tr', foo: 1 }, JSON.parse('{"__proto__":{"language":"tr"}}'), { __proto__: { language: 'tr' } },
    { constructor: 1 }, { toString: 1 }, new Changes(), new Map([['language', 'tr']]), { [Symbol('x')]: 1 }]) {
    f.refused(changes, 'changes');
  }
  for (const columns of [null, 'x', [], {}, { key: 'doing' }, { labels: { doing: 'A' }, role: 'done' },
    { order: KEYS, move: { key: 'doing', by: 1 } }, { labels: [] }, { labels: { doing: 7 } }, { labels: null },
    { hidden: { doing: 'on' } }, { hidden: { doing: 1 } }, { order: 'backlog,doing' }, { order: [1, 2, 3, 4] },
    { move: { key: 'doing', by: 2 } }, { move: { key: 'doing', by: 0 } }, { move: { key: 7, by: 1 } },
    { move: { key: 'doing' } }, { move: { key: 'doing', by: 1, to: 2 } }, { move: ['doing', 1] }]) {
    f.refused({ columns }, 'columns');
  }
  for (const language of ['de', 'TR', '', null, ['tr']]) {
    assert.throws(() => f.set({ language }), { code: 'validation', message: 'Invalid language. Use tr or en.' });
  }
  for (const homeProjects of [null, [], { listed: ['p-000001'] }, { listed: ['bad id'], shown: [] },
    { listed: ['p-000001'], shown: ['p-000002'] }, { listed: [], shown: [], extra: 1 }]) {
    assert.throws(() => f.set({ homeProjects }), { code: 'validation', message: 'Invalid project list.' });
  }
  // The lock is never taken for a malformed request.
  withLock({ ...f.ctx, instance: 'other' }, '_config', () => {
    assert.throws(() => setConfig(f.ctx, { changes: { foo: 1 }, expectedRevision: 'x' }), { code: 'validation' });
    assert.throws(() => setConfig(f.ctx, { changes: { leaseMinutes: 1 }, expectedRevision: 'x' }),
      { code: 'validation' });
  });
  assert.deepEqual(f.events(), []);
});

test('label rules: each breach has its reason code and no user text in the error', (t) => {
  const f = fixture(t);
  const label = (value, key = 'review') => ({ columns: { labels: { [key]: value } } });
  for (const [value, reason] of [['', 'label_empty'], ['   ', 'label_empty'], [' 　', 'label_empty'],
    ['\t', 'label_empty'], ['x'.repeat(41), 'label_long'], ['\u{1F600}'.repeat(41), 'label_long'],
    ['a\tb', 'label_chars'], ['a\nb', 'label_chars'], ['a\r\nb', 'label_chars'], ['a b', 'label_chars'],
    ['a‮b', 'label_chars'], ['a​b', 'label_chars'], ['a\u0000b', 'label_chars'], ['Name\n', 'label_chars'],
    ['﻿Name', 'label_chars'], ['a​b' + 'x'.repeat(60), 'label_chars'],
    ['Doing', 'label_duplicate'], ['DOING', 'label_duplicate'], ['doing', 'label_duplicate'],
    ['DOİNG', 'label_duplicate'], ['doıng', 'label_duplicate'], ['  Done ', 'label_duplicate']]) {
    f.refused(label(value), 'columns.label', reason);
  }
  f.refused(label('Anything', 'missing'), 'columns.label', 'column_unknown');
  f.refused(label('Anything', '__proto__'), 'columns.label', 'column_unknown');
  // Two labels that collide only after the same write are refused too; a swap is not a collision.
  f.refused({ columns: { labels: { doing: 'Next', review: 'NEXT' } } }, 'columns.label', 'label_duplicate');
  assert.equal(f.set({ columns: { labels: { doing: 'Review', review: 'Doing' } } }).changed, true);
  assert.deepEqual(loadConfig(f.root).columns.map((column) => column.label), ['Backlog', 'Review', 'Doing', 'Done']);

  // Surrounding spaces are trimmed, the text is stored in NFC, and 40 code points fit even outside the BMP.
  f.set(label('  In review  '));
  assert.equal(loadConfig(f.root).columns[2].label, 'In review');
  f.set(label('Café'));
  assert.equal(loadConfig(f.root).columns[2].label, 'Café');
  f.set(label('\u{1F600}'.repeat(40)));
  assert.equal([...loadConfig(f.root).columns[2].label].length, 40);
  f.set(label('# Ready | <b>'));
  assert.equal(loadConfig(f.root).columns[2].label, '# Ready | <b>');
});

test('older labels that break the rules do not block other writes', (t) => {
  const f = fixture(t);
  const long = 'L'.repeat(60);
  f.editColumns((columns) => columns.map((column) => ({ ...column,
    label: { backlog: long, doing: 'Same', review: 'same', done: 'Tab\there' }[column.key] })));
  f.edit({ leaseMinutes: 3000 });
  assert.equal(f.set({ columns: { labels: { done: 'Finished' } } }).changed, true);
  assert.equal(f.set({ columns: { order: ['doing', 'backlog', 'review', 'done'] } }).changed, true);
  assert.equal(f.set({ columns: { hidden: { review: true } } }).changed, true);
  assert.equal(f.set({ leaseMinutes: 90 }).changed, true);
  assert.equal(f.set({ language: 'tr' }).changed, true);
  // Sending an old label back unchanged is no change; changing one still meets the rules.
  assert.deepEqual(f.set({ columns: { labels: { backlog: long, doing: 'Same' } } }).fields, []);
  f.refused({ columns: { labels: { backlog: `${long}x` } } }, 'columns.label', 'label_long');
  f.refused({ columns: { labels: { done: 'SAME' } } }, 'columns.label', 'label_duplicate');
  assert.deepEqual(loadConfig(f.root).columns.map((column) => column.label), ['Same', long, 'same', 'Finished']);
});

test('hidden flags: true is stored, false removes the property, and the first column of a role stays visible', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.set({ columns: { hidden: { review: true } } }).fields, ['columns.hidden']);
  assert.equal(loadConfig(f.root).columns[2].hidden, true);
  assert.deepEqual(f.set({ columns: { hidden: { review: false } } }).fields, ['columns.hidden']);
  assert.equal(Object.hasOwn(loadConfig(f.root).columns[2], 'hidden'), false);
  for (const key of ['backlog', 'doing', 'done']) {
    f.refused({ columns: { hidden: { [key]: true } } }, 'columns.hidden', 'role_first_hidden');
  }
  f.refused({ columns: { hidden: { review: true, doing: true } } }, 'columns.hidden', 'role_first_hidden');
  f.refused({ columns: { hidden: { missing: true } } }, 'columns.hidden', 'column_unknown');
  // A reorder that would put a hidden column first in its role is refused under the order's name.
  f.set({ columns: { hidden: { review: true } } });
  f.refused({ columns: { move: { key: 'review', by: -1 } } }, 'columns.order', 'role_first_hidden');
  f.refused({ columns: { order: ['backlog', 'review', 'doing', 'done'] } }, 'columns.order', 'role_first_hidden');
  // Hiding and reordering in one write is judged on the result.
  f.set({ columns: { hidden: { review: false } } });
  assert.equal(f.set({ columns: { hidden: { doing: true }, order: ['backlog', 'review', 'doing', 'done'] } }).changed,
    true);
  assert.deepEqual(loadConfig(f.root).columns.map(({ key, hidden }) => [key, hidden === true]),
    [['backlog', false], ['review', false], ['doing', true], ['done', false]]);
});

test('a hand-written breach of the first-column rule loads, blocks no unrelated write and can be repaired', (t) => {
  const f = fixture(t);
  const breach = () => f.editColumns((columns) => columns.map((column) => column.key === 'doing'
    ? { ...column, hidden: true } : column));
  breach();
  assert.equal(loadConfig(f.root).columns[1].hidden, true);
  assert.equal(f.set({ columns: { labels: { done: 'Finished' } } }).changed, true);
  assert.equal(f.set({ leaseMinutes: 30 }).changed, true);
  // A visibility write that leaves the breach is refused; one that removes it is accepted.
  f.refused({ columns: { hidden: { review: true } } }, 'columns.hidden', 'role_first_hidden');
  f.refused({ columns: { move: { key: 'done', by: -1 } } }, 'columns.order', 'role_first_hidden');
  assert.equal(f.set({ columns: { hidden: { doing: false } } }).changed, true);
  breach();
  assert.equal(f.set({ columns: { move: { key: 'review', by: -1 } } }).changed, true);
  assert.deepEqual(loadConfig(f.root).columns.map((column) => column.key), ['backlog', 'review', 'doing', 'done']);
});

test('order: only a full permutation is taken, a move stops at the edges and no card file changes', (t) => {
  const f = fixture(t);
  for (const title of ['One', 'Two']) addCard(f.ctx, { title });
  addCard(f.ctx, { title: 'Three', column: 'review' });
  const cards = tree(f.root);
  assert.ok(cards.length >= 3);
  for (const order of [[], ['backlog', 'doing', 'review'], [...KEYS, 'extra'], ['backlog', 'doing', 'review', 'review'],
    ['backlog', 'doing', 'review', 'missing'], [...KEYS, 'done']]) {
    f.refused({ columns: { order } }, 'columns.order', 'order_mismatch');
  }
  f.refused({ columns: { move: { key: 'backlog', by: -1 } } }, 'columns.order', 'move_edge');
  f.refused({ columns: { move: { key: 'done', by: 1 } } }, 'columns.order', 'move_edge');
  f.refused({ columns: { move: { key: 'missing', by: 1 } } }, 'columns.order', 'column_unknown');
  assert.deepEqual(f.set({ columns: { order: ['done', 'review', 'doing', 'backlog'] } }).fields, ['columns.order']);
  assert.deepEqual(loadConfig(f.root).columns.map((column) => column.key), ['done', 'review', 'doing', 'backlog']);
  assert.deepEqual(f.set({ columns: { move: { key: 'backlog', by: -1 } } }).fields, ['columns.order']);
  assert.deepEqual(f.set({ columns: { move: { key: 'done', by: 1 } } }).fields, ['columns.order']);
  assert.deepEqual(loadConfig(f.root).columns.map((column) => column.key), ['review', 'done', 'backlog', 'doing']);
  assert.deepEqual(loadConfig(f.root).columns.map((column) => column.role), ['doing', 'done', 'todo', 'doing']);
  assert.deepEqual(tree(f.root), cards, 'cards keep their bytes');
});

test('lease: 5 to 1440 whole minutes; a running claim keeps its lease and the next claim uses the new one', (t) => {
  const f = fixture(t);
  for (const value of [4, 0, -5, 1441, 1.5, '30', NaN, Infinity, null, [30], true]) {
    f.refused({ leaseMinutes: value }, 'leaseMinutes', 'lease_range');
  }
  const first = addCard(f.ctx, { title: 'First' }).entity.id, second = addCard(f.ctx, { title: 'Second' }).entity.id;
  claimCard(f.ctx, first, {});
  const lease = entity.resolve(f.ctx, 'card', first).data.lease;
  assert.equal(lease, '2026-11-08T14:00:00.000Z');
  assert.equal(f.set({ leaseMinutes: 1440 }).changed, true);
  assert.equal(f.set({ leaseMinutes: 5 }).changed, true);
  assert.equal(loadConfig(f.root).leaseMinutes, 5);
  assert.equal(entity.resolve(f.ctx, 'card', first).data.lease, lease);
  claimCard(f.ctx, second, {});
  assert.equal(entity.resolve(f.ctx, 'card', second).data.lease, '2026-11-08T12:05:00.000Z');
  claimCard(f.ctx, first, { renew: true });
  assert.equal(entity.resolve(f.ctx, 'card', first).data.lease, '2026-11-08T12:05:00.000Z');
  // A hand-written value outside the range still loads and can be replaced.
  f.edit({ leaseMinutes: 3 });
  assert.equal(loadConfig(f.root).leaseMinutes, 3);
  assert.equal(f.set({ leaseMinutes: 10 }).changed, true);
});

test('the event names fields only: no value, no before or after, no feature', (t) => {
  const f = fixture(t);
  fs.mkdirSync(join(f.root, 'projects'), { recursive: true });
  fs.writeFileSync(join(f.root, 'projects/one.md'), '---\nid: p-000042\ntitle: One\n---\n');
  const result = f.set({ language: 'tr', leaseMinutes: 777, columns: { labels: { review: 'Zebra crossing' },
    hidden: { review: true }, order: ['backlog', 'doing', 'done', 'review'] },
  homeProjects: { listed: ['p-000042'], shown: [] } }, { actor: 'web:owner' });
  assert.deepEqual(result.fields, FIELD_NAMES);
  const [event, ...rest] = f.events();
  assert.deepEqual(rest, []);
  const { tx, ...logged } = event;
  assert.match(tx, /^s-[0-9a-z]+-[0-9a-f]{16}$/u);
  assert.deepEqual(logged, { v: 1, seq: 1, ts: f.ctx.clock.now().toISOString(), actor: 'web:owner',
    op: 'config.change', target: '.cairn/config.json', fields: FIELD_NAMES,
    features: { changeTrail: true, changeContent: true, liveUpdates: true, mentions: true }, rev: result.revision });
  const log = fs.readFileSync(join(f.root, '.cairn/events/2026-11.jsonl'), 'utf8');
  for (const value of ['Zebra', 'crossing', '"tr"', '"en"', '777', 'p-000042', 'before', 'after', '"feature"',
    'backlog', 'review']) {
    assert.equal(log.includes(value), false, value);
  }
  assert.equal(f.set({ leaseMinutes: 30 }).changed, true);
  assert.equal(f.events().at(-1).actor, 'cli:owner', 'the actor defaults to the context actor');
  // The last-change line still describes feature changes only.
  assert.equal(readSettings(f.ctx).lastChange, null);
  setFeature(f.ctx, { name: 'mentions', value: false, expectedRevision: f.rev() });
  const last = readSettings(f.ctx).lastChange;
  f.set({ leaseMinutes: 31 });
  assert.deepEqual(readSettings(f.ctx).lastChange, last);
  assert.equal(f.events().at(-1).features.mentions, false);
});

test('previewConfig is pure and reports the fields the writer then changes', (t) => {
  const f = fixture(t);
  const config = deepFreeze(loadConfig(f.root)), copy = structuredClone(config);
  const samples = [{ language: 'tr' }, { leaseMinutes: 30 }, { columns: { labels: { review: ' Check ' } } },
    { columns: { hidden: { review: true }, move: { key: 'review', by: 1 } } }, { columns: { order: KEYS } },
    { homeProjects: { listed: ['p-000001'], shown: [] } }, { language: 'en', leaseMinutes: 120 }];
  for (const changes of samples) {
    deepFreeze(changes);
    const before = structuredClone(changes);
    const preview = previewConfig(config, changes);
    assert.deepEqual(changes, before);
    assert.deepEqual(config, copy);
    assert.ok(Array.isArray(preview.fields));
    const current = loadConfig(f.root);
    const expected = previewConfig(current, changes);
    const written = f.set(changes);
    assert.deepEqual(written.fields, expected.fields, JSON.stringify(changes));
    assert.equal(written.changed, expected.fields.length > 0);
    if (written.changed) assert.deepEqual(loadConfig(f.root), expected.config);
  }
  assert.deepEqual(previewConfig(config, { columns: { labels: { review: ' Check ' } } }).fields, ['columns.label']);
  assert.deepEqual(previewConfig(config, { language: 'en' }), { config, fields: [] });
  // The preview refuses exactly what the writer refuses, so a page can ask whether to draw a button.
  for (const [changes, reason] of [[{ columns: { hidden: { doing: true } } }, 'role_first_hidden'],
    [{ columns: { move: { key: 'backlog', by: -1 } } }, 'move_edge'], [{ leaseMinutes: 2 }, 'lease_range']]) {
    assert.throws(() => previewConfig(config, changes), (error) => error.code === 'validation'
      && error.details.reason === reason);
  }
  assert.throws(() => previewConfig(config, {}), { code: 'validation' });
  assert.deepEqual(f.events().every(({ op }) => op === 'config.change'), true);
});

test('hand edits to each audited field are recorded once, by name, without values', (t) => {
  const f = fixture(t);
  readSettings(f.ctx);
  const edits = [
    ['language', () => f.edit({ language: 'tr' })],
    ['leaseMinutes', () => f.edit({ leaseMinutes: 4321 })],
    ['columns.label', () => f.editColumns((columns) => columns.map((column) => column.key === 'review'
      ? { ...column, label: 'Handwritten' } : column))],
    ['columns.hidden', () => f.editColumns((columns) => columns.map((column) => column.key === 'review'
      ? { ...column, hidden: true } : column))],
    ['columns.order', () => f.editColumns((columns) => [columns[1], columns[0], columns[2], columns[3]])],
    ['home.hiddenProjects', () => f.edit({ home: { hiddenProjects: ['p-000077'] } })],
  ];
  for (const [name, apply] of edits) {
    const count = f.events().length;
    apply();
    assert.equal(checkConfigDrift(f.open()), true, name);
    const event = f.events().at(-1);
    assert.equal(f.events().length, count + 1, name);
    const { tx, seq, ts, ...logged } = event;
    assert.deepEqual(logged, { v: 1, actor: 'owner:external', op: 'config.external', target: '.cairn/config.json',
      fields: [name], features: { changeTrail: true, changeContent: true, liveUpdates: true, mentions: true },
      rev: f.rev() }, name);
    // Recorded once: neither another check nor a read from a fresh context repeats it.
    assert.equal(checkConfigDrift(f.open()), false, name);
    readSettings(f.open());
    assert.equal(f.events().length, count + 1, name);
  }
  assert.equal(readSettings(f.ctx).lastChange, null, 'field edits do not move the last feature change');
  // Edits the writer does not own stay silent: a reformat, a role, an agent project.
  for (const patch of [{}, { agents: { project: 'p-000001' } }, { lint: { orphan: 'off' } }]) {
    f.edit(patch);
    assert.equal(checkConfigDrift(f.open()), false);
  }
  f.editColumns((columns) => columns.map((column) => column.key === 'review' ? { ...column, role: 'done' } : column));
  assert.equal(checkConfigDrift(f.open()), false);
  assert.equal(f.events().length, edits.length);

  // Everything at once, with a feature: one event carrying `changed`, `after` and `fields`.
  f.edit({ language: 'en', leaseMinutes: 15, features: { mentions: false, liveUpdates: false },
    home: { hiddenProjects: [] } });
  f.editColumns((columns) => [columns[1], columns[0], columns[3], { ...columns[2], hidden: false, label: 'Again' }]);
  assert.equal(checkConfigDrift(f.open()), true);
  assert.equal(f.events().length, edits.length + 1);
  const all = f.events().at(-1);
  assert.deepEqual([all.op, all.actor, all.changed, all.after, all.fields], ['config.external', 'owner:external',
    ['liveUpdates', 'mentions'], { liveUpdates: false, mentions: false }, FIELD_NAMES]);
  assert.deepEqual(readSettings(f.open()).lastChange,
    { ts: all.ts, actor: 'owner:external', feature: ['liveUpdates', 'mentions'], after: all.after });
  // A column added by hand shows as an order change (the key list changed) and a label change.
  f.editColumns((columns) => [...columns, { key: 'parked', label: 'Parked', role: 'todo' }]);
  assert.equal(checkConfigDrift(f.open()), true);
  assert.deepEqual(f.events().at(-1).fields, ['columns.label', 'columns.order']);
  const log = fs.readFileSync(join(f.root, '.cairn/events/2026-11.jsonl'), 'utf8');
  for (const value of ['Handwritten', 'Again', 'Parked', '4321', 'p-000077', '"tr"']) {
    assert.equal(log.includes(value), false, value);
  }
  // Our own write after all this is not mistaken for a hand edit.
  f.set({ leaseMinutes: 20 });
  assert.equal(checkConfigDrift(f.open()), false);
  assert.equal(f.events().at(-1).op, 'config.change');
});

test('a state file from before field digests is baselined silently on the first read', (t) => {
  const f = fixture(t);
  setFeature(f.ctx, { name: 'mentions', value: false, expectedRevision: f.rev() });
  const old = f.state();
  delete old.fields;
  delete old.pending;
  fs.writeFileSync(f.stateFile, JSON.stringify(old) + '\n');
  const fresh = f.open();
  const settings = readSettings(fresh);
  assert.equal(f.events().length, 1);
  assert.deepEqual(fresh.warnings, []);
  assert.deepEqual(Object.keys(f.state().fields).sort(), FIELD_NAMES);
  assert.ok(Object.values(f.state().fields).every((digest) => /^[0-9a-f]{16}$/u.test(digest)));
  assert.deepEqual(settings.lastChange, { ts: f.events()[0].ts, actor: 'cli:owner', feature: 'mentions',
    after: false });
  // From here on a hand edit is seen; unknown names in the stored digests are ignored.
  const state = f.state();
  state.fields['future.field'] = '0'.repeat(16);
  fs.writeFileSync(f.stateFile, JSON.stringify(state) + '\n');
  f.edit({ leaseMinutes: 77 });
  const next = f.open();
  assert.equal(checkConfigDrift(next), true);
  assert.deepEqual(next.warnings, []);
  assert.deepEqual(f.events().at(-1).fields, ['leaseMinutes']);
  // A malformed digest map or intent record invalidates the state, which is then rebuilt once.
  for (const patch of [{ fields: [] }, { fields: { language: 'short' } }, { pending: { tx: 's-1' } },
    { pending: { tx: 's-1', ts: 'x', actor: null, fields: ['language'], rev: '0'.repeat(16), digests: {} } },
    { pending: { tx: 's-1', ts: '2026-11-08T12:00:00.000Z', actor: null, fields: [], rev: '0'.repeat(16),
      digests: {} } }]) {
    fs.writeFileSync(f.stateFile, JSON.stringify({ ...f.state(), ...patch }) + '\n');
    const broken = f.open();
    readSettings(broken);
    assert.ok(broken.warnings.includes('settings_state_rebuilt'), JSON.stringify(patch));
    const again = f.open();
    readSettings(again);
    assert.deepEqual(again.warnings, []);
  }
});

test('intent recovery: the file was replaced but the event was not appended', (t) => {
  const f = fixture(t);
  const expectedRevision = readSettings(f.ctx).revision;
  t.after(() => fs.__setFsHooks());
  fs.__setFsHooks({ rename(from, to) {
    fs.renameSync(from, to);
    if (to === f.file) {
      fs.__setFsHooks();
      throw new Error('crash after rename');
    }
  } });
  assert.throws(() => setConfig(f.ctx, { changes: { leaseMinutes: 30, language: 'tr' }, expectedRevision,
    actor: 'web:owner' }), /crash after rename/u);
  assert.equal(loadConfig(f.root).leaseMinutes, 30);
  assert.deepEqual(f.events(), []);
  const pending = f.state().pending;
  assert.deepEqual([pending.actor, pending.fields, pending.rev], ['web:owner', ['language', 'leaseMinutes'], f.rev()]);
  assert.notEqual(f.state().rev, f.rev());

  f.ctx.clock.advance(60_000);
  const fresh = f.open();
  assert.equal(readSettings(fresh).revision, f.rev());
  const [event, ...rest] = f.events();
  assert.deepEqual(rest, []);
  assert.deepEqual([event.op, event.tx, event.ts, event.actor, event.fields, event.rev],
    ['config.change', pending.tx, pending.ts, 'web:owner', ['language', 'leaseMinutes'], f.rev()]);
  assert.equal(f.state().pending, undefined);
  assert.equal(f.state().rev, f.rev());
  assert.equal(checkConfigDrift(f.open()), false);
  assert.equal(f.events().length, 1);
  // The digests moved with the recovery: the next hand edit reports only itself.
  f.edit({ leaseMinutes: 31 });
  assert.equal(checkConfigDrift(f.open()), true);
  assert.deepEqual(f.events().at(-1).fields, ['leaseMinutes']);
});

test('intent recovery: the event was appended but the state was not updated', (t) => {
  const f = fixture(t);
  const expectedRevision = readSettings(f.ctx).revision;
  f.ctx.faults = (point) => {
    if (point === 'after-event') throw new Error('crash after event');
  };
  assert.throws(() => setConfig(f.ctx, { changes: { leaseMinutes: 30 }, expectedRevision }), /crash after event/u);
  delete f.ctx.faults;
  assert.equal(f.events().length, 1);
  assert.ok(f.state().pending);
  assert.notEqual(f.state().rev, f.rev());
  // A write recovers as well as a read, and the event is not appended a second time.
  assert.deepEqual(f.set({ leaseMinutes: 30 }), { changed: false, revision: f.rev(), fields: [] });
  assert.equal(f.events().length, 1);
  assert.equal(f.state().pending, undefined);
  assert.equal(f.state().rev, f.rev());
  assert.equal(checkConfigDrift(f.open()), false);
  assert.deepEqual(f.events().map(({ op, fields }) => [op, fields]), [['config.change', ['leaseMinutes']]]);
});

test('intent recovery: an intent whose write never landed is dropped without an event', (t) => {
  const f = fixture(t);
  readSettings(f.ctx);
  const state = f.state(), stored = f.bytes();
  const pending = { tx: 's-abc-0123456789abcdef', ts: '2026-11-08T11:59:00.000Z', actor: 'web:owner',
    fields: ['leaseMinutes'], rev: 'f'.repeat(16), digests: { leaseMinutes: 'e'.repeat(16) } };
  fs.writeFileSync(f.stateFile, JSON.stringify({ ...state, pending }) + '\n');
  const fresh = f.open();
  assert.equal(checkConfigDrift(fresh), false);
  assert.deepEqual(fresh.warnings, []);
  assert.deepEqual(f.events(), []);
  assert.deepEqual(f.state(), state);
  assert.deepEqual(f.bytes(), stored);
});

test('intent recovery: a hand edit after an unfinished write keeps the real actor and reports the rest', (t) => {
  const f = fixture(t);
  const expectedRevision = readSettings(f.ctx).revision;
  t.after(() => fs.__setFsHooks());
  fs.__setFsHooks({ rename(from, to) {
    fs.renameSync(from, to);
    if (to === f.file) {
      fs.__setFsHooks();
      throw new Error('crash after rename');
    }
  } });
  assert.throws(() => setConfig(f.ctx, { changes: { leaseMinutes: 30 }, expectedRevision, actor: 'web:owner' }),
    /crash after rename/u);
  const { tx } = f.state().pending;
  f.edit({ language: 'tr' });
  assert.equal(checkConfigDrift(f.open()), true);
  const [first, second, ...rest] = f.events();
  assert.deepEqual(rest, []);
  assert.deepEqual([first.op, first.tx, first.actor, first.fields], ['config.change', tx, 'web:owner',
    ['leaseMinutes']]);
  assert.deepEqual([second.op, second.actor, second.fields, second.unknown], ['config.external', 'owner:external',
    ['language'], undefined]);
  assert.equal(f.state().pending, undefined);
  assert.equal(checkConfigDrift(f.open()), false);
  assert.equal(f.events().length, 2);
});

test('a pending write is not logged twice even when the log has grown far past the dedup window', (t) => {
  const f = fixture(t);
  const expectedRevision = readSettings(f.ctx).revision;
  f.ctx.faults = (point) => {
    if (point === 'after-event') throw new Error('crash after event');
  };
  assert.throws(() => setConfig(f.ctx, { changes: { leaseMinutes: 30 }, expectedRevision }), /crash after event/u);
  delete f.ctx.faults;
  const log = join(f.root, '.cairn/events/2026-11.jsonl');
  const extra = Array.from({ length: 600 }, (_, index) => JSON.stringify({ v: 1, seq: index + 2,
    ts: f.ctx.clock.now().toISOString(), actor: 'cli:owner', op: 'note.write', target: 'notes/a.md', rev: null,
    tx: `t-${index}`, pad: 'x'.repeat(200) })).join('\n') + '\n';
  fs.appendFileSync(log, extra);
  assert.equal(checkConfigDrift(f.open()), false);
  assert.equal(f.events().filter(({ op }) => op === 'config.change').length, 1);
  assert.equal(f.state().pending, undefined);
});

test('a lost state cannot launder a hand edit or an interrupted write', (t) => {
  const f = fixture(t);
  setFeature(f.ctx, { name: 'mentions', value: false, expectedRevision: f.rev() });
  const edits = [() => f.edit({ leaseMinutes: 999 }),
    () => f.editColumns((columns) => columns.map((column) => column.key === 'review'
      ? { ...column, label: 'Secret label' } : column)),
    () => f.editColumns((columns) => columns.map((column) => column.key === 'review'
      ? { ...column, hidden: true } : column))];
  for (const [index, apply] of edits.entries()) {
    const count = f.events().length;
    apply();
    for (const damage of [() => fs.rmSync(f.stateFile), () => fs.writeFileSync(f.stateFile, '{')]) {
      damage();
      const fresh = f.open();
      assert.equal(readSettings(fresh).features.mentions, false);
      const logged = f.events();
      assert.equal(logged.length, count + 1, `edit ${index}`);
      const event = logged.at(-1);
      assert.deepEqual([event.op, event.actor, event.fields, event.unknown, event.rev],
        ['config.external', 'owner:external', FIELD_NAMES, true, f.rev()]);
      assert.equal(event.changed, undefined);
      // No storm: the state is consistent, so neither another read nor a rebuild from the log repeats it.
      assert.equal(checkConfigDrift(f.open()), false);
      fs.rmSync(f.stateFile);
      assert.equal(checkConfigDrift(f.open()), false);
      assert.equal(f.events().length, count + 1);
      assert.deepEqual(Object.keys(f.state().fields).sort(), FIELD_NAMES);
      break;
    }
  }
  assert.doesNotMatch(fs.readFileSync(join(f.root, '.cairn/events/2026-11.jsonl'), 'utf8'), /Secret label|999/u);

  // A write that reached the disk before its state and event were lost is reported too.
  const expectedRevision = readSettings(f.ctx).revision, count = f.events().length;
  t.after(() => fs.__setFsHooks());
  fs.__setFsHooks({ rename(from, to) {
    fs.renameSync(from, to);
    if (to === f.file) {
      fs.__setFsHooks();
      throw new Error('crash after rename');
    }
  } });
  assert.throws(() => setConfig(f.ctx, { changes: { leaseMinutes: 30 }, expectedRevision }), /crash after rename/u);
  fs.rmSync(f.stateFile);
  readSettings(f.open());
  assert.equal(f.events().length, count + 1);
  assert.deepEqual([f.events().at(-1).op, f.events().at(-1).unknown], ['config.external', true]);
});

test('a lost state is silent when the file is the one last recorded, legacy events included', (t) => {
  const f = fixture(t);
  // A fresh folder has no configuration event: nothing to report.
  fs.rmSync(f.stateFile, { force: true });
  readSettings(f.open());
  assert.deepEqual(f.events(), []);
  setFeature(f.ctx, { name: 'mentions', value: false, expectedRevision: f.rev() });
  // A write of an earlier version: the file changed and a legacy event carries the new revision.
  f.edit({ language: 'tr' });
  const legacy = f.rev();
  fs.mkdirSync(join(f.root, '.cairn/events'), { recursive: true });
  const last = f.events().at(-1);
  fs.appendFileSync(join(f.root, '.cairn/events/2026-11.jsonl'), JSON.stringify({ v: 1, seq: last.seq + 1,
    ts: last.ts, actor: 'cli:owner', op: 'config.language', target: '.cairn/config.json', rev: legacy,
    before: 'en', after: 'tr', tx: 's-legacy-0000000000000000' }) + '\n');
  fs.rmSync(f.stateFile);
  const fresh = f.open();
  assert.equal(readSettings(fresh).language, 'tr');
  assert.deepEqual(f.events().map(({ op }) => op), ['config.change', 'config.language']);
});

test('column input is read once and symbol keys are refused', (t) => {
  const f = fixture(t);
  let reads = 0;
  const labels = {};
  Object.defineProperty(labels, 'review', { enumerable: true, get() { return reads++ === 0 ? 'Once' : 7; } });
  assert.equal(f.set({ columns: { labels } }).changed, true);
  assert.equal(reads, 1);
  assert.equal(loadConfig(f.root).columns[2].label, 'Once');
  let moves = 0;
  const move = { by: 1 };
  Object.defineProperty(move, 'key', { enumerable: true, get() { return moves++ === 0 ? 'backlog' : 7; } });
  assert.equal(f.set({ columns: { move } }).changed, true);
  assert.equal(moves, 1);
  assert.equal(loadConfig(f.root).columns[1].key, 'backlog');
  f.refused({ columns: { labels: { [Symbol('x')]: 'A' } } }, 'columns');
  f.refused({ columns: { hidden: { [Symbol('x')]: true } } }, 'columns');
});

test('a rebuilt state takes no last change from a fields event and stays valid afterwards', (t) => {
  const f = fixture(t);
  // Only field events in the log: the rebuilt state has no last change and the revision of the last write.
  const changed = f.set({ leaseMinutes: 30 });
  fs.rmSync(f.stateFile);
  let fresh = f.open();
  assert.equal(checkConfigDrift(fresh), false);
  assert.equal(readSettings(fresh).lastChange, null);
  assert.equal(f.state().rev, changed.revision);
  assert.equal(f.state().lastChange, null);
  fresh = f.open();
  readSettings(fresh);
  assert.deepEqual(fresh.warnings, [], 'the rebuilt state is valid on the second read');

  // A feature change followed by field events and a field-only hand edit: the feature line survives the rebuild.
  setFeature(f.ctx, { name: 'liveUpdates', value: false, expectedRevision: f.rev() });
  const expected = readSettings(f.ctx).lastChange;
  f.set({ language: 'tr' });
  f.edit({ leaseMinutes: 45 });
  assert.equal(checkConfigDrift(f.open()), true);
  const count = f.events().length;
  for (const bytes of [null, '{']) {
    if (bytes === null) fs.rmSync(f.stateFile);
    else fs.writeFileSync(f.stateFile, bytes);
    fresh = f.open();
    assert.deepEqual(readSettings(fresh).lastChange, expected);
    assert.equal(fresh.warnings.includes('settings_state_rebuilt'), bytes !== null);
    assert.equal(readSettings(fresh).features.liveUpdates, false);
    assert.equal(f.state().rev, f.rev());
    fresh = f.open();
    assert.equal(checkConfigDrift(fresh), false);
    assert.deepEqual(readSettings(fresh).lastChange, expected);
    assert.deepEqual(fresh.warnings, []);
    assert.equal(f.events().length, count);
  }
});
