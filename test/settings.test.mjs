import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, sep } from 'node:path';
import { openSync } from 'node:fs';
import * as fs from '../core/fsx.mjs';
import { features, loadConfig } from '../core/config.mjs';
import { openContext } from '../core/context.mjs';
import { initDataDir } from '../core/roots.mjs';
import { readEvents } from '../core/events.mjs';
import { revision, write } from '../core/store.mjs';
import { readShadow, recordShadow, shadowBytes } from '../core/shadow.mjs';
import { changeDiff, listChanges, reconcileBeforeRun, reconcileExternal } from '../core/changes.mjs';
import { mentions, linkMention } from '../core/mentions.mjs';
import { checkConfigDrift, clearShadow, readSettings, setFeature } from '../core/settings.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { lockName, withLock } from '../core/lock.mjs';

function fixture(t) {
  const root = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-08T12:00:00Z');
  initDataDir(root, { home, env: {}, clock });
  const open = () => openContext({ mode: 'write', dataDir: root, home, env: {}, clock, actor: 'cli:owner' });
  const ctx = open();
  const put = (path, bytes) => {
    fs.mkdirSync(dirname(join(root, path)), { recursive: true });
    fs.writeFileSync(join(root, path), bytes);
  };
  const editConfig = (patch) => put('.cairn/config.json', JSON.stringify({ ...loadConfig(root), ...patch }));
  const set = (name, value) => setFeature(ctx, { name, value, expectedRevision: readSettings(ctx).revision });
  const blobs = () => {
    try { return fs.readdirSync(join(root, '.cairn/shadow/blobs')).sort(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return [];
    }
  };
  return { ctx, open, put, editConfig, set, blobs };
}

test('feature defaults and validation preserve the existing format', (t) => {
  const { ctx, editConfig } = fixture(t);
  const defaults = { changeTrail: true, changeContent: true, liveUpdates: true, mentions: true };
  assert.deepEqual(features({}), defaults);
  assert.deepEqual(readSettings(ctx), { features: defaults,
    revision: revision(fs.readFileSync(join(ctx.root, '.cairn/config.json'))),
    shadow: { blobs: 0, bytes: 0 }, trailOffSince: null, lastChange: null });
  assert.equal(loadConfig(ctx.root).formatVersion, 1);
  for (const [value, field] of [[null, 'features'], [[], 'features'], [false, 'features'], ['false', 'features'],
    [{ changeTrail: 'false' }, 'features.changeTrail'], [{ foo: true }, 'features.foo']]) {
    editConfig({ features: value });
    assert.throws(() => loadConfig(ctx.root), { code: 'validation', message: `Invalid configuration: ${field}` });
    // Restore without loading the invalid file.
    fs.writeFileSync(join(ctx.root, '.cairn/config.json'), JSON.stringify(ctx.config));
  }
});

test('settings writes are conditional, audited and preserve unrelated fields', (t) => {
  const { ctx, editConfig, set } = fixture(t);
  editConfig({ lint: { orphan: 'off' }, rules: { filename: 'warn' }, schema: ctx.schema });
  const before = loadConfig(ctx.root), initial = readSettings(ctx);
  const bytes = fs.readFileSync(join(ctx.root, '.cairn/config.json'));
  assert.deepEqual(setFeature(ctx, { name: 'changeTrail', value: true,
    expectedRevision: initial.revision }), { changed: false, revision: initial.revision });
  assert.deepEqual(fs.readFileSync(join(ctx.root, '.cairn/config.json')), bytes);
  assert.deepEqual(readEvents(ctx), []);
  const changed = set('changeTrail', false);
  assert.equal(changed.changed, true);
  assert.notEqual(changed.revision, initial.revision);
  assert.deepEqual(loadConfig(ctx.root), { ...before, features: { changeTrail: false } });
  const [event] = readEvents(ctx);
  assert.equal(event.op, 'config.change');
  assert.equal(event.feature, 'changeTrail');
  assert.equal(event.before, true);
  assert.equal(event.after, false);
  assert.equal(event.actor, ctx.actor);
  assert.equal(event.rev, changed.revision);
  assert.deepEqual(readSettings(ctx).lastChange,
    { ts: event.ts, actor: ctx.actor, feature: 'changeTrail', after: false });
  assert.throws(() => setFeature(ctx, { name: 'mentions', value: false,
    expectedRevision: initial.revision }), { code: 'conflict' });
  for (const options of [{ name: 'foo', value: false }, { name: 'mentions', value: 'false' }]) {
    assert.throws(() => setFeature(ctx, { ...options, expectedRevision: changed.revision }), { code: 'validation' });
  }
  assert.equal(readEvents(ctx).length, 1);
  assert.doesNotMatch(JSON.stringify(readEvents(ctx)), /"(?:title|body|text|content)"\s*:/u);
});

test('disabled trail skips reconciliation and reopening baselines once with a gap', (t) => {
  const { ctx, put, set, blobs } = fixture(t);
  put('notes/a.md', 'before');
  reconcileExternal(ctx);
  const oldBlobs = blobs();
  const from = ctx.clock.now().toISOString();
  set('changeTrail', false);
  assert.deepEqual(blobs(), oldBlobs);
  for (const name of ['a', 'b', 'c']) put(`notes/${name}.md`, `during ${name}`);
  assert.deepEqual(reconcileExternal(ctx), { recorded: 0, baseline: false, seqs: [] });
  assert.ok(ctx.warnings.includes('trail_disabled'));
  assert.deepEqual(listChanges(ctx), []);
  assert.deepEqual(reconcileBeforeRun(ctx), ['trail_disabled']);
  assert.equal(readEvents(ctx).filter(({ op }) => op === 'external.change').length, 0);
  assert.equal(readShadow(ctx).disabledSince, from);
  // Own writes and their history still work while the external trail is off.
  const own = write(ctx, { op: 'note.write', path: 'notes/own.md', apply: () => 'own' });
  assert.ok(own.seq);
  ctx.clock.advance(60_000);
  set('changeTrail', true);
  assert.equal(readShadow(ctx).initialized, false);
  assert.equal(reconcileExternal(ctx, { paths: ['notes/a.md'] }).baseline, true);
  reconcileExternal(ctx);
  const gaps = readEvents(ctx).filter(({ op }) => op === 'external.gap');
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].from, from);
  assert.equal(gaps[0].to, ctx.clock.now().toISOString());
  assert.equal(readEvents(ctx).filter(({ op }) => op === 'external.change').length, 0);
  put('notes/b.md', 'after reopening');
  assert.equal(reconcileExternal(ctx).recorded, 1);
});

test('content gate keeps revisions without new blobs or external diff copies', (t) => {
  const { ctx, put, set, blobs } = fixture(t);
  put('notes/a.md', 'before');
  reconcileExternal(ctx);
  const oldBlobs = blobs();
  set('changeContent', false);
  assert.deepEqual(blobs(), oldBlobs);
  put('notes/a.md', 'after');
  put('notes/new.md', 'new');
  assert.equal(reconcileExternal(ctx).recorded, 2);
  const events = readEvents(ctx).filter(({ op }) => op === 'external.change');
  for (const event of events) {
    assert.deepEqual(changeDiff(ctx, event), { diff: null, reason: 'content_not_kept' });
    const saved = fs.readFileSync(join(ctx.root, `.cairn/history/${event.tx}.json`), 'utf8');
    assert.equal(saved.includes('"before":"before"'), false);
  }
  for (const [path, text] of [['notes/a.md', 'after'], ['notes/new.md', 'new']]) {
    assert.deepEqual(readShadow(ctx).entries.get(path), { rev: revision(text), blob: false, size: text.length });
    assert.equal(shadowBytes(ctx, path), null);
  }
  assert.ok(blobs().every((name) => oldBlobs.includes(name)));
  recordShadow(ctx, [{ path: 'notes/direct.md', bytes: Buffer.from('direct') }]);
  assert.equal(readShadow(ctx).entries.get('notes/direct.md').blob, false);
  set('changeContent', true);
  put('notes/a.md', 'kept again');
  reconcileExternal(ctx);
  assert.deepEqual(shadowBytes(ctx, 'notes/a.md'), Buffer.from('kept again'));
});

test('clearing shadow deletes unique blocks and preserves revisions and initialization', (t) => {
  const { ctx, put } = fixture(t);
  put('notes/a.md', 'shared');
  put('notes/b.md', 'shared');
  put('notes/c.md', 'other');
  reconcileExternal(ctx);
  const before = readShadow(ctx);
  assert.deepEqual(readSettings(ctx).shadow, { blobs: 2, bytes: 11 });
  assert.deepEqual(clearShadow(ctx), { blobs: 2, bytes: 11 });
  assert.deepEqual(readSettings(ctx).shadow, { blobs: 0, bytes: 0 });
  const shadow = readShadow(ctx);
  assert.equal(shadow.initialized, true);
  for (const [path, entry] of before.entries) {
    assert.deepEqual(shadow.entries.get(path), { rev: entry.rev, blob: false, size: entry.size });
  }
  assert.equal(reconcileExternal(ctx).recorded, 0);
  const [event] = readEvents(ctx);
  assert.equal(event.op, 'shadow.clear');
  assert.equal(event.actor, ctx.actor);
  assert.equal(event.blobs, 2);
  assert.equal(event.bytes, 11);
});

test('manual feature edits are audited once across contexts even with the trail off', (t) => {
  const { ctx, open, editConfig, set } = fixture(t);
  set('changeTrail', false);
  editConfig({ features: { changeTrail: false, mentions: false } });
  assert.equal(checkConfigDrift(open()), true);
  const event = readEvents(ctx).at(-1);
  assert.equal(event.op, 'config.external');
  assert.equal(event.actor, 'owner:external');
  assert.deepEqual(event.changed, ['mentions']);
  assert.equal(event.after.mentions, false);
  assert.equal(event.rev, revision(fs.readFileSync(join(ctx.root, '.cairn/config.json'))));
  assert.equal(checkConfigDrift(open()), false);
  editConfig({ language: 'tr' });
  assert.equal(checkConfigDrift(open()), false);
  assert.equal(readEvents(ctx).length, 2);
  // A non-feature edit must not mask a later edit to a different feature.
  editConfig({ features: { changeTrail: false, mentions: false, liveUpdates: false } });
  assert.equal(checkConfigDrift(open()), true);
  assert.deepEqual(readEvents(ctx).at(-1).changed, ['liveUpdates']);
});

test('manual trail toggles use the same gap and baseline as settings writes', (t) => {
  const { ctx, put, editConfig } = fixture(t);
  put('notes/a.md', 'before');
  reconcileExternal(ctx);
  editConfig({ features: { changeTrail: false } });
  reconcileExternal(ctx);
  put('notes/a.md', 'during');
  ctx.clock.advance(1000);
  editConfig({ features: {} });
  reconcileExternal(ctx);
  reconcileExternal(ctx);
  assert.equal(readEvents(ctx).filter(({ op }) => op === 'external.gap').length, 1);
  assert.equal(readEvents(ctx).filter(({ op }) => op === 'external.change').length, 0);
});

test('mentions and linking fail before scanning when disabled', (t) => {
  const { ctx, set } = fixture(t);
  set('mentions', false);
  for (const run of [() => mentions(ctx, '@missing'), () => linkMention(ctx, '@missing', 'missing.md:1')]) {
    assert.throws(run, { code: 'feature_disabled', exit: 2 });
  }
});

test('all feature values round-trip independently, including content while the trail is off', (t) => {
  const { ctx, set } = fixture(t);
  for (const name of Object.keys(features({}))) set(name, false);
  assert.deepEqual(readSettings(ctx).features,
    { changeTrail: false, changeContent: false, liveUpdates: false, mentions: false });
  set('changeTrail', true);
  assert.equal(readSettings(ctx).features.changeContent, false);
  for (const name of ['changeContent', 'liveUpdates', 'mentions']) set(name, true);
  assert.deepEqual(readSettings(ctx).features, features({}));
});

test('settings detect an external edit before atomic replacement', (t) => {
  const { ctx, editConfig } = fixture(t);
  const initial = readSettings(ctx);
  t.after(() => fs.__setFsHooks());
  fs.__setFsHooks({ openSync(path, ...args) {
    if (String(path).includes('.tmp-')) {
      fs.__setFsHooks();
      editConfig({ language: 'tr' });
    }
    return openSync(path, ...args);
  } });
  assert.throws(() => setFeature(ctx, { name: 'mentions', value: false,
    expectedRevision: initial.revision }), { code: 'conflict' });
  assert.equal(loadConfig(ctx.root).language, 'tr');
  assert.equal(features(loadConfig(ctx.root)).mentions, true);
  assert.deepEqual(readEvents(ctx), []);
});

test('config contention is reported and reconciliation locks paths before config and shadow', (t) => {
  const { ctx, put } = fixture(t);
  const initial = readSettings(ctx);
  const other = { ...ctx, instance: 'other' };
  withLock(other, '_config', () => {
    assert.throws(() => setFeature(ctx, { name: 'mentions', value: false,
      expectedRevision: initial.revision }), { code: 'locked', exit: 6 });
    assert.throws(() => clearShadow(ctx), { code: 'locked' });
  });
  put('notes/a.md', 'before');
  reconcileExternal(ctx);
  put('notes/a.md', 'after');
  t.after(() => fs.__setFsHooks());
  fs.__setFsHooks({ afterCheck(path) {
    if (path !== join(ctx.root, '.cairn/locks/_shadow.lock')) return;
    // Baseline/config-drift locks have no path lock; when a path lock exists config must already be held.
    if (fs.existsSync(join(ctx.root, `.cairn/locks/${lockName('notes/a.md')}.lock`))) {
      assert.ok(fs.existsSync(join(ctx.root, '.cairn/locks/_config.lock')));
    }
  } });
  assert.equal(reconcileExternal(ctx).recorded, 1);
});

test('gap recovery is idempotent and separate disable intervals may share a timestamp', (t) => {
  const { ctx, set } = fixture(t);
  reconcileExternal(ctx);
  set('changeTrail', false);
  const expectedRevision = readSettings(ctx).revision;
  t.after(() => fs.__setFsHooks());
  fs.__setFsHooks({ rename(from, to) {
    if (to.replace(/\\/gu, '/').endsWith('/shadow/manifest.json')) throw new Error('manifest failed');
    fs.renameSync(from, to);
  } });
  assert.throws(() => setFeature(ctx, { name: 'changeTrail', value: true, expectedRevision }), /manifest failed/u);
  fs.__setFsHooks();
  checkConfigDrift(ctx);
  reconcileExternal(ctx);
  assert.equal(readEvents(ctx).filter(({ op }) => op === 'external.gap').length, 1);
  set('changeTrail', false);
  set('changeTrail', true);
  reconcileExternal(ctx);
  assert.equal(readEvents(ctx).filter(({ op }) => op === 'external.gap').length, 2);
});

test('partial shadow clearing unpublishes all blobs before the second deletion fails', (t) => {
  const { ctx, put } = fixture(t);
  put('notes/a.md', 'first');
  put('notes/b.md', 'second');
  reconcileExternal(ctx);
  const before = readShadow(ctx);
  let count = 0;
  t.after(() => fs.__setFsHooks());
  fs.__setFsHooks({ afterCheck(path) {
    if (!path.startsWith(join(ctx.root, '.cairn', 'shadow', 'blobs') + sep)) return;
    if ([...readShadow(ctx).entries.values()].some((entry) => entry.blob)) return;
    if (++count === 2) throw new Error('clear failed');
  } });
  assert.throws(() => clearShadow(ctx), /clear failed/u);
  fs.__setFsHooks();
  for (const [path, entry] of before.entries) {
    assert.deepEqual(readShadow(ctx).entries.get(path), { rev: entry.rev, blob: false, size: entry.size });
    assert.equal(shadowBytes(ctx, path), null);
  }
  assert.equal(fs.readdirSync(join(ctx.root, '.cairn/shadow/blobs')).length, 1);
  assert.equal(readEvents(ctx).length, 0);
  assert.equal(clearShadow(ctx).blobs, 1);
  assert.equal(reconcileExternal(ctx).recorded, 0);
});

test('a 5000-event log is not opened for unchanged settings, even from fresh contexts', (t) => {
  const { ctx, open, set } = fixture(t);
  set('mentions', false);
  const lastChange = readSettings(ctx).lastChange;
  const log = join(ctx.root, '.cairn/events/2026-11.jsonl');
  const extra = Array.from({ length: 4999 }, (_, index) => JSON.stringify({ v: 1, seq: index + 2,
    ts: ctx.clock.now().toISOString(), actor: 'cli:owner', op: 'note.write', target: 'notes/a.md',
    rev: null, tx: `t-${index}` })).join('\n') + '\n';
  fs.appendFileSync(log, extra);
  const before = fs.readFileSync(log);
  let reads = 0;
  t.after(() => fs.__setFsHooks());
  fs.__setFsHooks({ openSync(path, ...args) {
    if (String(path).startsWith(join(ctx.root, '.cairn', 'events') + sep)) reads++;
    return openSync(path, ...args);
  } });
  assert.equal(checkConfigDrift(open()), false);
  assert.deepEqual(readSettings(open()).lastChange, lastChange);
  assert.equal(reads, 0);
  fs.unlinkSync(join(ctx.root, '.cairn/settings-state.json'));
  assert.equal(checkConfigDrift(open()), false);
  assert.equal(reads, 1);
  assert.equal(checkConfigDrift(open()), false);
  assert.deepEqual(readSettings(open()).lastChange, lastChange);
  assert.equal(reads, 1);
  fs.__setFsHooks();
  assert.deepEqual(fs.readFileSync(log), before);
});

test('malformed state is rebuilt once, warns and retains the last setting change', (t) => {
  const { ctx, open, set } = fixture(t);
  set('liveUpdates', false);
  const expected = readSettings(ctx).lastChange;
  const count = readEvents(ctx).length;
  for (const bytes of ['{', JSON.stringify({ v: 1, rev: 'bad', features: features({}) })]) {
    fs.writeFileSync(join(ctx.root, '.cairn/settings-state.json'), bytes);
    const fresh = open();
    assert.deepEqual(readSettings(fresh).lastChange, expected);
    assert.ok(fresh.warnings.includes('settings_state_rebuilt'));
    assert.equal(checkConfigDrift(fresh), false);
    assert.equal(readEvents(ctx).length, count);
  }
  const fresh = open();
  readSettings(fresh);
  assert.deepEqual(fresh.warnings, []);
});

test('a gap appended before a crash is recovered from its pending state without duplication', (t) => {
  const { ctx, open, set } = fixture(t);
  reconcileExternal(ctx);
  set('changeTrail', false);
  const expectedRevision = readSettings(ctx).revision;
  let appended = 0;
  ctx.faults = (point) => {
    if (point === 'after-event' && ++appended === 2) throw new Error('gap interrupted');
  };
  assert.throws(() => setFeature(ctx, { name: 'changeTrail', value: true, expectedRevision }), /gap interrupted/u);
  const pending = JSON.parse(fs.readFileSync(join(ctx.root, '.cairn/settings-state.json'), 'utf8'));
  assert.ok(pending.gapPending);
  assert.equal(checkConfigDrift(open()), false);
  assert.equal(readEvents(ctx).filter(({ op }) => op === 'external.gap').length, 1);
  assert.equal(readShadow(ctx).initialized, false);
  const state = JSON.parse(fs.readFileSync(join(ctx.root, '.cairn/settings-state.json'), 'utf8'));
  assert.equal(state.gapPending, null);
  assert.equal(state.trailPending, false);
});
