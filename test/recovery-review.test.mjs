import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { readFile, recover, write, writeMany } from '../core/store.mjs';
import { undo } from '../core/history.mjs';
import { readEvents } from '../core/events.mjs';
import { fixedClock, tempDir } from './support/env.mjs';

function fixture(t) {
  const root = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(root, { home, env: {}, clock });
  return openContext({ mode: 'write', dataDir: root, home, env: {}, clock, actor: 'agent:acme' });
}
const pending = (ctx) => readdirSync(join(ctx.root, '.cairn/pending'));
function crashAt(ctx, point, fn) {
  ctx.faults = (current) => { if (current === point) throw new Error('crashed'); };
  assert.throws(fn, /crashed/u);
  delete ctx.faults;
}
const note = (ctx, path, text) => write(ctx, { op: 'note.write', path, apply: () => text });

test('a transaction whose event is durable is completed, never rolled back', (t) => {
  const ctx = fixture(t);
  writeFileSync(join(ctx.root, 'a.md'), 'old-a');
  writeFileSync(join(ctx.root, 'b.md'), 'old-b');
  crashAt(ctx, 'after-event', () => writeMany(ctx, { op: 'pair', items: [
    { path: 'a.md', apply: () => 'new-a' }, { path: 'b.md', apply: () => 'new-b' },
  ] }));
  // A second writer changes one target before anyone recovers the first transaction.
  writeFileSync(join(ctx.root, 'b.md'), 'second-b');
  assert.equal(recover(ctx).external, 1);
  assert.deepEqual(readEvents(ctx).map(({ op }) => op), ['pair', 'external.change']);
  assert.equal(readFile(ctx, 'a.md').text, 'new-a');
  assert.equal(readFile(ctx, 'b.md').text, 'second-b');
  assert.deepEqual(pending(ctx), []);
});

test('pruning keeps the history of an outstanding transaction', (t) => {
  const ctx = fixture(t);
  writeFileSync(join(ctx.root, 'note.md'), 'old');
  crashAt(ctx, 'after-event', () => note(ctx, 'note.md', 'new'));
  const [intent] = pending(ctx);
  for (let i = 0; i < 51; i++) note(ctx, 'other.md', String(i));
  assert.ok(existsSync(join(ctx.root, '.cairn/history', intent)));
  assert.equal(recover(ctx).completed, 1);
  assert.deepEqual(pending(ctx), []);
});

test('a committed transaction with no history left still completes', (t) => {
  const ctx = fixture(t);
  writeFileSync(join(ctx.root, 'note.md'), 'old');
  crashAt(ctx, 'after-event', () => note(ctx, 'note.md', 'new'));
  const history = join(ctx.root, '.cairn/history');
  for (const name of readdirSync(history)) rmSync(join(history, name));
  assert.equal(recover(ctx).completed, 1);
  assert.equal(readFile(ctx, 'note.md').text, 'new');
  assert.deepEqual(pending(ctx), []);
});

test('recovery skips intents whose stored paths point elsewhere and keeps every file', (t) => {
  for (const tamper of [
    (intent) => { intent.items[0].temp = 'precious.md'; },
    (intent) => { intent.items[0].temp = '.cairn/config.json'; },
    (intent) => { intent.items[0].trash = { payload: 'precious.md', sidecar: '.cairn/config.json' }; },
    (intent) => { intent.items[0].path = '.cairn/config.json'; },
    (intent) => { intent.cleanup = [{ payload: 'precious.md', sidecar: '.cairn/config.json' }]; },
    (intent) => { intent.tx = '../precious'; },
  ]) {
    const ctx = fixture(t);
    writeFileSync(join(ctx.root, 'precious.md'), 'keep');
    writeFileSync(join(ctx.root, 'note.md'), 'old');
    crashAt(ctx, 'after-rename', () => note(ctx, 'note.md', 'new'));
    const [name] = pending(ctx);
    const file = join(ctx.root, '.cairn/pending', name);
    const intent = JSON.parse(readFileSync(file, 'utf8'));
    tamper(intent);
    writeFileSync(file, JSON.stringify(intent));
    const result = recover(ctx);
    assert.equal(result.skipped, 1, String(tamper));
    assert.equal(readFileSync(join(ctx.root, 'precious.md'), 'utf8'), 'keep');
    assert.ok(existsSync(join(ctx.root, '.cairn/config.json')));
    assert.deepEqual(pending(ctx), [name]);
  }
});

test('undo refuses history whose trash paths point elsewhere', (t) => {
  const ctx = fixture(t);
  writeFileSync(join(ctx.root, 'precious.md'), 'keep');
  writeFileSync(join(ctx.root, 'note.md'), 'old');
  write(ctx, { op: 'note.delete', path: 'note.md', apply: () => null });
  const dir = join(ctx.root, '.cairn/history');
  const [name] = readdirSync(dir);
  const record = JSON.parse(readFileSync(join(dir, name), 'utf8'));
  for (const item of [record, ...record.items]) item.trash = { payload: 'precious.md', sidecar: '.cairn/config.json' };
  writeFileSync(join(dir, name), JSON.stringify(record));
  assert.throws(() => undo(ctx, {}), { code: 'validation' });
  assert.equal(readFileSync(join(ctx.root, 'precious.md'), 'utf8'), 'keep');
  assert.ok(existsSync(join(ctx.root, '.cairn/config.json')));
});
