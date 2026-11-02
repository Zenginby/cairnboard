import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { readFile, recover, write, writeMany } from '../core/store.mjs';
import { undo } from '../core/history.mjs';
import { list, restore } from '../core/trash.mjs';
import { readEvents } from '../core/events.mjs';
import { lockName, withLock } from '../core/lock.mjs';
import { __setFsHooks } from '../core/fsx.mjs';
import { fixedClock, tempDir } from './support/env.mjs';

function fixture(t) {
  const root = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(root, { home, env: {}, clock });
  return openContext({ mode: 'write', dataDir: root, home, env: {}, clock, actor: 'agent:acme' });
}
const names = (ctx, dir) => readdirSync(join(ctx.root, '.cairn', dir));
function interrupt(ctx, point) {
  ctx.faults = (current) => { if (point === current) throw new Error('crashed'); };
}
function clear(ctx) { delete ctx.faults; }
const change = (ctx) => write(ctx, { op: 'note.write', path: 'note.md', extra: { reason: 'acme' }, apply: () => 'new' });

test('recovery rolls back before rename and completes after rename with the saved actor', (t) => {
  for (const point of ['before-rename', 'after-rename', 'after-event']) {
    const ctx = fixture(t);
    writeFileSync(join(ctx.root, 'note.md'), 'old');
    interrupt(ctx, point);
    assert.throws(() => change(ctx), /crashed/u);
    clear(ctx);
    ctx.actor = null;
    const result = recover(ctx);
    const complete = point !== 'before-rename';
    assert.equal(result.completed, Number(complete));
    assert.equal(result.rolledBack, Number(!complete));
    assert.equal(readFile(ctx, 'note.md').text, complete ? 'new' : 'old');
    assert.equal(readEvents(ctx).length, Number(complete));
    if (complete) {
      assert.equal(readEvents(ctx)[0].actor, 'agent:acme');
      assert.equal(readEvents(ctx)[0].reason, 'acme');
      assert.equal(readEvents(ctx)[0].ts, '2026-11-01T12:00:00.000Z');
    }
    assert.equal(names(ctx, 'history').length, Number(complete));
    assert.deepEqual(names(ctx, 'pending'), []);
    assert.deepEqual(recover(ctx), { completed: 0, rolledBack: 0, external: 0, skipped: 0 });
  }
});

test('recovery preserves external changes and skips intentions whose path is locked', (t) => {
  const ctx = fixture(t);
  interrupt(ctx, 'before-rename');
  assert.throws(() => change(ctx), /crashed/u);
  clear(ctx);
  withLock(ctx, lockName('note.md'), () => assert.equal(recover(ctx).skipped, 1));
  writeFileSync(join(ctx.root, 'note.md'), 'external');
  assert.equal(recover(ctx).external, 1);
  assert.equal(readFile(ctx, 'note.md').text, 'external');
  assert.equal(readEvents(ctx)[0].op, 'external.change');
  assert.equal(readEvents(ctx)[0].actor, 'system:recovery');
  assert.deepEqual(names(ctx, 'history'), []);
});

test('trash recovery rolls back sidecar-only and completes payload-only deletion', (t) => {
  for (const moved of [false, true]) {
    const ctx = fixture(t);
    writeFileSync(join(ctx.root, 'note.md'), 'old');
    interrupt(ctx, 'before-rename');
    assert.throws(() => write(ctx, { op: 'note.delete', path: 'note.md', apply: () => null }), /crashed/u);
    clear(ctx);
    const intent = JSON.parse(readFileSync(join(ctx.root, '.cairn/pending', names(ctx, 'pending')[0]), 'utf8'));
    const trash = intent.items[0].trash;
    if (moved) renameSync(join(ctx.root, 'note.md'), join(ctx.root, trash.payload));
    else writeFileSync(join(ctx.root, trash.sidecar), JSON.stringify({ path: 'note.md', deletedAt: intent.ts }));
    const result = recover(ctx);
    assert.equal(result[moved ? 'completed' : 'rolledBack'], 1);
    assert.equal(list(ctx).length, Number(moved));
    assert.equal(readFile(ctx, 'note.md')?.text ?? null, moved ? null : 'old');
  }
});

test('multi-target recovery rolls back a partial rename and completes a full rename', (t) => {
  for (const point of ['second-before', 'after-rename']) {
    const ctx = fixture(t);
    writeFileSync(join(ctx.root, 'a.md'), 'old-a');
    let count = 0;
    ctx.faults = (current) => {
      if ((point === 'second-before' && current === 'before-rename' && ++count === 2)
        || (point === 'after-rename' && current === point)) throw new Error('crashed');
    };
    assert.throws(() => writeMany(ctx, { op: 'pair.write', items: [
      { path: 'a.md', apply: () => 'new-a' }, { path: 'b.md', apply: () => 'new-b' },
    ] }), /crashed/u);
    clear(ctx);
    const complete = point === 'after-rename';
    assert.equal(recover(ctx)[complete ? 'completed' : 'rolledBack'], 1);
    assert.equal(readFile(ctx, 'a.md').text, complete ? 'new-a' : 'old-a');
    assert.equal(readFile(ctx, 'b.md')?.text ?? null, complete ? 'new-b' : null);
    assert.equal(readEvents(ctx).length, Number(complete));
    assert.equal(names(ctx, 'history').length, Number(complete));
  }
});

test('undo recovery consumes the original history and cleans restored deletion trash', (t) => {
  for (const deletion of [false, true]) {
    const ctx = fixture(t);
    writeFileSync(join(ctx.root, 'note.md'), 'old');
    write(ctx, { op: 'note.write', path: 'note.md', apply: () => deletion ? null : 'new' });
    interrupt(ctx, 'after-rename');
    assert.throws(() => undo(ctx, {}), /crashed/u);
    clear(ctx);
    assert.equal(recover(ctx).completed, 1);
    assert.equal(readFile(ctx, 'note.md').text, 'old');
    assert.deepEqual(names(ctx, 'history'), []);
    assert.deepEqual(list(ctx), []);
    assert.equal(readEvents(ctx).at(-1).op, 'undo');
  }
});

test('trash restore recovery cleans its payload only after the restored file commits', (t) => {
  const ctx = fixture(t);
  writeFileSync(join(ctx.root, 'note.md'), 'old');
  write(ctx, { op: 'note.delete', path: 'note.md', apply: () => null });
  const [entry] = list(ctx);
  interrupt(ctx, 'after-rename');
  assert.throws(() => restore(ctx, entry.trashId, {}), /crashed/u);
  clear(ctx);
  assert.equal(recover(ctx).completed, 1);
  assert.deepEqual(list(ctx), []);
  assert.equal(readFile(ctx, 'note.md').text, 'old');
});

test('recovery itself can be interrupted while rolling back without losing original bytes', (t) => {
  const ctx = fixture(t);
  writeFileSync(join(ctx.root, 'a.md'), 'old-a');
  let count = 0;
  ctx.faults = (point) => { if (point === 'before-rename' && ++count === 2) throw new Error('crashed'); };
  assert.throws(() => writeMany(ctx, { op: 'pair.write', items: [
    { path: 'a.md', apply: () => 'new-a' }, { path: 'b.md', apply: () => 'new-b' },
  ] }), /crashed/u);
  clear(ctx);
  t.after(() => __setFsHooks({}));
  __setFsHooks({ rename(from, to) {
    if (to === join(ctx.root, 'a.md')) throw new Error('recovery crashed');
    renameSync(from, to);
  } });
  assert.throws(() => recover(ctx), /recovery crashed/u);
  __setFsHooks({});
  assert.equal(recover(ctx).rolledBack, 1);
  assert.equal(readFile(ctx, 'a.md').text, 'old-a');
  assert.equal(readFile(ctx, 'b.md'), null);
});

test('CAIRN_TEST_CRASH kills a subprocess at every fault point and recovery remains idempotent', (t) => {
  for (const point of ['after-check', 'before-rename', 'after-rename', 'after-event']) {
    const ctx = fixture(t);
    const home = tempDir(t);
    const source = `
      import { openContext } from ${JSON.stringify(new URL('../core/context.mjs', import.meta.url).href)};
      import { write } from ${JSON.stringify(new URL('../core/store.mjs', import.meta.url).href)};
      const ctx = openContext({ mode: 'write', dataDir: process.env.CAIRN_DATA, actor: 'agent:acme' });
      write(ctx, { op: 'note.write', path: 'note.md', apply: () => 'new' });
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, HOME: home, USERPROFILE: home, CAIRN_DATA: ctx.root, CAIRN_TEST_CRASH: point }, encoding: 'utf8',
    });
    // Windows has no signals: a killed process just exits with a non-zero code.
    if (process.platform === 'win32') assert.notEqual(child.status, 0, child.stderr);
    else assert.equal(child.signal, 'SIGKILL', child.stderr);
    const result = recover(ctx);
    assert.equal(result[point === 'before-rename' ? 'rolledBack' : 'completed'], point === 'after-check' ? 0 : 1);
    assert.equal(readEvents(ctx).length, ['after-check', 'before-rename'].includes(point) ? 0 : 1);
    assert.deepEqual(names(ctx, 'pending'), []);
  }
});

test('a partial multi-target undo rolls back without consuming history, including an interrupted rollback', (t) => {
  for (const interruptRollback of [false, true]) {
    const ctx = fixture(t);
    writeMany(ctx, { op: 'ingest', items: [
      { path: 'raw/a.md', createOnly: true, apply: () => 'source' },
      { path: 'research/a.md', apply: () => 'summary' },
    ] });
    let count = 0;
    ctx.faults = (point) => { if (point === 'before-rename' && ++count === 2) throw new Error('crashed'); };
    assert.throws(() => undo(ctx, {}), /crashed/u);
    clear(ctx);
    if (interruptRollback) {
      t.after(() => __setFsHooks({}));
      __setFsHooks({ rename(from, to) {
        renameSync(from, to);
        if (to === join(ctx.root, 'raw/a.md')) throw new Error('recovery crashed');
      } });
      assert.throws(() => recover(ctx), /recovery crashed/u);
      __setFsHooks({});
    }
    assert.equal(recover(ctx).rolledBack, 1);
    assert.equal(readFile(ctx, 'raw/a.md').text, 'source');
    assert.equal(readFile(ctx, 'research/a.md').text, 'summary');
    assert.deepEqual(list(ctx), []);
    assert.equal(names(ctx, 'history').length, 1);
    undo(ctx, {});
    assert.equal(list(ctx).length, 2);
    assert.equal(readFile(ctx, 'raw/a.md'), null);
    assert.equal(readFile(ctx, 'research/a.md'), null);
  }
});

test('a partial creation rolls back to trash while preserving an external edit to its companion', (t) => {
  const ctx = fixture(t);
  let count = 0;
  ctx.faults = (point) => {
    if (point === 'before-rename' && ++count === 2) {
      writeFileSync(join(ctx.root, 'b.md'), 'external');
    }
  };
  assert.throws(() => writeMany(ctx, { op: 'pair.write', items: [
    { path: 'a.md', apply: () => 'a' }, { path: 'b.md', apply: () => 'b' },
  ] }), { code: 'conflict' });
  clear(ctx);
  assert.equal(readFile(ctx, 'a.md'), null);
  assert.equal(readFile(ctx, 'b.md').text, 'external');
  assert.equal(list(ctx).length, 1);
  assert.deepEqual(names(ctx, 'pending'), []);
  assert.deepEqual(names(ctx, 'history'), []);
  assert.deepEqual(readEvents(ctx), []);
});

test('single-target intentions and histories also recover and undo without an items array', (t) => {
  for (const deletion of [false, true]) {
    const ctx = fixture(t);
    writeFileSync(join(ctx.root, 'note.md'), 'old');
    interrupt(ctx, 'after-rename');
    assert.throws(() => write(ctx, { op: 'note.write', path: 'note.md', apply: () => deletion ? null : 'new' }), /crashed/u);
    clear(ctx);
    for (const dir of ['pending', 'history']) {
      const path = join(ctx.root, '.cairn', dir, names(ctx, dir)[0]);
      const record = JSON.parse(readFileSync(path, 'utf8'));
      delete record.items;
      if (dir === 'history') delete record.trash;
      writeFileSync(path, JSON.stringify(record));
    }
    assert.equal(recover(ctx).completed, 1);
    undo(ctx, {});
    assert.equal(readFile(ctx, 'note.md').text, 'old');
    assert.deepEqual(list(ctx), []);
  }
});

test('recovery records an external edit even when the interrupted transaction already has an event', (t) => {
  const ctx = fixture(t);
  interrupt(ctx, 'after-event');
  assert.throws(() => change(ctx), /crashed/u);
  clear(ctx);
  writeFileSync(join(ctx.root, 'note.md'), 'external');
  assert.equal(recover(ctx).external, 1);
  assert.equal(readFile(ctx, 'note.md').text, 'external');
  assert.deepEqual(readEvents(ctx).map(({ op }) => op), ['note.write', 'external.change']);
});

test('delayed recovery does not duplicate an event beyond the event log tail', (t) => {
  const ctx = fixture(t);
  interrupt(ctx, 'after-event');
  assert.throws(() => change(ctx), /crashed/u);
  clear(ctx);
  const [first] = readEvents(ctx);
  const log = join(ctx.root, '.cairn/events/2026-11.jsonl');
  const later = Array.from({ length: 20 }, (_, index) => JSON.stringify({
    ...first, seq: index + 2, tx: `t-later-${index}`, reason: 'x'.repeat(4096),
  })).join('\n') + '\n';
  writeFileSync(log, readFileSync(log, 'utf8') + later);
  assert.equal(recover(ctx).completed, 1);
  assert.equal(readEvents(ctx).filter(({ tx }) => tx === first.tx).length, 1);
  assert.equal(readEvents(ctx).length, 21);
});

test('recovery handles interruption while saving per-target history or finalizing the history bundle', (t) => {
  for (const phase of ['stage', 'finalize']) {
    const ctx = fixture(t);
    t.after(() => __setFsHooks({}));
    __setFsHooks({ rename(from, to) {
      if (to.includes(`${join('.cairn', 'history')}${sep}`)
        && (phase === 'stage' ? to.endsWith('-1.pending.json') : !to.endsWith('.pending.json'))) {
        throw new Error('history crashed');
      }
      renameSync(from, to);
    } });
    assert.throws(() => writeMany(ctx, { op: 'pair.write', items: [
      { path: 'a.md', apply: () => 'a' }, { path: 'b.md', apply: () => 'b' },
    ] }), /history crashed/u);
    __setFsHooks({});
    assert.equal(recover(ctx)[phase === 'stage' ? 'rolledBack' : 'completed'], 1);
    assert.equal(readFile(ctx, 'a.md')?.text ?? null, phase === 'stage' ? null : 'a');
    assert.equal(readFile(ctx, 'b.md')?.text ?? null, phase === 'stage' ? null : 'b');
    assert.equal(names(ctx, 'history').length, phase === 'stage' ? 0 : 1);
    assert.deepEqual(names(ctx, 'pending'), []);
  }
});
