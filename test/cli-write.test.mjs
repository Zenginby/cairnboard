import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import * as fs from '../core/fsx.mjs';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { exportBoard } from '../core/export.mjs';
import { lockName } from '../core/lock.mjs';
import { parseFile } from '../core/frontmatter.mjs';
import { writeMany } from '../core/store.mjs';
import { tempDir, fixedClock } from './support/env.mjs';
import { runCli, spawnCli } from './support/cli.mjs';

function fixture(t, initialized = true) {
  const home = tempDir(t), data = tempDir(t), cwd = tempDir(t);
  const clock = fixedClock('2026-11-01T12:00:00Z');
  if (initialized) initDataDir(data, { home, env: {}, clock });
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

test('init preserves existing content and export board is derived read output', async (t) => {
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
  const stdout = await runCli(['export', 'board', '--stdout', '--json'], f.opts);
  assert.equal(stdout.code, 0, stdout.stdout);
  assert.equal(stdout.json.data, expected);
  assert.equal((await runCli(['export', 'board', '--stdout'], f.opts)).stdout, expected);
  const beforeExport = tree(f.data);
  assert.equal((await f.run(['export', 'board', '--dry-run'])).code, 0);
  assert.deepEqual(tree(f.data), beforeExport);
  assert.equal((await runCli(['export', 'board', '--json'], f.opts)).code, 0);
  assert.equal(fs.readFileSync(join(f.data, 'board.md'), 'utf8'), expected);
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
