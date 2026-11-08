import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import * as fs from '../core/fsx.mjs';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { readEvents } from '../core/events.mjs';
import { reconcileExternal } from '../core/changes.mjs';
import { revision } from '../core/store.mjs';
import { main } from '../cli/main.mjs';
import { commands } from '../cli/registry.mjs';
import { cliInvocation, prepareInstall, renderSkill } from '../core/agent.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { runCli } from './support/cli.mjs';

function fixture(t) {
  const home = tempDir(t), data = tempDir(t), clock = fixedClock('2026-11-08T12:00:00Z');
  initDataDir(data, { home, env: {}, clock });
  const put = (path, text) => {
    fs.mkdirSync(dirname(join(data, path)), { recursive: true });
    fs.writeFileSync(join(data, path), text);
  };
  const open = () => openContext({ mode: 'write', dataDir: data, home, env: {}, clock, actor: 'cli:owner' });
  const run = (args, extra) => runCli(args, { home, data, clock, ...extra });
  return { home, data, clock, put, open, run };
}

function tree(root, prefix = '') {
  return fs.readdirSync(join(root, prefix)).sort().flatMap((name) => {
    const path = prefix ? `${prefix}/${name}` : name;
    const stat = fs.statSync(join(root, path));
    return stat.isDirectory() ? tree(root, path) : [[path, fs.readFileSync(join(root, path), 'utf8')]];
  });
}

test('cairn config and config get report defaults and validate feature names', async (t) => {
  const f = fixture(t);
  const all = await f.run(['config', '--json']);
  assert.equal(all.code, 0, all.stdout + all.stderr);
  assert.deepEqual(all.json.data.features, {
    changeTrail: true,
    changeContent: true,
    liveUpdates: true,
    mentions: true,
  });
  assert.deepEqual(all.json.data.shadow, { blobs: 0, bytes: 0 });
  assert.equal(all.json.data.lastChange, null);
  assert.match(all.json.data.revision, /^[0-9a-f]{16}$/u);

  const human = await f.run(['config']);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^change-trail: on$/mu);
  assert.match(human.stdout, /^live-updates: on$/mu);
  assert.match(human.stdout, /^shadow: 0 blobs, 0 bytes$/mu);

  const got = await f.run(['config', 'get', 'live-updates']);
  assert.equal(got.code, 0, got.stderr);
  assert.equal(got.stdout, 'on\n');

  const gotJson = await f.run(['config', 'get', 'live-updates', '--json']);
  assert.equal(gotJson.code, 0, gotJson.stdout);
  assert.equal(gotJson.json.data.name, 'live-updates');
  assert.equal(gotJson.json.data.feature, 'liveUpdates');
  assert.equal(gotJson.json.data.value, true);

  const bad = await f.run(['config', 'get', 'unknown-feature', '--json']);
  assert.equal(bad.code, 5);
  assert.equal(bad.json.error.code, 'validation');

  const dry = await f.run(['config', '--dry-run', '--json']);
  assert.equal(dry.code, 0);
  assert.deepEqual(dry.json.data, all.json.data);
});

test('config set and clear-shadow enforce owner terminal and typed confirmation before touching disk', async (t) => {
  const f = fixture(t);
  const before = tree(f.data);

  for (const args of [['config', 'set', 'mentions', 'off'], ['config', 'clear-shadow']]) {
    const nonTty = await f.run([...args, '--json']);
    assert.equal(nonTty.code, 2, nonTty.stdout);
    assert.equal(nonTty.json.error.code, 'owner_only');
    assert.equal(nonTty.json.error.message, 'Change settings from your own terminal or the Settings page.');

    const stdinNotTty = await f.run([...args, '--json'], {
      isTTY: true,
      stdin: Object.assign(Readable.from(['mentions\n']), { isTTY: false }),
    });
    assert.equal(stdinNotTty.code, 2);
    assert.equal(stdinNotTty.json.error.code, 'owner_only');

    const agentPty = await f.run([...args, '--json'], {
      isTTY: true,
      stdin: 'mentions\n',
      env: { CODEX_SANDBOX: '1' },
    });
    assert.equal(agentPty.code, 2);
    assert.equal(agentPty.json.error.code, 'owner_only');

    const withYes = await f.run([...args, '--yes', '--json'], { isTTY: true, stdin: 'mentions\n' });
    assert.equal(withYes.code, 2);
    assert.equal(withYes.json.error.code, 'usage');
  }

  for (const [args, input] of [
    [['config', 'set', 'mentions', 'off'], 'yes\n'],
    [['config', 'set', 'mentions', 'off'], 'wrong\n'],
    [['config', 'set', 'mentions', 'off'], ''],
    [['config', 'clear-shadow'], 'yes\n'],
    [['config', 'clear-shadow'], 'mentions\n'],
  ]) {
    const mismatch = await f.run([...args, '--json'], { isTTY: true, stdin: input });
    assert.equal(mismatch.code, 2, mismatch.stdout + mismatch.stderr);
    assert.equal(mismatch.json.error.code, 'usage');
  }

  const badFeature = await f.run(['config', 'set', 'bogus', 'off', '--json'], { isTTY: true, stdin: 'bogus\n' });
  assert.equal(badFeature.code, 5);
  assert.equal(badFeature.json.error.code, 'validation');

  const badValue = await f.run(['config', 'set', 'mentions', 'maybe', '--json'], { isTTY: true, stdin: 'mentions\n' });
  assert.equal(badValue.code, 5);
  assert.equal(badValue.json.error.code, 'validation');

  assert.deepEqual(tree(f.data), before);
});

test('config set writes config with typed confirmation, records cli:owner and derives TTY on io', async (t) => {
  const f = fixture(t);
  let stdout = '', stderr = '';
  const exit = await main(['config', 'set', 'mentions', 'off', '--json'], {
    env: { ...process.env, HOME: f.home, USERPROFILE: f.home, CAIRN_DATA: f.data,
      CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, CODEX_SANDBOX: undefined,
      CODEX_THREAD_ID: undefined, GEMINI_CLI: undefined, CURSOR_AGENT: undefined },
    cwd: f.home,
    clock: f.clock,
    stdin: Object.assign(Readable.from(['mentions\n']), { isTTY: true }),
    stdout: { isTTY: true, write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
  });
  assert.equal(exit, 0, stdout + stderr);
  assert.match(stderr, /Type mentions:/u);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.data.changed, true);
  assert.equal(parsed.data.name, 'mentions');
  assert.equal(parsed.data.feature, 'mentions');
  assert.equal(parsed.data.value, false);

  const [event] = readEvents(f.open());
  assert.equal(event.op, 'config.change');
  assert.equal(event.actor, 'cli:owner');
  assert.equal(event.feature, 'mentions');
  assert.equal(event.before, true);
  assert.equal(event.after, false);

  assert.equal((await f.run(['config', 'get', 'mentions'])).stdout, 'off\n');

  const dry = await f.run(['config', 'set', 'mentions', 'on', '--dry-run', '--json']);
  assert.equal(dry.code, 0, dry.stdout);
  assert.equal(dry.json.data.changed, true);
  assert.equal((await f.run(['config', 'get', 'mentions'])).stdout, 'off\n');

  const stale = await f.run(['config', 'set', 'mentions', 'on', '--if-revision', '0000000000000000', '--json'],
    { isTTY: true, stdin: 'mentions\n' });
  assert.equal(stale.code, 4);
  assert.equal(stale.json.error.code, 'conflict');

  const customActor = await f.run(['config', 'set', 'change-trail', 'off', '--actor', 'alice', '--json'],
    { isTTY: true, stdin: 'change-trail\n' });
  assert.equal(customActor.code, 0, customActor.stdout);
  assert.equal(readEvents(f.open()).at(-1).actor, 'cli:alice');

  const reopen = await f.run(['config', 'set', 'change-trail', 'on', '--json'],
    { isTTY: true, stdin: 'change-trail\n' });
  assert.equal(reopen.code, 0, reopen.stdout);
  assert.ok(!reopen.json.warnings.includes('trail_disabled'));
  assert.equal(readEvents(f.open()).at(-1).op, 'external.gap');
  assert.equal(readEvents(f.open()).at(-1).actor, 'cli:owner');

  const badActor = await f.run(['config', 'set', 'mentions', 'on', '--actor', 'BAD', '--json'],
    { isTTY: true, stdin: 'mentions\n' });
  assert.equal(badActor.code, 2);
  assert.equal(badActor.json.error.code, 'usage');
});

test('main rejects non-TTY stdin or stdout when io.isTTY is omitted', async (t) => {
  const f = fixture(t);
  for (const [stdinTty, stdoutTty] of [[false, true], [true, false], [true, undefined]]) {
    let stdout = '', stderr = '';
    const exit = await main(['config', 'set', 'mentions', 'off', '--json'], {
      env: { HOME: f.home, USERPROFILE: f.home, CAIRN_DATA: f.data },
      cwd: f.home,
      clock: f.clock,
      stdin: Object.assign(Readable.from(['mentions\n']), { isTTY: stdinTty }),
      stdout: { isTTY: stdoutTty, write: (text) => { stdout += text; } },
      stderr: { write: (text) => { stderr += text; } },
    });
    assert.equal(exit, 2, stdout + stderr);
    assert.equal(JSON.parse(stdout).error.code, 'owner_only');
  }
  const missingStdoutTty = await f.run(['config', 'set', 'mentions', 'off', '--json'], {
    isTTY: true, stdin: 'mentions\n', stdout: { isTTY: undefined },
  });
  assert.equal(missingStdoutTty.code, 2, missingStdoutTty.stdout);
  assert.equal(missingStdoutTty.json.error.code, 'owner_only');
});

test('config clear-shadow deletes blobs with clear confirmation and reports lock contention', async (t) => {
  const f = fixture(t);
  f.put('notes/a.md', 'alpha');
  f.put('notes/b.md', 'beta');
  reconcileExternal(f.open());
  assert.equal((await f.run(['config', '--json'])).json.data.shadow.blobs, 2);

  const cleared = await f.run(['config', 'clear-shadow', '--json'], { isTTY: true, stdin: 'clear\n' });
  assert.equal(cleared.code, 0, cleared.stdout + cleared.stderr);
  assert.match(cleared.stderr, /Type clear:/u);
  assert.equal(cleared.json.data.blobs, 2);
  assert.equal(cleared.json.data.bytes, 9);
  assert.equal((await f.run(['config', '--json'])).json.data.shadow.blobs, 0);
  assert.equal(readEvents(f.open()).at(-1).op, 'shadow.clear');
  assert.equal(readEvents(f.open()).at(-1).actor, 'cli:owner');
  assert.equal(reconcileExternal(f.open()).recorded, 0);

  const lockPath = join(f.data, '.cairn/locks/_config.lock');
  fs.mkdirSync(dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({
    host: f.open().host, pid: f.open().pid, instance: 'holder', ts: f.clock.now().toISOString(),
  }));
  t.after(() => fs.rmSync(lockPath, { force: true }));
  assert.equal((await f.run(['config', '--json'])).code, 6);
  assert.equal((await f.run(['config', 'get', 'mentions', '--json'])).code, 6);
  assert.equal((await f.run(['config', 'clear-shadow', '--json'], { isTTY: true, stdin: 'clear\n' })).code, 6);
});

test('config clear-shadow removes prior external content from history and changes --diff', async (t) => {
  const f = fixture(t);
  f.put('notes/a.md', 'prior secret\n');
  reconcileExternal(f.open());
  f.put('notes/a.md', 'updated secret\n');
  reconcileExternal(f.open());

  const cleared = await f.run(['config', 'clear-shadow', '--json'], { isTTY: true, stdin: 'clear\n' });
  assert.equal(cleared.code, 0, cleared.stdout + cleared.stderr);

  const diffed = await f.run(['changes', '--since', '0', '--diff', '--json']);
  assert.equal(diffed.code, 0, diffed.stdout);
  const ext = diffed.json.data.changes.find((change) => change.op === 'external.change');
  assert.ok(ext);
  assert.equal(ext.diff, null);
  assert.equal(ext.reason, 'content_not_kept');

  const humanDiff = await f.run(['changes', '--target', 'notes/a.md', '--diff']);
  assert.equal(humanDiff.code, 0, humanDiff.stderr);
  assert.match(humanDiff.stdout, /\(content_not_kept\)/u);
  assert.equal(humanDiff.stdout.includes('prior secret'), false);

  const files = fs.readdirSync(join(f.data, '.cairn/history')).filter((name) => name.startsWith('x-'));
  assert.equal(files.length, 1);
  const raw = fs.readFileSync(join(f.data, '.cairn/history', files[0]), 'utf8');
  assert.equal(raw.includes('prior secret'), false);
  const saved = JSON.parse(raw);
  assert.equal(Object.hasOwn(saved, 'before'), false);
  assert.equal(saved.beforeUnavailable, true);
});

test('manual config edits produce config.external on cairn config', async (t) => {
  const f = fixture(t);
  await f.run(['config', '--json']);
  const configFile = join(f.data, '.cairn/config.json');
  const next = { ...JSON.parse(fs.readFileSync(configFile, 'utf8')), features: { liveUpdates: false } };
  fs.writeFileSync(configFile, JSON.stringify(next, null, 2) + '\n');

  const res = await f.run(['config', '--json']);
  assert.equal(res.code, 0, res.stdout);
  assert.equal(res.json.data.features.liveUpdates, false);
  assert.equal(res.json.data.revision, revision(fs.readFileSync(configFile)));
  assert.equal(res.json.data.lastChange.actor, 'owner:external');
  assert.deepEqual(res.json.data.lastChange.feature, ['liveUpdates']);
  assert.deepEqual(res.json.data.lastChange.after, { liveUpdates: false });

  const human = await f.run(['config']);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /live-updates: off/u);
  assert.match(human.stdout, /owner:external/u);

  const [event] = readEvents(f.open());
  assert.equal(event.op, 'config.external');
  assert.equal(event.actor, 'owner:external');
  assert.deepEqual(event.changed, ['liveUpdates']);
});

test('renderSkill excludes agentVisible: false and respects disabled mentions in skill, help and CLI', async (t) => {
  const f = fixture(t);
  const invocation = cliInvocation(f.home);
  const fullSkill = renderSkill({ version: '1.2.3', invocation, actor: null, commands });
  assert.ok(!fullSkill.includes('config set'));
  assert.ok(!fullSkill.includes('clear-shadow'));
  assert.ok(fullSkill.includes(`${invocation} config --json`));
  assert.ok(fullSkill.includes(`${invocation} config get <feature> --json`));
  assert.ok(fullSkill.includes(`${invocation} mentions <note-id> --json`));

  const withoutMentions = renderSkill({
    version: '1.2.3',
    invocation,
    actor: null,
    commands,
    features: { changeTrail: true, changeContent: true, liveUpdates: true, mentions: false },
  });
  assert.ok(!withoutMentions.includes('mentions'));
  assert.ok(withoutMentions.includes(`${invocation} wiki check - --path <target-path> --json`));
  assert.ok(withoutMentions.includes(`${invocation} config get <feature> --json`));

  const fakeRepo = tempDir(t);
  fs.mkdirSync(join(fakeRepo, 'dist'));
  fs.writeFileSync(join(fakeRepo, 'dist/cairn.mjs'), '');
  const plan = prepareInstall({
    home: f.home,
    repoRoot: fakeRepo,
    commands,
    features: { changeTrail: true, changeContent: true, liveUpdates: true, mentions: false },
  });
  plan.apply();
  const installed = fs.readFileSync(join(f.home, '.claude/skills/cairnboard/SKILL.md'), 'utf8');
  assert.ok(!installed.includes('mentions'));
  assert.ok(!installed.includes('config set'));

  const disabledSet = await f.run(['config', 'set', 'mentions', 'off', '--json'],
    { isTTY: true, stdin: 'mentions\n' });
  assert.equal(disabledSet.code, 0);

  const helpAll = await f.run(['help']);
  assert.equal(helpAll.code, 0);
  assert.match(helpAll.stdout, /^\s+mentions\s+Find unlinked mentions of a note\. \(disabled\)$/mu);

  const helpOne = await f.run(['help', 'mentions']);
  assert.equal(helpOne.code, 0);
  assert.match(helpOne.stdout, /\(disabled\)$/mu);

  const helpFlag = await f.run(['mentions', '--help', '--data', f.data, '--json']);
  assert.equal(helpFlag.code, 0);
  assert.ok(helpFlag.json.data.summary.endsWith(' (disabled)'));

  f.put('notes/target.md', '# Borealis\n');
  const blocked = await f.run(['mentions', '@notes/target', '--json']);
  assert.equal(blocked.code, 2);
  assert.equal(blocked.json.error.code, 'feature_disabled');

  const brokenData = tempDir(t);
  fs.mkdirSync(join(brokenData, '.cairn'), { recursive: true });
  fs.writeFileSync(join(brokenData, '.cairn/config.json'), '{broken');
  assert.equal((await runCli(['help'], { home: f.home, data: brokenData })).code, 0);
});
