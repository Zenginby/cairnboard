import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import * as fs from '../core/fsx.mjs';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { readFile } from '../core/store.mjs';
import { readEvents } from '../core/events.mjs';
import { parseFile } from '../core/frontmatter.mjs';
import { addEntry, show, list, entries } from '../core/journal.mjs';
import { fixedClock, tempDir } from './support/env.mjs';

function fixture(t, preset = 'default') {
  const root = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(root, { home, env: {}, clock, preset });
  return openContext({ mode: 'write', dataDir: root, home, env: {}, clock });
}

for (const [preset, language, label] of [['default', 'en', 'Pitfall'], ['tr-wiki', 'tr', 'Tuzak']]) {
  test(`${preset} journal appends to matching sections and exposes indexed entries`, (t) => {
    const ctx = fixture(t, preset);
    ctx.config.language = language;
    const first = addEntry(ctx, { date: '2026-11-01', title: 'Work', label: 'acme', entries: [{ type: 'pitfall', text: 'First' }] });
    assert.equal(first.path, preset === 'default' ? 'journal/2026-11-01.md' : 'wiki/gunluk-loglar/2026-11-01.md');
    const original = readFile(ctx, first.path).text;
    assert.deepEqual(parseFile(original).data, { date: '2026-11-01' });
    assert.ok(original.includes(`- **${label}:** First\n`));
    addEntry(ctx, { date: '2026-11-01', title: 'Other', entries: [{ type: null, text: 'Keep' }] });
    assert.ok(readFile(ctx, first.path).text.startsWith(original));
    const before = readFile(ctx, first.path).text;
    addEntry(ctx, { date: '2026-11-01', title: 'Work', label: 'acme', entries: [{ type: 'pitfall', text: 'Processed → [[page]]' }] });
    const after = readFile(ctx, first.path).text;
    assert.ok(after.startsWith(original));
    assert.ok(after.endsWith(before.slice(before.indexOf('## Other'))));
    assert.equal(after.split('## Work').length, 2);
    assert.ok(after.indexOf('Processed') < after.indexOf('## Other'));
    assert.equal(show(ctx, '2026-11-01').body, parseFile(after).body);
    assert.equal(list(ctx, { month: '2026-11' }).length, 1);
    assert.deepEqual(list(ctx, { month: '2026-10' }), []);
    assert.deepEqual(entries(ctx, { type: 'pitfall', unprocessed: true }).map(({ text }) => text), ['First']);
    assert.deepEqual(entries(ctx, { since: '2026-11-02' }), []);
    assert.deepEqual(readEvents(ctx).map(({ op }) => op), ['journal.add', 'journal.add', 'journal.add']);
  });
}

test('journal preserves manual CRLF content, skips fenced headings and supports multiline items', (t) => {
  const ctx = fixture(t);
  ctx.config.language = 'en';
  fs.mkdirSync(join(ctx.root, 'journal'));
  const original = '---\r\ndate: 2026-11-01 # keep\r\n---\r\n# Day\r\nSummary\r\n\r\n```md\r\n## Work\r\n```\r\n\r\n## Work\r\n- Manual\r\n\r\n## Next\r\n- Keep\r\n';
  fs.writeFileSync(join(ctx.root, 'journal/2026-11-01.md'), original);
  addEntry(ctx, { date: '2026-11-01', title: 'Work', entries: [{ type: 'lesson', text: 'One\nTwo' }] });
  const after = readFile(ctx, 'journal/2026-11-01.md').text;
  assert.equal(after, original.replace('## Next', '- **Lesson:** One\r\n  Two\r\n## Next'));
  assert.equal(entries(ctx, { type: 'lesson' })[0].text, 'One\nTwo');
});

test('journal validates input, respects revision preconditions and dry-run writes nothing', (t) => {
  const ctx = fixture(t);
  const input = { date: '2026-11-01', title: 'Work', entries: [{ type: null, text: 'Item' }] };
  const before = fs.readdirSync(ctx.root, { recursive: true });
  assert.equal(addEntry({ ...ctx, mode: 'dry-run' }, input).dryRun, true);
  assert.equal(addEntry({ ...ctx, mode: 'read' }, input, { dryRun: true }).dryRun, true);
  assert.deepEqual(fs.readdirSync(ctx.root, { recursive: true }), before);
  const first = addEntry(ctx, input);
  assert.throws(() => addEntry(ctx, input, { ifRevision: 'wrong' }), { code: 'conflict' });
  assert.equal(addEntry(ctx, input, { ifRevision: first.revision }).dryRun, false);
  for (const patch of [{ date: '2026-02-30' }, { title: '' }, { title: 'Work\n## Injected' }, { entries: [{ type: 'unknown', text: 'Item' }] }]) {
    assert.throws(() => addEntry(ctx, { ...input, ...patch }), { code: 'validation' });
  }
  assert.throws(() => show(ctx, '2026-11-02'), { code: 'not_found' });
});

for (const [tz, iso, day] of [
  ['Pacific/Kiritimati', '2026-11-01T11:00:00Z', '2026-11-02'],
  ['Europe/Berlin', '2026-03-29T01:30:00Z', '2026-03-29'],
]) {
  test(`journal chooses the local day in ${tz}`, (t) => {
    const ctx = fixture(t);
    const script = `
      import { openContext } from './core/context.mjs';
      import { fixedClock } from './core/clock.mjs';
      import { addEntry } from './core/journal.mjs';
      const ctx = openContext({ mode: 'write', dataDir: process.env.CAIRN_DATA, home: process.env.HOME,
        env: {}, clock: fixedClock(process.env.TEST_TIME) });
      console.log(addEntry(ctx, { title: 'Work', entries: [] }).path);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HOME: tempDir(t), CAIRN_DATA: ctx.root, TZ: tz, TEST_TIME: iso }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `journal/${day}.md`);
  });
}
