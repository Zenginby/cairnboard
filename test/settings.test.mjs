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
import { checkConfigDrift, clearShadow, readSettings, setFeature, setHomeProjects,
  setLanguage } from '../core/settings.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { runCli } from './support/cli.mjs';
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
  return { ctx, home, open, put, editConfig, set, blobs };
}

test('feature defaults and validation preserve the existing format', (t) => {
  const { ctx, editConfig } = fixture(t);
  const defaults = { changeTrail: true, changeContent: true, liveUpdates: true, mentions: true };
  assert.deepEqual(features({}), defaults);
  assert.deepEqual(readSettings(ctx), { features: defaults, language: 'en', leaseMinutes: 120,
    columns: [['backlog', 'Backlog', 'todo'], ['doing', 'Doing', 'doing'], ['review', 'Review', 'doing'],
      ['done', 'Done', 'done']].map(([key, label, role]) => ({ key, label, role, hidden: false })),
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

test('the language write is conditional, audited by code only and is not seen as a hand edit', (t) => {
  const { ctx, editConfig, set, open } = fixture(t);
  editConfig({ lint: { orphan: 'off' }, home: { hiddenProjects: ['p-000001'] }, schema: ctx.schema });
  set('mentions', false);
  const before = loadConfig(ctx.root), initial = readSettings(ctx);
  const file = join(ctx.root, '.cairn/config.json');
  const bytes = fs.readFileSync(file), events = readEvents(ctx).length;
  assert.equal(initial.language, 'en');

  // Writing the current value changes nothing and logs nothing.
  assert.deepEqual(setLanguage(ctx, { language: 'en', expectedRevision: initial.revision }),
    { changed: false, revision: initial.revision });
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(readEvents(ctx).length, events);

  for (const language of ['de', 'TR', '', 'tr ', null, undefined, true, ['tr'], { tr: 1 }]) {
    assert.throws(() => setLanguage(ctx, { language, expectedRevision: initial.revision }), { code: 'validation' });
  }
  assert.throws(() => setLanguage(ctx, { language: 'tr', expectedRevision: '0123456789abcdef' }),
    { code: 'conflict' });
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(readEvents(ctx).length, events);

  const changed = setLanguage(ctx, { language: 'tr', expectedRevision: initial.revision, actor: 'web:owner' });
  assert.equal(changed.changed, true);
  assert.equal(changed.revision, revision(fs.readFileSync(file)));
  assert.notEqual(changed.revision, initial.revision);
  assert.deepEqual(loadConfig(ctx.root), { ...before, language: 'tr' }, 'unrelated fields are preserved');
  assert.equal(ctx.config.language, 'tr');
  const event = readEvents(ctx).at(-1);
  assert.equal(readEvents(ctx).length, events + 1);
  const { tx, seq, ...logged } = event;
  assert.match(tx, /^s-/u);
  assert.deepEqual(logged, { v: 1, ts: ctx.clock.now().toISOString(), actor: 'web:owner', op: 'config.change',
    target: '.cairn/config.json', rev: changed.revision, fields: ['language'],
    features: { changeTrail: true, changeContent: true, liveUpdates: true, mentions: false } });

  // Our own write keeps the stored revision in step: neither a drift check nor a read logs a hand edit.
  assert.equal(checkConfigDrift(open()), false);
  const after = readSettings(open());
  assert.equal(after.language, 'tr');
  assert.equal(after.revision, changed.revision);
  assert.deepEqual(after.lastChange, initial.lastChange, 'the last feature change line is left as it was');
  assert.equal(readEvents(ctx).length, events + 1);
  assert.equal(readEvents(ctx).some(({ op }) => op === 'config.external'), false);
  assert.equal(ctx.warnings?.includes('settings_state_rebuilt') ?? false, false, 'the stored state stays valid');

  // The old revision no longer works; a feature write on the new one does, and the language survives it.
  assert.throws(() => setLanguage(ctx, { language: 'en', expectedRevision: initial.revision }), { code: 'conflict' });
  set('mentions', true);
  assert.equal(loadConfig(ctx.root).language, 'tr');
  assert.equal(setLanguage(ctx, { language: 'en', expectedRevision: readSettings(ctx).revision }).changed, true);
  assert.equal(readEvents(ctx).at(-1).actor, ctx.actor, 'the actor defaults to the context actor');
  assert.equal(readEvents(ctx).some(({ op }) => op === 'config.external'), false);
});

test('the language write waits for the config lock and survives a rebuilt settings state', (t) => {
  const { ctx, put, open } = fixture(t);
  const initial = readSettings(ctx);
  const lockPath = join(ctx.root, '.cairn/locks/_config.lock');
  put('.cairn/locks/_config.lock', JSON.stringify({ host: ctx.host, pid: ctx.pid, instance: 'holder',
    ts: ctx.clock.now().toISOString() }));
  assert.throws(() => setLanguage(ctx, { language: 'tr', expectedRevision: initial.revision }), { code: 'locked' });
  fs.rmSync(lockPath);
  assert.equal(loadConfig(ctx.root).language, 'en');
  const changed = setLanguage(ctx, { language: 'tr', expectedRevision: initial.revision });
  // A lost state file is rebuilt from the events; the language event alone must not turn into a hand edit.
  fs.rmSync(join(ctx.root, '.cairn/settings-state.json'));
  const fresh = open();
  assert.equal(checkConfigDrift(fresh), false);
  assert.equal(readSettings(fresh).revision, changed.revision);
  assert.equal(readEvents(fresh).some(({ op }) => op === 'config.external'), false);
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
  // A hand edit to another audited field is recorded by name only, and leaves the feature line as it was.
  const lastChange = readSettings(open()).lastChange;
  editConfig({ language: 'tr' });
  assert.equal(checkConfigDrift(open()), true);
  assert.equal(readEvents(ctx).length, 3);
  const edited = readEvents(ctx).at(-1);
  assert.deepEqual([edited.op, edited.actor, edited.fields, edited.changed, edited.after],
    ['config.external', 'owner:external', ['language'], undefined, undefined]);
  assert.deepEqual(readSettings(open()).lastChange, lastChange);
  assert.equal(readEvents(ctx).length, 3);
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
  const pending = setFeature(ctx, { name: 'changeTrail', value: true, expectedRevision });
  assert.equal(pending.changed, true);
  assert.deepEqual(pending.warnings, ['trail_sync_pending']);
  assert.equal(features(loadConfig(ctx.root)).changeTrail, true);
  assert.equal(JSON.parse(fs.readFileSync(join(ctx.root, '.cairn/settings-state.json'), 'utf8')).trailPending, true);
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
  const interrupted = setFeature(ctx, { name: 'changeTrail', value: true, expectedRevision });
  assert.equal(interrupted.changed, true);
  assert.deepEqual(interrupted.warnings, ['trail_sync_pending']);
  const pending = JSON.parse(fs.readFileSync(join(ctx.root, '.cairn/settings-state.json'), 'utf8'));
  assert.ok(pending.gapPending);
  assert.equal(pending.trailPending, true);
  assert.equal(checkConfigDrift(open()), false);
  assert.equal(readEvents(ctx).filter(({ op }) => op === 'external.gap').length, 1);
  assert.equal(readShadow(ctx).initialized, false);
  const state = JSON.parse(fs.readFileSync(join(ctx.root, '.cairn/settings-state.json'), 'utf8'));
  assert.equal(state.gapPending, null);
  assert.equal(state.trailPending, false);
});

test('corrupt shadow manifest does not block readSettings, setFeature or clearShadow', (t) => {
  const { ctx, open, put, set, blobs } = fixture(t);
  put('notes/a.md', 'alpha');
  reconcileExternal(ctx);
  assert.equal(blobs().length, 1);
  const manifestFile = join(ctx.root, '.cairn/shadow/manifest.json');
  for (const broken of ['{broken', JSON.stringify({
    v: 1, initialized: true, entries: { '../escape.md': { rev: revision('x'), blob: false } },
  })]) {
    fs.writeFileSync(manifestFile, broken);
    const opened = [];
    t.after(() => fs.__setFsHooks());
    fs.__setFsHooks({ openSync(path, ...args) {
      opened.push(String(path).replace(/\\/gu, '/'));
      return openSync(path, ...args);
    } });
    const shown = readSettings(open());
    fs.__setFsHooks();
    assert.deepEqual(shown.shadow, { blobs: 1, bytes: 5 });
    assert.equal(opened.some((path) => path.endsWith('/shadow/manifest.json')), false);
  }
  fs.writeFileSync(manifestFile, '{broken');
  const rev = readSettings(ctx).revision;
  const disabled = setFeature(ctx, { name: 'changeTrail', value: false, expectedRevision: rev });
  assert.equal(disabled.changed, true);
  assert.deepEqual(disabled.warnings, ['trail_sync_pending']);
  assert.equal(features(loadConfig(ctx.root)).changeTrail, false);
  assert.equal(JSON.parse(fs.readFileSync(join(ctx.root, '.cairn/settings-state.json'), 'utf8')).trailPending, true);
  assert.equal(readEvents(ctx).at(-1).op, 'config.change');
  assert.equal(readSettings(open()).features.changeTrail, false);

  assert.deepEqual(clearShadow(ctx), { blobs: 1, bytes: 5 });
  assert.deepEqual(blobs(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestFile, 'utf8')), { v: 1, initialized: false, entries: {} });
  const clearedEvent = readEvents(ctx).at(-1);
  assert.equal(clearedEvent.op, 'shadow.clear');
  assert.equal(clearedEvent.manifestReset, true);
  assert.equal(clearedEvent.historyCleared, 0);

  // clearShadow left the repaired manifest intact; the next drift check and reopen finish cleanly with one gap.
  assert.equal(checkConfigDrift(open()), false);
  set('changeTrail', true);
  assert.equal(reconcileExternal(ctx).baseline, true);
  assert.equal(readEvents(ctx).filter(({ op }) => op === 'external.gap').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(join(ctx.root, '.cairn/settings-state.json'), 'utf8')).trailPending, false);
});

test('clearShadow scrubs external.change history, keeps undo history and respects changeContent: false', (t) => {
  const { ctx, put, set } = fixture(t);
  const own = write(ctx, { op: 'note.write', path: 'notes/own.md', apply: () => 'own after' });
  const ownFile = join(ctx.root, `.cairn/history/${readEvents(ctx).find((e) => e.seq === own.seq).tx}.json`);
  const ownBefore = fs.readFileSync(ownFile, 'utf8');

  put('notes/a.md', 'secret v1\n');
  put('notes/bin.md', Buffer.from([0xff, 0xfe]));
  reconcileExternal(ctx);
  put('notes/a.md', 'secret v2\n');
  put('notes/bin.md', 'after bin\n');
  put('notes/created.md', 'created text\n');
  assert.equal(reconcileExternal(ctx).recorded, 3);

  set('changeContent', false);
  put('notes/a.md', 'secret v3\n');
  assert.equal(reconcileExternal(ctx).recorded, 1);
  const offEvent = readEvents(ctx).filter(({ op }) => op === 'external.change').at(-1);
  const offRaw = fs.readFileSync(join(ctx.root, `.cairn/history/${offEvent.tx}.json`), 'utf8');
  assert.equal(offRaw.includes('secret v2'), false);
  assert.equal(JSON.parse(offRaw).before, null);
  assert.equal(JSON.parse(offRaw).beforeBytes, undefined);

  clearShadow(ctx);
  const clearEvent = readEvents(ctx).at(-1);
  assert.equal(clearEvent.op, 'shadow.clear');
  assert.equal(clearEvent.historyCleared, 4);
  assert.equal(fs.readFileSync(ownFile, 'utf8'), ownBefore);

  const extEvents = readEvents(ctx).filter(({ op }) => op === 'external.change');
  assert.equal(extEvents.length, 4);
  for (const ev of extEvents) {
    assert.deepEqual(changeDiff(ctx, ev), { diff: null, reason: 'content_not_kept' });
    const raw = fs.readFileSync(join(ctx.root, `.cairn/history/${ev.tx}.json`), 'utf8');
    assert.equal(raw.includes('secret v1'), false);
    assert.equal(raw.includes('secret v2'), false);
    const saved = JSON.parse(raw);
    assert.equal(Object.hasOwn(saved, 'before'), false);
    assert.equal(Object.hasOwn(saved, 'beforeBytes'), false);
    assert.equal(saved.beforeUnavailable, true);
    assert.equal(Object.hasOwn(saved.items[0], 'before'), false);
    assert.equal(Object.hasOwn(saved.items[0], 'beforeBytes'), false);
    assert.equal(saved.items[0].beforeUnavailable, true);
  }
  clearShadow(ctx);
  assert.equal(readEvents(ctx).at(-1).historyCleared, 0);
});

test('writes while changeTrail is off store no shadow blobs', async (t) => {
  const { ctx, home, put, set, blobs } = fixture(t);
  put('notes/existing.md', 'keep');
  reconcileExternal(ctx);
  const before = blobs();
  set('changeTrail', false);

  write(ctx, { op: 'note.write', path: 'notes/direct.md', apply: () => 'direct while off' });
  const added = await runCli(['note', 'add', '--title', 'Quiet Note', '--actor', 'owner', '--json'], {
    home, data: ctx.root, clock: ctx.clock,
  });
  assert.equal(added.code, 0, added.stdout + added.stderr);
  assert.deepEqual(blobs(), before);
  assert.equal(readShadow(ctx).entries.get(added.json.data.path.replace(/\\/gu, '/')).blob, false);
});

test('Home project writes store hidden ids, keep unlisted hidden ones, are conditional and audited', (t) => {
  const { ctx, editConfig, put } = fixture(t);
  // Hidden ids that name no project are dropped on a write, so the projects exist.
  for (const id of ['p-000001', 'p-000003', 'p-000009']) {
    put(`projects/${id}.md`, `---\nid: ${id}\ntitle: ${id}\n---\n`);
  }
  editConfig({ home: { featuredProject: 'p-000001', hiddenProjects: ['p-000009'] }, lint: { orphan: 'off' } });
  const before = loadConfig(ctx.root), initial = readSettings(ctx);
  const changed = setHomeProjects(ctx, { listed: ['P-OOOOO1', 'p-000002', 'p-000003'], shown: ['p-000002'],
    expectedRevision: initial.revision });
  assert.equal(changed.changed, true);
  assert.deepEqual(loadConfig(ctx.root), { ...before, home: { featuredProject: 'p-000001',
    hiddenProjects: ['p-000009', 'p-000001', 'p-000003'] } }, 'the unlisted p-000009 stays hidden');
  const events = readEvents(ctx);
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].op, events[0].fields, events[0].rev, events[0].actor],
    ['config.change', ['home.hiddenProjects'], changed.revision, ctx.actor]);
  assert.deepEqual([events[0].hiddenBefore, events[0].hidden], [undefined, undefined], 'no ids in the event');
  // The settings state learned the revision: reading settings records no external change.
  assert.equal(readSettings(ctx).revision, changed.revision);
  assert.equal(checkConfigDrift(ctx), false);
  assert.equal(readEvents(ctx).length, 1);
  assert.deepEqual(setHomeProjects(ctx, { listed: ['p-000001'], shown: [], expectedRevision: changed.revision }),
    { changed: false, revision: changed.revision });
  const shownAll = setHomeProjects(ctx, { listed: ['p-000001', 'p-000003', 'p-000009'],
    shown: ['p-000001', 'p-000003', 'p-000009'], expectedRevision: changed.revision });
  assert.deepEqual(loadConfig(ctx.root).home.hiddenProjects, []);
  assert.throws(() => setHomeProjects(ctx, { listed: ['p-000001'], shown: [], expectedRevision: changed.revision }),
    { code: 'conflict' });
  const tooMany = Array.from({ length: 201 }, (_, i) => `p-${String(i).padStart(6, '0')}`);
  for (const [listed, shown] of [[null, []], ['p-000001', []], [['bad id'], []], [[7], []], [tooMany, []],
    [['p-000001'], ['p-000002']], [['p-000001'], null]]) {
    assert.throws(() => setHomeProjects(ctx, { listed, shown, expectedRevision: shownAll.revision }),
      { code: 'validation' });
  }
  assert.equal(readEvents(ctx).length, 2);
});

test('a Home project write drops hidden ids that are invalid or name a deleted project', (t) => {
  const { ctx, editConfig, put } = fixture(t);
  put('projects/paused.md', '---\nid: p-000007\ntitle: Paused\nstatus: paused\n---\n');
  editConfig({ home: { hiddenProjects: ['not an id', 'p-000008', 'p-000007'] } });
  setHomeProjects(ctx, { listed: ['p-000001'], shown: [], expectedRevision: readSettings(ctx).revision });
  assert.deepEqual(loadConfig(ctx.root).home.hiddenProjects, ['p-000007', 'p-000001'],
    'the paused project stays hidden; the invalid and deleted ids go');
});

test('home.hiddenProjects is checked only inside a home object; earlier hand-written home values still load', (t) => {
  const { ctx, editConfig } = fixture(t);
  for (const home of [{ hiddenProjects: 'p-000001' }, { hiddenProjects: [1] }, { hiddenProjects: ['x'.repeat(65)] },
    { hiddenProjects: Array.from({ length: 201 }, () => 'p-000001') }]) {
    editConfig({ home });
    assert.throws(() => loadConfig(ctx.root), { code: 'validation' }, JSON.stringify(home).slice(0, 60));
    fs.writeFileSync(join(ctx.root, '.cairn/config.json'), JSON.stringify(ctx.config));
  }
  for (const home of [null, 'x', [], { featuredProject: 7 }, { hiddenProjects: ['p-000001'] }]) {
    editConfig({ home });
    assert.deepEqual(loadConfig(ctx.root).home, home);
  }
  // A write over a non-object home replaces it with an object.
  editConfig({ home: 'x' });
  setHomeProjects(ctx, { listed: ['p-000001'], shown: [], expectedRevision: readSettings(ctx).revision });
  assert.deepEqual(loadConfig(ctx.root).home, { hiddenProjects: ['p-000001'] });
});

test('Home project writes detect an external edit before atomic replacement', (t) => {
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
  assert.throws(() => setHomeProjects(ctx, { listed: ['p-000001'], shown: [], expectedRevision: initial.revision }),
    { code: 'conflict' });
  assert.equal(loadConfig(ctx.root).home, undefined);
  assert.deepEqual(readEvents(ctx), []);
});
