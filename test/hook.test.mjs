import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultConfig } from '../core/config.mjs';
import { openContext } from '../core/context.mjs';
import { evaluateHook } from '../core/hook.mjs';
import { fixedClock, tempDir } from './support/env.mjs';
import { runCli } from './support/cli.mjs';
import { snapshot } from './support/vault.mjs';

const clock = fixedClock('2026-11-01T12:00:00Z');

function make(t, entries = {}, rules) {
  const dir = tempDir(t), home = tempDir(t);
  mkdirSync(join(dir, '.cairn'));
  writeFileSync(join(dir, '.cairn/config.json'), JSON.stringify({ ...defaultConfig('en'), ...(rules ? { rules } : {}) }));
  for (const [path, text] of Object.entries(entries)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const ctx = openContext({ mode: 'read', dataDir: dir, home, env: {}, clock, platform: process.platform });
  const hook = (input, extra = {}) => runCli(['wiki', 'hook'], { home, data: dir, cwd: home, clock, stdin: typeof input === 'string' ? input : JSON.stringify(input), ...extra });
  return { dir, home, ctx, hook };
}

const concept = (extra = '', body = '# T\n') => `---\nkind: concept\ntags: [a]\nupdated: 2026-10-30\n${extra}---\n${body}`;
const write = (dir, rel, content) => ({ tool_name: 'Write', tool_input: { file_path: join(dir, rel), content } });

test('Write: an error rule denies with rule names and lines; warn and clean pages allow', (t) => {
  const f = make(t, {}, { required: 'error', links: 'error' });
  const denied = evaluateHook(f.ctx, write(f.dir, 'wiki/concepts/x.md', '---\nkind: concept\ntags: [a]\nupdated: 2026-10-30\nsources: [a]\n---\nno heading\n[[ghost]]\n'));
  assert.equal(denied.decision, 'deny');
  assert.match(denied.reason, /required/u);
  assert.match(denied.reason, /links \(line 8\)/u);
  assert.match(denied.reason, /ghost/u);
  const warned = make(t, {}, { required: 'warn' });
  const result = evaluateHook(warned.ctx, write(warned.dir, 'wiki/concepts/x.md', concept('sources: [a]\n', 'no heading\n')));
  assert.equal(result.decision, 'allow');
  assert.match(result.warnings.join('\n'), /required/u);
  assert.deepEqual(evaluateHook(f.ctx, write(f.dir, 'wiki/concepts/x.md', concept('sources: [a]\n'))), { decision: 'allow', warnings: [] });
});

test('other tools, paths outside the roots and a missing data folder are allowed untouched', (t) => {
  const f = make(t, {}, { required: 'error' });
  const bad = '---\nkind: concept\n---\nx\n';
  assert.deepEqual(evaluateHook(f.ctx, { tool_name: 'Read', tool_input: { file_path: join(f.dir, 'a.md') } }), { decision: 'allow', warnings: [] });
  assert.equal(evaluateHook(f.ctx, write(tempDir(t), 'wiki/concepts/x.md', bad)).decision, 'allow');
  assert.equal(evaluateHook(f.ctx, write(f.dir, '.cairn/config.json', bad)).decision, 'allow');
  assert.equal(evaluateHook(f.ctx, write(f.dir, 'raw/a.md', bad)).decision, 'allow');
  assert.equal(evaluateHook(f.ctx, write(f.dir, 'wiki/concepts/x.txt', bad)).decision, 'allow');
  assert.equal(evaluateHook(f.ctx, write(f.dir, 'wiki/concepts/x.md', bad)).decision, 'deny');
  assert.deepEqual(evaluateHook(null, write(f.dir, 'wiki/concepts/x.md', bad)), { decision: 'allow', warnings: [] });
  // A symlink inside the data folder that leads outside is never followed into the root.
  const outside = tempDir(t);
  symlinkSync(outside, join(f.dir, 'wiki-out'));
  assert.equal(evaluateHook(f.ctx, write(f.dir, 'wiki-out/x.md', bad)).decision, 'allow');
  assert.equal(evaluateHook(f.ctx, write(f.dir, '../x.md', bad)).decision, 'allow');
});

test('Edit applies old_string to the current file; missing text or file allows with a warning', (t) => {
  const page = concept('sources: [a]\n', '# T\nfirst [[ok]] and second\nfirst again\n');
  const f = make(t, { 'wiki/concepts/x.md': page, 'wiki/concepts/ok.md': concept('sources: [a]\n') }, { links: 'error' });
  const edit = (tool_input) => evaluateHook(f.ctx, { tool_name: 'Edit', tool_input: { file_path: join(f.dir, 'wiki/concepts/x.md'), ...tool_input } });
  assert.equal(edit({ old_string: 'second', new_string: '[[ghost]]' }).decision, 'deny');
  assert.equal(edit({ old_string: 'second', new_string: 'plain' }).decision, 'allow');
  // $& stays literal; replace_all hits every occurrence, a single replace of a repeated text is left to Claude Code.
  assert.equal(edit({ old_string: 'second', new_string: '$&[[ghost]]' }).decision, 'deny');
  assert.equal(edit({ old_string: 'first', new_string: '[[ghost]]', replace_all: true }).decision, 'deny');
  const repeated = edit({ old_string: 'first', new_string: '[[ghost]]' });
  assert.equal(repeated.decision, 'allow');
  assert.ok(repeated.warnings.length);
  const absent = edit({ old_string: 'nowhere', new_string: '[[ghost]]' });
  assert.equal(absent.decision, 'allow');
  assert.ok(absent.warnings.length);
  const nofile = evaluateHook(f.ctx, { tool_name: 'Edit', tool_input: { file_path: join(f.dir, 'wiki/concepts/new.md'), old_string: 'a', new_string: 'b' } });
  assert.equal(nofile.decision, 'allow');
  assert.ok(nofile.warnings.length);
});

test('unexpected input fails open with hook_error', (t) => {
  const f = make(t, {}, { required: 'error' });
  for (const input of [null, 'text', { tool_name: 'Write', tool_input: null }, write(f.dir, 'wiki/concepts/x.md', 5),
    { tool_name: 'Write', tool_input: { file_path: 'relative.md', content: 'x' } }]) {
    const result = evaluateHook(f.ctx, input);
    assert.equal(result.decision, 'allow');
    assert.ok(result.warnings.includes('hook_error'), JSON.stringify(input));
  }
});

test('wiki hook: documented deny, warning and allow output; broken stdin and missing data fail open', async (t) => {
  const f = make(t, {}, { required: 'error' });
  const bad = write(f.dir, 'wiki/concepts/x.md', '---\nkind: concept\n---\nx\n');
  const before = snapshot(f.dir);
  const denied = await f.hook({ ...bad, hook_event_name: 'PreToolUse', cwd: f.home, session_id: 's' });
  assert.equal(denied.code, 0, denied.stderr);
  const out = JSON.parse(denied.stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /required/u);
  const ok = await f.hook(write(f.dir, 'wiki/concepts/x.md', concept('sources: [a]\n')));
  assert.deepEqual([ok.code, ok.stdout], [0, '']);
  const other = await f.hook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.deepEqual([other.code, other.stdout], [0, '']);
  const broken = await f.hook('{not json');
  assert.equal(broken.code, 0);
  const context = JSON.parse(broken.stdout).hookSpecificOutput;
  assert.equal(context.permissionDecision, undefined);
  assert.match(context.additionalContext, /hook_error/u);
  const empty = await f.hook('');
  assert.match(JSON.parse(empty.stdout).hookSpecificOutput.additionalContext, /hook_error/u);
  const huge = await f.hook(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(f.dir, 'wiki/concepts/x.md'), content: 'x'.repeat(2 * 1024 * 1024 + 10) } }));
  assert.equal(huge.code, 0);
  assert.match(JSON.parse(huge.stdout).hookSpecificOutput.additionalContext, /hook_error/u);
  const nodata = await runCli(['wiki', 'hook'], { home: f.home, data: join(f.home, 'missing'), cwd: f.home, clock, stdin: JSON.stringify(bad) });
  assert.deepEqual([nodata.code, nodata.stdout], [0, '']);
  // Only the index cache may change.
  const kept = (map) => [...map].filter(([path]) => !/^\.cairn\/index\.db/u.test(path));
  assert.deepEqual(kept(snapshot(f.dir)), kept(before));
  assert.equal(existsSync(join(f.dir, 'wiki/concepts/x.md')), false);
});

test('wiki hook passes warnings to Claude as additionalContext without a permission decision', async (t) => {
  const f = make(t);
  const response = await f.hook(write(f.dir, 'wiki/concepts/x.md', concept('', 'no heading\n')));
  assert.equal(response.code, 0);
  const { hookSpecificOutput } = JSON.parse(response.stdout);
  assert.equal(hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(hookSpecificOutput.permissionDecision, undefined);
  assert.match(hookSpecificOutput.additionalContext, /required/u);
  assert.match(hookSpecificOutput.additionalContext, /sources/u);
});
