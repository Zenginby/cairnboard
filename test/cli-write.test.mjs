import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import * as fs from '../core/fsx.mjs';
import { openContext } from '../core/context.mjs';
import { exportBoard } from '../core/export.mjs';
import { lockName } from '../core/lock.mjs';
import { parseFile } from '../core/frontmatter.mjs';
import { writeMany } from '../core/store.mjs';
import { readShadow, shadowBytes } from '../core/shadow.mjs';
import { readEvents } from '../core/events.mjs';
import { reconcileExternal } from '../core/changes.mjs';
import { tempDir, fixedClock, seedDataDir } from './support/env.mjs';
import { runCli, spawnCli } from './support/cli.mjs';

function fixture(t, initialized = true) {
  const home = tempDir(t), data = tempDir(t), cwd = tempDir(t);
  const clock = fixedClock('2026-11-01T12:00:00Z');
  if (initialized) seedDataDir(data, { home, env: {}, clock });
  const opts = { home, data, cwd, clock };
  const put = (path, text) => {
    fs.mkdirSync(dirname(join(data, path)), { recursive: true });
    fs.writeFileSync(join(data, path), text);
  };
  const run = (args, extra) => runCli([...args, '--actor', 'acme', '--json'], { ...opts, ...extra });
  return { ...opts, opts, put, run };
}

function tree(root, prefix = '') {
  return fs.readdirSync(join(root, prefix)).sort().flatMap((name) => {
    const path = prefix ? `${prefix}/${name}` : name;
    if (/^\.cairn\/index\.db(?:-wal|-shm|-journal)?$/u.test(path)) return [];
    const stat = fs.lstatSync(join(root, path));
    return stat.isDirectory() ? [[path], ...tree(root, path)] : [[path, fs.readFileSync(join(root, path), 'hex'), stat.mtimeMs]];
  });
}

test('export board is not an owner change', async (t) => {
  const f = fixture(t);
  const result = await f.run(['export', 'board']);
  assert.equal(result.code, 0, result.stdout);
  const ctx = openContext({ mode: 'write', dataDir: f.data, home: f.home, env: {}, clock: f.clock });
  assert.deepEqual(shadowBytes(ctx, 'board.md'), fs.readFileSync(join(f.data, 'board.md')));
  assert.equal(reconcileExternal(ctx).recorded, 0);
  assert.deepEqual(readEvents(ctx), []);
});

test('write updates shadow', async (t) => {
  const f = fixture(t);
  const added = await f.run(['note', 'add', '--title', 'Shadow']);
  assert.equal(added.code, 0, added.stdout);
  const ctx = openContext({ mode: 'read', dataDir: f.data, home: f.home, env: {}, clock: f.clock });
  assert.deepEqual(shadowBytes(ctx, added.json.data.path), fs.readFileSync(join(f.data, added.json.data.path)));
});

test('own write without shadow update is not external', async (t) => {
  const { reconcileExternal } = await import('../core/changes.mjs');
  const f = fixture(t);
  const ctx = openContext({ mode: 'write', dataDir: f.data, home: f.home, env: {}, clock: f.clock });
  reconcileExternal(ctx);
  ctx.faults = (point) => { if (point === 'after-rename') throw new Error('crashed'); };
  assert.throws(() => writeMany(ctx, { op: 'note.write', items: [
    { path: 'notes/crashed.md', apply: () => 'committed' },
  ] }), /crashed/u);
  delete ctx.faults;
  assert.equal(readShadow(ctx).entries.has('notes/crashed.md'), false);
  t.after(() => fs.__setFsHooks());
  fs.__setFsHooks({ rename(from, to) {
    if (to === join(ctx.root, '.cairn/shadow/manifest.json')) throw new Error('shadow failed');
    fs.renameSync(from, to);
  } });
  const recovered = openContext({ mode: 'write', dataDir: f.data, home: f.home, env: {}, clock: f.clock });
  fs.__setFsHooks();
  assert.equal(readShadow(recovered).entries.has('notes/crashed.md'), false);
  const count = readEvents(recovered).length;
  assert.equal(reconcileExternal(recovered).recorded, 0);
  assert.equal(readEvents(recovered).length, count);
});

test('shadow failure warns without failing a write', async (t) => {
  const f = fixture(t);
  const outside = tempDir(t);
  fs.symlinkSync(outside, join(f.data, '.cairn/shadow'), 'dir');
  const added = await f.run(['note', 'add', '--title', 'Shadow']);
  assert.equal(added.code, 0, added.stdout);
  assert.ok(added.json.warnings.includes('shadow_write_failed'));
  assert.ok(added.json.warnings.includes('reconcile_skipped'));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('cli write command records prior owner edit first', async (t) => {
  const f = fixture(t);
  const added = await f.run(['note', 'add', '--title', 'Prior']);
  f.put(added.json.data.path, fs.readFileSync(join(f.data, added.json.data.path), 'utf8') + '\nOwner edit\n');
  const updated = await f.run(['note', 'update', added.json.data.ref, '--title', 'Agent']);
  assert.equal(updated.code, 0, updated.stdout);
  const ctx = openContext({ mode: 'read', dataDir: f.data, home: f.home, env: {}, clock: f.clock });
  assert.deepEqual(readEvents(ctx).slice(-2).map(({ op }) => op), ['external.change', 'note.update']);
});

test('dry-run does not reconcile', async (t) => {
  const f = fixture(t);
  const added = await f.run(['note', 'add', '--title', 'Dry']);
  f.put(added.json.data.path, fs.readFileSync(join(f.data, added.json.data.path), 'utf8') + '\nOwner edit\n');
  const before = tree(f.data);
  const updated = await f.run(['note', 'update', added.json.data.ref, '--title', 'Preview', '--dry-run']);
  assert.equal(updated.code, 0, updated.stdout);
  assert.deepEqual(tree(f.data), before);
});

test('ordinary read commands do not reconcile or write a shadow', async (t) => {
  const f = fixture(t);
  f.put('notes/a.md', '# Read\n');
  for (const args of [['note', 'list'], ['note', 'show', '@notes/a'], ['search', 'Read'], ['home'], ['board']]) {
    const result = await f.run(args);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(fs.existsSync(join(f.data, '.cairn/shadow')), false);
  }
});

test('one CLI invocation reconciles exactly once', async (t) => {
  const f = fixture(t);
  const ctx = openContext({ mode: 'write', dataDir: f.data, home: f.home, env: {}, clock: f.clock });
  reconcileExternal(ctx);
  let manifests = 0;
  t.after(() => fs.__setFsHooks());
  fs.__setFsHooks({ afterCheck(path) {
    if (path === join(f.data, '.cairn/shadow/manifest.json')) manifests++;
  } });
  const result = await f.run(['context']);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(manifests, 1);
});

test('if-revision conflict names last actor', async (t) => {
  const f = fixture(t);
  const added = await f.run(['note', 'add', '--title', 'Conflict']);
  const item = added.json.data;
  f.put(item.path, fs.readFileSync(join(f.data, item.path), 'utf8') + '\nOwner edit\n');
  const result = await f.run(['note', 'update', item.ref, '--title', 'Stale', '--if-revision', item.revision]);
  assert.equal(result.code, 4, result.stdout);
  assert.equal(result.json.error.current.last.actor, 'owner:external');
  assert.equal(result.json.error.current.last.op, 'external.change');
  const human = await runCli(['note', 'update', item.ref, '--title', 'Stale', '--if-revision', item.revision,
    '--actor', 'acme'], f.opts);
  assert.equal(human.code, 4);
  assert.match(human.stderr, /Changed by owner:external at .* \(external.change\)\./u);
});

test('every entity write previews a revision and leaves sources and metadata untouched', async (t) => {
  const f = fixture(t);
  for (const folder of ['projects', 'cards', 'notes', 'research']) f.put(`${folder}/acme.md`, '# Acme\nBody\n');
  const before = tree(f.data);
  for (const type of ['project', 'card', 'note', 'research']) {
    const folder = type === 'research' ? type : `${type}s`;
    for (const args of [[type, 'add', '--title', 'New'], [type, 'update', `@${folder}/acme`, '--title', 'Changed'],
      [type, 'rm', `@${folder}/acme`]]) {
      const response = await f.run([...args, '--dry-run']);
      assert.equal(response.code, 0, response.stdout + response.stderr);
      assert.ok(Object.hasOwn(response.json.data, 'revision'));
      if (args[1] === 'rm') assert.equal(response.json.data.revision, null);
      if (args[1] !== 'rm') assert.match(response.json.data.revision, /^[a-f0-9]{16}$/u);
      assert.deepEqual(tree(f.data), before);
    }
  }
  for (const args of [['card', 'move', '@cards/acme', '--column', 'doing'], ['card', 'claim', '@cards/acme', '--steal'],
    ['card', 'release', '@cards/acme'], ['card', 'comment', '@cards/acme', '--body', '-'],
    ['card', 'done', '@cards/acme'], ['journal', 'add', '--title', 'Work', '--item', 'Done']]) {
    const response = await f.run([...args, '--dry-run'], { stdin: 'Progress' });
    assert.equal(response.code, 0, response.stdout);
    assert.match(response.json.data.revision, /^[a-f0-9]{16}$/u);
    assert.deepEqual(tree(f.data), before);
  }
});

test('writes require actors, CAS returns current, and live file locks return six', async (t) => {
  const f = fixture(t);
  assert.equal((await runCli(['card', 'add', '--title', 'Acme', '--json'], f.opts)).code, 2);
  const added = await f.run(['card', 'add', '--title', 'Acme']);
  assert.equal(added.code, 0, added.stdout);
  const ref = added.json.data.ref;
  const conflict = await f.run(['card', 'done', ref, '--if-revision', 'old']);
  assert.equal(conflict.code, 4);
  assert.equal(conflict.json.error.current.revision, added.json.data.revision);
  const ctx = openContext({ mode: 'write', dataDir: f.data, home: f.home, env: {}, clock: f.clock });
  const path = join(f.data, '.cairn/locks', `${lockName(added.json.data.path)}.lock`);
  fs.writeFileSync(path, JSON.stringify({ host: ctx.host, pid: ctx.pid, instance: ctx.instance, ts: f.clock.now().toISOString() }));
  const locked = await spawnCli(['card', 'update', ref, '--title', 'Changed', '--actor', 'acme', '--json'], f.opts);
  assert.equal(locked.code, 6, locked.stdout);
});

test('stdin is untouched without body flags, including an open child pipe', async (t) => {
  const f = fixture(t);
  const stdin = new Readable({ read() { throw new Error('stdin was read'); } });
  t.after(() => stdin.destroy());
  assert.equal((await f.run(['card', 'add', '--title', 'Acme'], { stdin })).code, 0);
  assert.equal(stdin.listenerCount('data'), 0);
  const child = await spawnCli(['card', 'add', '--title', 'Zorblax', '--actor', 'acme', '--json'],
    { ...f.opts, keepStdinOpen: true, timeout: 10000 });
  assert.equal(child.code, 0, child.stdout + child.stderr);
  const body = await f.run(['note', 'add', '--title', 'Body', '--body', '-'], { stdin: '🙂\nBody\n' });
  assert.equal(body.code, 0, body.stdout);
  assert.equal(parseFile(fs.readFileSync(join(f.data, body.json.data.path), 'utf8')).body, '🙂\nBody\n');
  fs.writeFileSync(join(f.cwd, 'body.md'), 'From file\n');
  const file = await f.run(['note', 'update', body.json.data.ref, '--body-file', 'body.md']);
  assert.equal(file.code, 0, file.stdout);
  assert.equal(parseFile(fs.readFileSync(join(f.data, file.json.data.path), 'utf8')).body, 'From file\n');
  for (const flags of [['--body', 'literal'], ['--body', '-', '--body-file', 'body.md']]) {
    assert.equal((await f.run(['card', 'add', '--title', 'Bad', ...flags], { stdin })).code, 2);
  }
});

test('claim confirmation, renew, release, check and done match the agent flow', async (t) => {
  const f = fixture(t);
  const body = '# Acme\r\n\u200bKeep\r\n## Acceptance\r\n- [ ] First\r\n- [ ] Second\r\n';
  f.put('cards/acme.md', body);
  const ref = '@cards/acme';
  assert.equal((await f.run(['card', 'claim', ref, '--steal'])).code, 7);
  const claimed = await f.run(['card', 'claim', ref, '--steal'], { isTTY: true, stdin: 'yes\n' });
  assert.equal(claimed.code, 0, claimed.stdout);
  assert.equal(claimed.json.data.meta.assignee, 'acme');
  assert.equal(parseFile(fs.readFileSync(join(f.data, 'cards/acme.md'), 'utf8')).body, body);
  assert.equal((await f.run(['card', 'claim', ref, '--renew'])).code, 0);
  const checked = await f.run(['card', 'check', ref, '2', '--if-revision', claimed.json.data.revision]);
  assert.equal(checked.code, 0, checked.stdout);
  assert.equal(parseFile(fs.readFileSync(join(f.data, 'cards/acme.md'), 'utf8')).body, body.replace('- [ ] Second', '- [x] Second'));
  const before = tree(f.data);
  assert.equal((await f.run(['card', 'check', ref, '1', '--dry-run'])).code, 0);
  assert.deepEqual(tree(f.data), before);
  assert.equal((await f.run(['card', 'check', ref, '2', '--uncheck'])).code, 0);
  assert.equal((await f.run(['card', 'check', ref, 'NaN'])).code, 2);
  const done = await f.run(['card', 'done', ref]);
  assert.equal(done.code, 0);
  assert.ok(done.json.warnings.includes('acceptance_open:2/2'));
  assert.equal((await f.run(['card', 'release', ref])).json.data.meta.assignee, undefined);
  assert.equal((await f.run(['project', 'rm', 'p-000000'])).code, 7);
});

test('journal preserves repeated option order and note and research fields', async (t) => {
  const f = fixture(t);
  const journal = await f.run(['journal', 'add', '--title', 'Work', '--pitfall', 'A', '--lesson', 'B', '--pitfall', 'C', '--item', 'D']);
  assert.equal(journal.code, 0, journal.stdout);
  const text = fs.readFileSync(join(f.data, journal.json.data.path), 'utf8');
  assert.match(text, /\*\*Pitfall:\*\* A\n- \*\*Lesson:\*\* B\n- \*\*Pitfall:\*\* C\n- D/u);
  const note = await f.run(['note', 'add', '--title', 'Acme', '--pin', '--kind', 'concept', '--valid-from', '2026-01-01',
    '--valid-until', '2027-01-01', '--superseded-by', 'n-000000']);
  assert.equal(note.code, 0, note.stdout);
  assert.equal(note.json.data.meta.pinned, true);
  assert.equal(note.json.data.content.superseded_by, 'n-000000');
  const research = await f.run(['research', 'add', '--title', 'Source', '--kind', 'analysis', '--date', '2026-11-01']);
  assert.equal(research.code, 0, research.stdout);
  assert.equal(research.json.data.meta.kind, 'analysis');
});

test('trash and undo preview without writes and undo has no second target', async (t) => {
  const f = fixture(t);
  const added = await f.run(['note', 'add', '--title', 'Acme']);
  const beforeUndo = tree(f.data);
  assert.equal((await f.run(['undo', '--dry-run'])).code, 0);
  assert.deepEqual(tree(f.data), beforeUndo);
  assert.equal((await f.run(['undo'])).code, 0);
  assert.equal((await f.run(['undo'])).code, 3);
  const next = await f.run(['note', 'add', '--title', 'Zorblax']);
  assert.equal((await f.run(['note', 'rm', next.json.data.ref])).code, 0);
  const listed = await f.run(['trash', 'list']);
  const id = listed.json.data.items.find((item) => item.path === next.json.data.path).trashId;
  const before = tree(f.data);
  const dry = await f.run(['trash', 'restore', id, '--dry-run']);
  assert.equal(dry.code, 0, dry.stdout);
  assert.deepEqual(tree(f.data), before);
  const restored = await f.run(['trash', 'restore', id]);
  assert.equal(restored.code, 0, restored.stdout);
  assert.equal(restored.json.data.revision, next.json.data.revision);
  assert.ok(added.json.data.id);
});

test('link finds the git root, adds one ignore line, and dry-run writes nothing', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(join(f.cwd, '.git'));
  fs.mkdirSync(join(f.cwd, 'sub'));
  fs.writeFileSync(join(f.cwd, '.gitignore'), 'dist');
  const project = await f.run(['project', 'add', '--title', 'Acme']);
  const args = ['link', project.json.data.ref, '--gitignore'];
  const before = tree(f.cwd);
  assert.equal((await f.run([...args, '--dry-run'], { cwd: join(f.cwd, 'sub') })).code, 0);
  assert.deepEqual(tree(f.cwd), before);
  assert.equal((await f.run(args)).code, 7);
  for (let n = 0; n < 2; n++) assert.equal((await f.run(args, { cwd: join(f.cwd, 'sub'), isTTY: true, stdin: 'yes\n' })).code, 0);
  assert.equal(fs.readFileSync(join(f.cwd, '.cairn'), 'utf8'), `project = ${project.json.data.id}\n`);
  assert.equal(fs.readFileSync(join(f.cwd, '.gitignore'), 'utf8'), 'dist\n.cairn\n');
  assert.equal((await f.run([...args, '--dry-run'], { cwd: f.home })).code, 5);
});

test('init preserves existing content; export board needs an actor and replaces only its own board', async (t) => {
  const f = fixture(t, false);
  f.put('keep.md', '# Keep\n');
  const before = tree(f.data);
  assert.equal((await f.run(['init', '--preset', 'tr-wiki', '--dry-run'])).code, 0);
  assert.deepEqual(tree(f.data), before);
  const initialized = await f.run(['init', '--preset', 'tr-wiki']);
  assert.equal(initialized.code, 0, initialized.stdout);
  assert.deepEqual(fs.readdirSync(f.data).sort(), ['.cairn', 'keep.md']);
  assert.equal(fs.readFileSync(join(f.data, 'keep.md'), 'utf8'), '# Keep\n');
  const ctx = openContext({ mode: 'read', dataDir: f.data, home: f.home, env: {} });
  const expected = exportBoard(ctx);
  assert.equal((await runCli(['export', 'board', '--json'], f.opts)).code, 2);
  assert.equal((await runCli(['export', 'board', '--stdout'], f.opts)).code, 0);
  const stdout = await f.run(['export', 'board', '--stdout']);
  assert.equal(stdout.code, 0, stdout.stdout);
  assert.equal(stdout.json.data, expected);
  assert.equal((await runCli(['export', 'board', '--stdout', '--actor', 'acme'], f.opts)).stdout, expected);
  const beforeExport = tree(f.data);
  assert.equal((await f.run(['export', 'board', '--dry-run'])).code, 0);
  assert.deepEqual(tree(f.data), beforeExport);
  assert.equal((await f.run(['export', 'board'])).code, 0);
  assert.equal(fs.readFileSync(join(f.data, 'board.md'), 'utf8'), expected);
  assert.equal((await f.run(['export', 'board'])).code, 0);
  // A hand-written board is never replaced.
  f.put('board.md', '---\nkanban-plugin: board\n---\n\n## Mine\n');
  const refused = await f.run(['export', 'board']);
  assert.equal(refused.code, 4);
  assert.equal(fs.readFileSync(join(f.data, 'board.md'), 'utf8'), '---\nkanban-plugin: board\n---\n\n## Mine\n');
});

test('actual entity writes return updated summaries, preserve unknown fields and use trash', async (t) => {
  const f = fixture(t);
  for (const type of ['project', 'card', 'note', 'research']) {
    const added = await f.run([type, 'add', '--title', 'Acme']);
    assert.equal(added.code, 0, added.stdout);
    const { path, ref, revision } = added.json.data;
    const text = fs.readFileSync(join(f.data, path), 'utf8');
    fs.writeFileSync(join(f.data, path), text.replace('---\n', '---\nx-extra: keep\n'));
    const shown = await f.run([type, 'show', ref]);
    const updated = await f.run([type, 'update', ref, '--title', 'Changed', '--if-revision', shown.json.data.revision]);
    assert.equal(updated.code, 0, updated.stdout);
    assert.equal(updated.json.data.path, path);
    assert.equal(updated.json.data.content.title, 'Changed');
    assert.equal(updated.json.data.content['x-extra'], 'keep');
    assert.notEqual(updated.json.data.revision, revision);
    const removed = await f.run([type, 'rm', ref], { isTTY: true, stdin: 'yes\n' });
    assert.equal(removed.code, 0, removed.stdout);
    assert.equal(removed.json.data.revision, null);
    assert.equal(fs.existsSync(join(f.data, path)), false);
    assert.ok((await f.run(['trash', 'list'])).json.data.items.some((item) => item.path === path));
  }
});

test('export refuses a symlink destination even in dry-run', async (t) => {
  const f = fixture(t), target = join(f.cwd, 'target.md');
  fs.writeFileSync(target, 'Keep\n');
  try { fs.symlinkSync(target, join(f.data, 'board.md')); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Symlinks unavailable.');
    throw error;
  }
  for (const flags of [[], ['--dry-run']]) assert.equal((await f.run(['export', 'board', ...flags])).code, 5);
  assert.equal(fs.readFileSync(target, 'utf8'), 'Keep\n');
});

test('undo returns revisions for every target of a multi-file operation', async (t) => {
  const f = fixture(t);
  const ctx = openContext({ mode: 'write', dataDir: f.data, home: f.home, env: {}, clock: f.clock, actor: 'cli:acme' });
  writeMany(ctx, { op: 'note.create', items: ['notes/acme.md', 'notes/zorblax.md'].map((path) => ({ path, apply: () => '# Work\n' })) });
  const before = tree(f.data), dry = await f.run(['undo', '--dry-run']);
  assert.equal(dry.code, 0, dry.stdout);
  assert.deepEqual(dry.json.data.items, [{ path: 'notes/acme.md', revision: null }, { path: 'notes/zorblax.md', revision: null }]);
  assert.deepEqual(tree(f.data), before);
  assert.deepEqual((await f.run(['undo'])).json.data.items, dry.json.data.items);
  assert.equal(fs.existsSync(join(f.data, 'notes/acme.md')), false);
  assert.equal(fs.existsSync(join(f.data, 'notes/zorblax.md')), false);
});

test('init resolves a relative Unicode path and preserves the original config revision', async (t) => {
  const f = fixture(t, false), name = 'Proje Notları'.normalize('NFD');
  const initialized = await f.run(['init', name, '--language', 'tr']);
  assert.equal(initialized.code, 0, initialized.stdout);
  assert.equal(initialized.json.data.path.normalize('NFC'), join(f.cwd, name).normalize('NFC'));
  const path = join(f.cwd, name, '.cairn/config.json');
  const config = JSON.parse(fs.readFileSync(path, 'utf8'));
  assert.equal(config.language, 'tr');
  fs.writeFileSync(path, JSON.stringify(config));
  const before = tree(join(f.cwd, name));
  const dry = await f.run(['init', name, '--dry-run']);
  assert.equal(dry.code, 0, dry.stdout);
  assert.deepEqual(tree(join(f.cwd, name)), before);
  assert.equal((await f.run(['init', name, '--if-revision', 'old', '--dry-run'])).code, 4);
  const again = await f.run(['init', name, '--if-revision', dry.json.data.revision]);
  assert.equal(again.code, 0, again.stdout);
  assert.equal(again.json.data.revision, dry.json.data.revision);
});

test('undo reverts only the caller\'s own latest operation', async (t) => {
  const f = fixture(t);
  assert.equal((await f.run(['card', 'add', '--title', 'Acme'])).code, 0);
  const other = await runCli(['undo', '--actor', 'bob', '--json'], f.opts);
  assert.equal(other.code, 4);
  assert.deepEqual(other.json.error.current, { actor: 'cli:acme', op: 'card.create' });
  assert.equal(fs.existsSync(join(f.data, 'cards/acme.md')), true);
  assert.equal((await f.run(['undo'])).code, 0);
  assert.equal(fs.existsSync(join(f.data, 'cards/acme.md')), false);
});

test('init records only the first default unless --set-default is confirmed', async (t) => {
  const f = fixture(t), second = join(f.cwd, 'second');
  const kept = await f.run(['init', second]);
  assert.equal(kept.code, 0);
  assert.deepEqual(kept.json.warnings, [`not_default:${f.data}`]);
  const listed = await runCli(['status', '--json'], { ...f.opts, data: undefined });
  assert.equal(listed.json.data.dataDir, fs.realpathSync(f.data));
  assert.equal((await f.run(['init', second, '--set-default'])).code, 7);
  assert.equal((await f.run(['init', second, '--set-default'], { isTTY: true, stdin: 'yes\n' })).code, 0);
});

test('dangerous commands refuse inside a coding agent even with a terminal and show their target', async (t) => {
  const f = fixture(t);
  const project = (await f.run(['project', 'add', '--title', 'Acme'])).json.data;
  for (const marker of ['CLAUDECODE', 'CODEX_SANDBOX', 'GEMINI_CLI']) {
    const refused = await f.run(['project', 'rm', project.id], { isTTY: true, stdin: 'yes\n', env: { [marker]: '1' } });
    assert.equal(refused.code, 7);
    assert.match(refused.json.error.message, /coding agent/);
  }
  const confirmed = await f.run(['project', 'rm', project.id], { isTTY: true, stdin: 'yes\n' });
  assert.equal(confirmed.code, 0);
  assert.match(confirmed.stderr, new RegExp(`Confirm project rm ${project.id} \\(data: [^)]+\\)\\?`));
});

test('body input is capped at 1 MB and bad body paths are validation errors', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(join(f.cwd, 'big.md'), 'x'.repeat(1024 * 1024 + 1));
  fs.writeFileSync(join(f.cwd, 'file'), 'x');
  assert.equal((await f.run(['card', 'add', '--title', 'Acme', '--body-file', 'big.md'])).code, 5);
  // Windows reports a path under a regular file as missing (ENOENT), POSIX as not a directory.
  assert.equal((await f.run(['card', 'add', '--title', 'Acme', '--body-file', 'file/sub'])).code, process.platform === 'win32' ? 3 : 5);
  assert.equal((await f.run(['card', 'add', '--title', 'Acme', '--body', '-'], { stdin: 'y'.repeat(1024 * 1024 + 1) })).code, 5);
  assert.equal((await f.run(['card', 'add', '--title=-1 bug'])).code, 0);
});

test('review focus 2: a frontmatter-less Obsidian card is listed, claimed and keeps its body bytes', async (t) => {
  const f = fixture(t);
  const body = '# Yeni iş\n\nMetin satırı.\n';
  f.put('cards/yeni-is.md', body);
  const listed = await runCli(['card', 'list', '--unassigned', '--column-role', 'todo', '--compact', '--json'], f.opts);
  assert.equal(listed.code, 0, listed.stdout);
  assert.deepEqual(listed.json.data.items.map((line) => line.split('\t')[0]), ['@cards/yeni-is']);
  const claimed = await f.run(['card', 'claim', '@cards/yeni-is']);
  assert.equal(claimed.code, 0, claimed.stdout);
  const text = fs.readFileSync(join(f.data, 'cards/yeni-is.md'), 'utf8');
  assert.match(text, /^---\n[\s\S]*\bid: c-[0-9a-z]{6}\n[\s\S]*---\n/u);
  assert.ok(text.endsWith(body));
});

test('review focus 4: hostile card titles stay inside the card folder and never collide', async (t) => {
  const f = fixture(t);
  const titles = ['🎉🎉', '../../etc', 'CON', 'a/b', 'x'.repeat(300), '../../etc'];
  const paths = [];
  for (const title of titles) {
    const added = await f.run(['card', 'add', '--title', title]);
    assert.equal(added.code, 0, added.stdout);
    paths.push(added.json.data.path);
  }
  assert.equal(new Set(paths).size, paths.length);
  for (const path of paths) {
    assert.match(path, /^cards\/[^/\\]+\.md$/u);
    assert.doesNotMatch(path, /^cards\/(?:con|prn|aux|nul)\.md$/iu);
    assert.ok(fs.existsSync(join(f.data, path)));
  }
  assert.equal(paths[0], 'cards/untitled.md');
});

test('card and note metadata updates reject invalid UTF-8 without changing bytes', async (t) => {
  const f = fixture(t);
  const bytes = Buffer.concat([Buffer.from('# Acme\n'), Buffer.from([0xff, 0xff]), Buffer.from('\n')]);
  for (const type of ['card', 'note']) f.put(`${type}s/acme.md`, bytes);
  for (const type of ['card', 'note']) {
    const path = `${type}s/acme.md`, absolute = join(f.data, path);
    const sha = () => createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    const before = sha();
    for (const flags of [[], ['--dry-run']]) {
      const response = await f.run([type, 'update', `@${type}s/acme`, '--title', 'Changed', ...flags]);
      assert.equal(response.code, 5, response.stdout);
      assert.equal(response.json.error.code, 'bad_encoding');
      assert.match(response.json.error.message, /convert.*UTF-8/iu);
      assert.equal(sha(), before);
    }
  }
  assert.deepEqual(fs.readdirSync(join(f.data, '.cairn/history')), []);
  assert.deepEqual(fs.readdirSync(join(f.data, '.cairn/pending')), []);
});

test('notes can be pinned and unpinned, but conflicting flags are usage errors', async (t) => {
  const f = fixture(t);
  const added = await f.run(['note', 'add', '--title', 'Acme', '--pin']);
  assert.equal(added.code, 0, added.stdout);
  assert.equal(added.json.data.meta.pinned, true);
  const ref = added.json.data.ref;
  const unpinned = await f.run(['note', 'update', ref, '--unpin']);
  assert.equal(unpinned.code, 0, unpinned.stdout);
  assert.equal(unpinned.json.data.meta.pinned, false);
  assert.equal((await f.run(['note', 'update', ref, '--pin'])).json.data.meta.pinned, true);
  assert.equal((await f.run(['note', 'add', '--title', 'Other', '--unpin'])).json.data.meta.pinned, false);
  for (const args of [['add', '--title', 'Other'], ['update', ref]]) {
    const before = tree(f.data);
    const bad = await f.run(['note', ...args, '--pin', '--unpin']);
    assert.equal(bad.code, 2, bad.stdout);
    assert.equal(bad.json.error.code, 'usage');
    assert.deepEqual(tree(f.data), before);
  }
});

test('research validity fields survive add and update and are used by lint', async (t) => {
  const f = fixture(t);
  const fields = ['--valid-from', '2026-01-01', '--valid-until', '2026-10-01', '--superseded-by', '[[missing]]'];
  const added = await f.run(['research', 'add', '--title', 'Acme', ...fields]);
  assert.equal(added.code, 0, added.stdout);
  const ref = added.json.data.ref, path = added.json.data.path;
  const lint = async () => {
    const response = await f.run(['wiki', 'lint', '--only', 'expired,superseded_missing,invalid_validity']);
    assert.equal(response.code, 0, response.stdout);
    return response.json.data.findings.filter((item) => item.path === path).map((item) => item.code).sort();
  };
  assert.equal(added.json.data.meta.valid_from, '2026-01-01');
  assert.equal(added.json.data.meta.valid_until, '2026-10-01');
  assert.equal(added.json.data.content.superseded_by, '[[missing]]');
  assert.deepEqual(await lint(), ['expired', 'superseded_missing']);
  const updated = await f.run(['research', 'update', ref, '--valid-from', '2027-01-01',
    '--valid-until', '2026-12-01', '--superseded-by', '[[acme]]']);
  assert.equal(updated.code, 0, updated.stdout);
  assert.equal(updated.json.data.meta.valid_from, '2027-01-01');
  assert.equal(updated.json.data.meta.valid_until, '2026-12-01');
  assert.equal(updated.json.data.content.superseded_by, '[[acme]]');
  assert.deepEqual(await lint(), ['invalid_validity']);
  for (const command of [['research', 'add', '--title', 'Other'], ['research', 'update', ref]]) {
    for (const option of ['--valid-from', '--valid-until']) {
      const bad = await f.run([...command, option, '2026-02-30']);
      assert.equal(bad.code, 5, bad.stdout);
      assert.equal(bad.json.error.code, 'validation');
    }
  }
});

test('card now, next and needs are one-line fields; updates keep the body and an empty value removes the field',
  async (t) => {
    const f = fixture(t);
    const body = '**Şimdi:** an old body paragraph\n\n## Acceptance\n\n- [ ] Ship it\n';
    fs.writeFileSync(join(f.cwd, 'body.md'), body);
    const added = await f.run(['card', 'add', '--title', 'Status', '--body-file', 'body.md',
      '--now', '  Writing the parser ', '--next', 'Review']);
    assert.equal(added.code, 0, added.stdout);
    const { ref, path } = added.json.data;
    const file = () => parseFile(fs.readFileSync(join(f.data, path), 'utf8'));
    assert.equal(file().data.now, 'Writing the parser', 'the value is trimmed');
    assert.equal(file().data.next, 'Review');
    assert.equal(file().data.needs, undefined);
    assert.equal(file().body, body);

    const updated = await f.run(['card', 'update', ref, '--now', 'Testing', '--needs', 'Pick a name']);
    assert.equal(updated.code, 0, updated.stdout);
    assert.deepEqual([file().data.now, file().data.next, file().data.needs], ['Testing', 'Review', 'Pick a name']);
    assert.equal(file().body, body, 'the body is untouched');

    const shown = await f.run(['card', 'show', ref]);
    assert.equal(shown.code, 0, shown.stdout);
    assert.equal(shown.json.data.content.now, 'Testing');
    assert.equal(shown.json.data.content.next, 'Review');
    assert.equal(shown.json.data.content.needs, 'Pick a name');

    for (const value of ['', '   ']) {
      const cleared = await f.run(['card', 'update', ref, '--needs', value]);
      assert.equal(cleared.code, 0, cleared.stdout);
      assert.equal(Object.hasOwn(file().data, 'needs'), false, `${JSON.stringify(value)} removes the field`);
    }
    assert.deepEqual([file().data.now, file().data.next], ['Testing', 'Review'], 'other lines stay');
    assert.equal(file().body, body);
    assert.equal((await f.run(['card', 'show', ref])).json.data.content.needs, undefined);

    const before = fs.readFileSync(join(f.data, path), 'utf8');
    for (const value of ['two\nlines', 'carriage\rreturn', 'x'.repeat(501)]) {
      const refused = await f.run(['card', 'update', ref, '--now', value]);
      assert.notEqual(refused.code, 0, JSON.stringify(value));
      assert.equal(refused.json.error.code, 'validation');
    }
    assert.equal((await f.run(['card', 'add', '--title', 'Bad', '--next', 'a\nb'])).json.error.code, 'validation');
    assert.equal(fs.readFileSync(join(f.data, path), 'utf8'), before, 'a refused value writes nothing');

    const schema = await f.run(['schema']);
    for (const field of ['now', 'next', 'needs']) assert.ok(schema.json.data.fields.card.includes(field), field);
    const help = await f.run(['card', 'update', '--help']);
    for (const option of ['now', 'next', 'needs']) assert.equal(help.json.data.options[option].type, 'string', option);
  });

test('journal jobs link to projects per section and the day keeps a one-line summary', async (t) => {
  const f = fixture(t);
  const alpha = (await f.run(['project', 'add', '--title', 'Alpha'])).json.data.id;
  const beta = (await f.run(['project', 'add', '--title', 'Beta'])).json.data.id;
  const day = 'journal/2026-11-07.md';
  const text = () => fs.readFileSync(join(f.data, day), 'utf8');
  const add = (...args) => f.run(['journal', 'add', '--date', '2026-11-07', ...args]);

  // Two projects on one day, and a job without a link.
  assert.equal((await add('--title', 'Alpha: parser', '--label', 'desk', '--project', alpha, '--item', 'One')).code, 0);
  assert.equal((await add('--title', 'Beta: docs', '--project', 'Beta', '--item', 'Two')).code, 0);
  assert.equal((await add('--title', 'Loose', '--item', 'Three')).code, 0);
  assert.equal((await add('--title', 'Alpha: parser', '--label', 'desk', '--project', alpha, '--item', 'Four')).code, 0,
    'the same project may add to its own job');
  assert.match(text(), /^## Alpha: parser · desk\n\n<!-- cairn:project p-[0-9a-z]+ -->\n\n- One\n/mu,
    'the heading line stays as it was; the link sits under it');
  assert.match(text(), /^## Beta: docs\n\n<!-- cairn:project p-[0-9a-z]+ -->\n\n- Two\n/mu);
  assert.match(text(), /^## Loose\n\n- Three\n/mu);

  let shown = (await f.run(['journal', 'show', '2026-11-07'])).json.data;
  assert.deepEqual(shown.content.sections, [
    { title: 'Alpha: parser', label: 'desk', project: alpha },
    { title: 'Beta: docs', label: null, project: beta },
    { title: 'Loose', label: null, project: null }]);
  assert.equal(shown.content.summary, undefined);

  // An unknown project and another project's job are refused without writing.
  const before = text();
  const unknown = await add('--title', 'Loose', '--project', 'p-zzzzzz', '--item', 'X');
  assert.equal(unknown.json.error.code, 'not_found');
  const other = await add('--title', 'Beta: docs', '--project', alpha, '--item', 'X');
  assert.equal(other.json.error.code, 'validation');
  assert.equal(text(), before);

  // Linking a job that had none puts the link under its heading and keeps its items.
  assert.equal((await add('--title', 'Loose', '--project', beta, '--item', 'Five')).code, 0);
  assert.match(text(), /^## Loose\n\n<!-- cairn:project p-[0-9a-z]+ -->\n\n- Three\n/mu);
  assert.equal((await f.run(['journal', 'show', '2026-11-07'])).json.data.content.sections[2].project, beta);

  // The summary: written alone, replaced, removed by an empty value; one line only.
  assert.equal((await add('--summary', 'First summary')).code, 0);
  assert.equal(parseFile(text()).data.summary, 'First summary');
  assert.equal((await add('--summary', '  Second summary ')).code, 0);
  assert.equal(parseFile(text()).data.summary, 'Second summary');
  shown = (await f.run(['journal', 'show', '2026-11-07'])).json.data;
  assert.equal(shown.content.summary, 'Second summary');
  assert.equal(shown.content.sections.length, 3, 'a summary adds no job');
  assert.equal((await add('--summary', 'a\nb')).json.error.code, 'validation');
  assert.equal((await add('--summary', '')).code, 0);
  assert.equal(Object.hasOwn(parseFile(text()).data, 'summary'), false);
  assert.equal((await add('--project', alpha)).json.error.code, 'validation', 'a link needs a job title');

  const schema = await f.run(['schema']);
  assert.deepEqual(schema.json.data.fields.journal, ['date', 'summary']);
});

test('journal days written before project links read and extend unchanged', async (t) => {
  const f = fixture(t);
  const alpha = (await f.run(['project', 'add', '--title', 'Alpha'])).json.data.id;
  const old = '---\ndate: 2026-10-20\n---\n## Alpha: old work · desk\n\n- Done a thing\n- **Karar:** kept\n\n'
    + '## Other: notes · laptop\n\n- More\n';
  f.put('journal/2026-10-20.md', old);
  const shown = await f.run(['journal', 'show', '2026-10-20']);
  assert.equal(shown.code, 0, shown.stdout);
  assert.deepEqual(shown.json.data.content.sections, [
    { title: 'Alpha: old work', label: 'desk', project: null },
    { title: 'Other: notes', label: 'laptop', project: null }]);
  assert.equal(shown.json.data.content.body, old.slice(old.indexOf('## ')));
  assert.equal((await f.run(['journal', 'add', '--date', '2026-10-20', '--title', 'New', '--project', alpha,
    '--item', 'Linked'])).code, 0);
  const after = fs.readFileSync(join(f.data, 'journal/2026-10-20.md'), 'utf8');
  assert.ok(after.startsWith(old), 'the old bytes stay as they were');
  assert.match(after.slice(old.length), /^\n?## New\n\n<!-- cairn:project p-[0-9a-z]+ -->\n\n- Linked\n$/u);
});

test('journal links are read the way they are written: fences and a leading rule do not confuse them', async (t) => {
  const f = fixture(t);
  const alpha = (await f.run(['project', 'add', '--title', 'Alpha'])).json.data.id;
  const beta = (await f.run(['project', 'add', '--title', 'Beta'])).json.data.id;
  // A fenced block first under the heading: no link is read, and linking writes one above the block.
  f.put('journal/2026-10-21.md', `---\ndate: 2026-10-21\n---\n## Work\n\n\`\`\`text\n## not a job\n\`\`\`\n`
    + `<!-- cairn:project ${alpha} -->\n\n- Item\n`);
  const show = async (date) => (await f.run(['journal', 'show', date])).json.data.content.sections;
  assert.deepEqual(await show('2026-10-21'), [{ title: 'Work', label: null, project: null }]);
  assert.equal((await f.run(['journal', 'add', '--date', '2026-10-21', '--title', 'Work', '--project', beta,
    '--item', 'More'])).code, 0);
  assert.deepEqual(await show('2026-10-21'), [{ title: 'Work', label: null, project: beta }]);
  // A body that starts with a thematic break still lists its jobs.
  f.put('journal/2026-10-22.md',
    `---\ndate: 2026-10-22\n---\n---\n\n## Work\n\n<!-- cairn:project ${alpha} -->\n\n- A\n`);
  assert.deepEqual(await show('2026-10-22'), [{ title: 'Work', label: null, project: alpha }]);
});

test('research category is a one-line optional field; an empty value on update removes it', async (t) => {
  const f = fixture(t);
  const body = 'Source summary.\n\n## Notes\n\n- one\n';
  fs.writeFileSync(join(f.cwd, 'body.md'), body);
  const added = await f.run(['research', 'add', '--title', 'Sample source', '--body-file', 'body.md',
    '--category', '  Review  ', '--tag', 'alpha']);
  assert.equal(added.code, 0, added.stdout);
  const { ref, path } = added.json.data;
  const file = () => parseFile(fs.readFileSync(join(f.data, path), 'utf8'));
  assert.equal(file().data.category, 'Review', 'the value is trimmed');
  assert.equal(file().body, body);
  const shown = await f.run(['research', 'show', ref]);
  assert.equal(shown.json.data.content.category, 'Review');
  const listed = await f.run(['research', 'list']);
  assert.equal(listed.json.data.items.find((item) => item.ref === ref).content.category, 'Review');
  const plain = await runCli(['research', 'show', ref, '--actor', 'acme'], f.opts);
  assert.match(plain.stdout, /^category: Review$/mu);

  const updated = await f.run(['research', 'update', ref, '--category', 'Query']);
  assert.equal(updated.code, 0, updated.stdout);
  assert.equal(file().data.category, 'Query');
  assert.deepEqual(file().data.tags, ['alpha']);
  assert.equal(file().body, body);
  for (const value of ['', '   ']) {
    await f.run(['research', 'update', ref, '--category', 'Again']);
    const cleared = await f.run(['research', 'update', ref, '--category', value]);
    assert.equal(cleared.code, 0, cleared.stdout);
    assert.equal(Object.hasOwn(file().data, 'category'), false, `${JSON.stringify(value)} removes the field`);
  }
  assert.deepEqual(file().data.tags, ['alpha']);
  assert.equal(file().body, body);

  await f.run(['research', 'update', ref, '--category', 'Keep']);
  const before = fs.readFileSync(join(f.data, path), 'utf8');
  for (const value of ['x'.repeat(101), 'two\nlines', 'tab\there']) {
    const refused = await f.run(['research', 'update', ref, '--category', value]);
    assert.equal(refused.json.error.code, 'validation', JSON.stringify(value));
  }
  assert.equal((await f.run(['research', 'add', '--title', 'Long', '--category', 'x'.repeat(101)])).json.error.code,
    'validation');
  assert.equal((await f.run(['research', 'add', '--title', 'Blank', '--category', '   '])).json.error.code,
    'validation');
  assert.equal((await f.run(['research', 'add', '--title', 'Ok', '--category', 'x'.repeat(100)])).code, 0);
  assert.equal(fs.readFileSync(join(f.data, path), 'utf8'), before, 'a refused value writes nothing');

  for (const args of [['note', 'add', '--title', 'N'], ['card', 'add', '--title', 'C']]) {
    const refused = await f.run([...args, '--category', 'Review']);
    assert.notEqual(refused.code, 0, args[0]);
  }
  const schema = await f.run(['schema']);
  assert.ok(schema.json.data.fields.research.includes('category'));
});

test('the tr-wiki layout stores a research category as kategori and reads it back', async (t) => {
  const f = fixture(t, false);
  assert.equal((await f.run(['init', '--preset', 'tr-wiki'])).code, 0);
  const added = await f.run(['research', 'add', '--title', 'Örnek kaynak', '--category', 'Proje araştırması']);
  assert.equal(added.code, 0, added.stdout);
  const text = fs.readFileSync(join(f.data, added.json.data.path), 'utf8');
  assert.match(text, /^kategori: /mu);
  assert.doesNotMatch(text, /^category:/mu);
  const shown = await f.run(['research', 'show', added.json.data.ref]);
  assert.equal(shown.json.data.content.category, 'Proje araştırması');
});

test('a research record without a category reads unchanged', async (t) => {
  const f = fixture(t);
  const added = await f.run(['research', 'add', '--title', 'Plain']);
  const shown = await f.run(['research', 'show', added.json.data.ref]);
  assert.equal(Object.hasOwn(shown.json.data.content, 'category'), false);
  assert.equal(Object.hasOwn(parseFile(fs.readFileSync(join(f.data, added.json.data.path), 'utf8')).data, 'category'),
    false);
});
