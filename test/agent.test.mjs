import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import * as fs from '../core/fsx.mjs';
import { parseDocument } from 'yaml';
import { TARGETS, cliInvocation, renderSkill, renderAgentsMd, prepareInstall, installAgent, checkAgents, packageVersion } from '../core/agent.mjs';
import { commands } from '../cli/registry.mjs';
import { checkData } from '../core/doctor.mjs';
import { initDataDir } from '../core/roots.mjs';
import { tempDir, fixedClock } from './support/env.mjs';

function fixture(t) {
  const home = tempDir(t), repoRoot = tempDir(t);
  fs.mkdirSync(join(repoRoot, 'dist'));
  fs.writeFileSync(join(repoRoot, 'dist/cairn.mjs'), '');
  return { home, repoRoot, commands };
}

function files(root, prefix = '') {
  return fs.readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? files(root, path) : [path];
  }).sort();
}

test('skill has quoted YAML, a first body version marker and full invocations', () => {
  const invocation = cliInvocation(join('acme', 'Proje Notları'));
  for (const actor of ['claude', null]) {
    const skill = renderSkill({ version: '1.2.3', invocation, actor, commands });
    const [, frontmatter, body] = skill.split('---\n');
    const doc = parseDocument(frontmatter);
    assert.deepEqual(doc.errors, []);
    assert.deepEqual(Object.keys(doc.toJS()), ['name', 'description']);
    assert.equal(doc.toJS().name, 'cairnboard');
    assert.match(frontmatter, /description: ".*"/u);
    assert.ok(body.startsWith('<!-- cairnboard-skill 1.2.3 -->\n'));
    assert.ok(Buffer.byteLength(body) <= 24 * 1024);
    assert.doesNotMatch(skill, /^cairn /mu);
    for (const command of commands.filter(({ hidden }) => !hidden)) assert.ok(skill.includes(`${invocation} ${command.name}`), command.name);
    assert.ok(!skill.includes('wiki hook'));
    assert.ok(skill.includes('--if-revision'));
    assert.ok(skill.includes('changes --target <ref> --diff'));
    assert.ok(skill.includes("never overwrite the owner's edit blindly"));
    if (actor === null) assert.match(skill, /codex, gemini, cursor, antigravity/u);
  }
  const snippet = renderAgentsMd({ version: '1.2.3', invocation, commands });
  assert.ok(snippet.includes(`${invocation} card list`));
  assert.ok(snippet.includes('1.2.3'));
  assert.ok(snippet.includes('changes --target <ref> --diff'));
});

test('invocation quotes POSIX metacharacters and uses Windows separators', () => {
  assert.equal(cliInvocation('/acme/a"$`\\b', 'linux'), 'node "/acme/a\\"\\$\\`\\\\b/dist/cairn.mjs"');
  assert.equal(cliInvocation('C:\\acme\\Proje Notları', 'win32'), 'node "C:\\acme\\Proje Notları\\dist\\cairn.mjs"');
});

test('install previews, writes only selected skill folders and reports unchanged', (t) => {
  const f = fixture(t);
  let stderr = '';
  const options = { ...f, stderr: { write: (text) => { stderr += text; } } };
  const preview = installAgent({ ...options, dryRun: true });
  assert.deepEqual(preview.map(({ target, status }) => [target, status]), [['claude', 'new'], ['agents', 'new']]);
  assert.deepEqual(files(f.home), []);
  assert.match(stderr, /new/u);
  installAgent(options);
  assert.deepEqual(files(f.home), ['.agents/skills/cairnboard/SKILL.md', '.claude/skills/cairnboard/SKILL.md']);
  assert.ok(checkAgents(f).filter(({ target }) => target !== 'antigravity-cli').every(({ ok }) => ok));
  assert.ok(installAgent(options).every(({ status }) => status === 'unchanged'));
  const path = preview[0].path;
  fs.writeFileSync(path, 'Old\n');
  stderr = '';
  assert.equal(installAgent({ ...options, targets: ['claude'], dryRun: true })[0].status, 'changed');
  assert.match(stderr, /-Old/u);
  assert.match(stderr, /\+---/u);
  assert.equal(fs.readFileSync(path, 'utf8'), 'Old\n');
  installAgent({ ...options, targets: ['antigravity-cli'] });
  assert.equal(checkAgents(f).find(({ target }) => target === 'antigravity-cli').ok, true);
});

test('check detects old versions and moved bundles without writing', (t) => {
  const f = fixture(t);
  assert.ok(checkAgents(f).every(({ installed, ok }) => installed === null && !ok));
  installAgent(f);
  const installed = checkAgents(f)[0];
  assert.equal(installed.current, packageVersion);
  fs.writeFileSync(installed.path, fs.readFileSync(installed.path, 'utf8').replace(`cairnboard-skill ${packageVersion}`, `cairnboard-skill ${packageVersion}-old`));
  assert.equal(checkAgents(f)[0].ok, false);
  fs.renameSync(join(f.repoRoot, 'dist/cairn.mjs'), join(f.repoRoot, 'dist/moved.mjs'));
  assert.equal(checkAgents(f)[1].invocationOk, false);
});

test('invalid targets and missing bundle fail before any write', (t) => {
  const f = fixture(t);
  assert.throws(() => installAgent({ ...f, targets: ['claude', 'unknown'] }), { code: 'usage' });
  assert.deepEqual(files(f.home), []);
  fs.renameSync(join(f.repoRoot, 'dist/cairn.mjs'), join(f.repoRoot, 'dist/moved.mjs'));
  assert.throws(() => installAgent(f), (error) => error.code === 'validation' && error.message.includes('npm run build:cli'));
});

test('oversized skills fail before installation and preserve existing skills for every target', (t) => {
  const f = fixture(t);
  installAgent({ ...f, targets: Object.keys(TARGETS) });
  const before = new Map(files(f.home).map((path) => [path, fs.readFileSync(join(f.home, path), 'utf8')]));
  // Exceed the skill limit even with a short /tmp root, while keeping the test file below Windows MAX_PATH.
  let repoRoot = f.repoRoot;
  while (repoRoot.length < 230) repoRoot = join(repoRoot, 'a'.repeat(Math.max(1, Math.min(70, 230 - repoRoot.length - 1))));
  fs.mkdirSync(join(repoRoot, 'dist'), { recursive: true });
  fs.writeFileSync(join(repoRoot, 'dist/cairn.mjs'), '');
  for (const target of Object.keys(TARGETS)) {
    for (const dryRun of [false, true]) {
      assert.throws(() => installAgent({ ...f, repoRoot, targets: [target], dryRun }),
        (error) => error.code === 'validation' && /24 KB/u.test(error.message) && /shorter/u.test(error.message));
    }
  }
  assert.deepEqual(new Map(files(f.home).map((path) => [path, fs.readFileSync(join(f.home, path), 'utf8')])), before);
  const home = tempDir(t);
  assert.throws(() => installAgent({ ...f, home, repoRoot }), { code: 'validation' });
  assert.deepEqual(files(home), []);
});

test('skill size enforcement counts UTF-8 bytes including a Unicode invocation', () => {
  const invocation = cliInvocation(join('acme', ...Array(3).fill('界'.repeat(40))));
  assert.throws(() => renderSkill({ version: '1.2.3', invocation, actor: 'claude', commands }), { code: 'validation' });
});

function dirLink(t, from, to) {
  try { fs.symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir'); return true; }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('Symlinks unavailable.'); return false; }
    throw error;
  }
}

test('a symlinked agent root such as ~/.claude is followed to its real directory', (t) => {
  const f = fixture(t), outside = tempDir(t);
  if (!dirLink(t, outside, join(f.home, '.claude'))) return;
  const [plan] = installAgent({ ...f, targets: ['claude'] });
  assert.equal(plan.path, join(fs.realpathSync(outside), 'skills/cairnboard/SKILL.md'));
  assert.deepEqual(files(outside), ['skills/cairnboard/SKILL.md']);
  assert.equal(checkAgents({ home: f.home }).find(({ target }) => target === 'claude').installed, packageVersion);
});

test('re-pointing the agent root after the diff was shown aborts the install', (t) => {
  const f = fixture(t), first = tempDir(t), second = tempDir(t), link = join(f.home, '.claude');
  if (!dirLink(t, first, link)) return;
  const plan = prepareInstall({ ...f, targets: ['claude'] });
  fs.rmSync(link, { recursive: false, force: true });
  dirLink(t, second, link);
  assert.throws(() => plan.apply(), { code: 'conflict' });
  assert.deepEqual(files(first), []);
  assert.deepEqual(files(second), []);
});

test('an agent root symlink to a file or a missing target is rejected', (t) => {
  const f = fixture(t), outside = tempDir(t), file = join(outside, 'file');
  fs.writeFileSync(file, '');
  if (!dirLink(t, join(outside, 'missing'), join(f.home, '.claude'))) return;
  assert.throws(() => installAgent({ ...f, targets: ['claude'] }), { code: 'unsafe_path' });
  if (process.platform === 'win32') return;
  fs.symlinkSync(file, join(f.home, '.agents'));
  assert.throws(() => installAgent({ ...f, targets: ['agents'] }), { code: 'unsafe_path' });
  assert.deepEqual(files(outside), ['file']);
});

test('symlinks below the agent root are rejected without touching destinations', (t) => {
  const f = fixture(t), outside = tempDir(t);
  fs.mkdirSync(join(f.home, '.claude'));
  if (!dirLink(t, outside, join(f.home, '.claude/skills'))) return;
  assert.throws(() => installAgent({ ...f, targets: ['claude'] }), { code: 'unsafe_path' });
  assert.deepEqual(files(outside), []);
  const skillPath = join(f.home, TARGETS.agents.path.slice(2));
  fs.mkdirSync(dirname(skillPath), { recursive: true });
  const other = join(outside, 'SKILL.md');
  fs.writeFileSync(other, 'Keep\n');
  try { fs.symlinkSync(other, skillPath); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('File symlinks unavailable.');
    throw error;
  }
  assert.throws(() => installAgent({ ...f, targets: ['agents'] }), { code: 'unsafe_path' });
  assert.equal(fs.readFileSync(other, 'utf8'), 'Keep\n');
});

test('doctor treats skills as optional and reports stale or broken installations', (t) => {
  const f = fixture(t), dataDir = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(dataDir, { home: f.home, env: {}, clock });
  const check = () => checkData({ home: f.home, env: {}, dataDir, clock }).find(({ name }) => name === 'agent');
  assert.equal(check().ok, true);
  installAgent(f);
  assert.equal(check().ok, true);
  fs.renameSync(join(f.repoRoot, 'dist/cairn.mjs'), join(f.repoRoot, 'dist/moved.mjs'));
  assert.equal(check().ok, false);
  assert.equal(check().hint, 'npm run build:cli && cairn agent install');
});

test('installation preserves edits made while confirmation is pending', (t) => {
  const f = fixture(t);
  installAgent(f);
  const path = checkAgents(f)[0].path;
  fs.writeFileSync(path, 'Old\n');
  const plan = prepareInstall({ ...f, targets: ['claude'] });
  fs.writeFileSync(path, 'New\n');
  assert.throws(() => plan.apply(), { code: 'conflict' });
  assert.equal(fs.readFileSync(path, 'utf8'), 'New\n');
});
