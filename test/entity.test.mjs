import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import * as fs from '../core/fsx.mjs';
import { openContext } from '../core/context.mjs';
import { readFile, revision } from '../core/store.mjs';
import { readEvents } from '../core/events.mjs';
import { refresh } from '../core/index.mjs';
import { parseFile } from '../core/frontmatter.mjs';
import { create, update, remove, resolve, list, validatePriority } from '../core/entity.mjs';
import * as project from '../core/project.mjs';
import * as research from '../core/research.mjs';
import { fixedClock, seedDataDir, tempDir } from './support/env.mjs';

function fixture(t) {
  const root = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  seedDataDir(root, { home, env: {}, clock });
  return openContext({ mode: 'write', dataDir: root, home, env: {}, clock, actor: 'agent:acme' });
}

function put(ctx, path, text) {
  fs.mkdirSync(dirname(join(ctx.root, path)), { recursive: true });
  fs.writeFileSync(join(ctx.root, path), text);
  refresh(ctx);
}

function snapshot(ctx) {
  return fs.readdirSync(ctx.root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('index.db'))
    .map((entry) => [join(entry.parentPath, entry.name), fs.readFileSync(join(entry.parentPath, entry.name), 'hex')]);
}

test('entity creation returns canonical summaries, defaults, unique paths and store events', (t) => {
  const ctx = fixture(t);
  const first = project.create(ctx, { title: 'Acme' }, '## Acceptance\n- [x] Done\n- [ ] Next\n');
  assert.equal(first.entity.path, 'projects/acme.md');
  assert.match(first.entity.id, /^p-[a-z0-9]{6}$/u);
  assert.equal(first.entity.data.status, 'active');
  assert.equal(first.entity.data.tone, 1);
  assert.equal(first.entity.data.created, ctx.clock.now().toISOString());
  assert.equal(first.entity.data.updated, first.entity.data.created);
  assert.deepEqual(first.entity.acceptance, { done: 1, total: 2 });
  assert.equal(first.entity.revision, first.revision);
  assert.equal(Object.hasOwn(first.entity, 'body'), false);
  assert.equal(project.create(ctx, { title: 'Acme' }).entity.path, 'projects/acme-2.md');
  assert.equal(project.list(ctx).find(({ path }) => path === 'projects/acme-2.md').data.tone, 2);
  assert.equal(project.show(ctx, first.entity.id.toUpperCase()).body, '## Acceptance\n- [x] Done\n- [ ] Next\n');
  const source = research.create(ctx, { title: 'Source' }).entity;
  assert.equal(source.data.kind, 'source');
  assert.match(source.data.date, /^2026-11-0[12]$/u);
  assert.match(source.id, /^r-/u);
  assert.deepEqual(readEvents(ctx).map(({ op }) => op), ['project.create', 'project.create', 'research.create']);
  for (const item of list(ctx, 'project')) {
    assert.equal(Object.hasOwn(item, 'body'), false);
    assert.equal(item.revision, readFile(ctx, item.path).revision);
  }
  project.update(ctx, first.entity.id, { status: 'paused', tone: 8 });
  assert.equal(project.show(ctx, first.entity.id).data.status, 'paused');
  assert.throws(() => project.update(ctx, first.entity.id, { tone: 9 }), { code: 'validation' });
  research.update(ctx, source.id, { kind: 'analysis', date: '2026-02-28' });
  assert.equal(research.show(ctx, source.id).kind, 'analysis');
  assert.throws(() => research.update(ctx, source.id, { date: '2026-02-29' }), { code: 'validation' });
});

test('hostile titles stay in the destination and reserve unindexed names', (t) => {
  const ctx = fixture(t);
  for (const [title, slug] of [['😀', 'untitled'], ['../../etc', 'etc'], ['CON', 'con-x'], ['a/b', 'a-b'], ['a'.repeat(300), 'a'.repeat(60)]]) {
    assert.equal(create(ctx, 'note', { title }).entity.path, `notes/${slug}.md`);
  }
  put(ctx, 'notes/ACME.md', '# Manual');
  assert.equal(create(ctx, 'note', { title: 'Acme' }).path, 'notes/acme-2.md');
});

test('manual note updates preserve their key, unrelated bytes and body', (t) => {
  const ctx = fixture(t);
  const before = '\uFEFF---\r\n# keep\r\ntitle: Old # inline\r\nx-extra: "acme"\r\ncustom: [a, b]\r\n---\r\n# Body\r\nİş 😀\r\n';
  put(ctx, 'notes/manual.md', before);
  const manual = resolve(ctx, 'note', '@notes/manual');
  assert.equal(manual.id, null);
  assert.equal(manual.revision, revision(before));
  ctx.clock.advance(1000);
  const changed = update(ctx, 'note', '@notes/manual', { title: 'New' }, { ifRevision: manual.revision });
  const after = readFile(ctx, manual.path).text;
  assert.ok(after.startsWith('\uFEFF---\r\n# keep\r\ntitle: New # inline\r\nx-extra: "acme"\r\ncustom: [a, b]\r\n'));
  assert.equal(parseFile(after).body, parseFile(before).body);
  assert.equal(resolve(ctx, 'note', manual.ref).id, null);
  assert.doesNotMatch(after, /^id:/mu);
  assert.equal(changed.revision, revision(after));
  assert.throws(() => update(ctx, 'note', '@notes/manual', { title: 'Lost' }, { ifRevision: manual.revision }), { code: 'conflict' });
  update(ctx, 'note', '@notes/manual', {}, { body: '# Replacement\n' });
  assert.equal(resolve(ctx, 'note', '@notes/manual').body, '# Replacement\n');
  assert.throws(() => resolve(ctx, 'project', '@notes/manual'), { code: 'not_found' });
  assert.throws(() => resolve(ctx, 'note', 'missing'), { code: 'not_found' });
});

test('duplicate ids warn on either read selector and block all mutations', (t) => {
  const ctx = fixture(t);
  for (const path of ['notes/a.md', 'notes/b.md']) put(ctx, path, '---\nid: n-acme12\n---\n# Acme\n');
  ctx.warnings.push('index_unavailable');
  for (const ref of ['n-acme12', '@notes/b']) {
    assert.deepEqual(resolve(ctx, 'note', ref).warnings, ['duplicate_id']);
    assert.throws(() => update(ctx, 'note', ref, { title: 'New' }), { code: 'duplicate_id' });
    assert.throws(() => remove(ctx, 'note', ref), { code: 'duplicate_id' });
  }
  assert.ok(list(ctx, 'note').every((item) => item.warnings.join() === 'duplicate_id'));
});

test('creation retries a generated id that is already in use', (t) => {
  const ctx = fixture(t);
  put(ctx, 'notes/manual.md', '---\nid: n-000000\n---\n# Manual\n');
  const script = `
    import crypto from 'node:crypto';
    import { syncBuiltinESMExports } from 'node:module';
    import { openContext } from './core/context.mjs';
    import { fixedClock } from './core/clock.mjs';
    let count = 0;
    crypto.webcrypto.getRandomValues = (array) => array.fill(count++);
    syncBuiltinESMExports();
    const { create } = await import('./core/note.mjs');
    const ctx = openContext({ mode: 'write', dataDir: process.env.CAIRN_DATA, home: process.env.HOME,
      env: {}, clock: fixedClock('2026-11-01T12:00:00Z') });
    console.log(create(ctx, { title: 'Acme' }).entity.id);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: tempDir(t), CAIRN_DATA: ctx.root }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'n-111111');
});

test('validation rejects invalid values before writing', (t) => {
  const ctx = fixture(t);
  for (const [type, fields] of [
    ['note', { title: ' ' }], ['note', { pinned: 'yes' }], ['note', { kind: 'source' }],
    ['project', { status: 'done' }], ['project', { tone: 0 }], ['project', { tone: 1.5 }],
    ['research', { kind: 'tool' }], ['research', { date: '2026-02-30' }],
    ['note', { valid_from: 'yesterday' }], ['note', { valid_until: '2026-13-01' }],
  ]) assert.throws(() => create(ctx, type, { title: 'Acme', ...fields }), { code: 'validation' });
  for (const priority of ['urgent', 'important', 'low']) assert.doesNotThrow(() => validatePriority(priority));
  for (const priority of ['high', null, 1]) assert.throws(() => validatePriority(priority), { code: 'validation' });
  assert.deepEqual(readEvents(ctx), []);
});

test('dry-run mutations take no locks, preserve sources and return the store result', (t) => {
  const ctx = fixture(t);
  const saved = create(ctx, 'note', { title: 'Acme' }).entity;
  const before = snapshot(ctx);
  for (const preview of [{ ...ctx, mode: 'dry-run' }, { ...ctx, mode: 'read' }]) {
    const opts = preview.mode === 'read' ? { dryRun: true } : {};
    assert.equal(create(preview, 'project', { title: 'Preview' }, '', opts).dryRun, true);
    assert.equal(update(preview, 'note', saved.id, { title: 'Preview' }, opts).dryRun, true);
    assert.equal(remove(preview, 'note', saved.id, opts).dryRun, true);
  }
  assert.deepEqual(snapshot(ctx), before);
  assert.deepEqual(fs.readdirSync(join(ctx.root, '.cairn/locks')), []);
  const result = remove(ctx, 'note', saved.id, { ifRevision: saved.revision });
  assert.equal(result.revision, null);
  assert.equal(readFile(ctx, saved.path), null);
  assert.equal(readEvents(ctx).at(-1).op, 'note.delete');
  assert.equal(fs.readdirSync(join(ctx.root, '.cairn/trash')).length, 2);
});

test('concurrent creators choose separate paths under the directory lock', async (t) => {
  const ctx = fixture(t);
  const script = `
    import { openContext } from './core/context.mjs';
    import { fixedClock } from './core/clock.mjs';
    import { create } from './core/note.mjs';
    const ctx = openContext({ mode: 'write', dataDir: process.env.CAIRN_DATA, home: process.env.HOME,
      env: {}, clock: fixedClock('2026-11-01T12:00:00Z') });
    process.stdout.write('ready\\n');
    process.stdin.once('data', () => {
      console.log(create(ctx, { title: 'Acme' }).path);
      process.stdin.destroy();
    });
  `;
  const children = Array.from({ length: 2 }, () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HOME: tempDir(t), CAIRN_DATA: ctx.root }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stdout = '', stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const ready = new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.includes('ready\n')) resolve(); });
      child.once('error', reject);
      child.once('exit', () => reject(new Error(stderr || 'Child exited before ready.')));
    });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve(stdout.trim().split('\n').at(-1)) : reject(new Error(stderr)));
    });
    return { child, ready, done };
  });
  await Promise.all(children.map(({ ready }) => ready));
  for (const { child } of children) child.stdin.end('go');
  assert.deepEqual((await Promise.all(children.map(({ done }) => done))).sort(), ['notes/acme-2.md', 'notes/acme.md']);
  refresh(ctx);
  assert.equal(new Set(list(ctx, 'note').map(({ id }) => id)).size, 2);
  assert.equal(readEvents(ctx).length, 2);
});

test('updates cannot rewrite the id or creation time', (t) => {
  const ctx = fixture(t);
  const { entity } = project.create(ctx, { title: 'Acme' });
  for (const patch of [{ id: 'p-000000' }, { created: '2020-01-01T00:00:00.000Z' }]) {
    assert.throws(() => project.update(ctx, entity.id, patch), { code: 'validation' });
  }
  assert.equal(project.show(ctx, entity.id).id, entity.id);
});
