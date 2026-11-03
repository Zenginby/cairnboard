import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as fs from '../core/fsx.mjs';
import { installHook, hookStatus, cliInvocation } from '../core/agent.mjs';
import { checkData } from '../core/doctor.mjs';
import { initDataDir } from '../core/roots.mjs';
import { runCli } from './support/cli.mjs';
import { tempDir, fixedClock } from './support/env.mjs';

const clock = fixedClock('2026-11-01T12:34:56Z');
const invocation = 'node "/acme/cairnboard/dist/cairn.mjs"';
const command = `${invocation} wiki hook`;
const settingsOf = (home) => join(home, '.claude/settings.json');
const read = (home) => JSON.parse(fs.readFileSync(settingsOf(home), 'utf8'));
const entries = (settings) => settings.hooks.PreToolUse.flatMap((group) => group.hooks.map((hook) => [group.matcher, hook.command]))
  .filter(([, c]) => c.endsWith(' wiki hook'));

function setup(t, settings) {
  const home = tempDir(t);
  if (settings !== undefined) {
    fs.mkdirSync(join(home, '.claude'));
    fs.writeFileSync(settingsOf(home), typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  }
  let stderr = '';
  return { home, io: { env: {}, clock, stderr: { write: (text) => { stderr += text; } } }, err: () => stderr };
}

test('install adds one Write|Edit PreToolUse entry to empty settings, atomically, with no backup', (t) => {
  const f = setup(t);
  const result = installHook({ home: f.home, invocation, io: f.io });
  assert.equal(result.path, settingsOf(f.home));
  assert.deepEqual(read(f.home), { hooks: { PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command }] }] } });
  assert.deepEqual(fs.readdirSync(join(f.home, '.claude')), ['settings.json']);
  assert.deepEqual(hookStatus({ home: f.home, invocation, env: {} }), { installed: true, current: true });
});

test('install keeps other hooks and settings, backs up the old file and stays single on repeat', (t) => {
  const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] };
  const stale = { matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'node "/old/place/dist/cairn.mjs" wiki hook' }, { type: 'command', command: 'lint.sh' }] };
  const original = { model: 'opus', permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [other, stale], Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
  const f = setup(t, original);
  const before = fs.readFileSync(settingsOf(f.home), 'utf8');
  assert.deepEqual(hookStatus({ home: f.home, invocation, env: {} }), { installed: true, current: false });
  const result = installHook({ home: f.home, invocation, io: f.io });
  assert.match(result.diff, /^-.*\/old\/place/mu);
  assert.match(result.diff, /^\+.*\/acme\/cairnboard/mu);
  const after = read(f.home);
  assert.equal(after.model, 'opus');
  assert.deepEqual(after.permissions, original.permissions);
  assert.deepEqual(after.hooks.Stop, original.hooks.Stop);
  assert.deepEqual(after.hooks.PreToolUse.filter((group) => group.matcher === 'Bash'), [other]);
  assert.ok(after.hooks.PreToolUse.some((group) => group.hooks.some((hook) => hook.command === 'lint.sh')));
  assert.deepEqual(entries(after), [['Write|Edit', command]]);
  const backup = join(f.home, '.claude/settings.json.cairnboard-20261101123456.bak');
  assert.equal(fs.readFileSync(backup, 'utf8'), before);
  const second = installHook({ home: f.home, invocation, io: f.io });
  assert.equal(second.diff, '');
  assert.deepEqual(entries(read(f.home)), [['Write|Edit', command]]);
  assert.deepEqual(fs.readdirSync(join(f.home, '.claude')).sort(), ['settings.json', 'settings.json.cairnboard-20261101123456.bak']);
  assert.deepEqual(hookStatus({ home: f.home, invocation, env: {} }), { installed: true, current: true });
});

test('dry run writes nothing, shows the diff on stderr; invalid JSON is refused untouched', (t) => {
  const f = setup(t, { model: 'opus' });
  const before = fs.readFileSync(settingsOf(f.home), 'utf8');
  installHook({ home: f.home, invocation, io: f.io, dryRun: true });
  assert.match(f.err(), /\+.*wiki hook/u);
  assert.equal(fs.readFileSync(settingsOf(f.home), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(join(f.home, '.claude')), ['settings.json']);
  for (const bad of ['{ "hooks": ', '[]', '{"hooks": []}', '{"hooks":{"PreToolUse":{}}}']) {
    const g = setup(t, bad);
    assert.throws(() => installHook({ home: g.home, invocation, io: g.io }), { code: 'validation' });
    assert.equal(fs.readFileSync(settingsOf(g.home), 'utf8'), bad);
    assert.deepEqual(fs.readdirSync(join(g.home, '.claude')), ['settings.json']);
  }
});

test('two changed installs in the same second preserve both settings backups', (t) => {
  const f = setup(t, { model: 'opus' });
  const before = fs.readFileSync(settingsOf(f.home), 'utf8');
  installHook({ home: f.home, invocation, io: f.io });
  const first = fs.readFileSync(settingsOf(f.home), 'utf8');
  const moved = 'node "/moved/cairnboard/dist/cairn.mjs"';
  installHook({ home: f.home, invocation: moved, io: f.io });
  const backups = fs.readdirSync(join(f.home, '.claude')).filter((name) => name.endsWith('.bak'));
  assert.equal(backups.length, 2);
  assert.deepEqual(backups.map((name) => fs.readFileSync(join(f.home, '.claude', name), 'utf8')).sort(), [before, first].sort());
  assert.equal(fs.readFileSync(join(f.home, '.claude/settings.json.cairnboard-20261101123456.bak'), 'utf8'), before);
  assert.deepEqual(hookStatus({ home: f.home, invocation: moved, env: {} }), { installed: true, current: true });
});

test('CLAUDE_CONFIG_DIR decides the settings file; a symlinked settings.json is refused', (t) => {
  const f = setup(t), config = tempDir(t);
  installHook({ home: f.home, invocation, io: { ...f.io, env: { CLAUDE_CONFIG_DIR: config } } });
  assert.deepEqual(entries(JSON.parse(fs.readFileSync(join(config, 'settings.json'), 'utf8'))), [['Write|Edit', command]]);
  assert.equal(fs.existsSync(join(f.home, '.claude')), false);
  assert.deepEqual(hookStatus({ home: f.home, invocation, env: { CLAUDE_CONFIG_DIR: config } }), { installed: true, current: true });
  assert.deepEqual(hookStatus({ home: f.home, invocation, env: {} }), { installed: false, current: false });
  const g = setup(t, {});
  const target = join(g.home, 'real.json');
  fs.writeFileSync(target, '{}');
  fs.rmSync(settingsOf(g.home));
  fs.symlinkSync(target, settingsOf(g.home));
  assert.throws(() => installHook({ home: g.home, invocation, io: g.io }), { code: 'unsafe_path' });
});

test('agent install --hooks: refuses without a terminal, previews with --dry-run, installs with yes; check and doctor report it', async (t) => {
  const home = tempDir(t), data = tempDir(t);
  initDataDir(data, { home, env: {}, clock });
  const opts = { home, data, clock, cwd: home };
  const plain = await runCli(['agent', 'install', '--hooks', '--json'], opts);
  assert.equal(plain.code, 7);
  assert.equal(fs.existsSync(join(home, '.claude')), false);
  const dry = await runCli(['agent', 'install', '--hooks', '--dry-run', '--json'], opts);
  assert.equal(dry.code, 0, dry.stdout + dry.stderr);
  assert.match(dry.stderr, /wiki hook/u);
  assert.equal(fs.existsSync(join(home, '.claude')), false);
  const declined = await runCli(['agent', 'install', '--hooks', '--json'], { ...opts, isTTY: true, stdin: 'no\n' });
  assert.equal(declined.code, 7);
  const done = await runCli(['agent', 'install', '--hooks', '--json'], { ...opts, isTTY: true, stdin: 'yes\n' });
  assert.equal(done.code, 0, done.stdout + done.stderr);
  assert.ok(done.json.data.some((item) => item.target === 'claude-hook' && item.status === 'new'));
  const settings = read(home);
  assert.equal(entries(settings).length, 1);
  assert.match(entries(settings)[0][1], / wiki hook$/u);
  const check = await runCli(['agent', 'check', '--json'], opts);
  const hook = check.json.data.find((item) => item.target === 'claude-hook');
  assert.equal(hook.installed, true);
  assert.equal(hook.current, true);
  assert.equal(hook.ok, true);
  const doctor = checkData({ dataDir: data, env: {}, home, cwd: home, clock });
  assert.equal(doctor.find((item) => item.name === 'hook').ok, true);
  const absent = await runCli(['agent', 'check', '--json'], { ...opts, env: { CLAUDE_CONFIG_DIR: tempDir(t) } });
  assert.equal(absent.json.data.find((item) => item.target === 'claude-hook').installed, false);
  assert.equal(absent.json.data.find((item) => item.target === 'claude-hook').ok, true);
});
