import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import * as fs from '../core/fsx.mjs';
import { tempDir, fixedClock } from './support/env.mjs';
import { runCli } from './support/cli.mjs';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { mentions, linkMention } from '../core/mentions.mjs';
import { lockName } from '../core/lock.mjs';
import { readEvents } from '../core/events.mjs';

function fixture(t) {
  const home = tempDir(t), data = tempDir(t);
  const clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(data, { home, env: {}, clock });
  const ctx = openContext({ mode: 'write', dataDir: data, home, env: {}, clock, actor: 'cli:acme' });
  const put = (path, text) => {
    fs.mkdirSync(dirname(join(data, path)), { recursive: true });
    fs.writeFileSync(join(data, path), text);
  };
  put('notes/target.md', '---\ntitle: Borealis\naliases: [IŞIK, "two words"]\n---\nBorealis');
  const run = (args, extra) => runCli([...args, '--json'], { home, data, clock, ...extra });
  return { ctx, data, put, run };
}

test('mentions finds titles, file names, aliases and Turkish folding in path/line order', (t) => {
  const f = fixture(t);
  f.put('notes/z.md', '# Other\nBOREALİS\ntarget\nışık IŞIK İŞİK isik\ntwo words');
  f.put('notes/a.md', 'Borealis');
  assert.deepEqual(mentions(f.ctx, '@notes/target'), [
    { path: 'notes/a.md', type: 'note', title: 'a', line: 1, snippet: 'Borealis' },
    ...['BOREALİS', 'target', 'ışık IŞIK İŞİK isik', 'two words'].map((snippet, at) =>
      ({ path: 'notes/z.md', type: 'note', title: 'Other', line: at + 2, snippet })),
  ]);
  assert.equal(mentions(f.ctx, '@notes/target', { limit: 1 }).length, 1);
  assert.deepEqual(mentions(f.ctx, '@notes/target', { limit: 0 }), []);
  assert.throws(() => mentions(f.ctx, '@notes/target', { limit: -1 }), { code: 'validation' });
});

test('Unicode letter/number boundaries reject Borealisler and embedded names', (t) => {
  const f = fixture(t);
  f.put('notes/a.md', 'Borealisler\nαBorealis\nBorealis2\n𐐀Borealis\n(Borealis),\nBorealis_\nBorealis\u200Dler\nBorealis\u200B2');
  assert.deepEqual(mentions(f.ctx, '@notes/target').map(({ line }) => line), [5, 6]);
});

// Owner rule (O plan, open question 1): a suffix after an apostrophe is a mention, a joined suffix is not.
test('Turkish suffixes count after an apostrophe only', (t) => {
  const f = fixture(t);
  f.put('notes/a.md', "Borealis'te\nBorealis’ten\nBorealiste\nBOREALİS'İN");
  assert.deepEqual(mentions(f.ctx, '@notes/target').map(({ line }) => line), [1, 2, 4]);
});

test('mentions excludes code, wiki links, linked pages and the target itself', (t) => {
  const f = fixture(t);
  f.put('notes/a.md', '```md\nBorealis\n```\n`Borealis`\n`😀\nBorealis`\n[[missing|Borealis]]\n[[Borealis]]\nBorealis');
  f.put('notes/b.md', 'Borealis\n[[notes/target]]');
  f.put('notes/c.md', '---\nsource: "[[target]]"\n---\nBorealis');
  assert.deepEqual(mentions(f.ctx, '@notes/target').map(({ path, line }) => [path, line]), [['notes/a.md', 9]]);
});

test('unavailable index falls back to exactly the same results and warns', (t) => {
  const f = fixture(t);
  f.put('notes/a.md', 'Borealis\nışık');
  f.put('notes/private-use.md', '\uE000Borealis\nBorealis\uE000\n\u{F0000}Borealis');
  f.put('notes/𐐀.md', 'Borealis');
  f.put('notes/\uE000.md', 'Borealis');
  f.put('notes/b.md', 'Borealis\n[[target]]');
  const expected = mentions(f.ctx, '@notes/target');
  // A symlink is an unavailable index path, as in the existing index fallback tests.
  const ctx = { ...f.ctx, warnings: [], indexPath: join(f.data, 'cache.db') };
  fs.symlinkSync(f.ctx.indexPath, ctx.indexPath);
  assert.deepEqual(mentions(ctx, '@notes/target'), expected);
  assert.deepEqual(ctx.warnings, ['index_unavailable']);
});

test('FTS phrases treat quotes, operators and punctuation as literal text', (t) => {
  const f = fixture(t);
  f.put('notes/target.md', '---\ntitle: \'Borealis "OR" *\'\naliases: ["C++"]\n---\n');
  f.put('notes/a.md', 'Borealis "OR" *\nC++\n!!!\nBorealis');
  assert.deepEqual(mentions(f.ctx, '@notes/target').map(({ line }) => line), [1, 2]);
  f.put('notes/target.md', '---\ntitle: \'Borealis "OR" *\'\naliases: ["C++", "!!!"]\n---\n');
  const ctx = { ...f.ctx };
  assert.deepEqual(mentions(ctx, '@notes/target').map(({ line }) => line), [1, 2, 3]);
});

test('CLI link patches only the match and undo restores every byte', async (t) => {
  const f = fixture(t);
  const before = Buffer.from('\uFEFF---\r\n# comment\r\ntitle: Source\r\n---\r\n`😀` İŞİK.\r\nTail without newline');
  f.put('notes/a.md', before);
  const args = ['mentions', '@notes/target', '--link', 'notes/a.md:5', '--actor', 'acme'];
  const preview = await f.run([...args, '--dry-run']);
  assert.equal(preview.code, 0, preview.stdout);
  assert.deepEqual(fs.readFileSync(join(f.data, 'notes/a.md')), before);
  const changed = await f.run(args, { isTTY: true, stdin: 'yes\n' });
  assert.equal(changed.code, 0, changed.stdout);
  assert.match(changed.stderr, /notes\/a.md:5/u);
  assert.equal(fs.readFileSync(join(f.data, 'notes/a.md'), 'utf8'), before.toString().replace('İŞİK', '[[target|İŞİK]]'));
  assert.equal(readEvents(f.ctx).at(-1).op, 'mentions.link');
  const undone = await f.run(['undo', '--actor', 'acme']);
  assert.equal(undone.code, 0, undone.stdout);
  assert.deepEqual(fs.readFileSync(join(f.data, 'notes/a.md')), before);
  f.put('notes/a.md', 'target');
  const exact = await f.run(['mentions', '@notes/target', '--link', 'notes/a.md:1', '--actor', 'acme'], { isTTY: true, stdin: 'yes\n' });
  assert.equal(exact.code, 0, exact.stdout);
  assert.equal(fs.readFileSync(join(f.data, 'notes/a.md'), 'utf8'), '[[target]]');
});

test('link refuses multiple matches with a count, nonmentions and unsafe paths', (t) => {
  const f = fixture(t);
  f.put('notes/a.md', 'Borealis and ışık\n`Borealis`');
  assert.throws(() => linkMention(f.ctx, '@notes/target', 'notes/a.md:1'), (error) => error.code === 'validation' && error.details.current.count === 2);
  assert.throws(() => linkMention(f.ctx, '@notes/target', 'notes/a.md:2'), { code: 'validation' });
  assert.throws(() => linkMention(f.ctx, '@notes/target', '../a.md:1'), { code: 'unsafe_path' });
  f.put('notes/b.md', '[[target]]\nBorealis');
  assert.throws(() => linkMention(f.ctx, '@notes/target', 'notes/b.md:2'), { code: 'validation' });
});

test('link cannot bypass a card claim through a mention', (t) => {
  const f = fixture(t);
  f.put('cards/a.md', '---\nassignee: other\nlease: 2026-11-01T12:05:00Z\n---\nBorealis');
  assert.throws(() => linkMention(f.ctx, '@notes/target', 'cards/a.md:5'), { code: 'claimed' });
});

test('link uses the full target path when even an ignored page makes its name ambiguous', (t) => {
  const f = fixture(t);
  f.put('notes/a.md', 'Borealis');
  f.put('raw/target.md', 'Ignored source');
  linkMention(f.ctx, '@notes/target', 'notes/a.md:1');
  assert.equal(fs.readFileSync(join(f.data, 'notes/a.md'), 'utf8'), '[[notes/target|Borealis]]');
});

test('exact target text omits the label and folding expansions preserve source bytes', (t) => {
  const f = fixture(t);
  f.put('notes/target.md', '---\ntitle: notes/target\naliases: [ffi, Borealis]\n---\n');
  f.put('notes/a.md', '\uFEFFtarget\r\nﬃ Borealis\u0301');
  linkMention(f.ctx, '@notes/target', 'notes/a.md:1');
  assert.equal(fs.readFileSync(join(f.data, 'notes/a.md'), 'utf8'), '\uFEFF[[target]]\r\nﬃ Borealis\u0301');
  f.put('notes/b.md', 'ﬃ');
  linkMention({ ...f.ctx }, '@notes/target', 'notes/b.md:1');
  assert.equal(fs.readFileSync(join(f.data, 'notes/b.md'), 'utf8'), '[[target|ﬃ]]');
  f.put('notes/c.md', 'Borealis\u0301');
  linkMention({ ...f.ctx }, '@notes/target', 'notes/c.md:1');
  assert.equal(fs.readFileSync(join(f.data, 'notes/c.md'), 'utf8'), '[[target|Borealis\u0301]]');
});

test('link uses store lock and rejects concurrent changes after reading', (t) => {
  const f = fixture(t);
  f.put('notes/a.md', 'Borealis');
  const lock = join(f.data, '.cairn/locks', `${lockName('notes/a.md')}.lock`);
  fs.__setFsHooks({ afterCheck: (path) => {
    if (path !== lock) return;
    fs.__setFsHooks();
    f.put('notes/a.md', 'External edit');
  } });
  t.after(() => fs.__setFsHooks());
  assert.throws(() => linkMention(f.ctx, '@notes/target', 'notes/a.md:1'), { code: 'conflict' });
  assert.equal(fs.readFileSync(join(f.data, 'notes/a.md'), 'utf8'), 'External edit');
  assert.deepEqual(readEvents(f.ctx), []);
});

test('CLI reads without actor, validates limits and uses existing confirmation rules', async (t) => {
  const f = fixture(t);
  f.put('notes/a.md', 'Borealis');
  const read = await f.run(['mentions', '@notes/target', '--limit', '1']);
  assert.equal(read.code, 0, read.stdout);
  assert.equal(read.json.data.items.length, 1);
  for (const limit of ['-1', '1.5', 'NaN', '501']) {
    assert.equal((await f.run(['mentions', '@notes/target', `--limit=${limit}`])).json.error.code, 'validation');
  }
  const args = ['mentions', '@notes/target', '--link', 'notes/a.md:1', '--actor', 'acme'];
  assert.equal((await f.run(args.slice(0, -2))).json.error.code, 'actor_required');
  assert.equal((await f.run(args)).json.error.code, 'confirmation_required');
  assert.equal((await f.run(['mentions', '@notes/target', '--link=', '--actor', 'acme'])).json.error.code, 'confirmation_required');
  assert.equal((await f.run(args, { isTTY: true, stdin: 'no\n' })).json.error.code, 'confirmation_required');
  assert.equal((await f.run(args, { isTTY: true, stdin: 'yes\n', env: { CODEX_THREAD_ID: 'fixture' } })).json.error.code, 'confirmation_required');
});
