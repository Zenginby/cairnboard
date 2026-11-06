import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { __setFsHooks } from '../core/fsx.mjs';
import { homeView } from '../cli/views.mjs';
import { okEnvelope } from '../cli/output.mjs';
import { createRead, DataNotReadyError } from '../server/read.mjs';
import { createRenderPool } from '../server/render-pool.mjs';
import tr from '../src/i18n/tr.json' with { type: 'json' };
import en from '../src/i18n/en.json' with { type: 'json' };
import { language, t as translate } from '../src/i18n/index.mjs';
import { tempDir, fixedClock } from './support/env.mjs';

function fixture(t, body) {
  const data = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(data, { home, env: {}, clock });
  mkdirSync(join(data, 'notes'), { recursive: true });
  writeFileSync(join(data, 'notes/pinned.md'), '---\nid: n-000001\ntitle: Pinned title\npinned: true\n---\nA note.');
  if (body !== undefined) {
    mkdirSync(join(data, 'journal'), { recursive: true });
    writeFileSync(join(data, 'journal/2026-11-01.md'), `---\ndate: 2026-11-01\n---\n${body}`);
  }
  const ctx = openContext({ mode: 'read', dataDir: data, home, env: {}, clock });
  return { ctx, data };
}

test('in-process Home returns the CLI envelope and combines context and view warnings', async (t) => {
  const { ctx } = fixture(t);
  ctx.warnings.push('pending_recovery', 'pending_recovery');
  const view = homeView(ctx);
  let opens = 0;
  const reader = createRead({ open: () => { opens++; return ctx; } });
  const result = await reader.home();
  assert.deepEqual(result, okEnvelope(view.data, [...ctx.warnings, ...view.warnings]));
  assert.equal(result.data.pinned[0].content.title, 'Pinned title');
  assert.equal(result.warnings.filter((code) => code === 'pending_recovery').length, 1);
  await reader.home();
  assert.equal(opens, 2, 'each request opens a fresh read context');
});

test('Home renders the journal from one full source read through the sanitized Markdown worker', async (t) => {
  const body = '## Daily work\n\n**Finished** [[pinned|Pinned title]].\n\n<script>alert("journal attack")</script>';
  const { ctx, data } = fixture(t, body);
  homeView(ctx);
  const source = join(data, 'journal/2026-11-01.md');
  let reads = 0;
  __setFsHooks({ openSync(path, ...args) {
    if (path === source) reads++;
    return openSync(path, ...args);
  } });
  t.after(() => __setFsHooks());
  const pool = createRenderPool();
  t.after(() => pool.close());
  const result = await createRead({ open: () => ctx, render: pool.render }).home();
  assert.equal(reads, 1);
  assert.equal(result.data.journal.content.body, body);
  assert.match(result.data.journal.content.html, /<h2>Daily work<\/h2>/u);
  assert.match(result.data.journal.content.html, /<strong>Finished<\/strong>/u);
  assert.match(result.data.journal.content.html, /href="\/notes\/n-000001"/u);
  assert.doesNotMatch(result.data.journal.content.html, /<script|alert\(|\[\[/u);
});

test('Home renders the full journal rather than its bounded plain-text content', async (t) => {
  const body = `${'a'.repeat(70_000)}\n\n## End marker`;
  const { ctx } = fixture(t, body);
  const result = await createRead({ open: () => ctx, render: (markdown) => {
    assert.equal(markdown, body);
    return { html: '<h2>End marker</h2>' };
  } }).home();
  assert.equal(result.data.journal.content.body.length, 65536);
  assert.equal(result.data.journal.content.html, '<h2>End marker</h2>');
  assert.ok(result.warnings.includes('truncated'));
});

test('Home journal render limits and failures retain plain text with the API warning codes', async (t) => {
  const { ctx } = fixture(t, '## Daily work');
  for (const [flag, code] of [['tooLarge', 'too_large'], ['timedOut', 'render_timeout'], ['failed', 'render_failed']]) {
    const result = await createRead({ open: () => ctx, render: () => ({ html: null, [flag]: true }) }).home();
    assert.equal(result.data.journal.content.html, null);
    assert.equal(result.data.journal.content.body, '## Daily work');
    assert.ok(result.warnings.includes(code), code);
  }
  const oversized = fixture(t, 'x'.repeat(5 * 1024 * 1024 + 1));
  const result = await createRead({ open: () => oversized.ctx, render: () => assert.fail('oversized journal must not reach the worker') }).home();
  assert.equal(result.data.journal.content.html, null);
  assert.ok(result.warnings.includes('too_large'));
});

test('only context-open failures become data-not-ready errors', async () => {
  const failure = new Error('open failed');
  for (const open of [() => { throw failure; }, async () => { throw failure; }]) {
    await assert.rejects(createRead({ open }).home(), (error) => {
      assert.ok(error instanceof DataNotReadyError);
      assert.equal(error.code, 'data_not_ready');
      assert.equal(error.cause, failure);
      return true;
    });
  }
  await assert.rejects(createRead({ open: () => null }).home(), (error) => {
    assert.ok(!(error instanceof DataNotReadyError));
    return true;
  });
});

test('Home dictionaries share keys and the language is chosen in one place', () => {
  assert.deepEqual(Object.keys(tr).sort(), Object.keys(en).sort());
  assert.equal(language, 'tr');
  assert.equal(translate('shell.home'), tr['shell.home']);
  for (const value of [...Object.values(tr), ...Object.values(en)]) assert.ok(value.trim());
});
