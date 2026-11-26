import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openContext } from '../core/context.mjs';
import { readFile, write, writeMany } from '../core/store.mjs';
import { latestUndoable, undo } from '../core/history.mjs';
import { appendEvent, readEvents } from '../core/events.mjs';
import { list } from '../core/trash.mjs';
import { fixedClock, seedDataDir, tempDir } from './support/env.mjs';

function fixture(t) {
  const root = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  seedDataDir(root, { home, env: {}, clock });
  return openContext({ mode: 'write', dataDir: root, home, env: {}, clock, actor: 'agent:acme' });
}

test('undo updates once, consumes its history and never makes undo history', (t) => {
  const ctx = fixture(t);
  writeFileSync(join(ctx.root, 'note.md'), 'old');
  write(ctx, { op: 'note.write', path: 'note.md', apply: () => 'new' });
  const tx = latestUndoable(ctx).tx;
  const preview = undo(ctx, { dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.equal(readFile(ctx, 'note.md').text, 'new');
  undo(ctx, {});
  assert.equal(readFile(ctx, 'note.md').text, 'old');
  assert.equal(readEvents(ctx).at(-1).undid, tx);
  assert.deepEqual(readdirSync(join(ctx.root, '.cairn/history')), []);
  assert.equal(latestUndoable(ctx), null);
  assert.throws(() => undo(ctx, {}), { code: 'nothing_to_undo', exit: 3 });
});

test('undo uses the last event, refuses external edits and retains only 50 committed histories', (t) => {
  const ctx = fixture(t);
  for (let i = 0; i < 51; i++) write(ctx, { op: 'note.write', path: 'note.md', apply: () => String(i) });
  const events = readEvents(ctx);
  const names = readdirSync(join(ctx.root, '.cairn/history'));
  assert.equal(names.length, 50);
  assert.equal(names.includes(`${events[0].tx}.json`), false);
  writeFileSync(join(ctx.root, 'note.md'), 'external');
  assert.throws(() => undo(ctx, {}), { code: 'conflict' });
  appendEvent(ctx, { tx: 't-external', op: 'external.change', target: 'note.md', rev: null });
  assert.equal(latestUndoable(ctx), null);
});

test('undo deletion restores bytes and removes trash; undo creation moves every target to trash', (t) => {
  const ctx = fixture(t);
  writeFileSync(join(ctx.root, 'note.md'), 'original\r\n');
  write(ctx, { op: 'note.delete', path: 'note.md', apply: () => null });
  assert.equal(list(ctx).length, 1);
  undo(ctx, {});
  assert.equal(readFile(ctx, 'note.md').text, 'original\r\n');
  assert.deepEqual(list(ctx), []);
  writeMany(ctx, { op: 'ingest', items: [
    { path: 'raw/a.md', createOnly: true, apply: () => 'source' },
    { path: 'research/a.md', apply: () => 'summary' },
  ] });
  undo(ctx, {});
  assert.equal(readFile(ctx, 'raw/a.md'), null);
  assert.equal(readFile(ctx, 'research/a.md'), null);
  assert.equal(list(ctx).length, 2);
});

test('undo preserves preimage bytes even when a Buffer contains non-UTF-8 bytes', (t) => {
  const ctx = fixture(t);
  const bytes = Buffer.from([0xff, 0xfe, 0x0a]);
  writeFileSync(join(ctx.root, 'note.md'), bytes);
  writeMany(ctx, { op: 'note.write', items: [{ path: 'note.md', apply: () => Buffer.from('new') }] });
  undo(ctx, {});
  assert.deepEqual(readFileSync(join(ctx.root, 'note.md')), bytes);
});

test('undo of a byte mutation restores a UTF-8 pre-image over invalid UTF-8', (t) => {
  const ctx = fixture(t), before = Buffer.from('# Acme\n');
  writeFileSync(join(ctx.root, 'note.md'), before);
  writeMany(ctx, { op: 'note.write', items: [{ path: 'note.md', apply: () => Buffer.from([0xff]) }] });
  undo(ctx, {});
  assert.deepEqual(readFileSync(join(ctx.root, 'note.md')), before);
});
