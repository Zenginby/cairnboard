import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as fs from '../core/fsx.mjs';
import { commands } from '../cli/registry.mjs';
import { cliInvocation, renderSkill, renderAgentsMd } from '../core/agent.mjs';
import { initDataDir } from '../core/roots.mjs';
import { runCli } from './support/cli.mjs';
import { tempDir, fixedClock } from './support/env.mjs';
import { snapshot } from './support/vault.mjs';

// Parse only quoted arguments and escapes; no shell expansion or execution.
function split(line) {
  const args = [];
  let word = '', quote = null, started = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '\\' && quote !== "'") { word += line[++i]; started = true; }
    else if (quote) { if (char === quote) quote = null; else word += char; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/u.test(char)) { if (started) args.push(word); word = ''; started = false; }
    else { word += char; started = true; }
  }
  assert.equal(quote, null);
  if (started) args.push(word);
  return args;
}

test('every fenced skill command succeeds with real fixtures and dry-run', async (t) => {
  const home = tempDir(t), data = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(data, { home, env: {}, clock });
  const opts = { home, data, clock, env: { CAIRN_DEBUG: '1' } };
  const run = async (args, extra) => {
    const response = await runCli(args, { ...opts, ...extra });
    assert.equal(response.code, 0, `${args.join(' ')}\n${response.stdout}${response.stderr}`);
    return response.json.data;
  };
  const ids = {};
  for (const type of ['project', 'card', 'note', 'research']) {
    const item = await run([type, 'add', '--title', 'acme', '--actor', 'codex', '--json',
      ...(type === 'card' ? ['--body', '-'] : [])], { stdin: '## Acceptance\n- [ ] First\n- [ ] Second\n' });
    ids[`<${type}-id>`] = item.id;
  }
  await run(['journal', 'add', '--title', 'acme', '--label', 'acme', '--date', '2026-11-01', '--item', 'x', '--actor', 'codex', '--json']);
  const note = await run(['note', 'add', '--title', 'zorblax', '--actor', 'codex', '--json']);
  await run(['note', 'rm', note.id, '--actor', 'codex', '--json']);
  const trash = await run(['trash', 'list', '--json']);
  const values = { ...ids, '<date>': '2026-11-01', '<text>': 'x', '<query>': 'x', '<column>': 'doing', '<n>': '1',
    '<path>': tempDir(t), '<target-path>': 'wiki/concepts/draft.md', '<actor>': 'codex', '<revision>': (await run(['card', 'show', ids['<card-id>'], '--json'])).revision,
    '<trash-id>': trash.items[0].trashId };
  const invocation = cliInvocation(join(home, 'Proje Notları'));
  const prefix = split(invocation);
  const skill = renderSkill({ version: '1.2.3', invocation, actor: null, commands });
  assert.ok(Buffer.byteLength(skill) <= 24 * 1024, 'rendered skill exceeds 24 KB');
  const before = snapshot(data);
  const seen = new Set();
  let count = 0;
  for (const [, block] of skill.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)) {
    for (const line of block.trim().split('\n')) {
      const args = split(line);
      assert.deepEqual(args.splice(0, prefix.length), prefix, line);
      const filled = args.map((arg) => Object.hasOwn(values, arg) ? values[arg] : arg);
      assert.ok(filled.every((arg) => typeof arg === 'string' && !/<[^>]+>/u.test(arg)), line);
      const command = [...commands].reverse().find(({ name }) => name.split(' ').every((word, i) => filled[i] === word));
      assert.ok(command, line);
      assert.ok(command.dangerous !== true, line);
      assert.ok(!filled.includes('--steal'), line);
      seen.add(command.name);
      const result = await run([...filled, '--dry-run'], {
        stdin: command.name === 'wiki check'
          ? '---\nkind: concept\ntags: [acme]\nupdated: 2026-11-01\nsources: [acme]\n---\n# Draft\n'
          : 'A fictional raw source.\n',
      });
      if (command.name === 'wiki check') assert.deepEqual(result, { errors: [], warnings: [] });
      if (command.name === 'ingest') assert.ok(result.raw.path.startsWith('raw/'));
      count++;
    }
  }
  assert.ok(count >= commands.filter(({ hidden }) => !hidden).length - 3);
  for (const command of commands.filter(({ dangerous, hidden }) => dangerous !== true && !hidden)) assert.ok(seen.has(command.name), command.name);
  const sources = (map) => [...map].filter(([path]) => !/^\.cairn\/index\.db/u.test(path)).sort();
  assert.deepEqual(sources(snapshot(data)), sources(before), 'skill dry-runs changed source or state files');
  assert.deepEqual(fs.readdirSync(home).filter((name) => ['.claude', '.agents', '.gemini'].includes(name)), []);
});

test('wiki workflow gives runnable context, capture, draft check, index and lint commands for every agent', () => {
  const invocation = cliInvocation(join('acme', 'Proje Notları'));
  for (const actor of ['claude', 'antigravity', null]) {
    const skill = renderSkill({ version: '1.2.3', invocation, actor, commands });
    assert.ok(Buffer.byteLength(skill) <= 24 * 1024, `${actor}: rendered skill exceeds 24 KB`);
    const wiki = skill.match(/^## Wiki\n([\s\S]*?)(?=^## |$(?![\s\S]))/mu)?.[1];
    assert.ok(wiki, `${actor}: missing Wiki workflow`);
    for (const command of ['context --json', 'ingest --title', 'wiki check - --path', 'wiki index --json', 'wiki lint --json']) {
      assert.ok(wiki.includes(`${invocation} ${command}`), `${actor}: missing ${command}`);
    }
    const fragment = renderAgentsMd({ version: '1.2.3', invocation, commands });
    assert.ok(fragment.includes(`${invocation} context --json`));
    assert.match(fragment, /wiki check/u);
  }
});
