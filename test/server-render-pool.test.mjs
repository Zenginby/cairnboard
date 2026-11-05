import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRenderPool } from '../server/render-pool.mjs';
import { renderMarkdown } from '../core/render.mjs';

// Measured: 40 KB of nested emphasis takes the parser over 20 s; a few thousand nested quotes overflow its stack.
const slow = `${'*'.repeat(20_000)}a${'*'.repeat(20_000)}`;
const deep = `${'>'.repeat(4000)}x`;

test('renders in a worker and resolves wiki links from the given pairs', async (t) => {
  const pool = createRenderPool();
  t.after(() => pool.close());
  const result = await pool.render('Hi [[Page]] and [[Gone]]', [[JSON.stringify(['Page', '']), { type: 'note', id: 'n-000001' }]]);
  assert.equal(result.html, '<p>Hi <a class="wikilink" href="/notes/n-000001">Page</a> and <span class="wikilink wikilink-ghost">Gone</span></p>');
  assert.equal(result.timedOut, false);
});

test('a page over the time limit is given up and the next page still renders', async (t) => {
  const pool = createRenderPool({ timeoutMs: 300 });
  t.after(() => pool.close());
  const started = Date.now();
  const [stuck, next] = await Promise.all([pool.render(slow), pool.render('**ok**')]);
  assert.deepEqual(stuck, { html: null, tooLarge: false, failed: false, timedOut: true });
  assert.equal(next.html, '<p><strong>ok</strong></p>');
  assert.ok(Date.now() - started < 10_000, 'the slow page must not run to completion');
});

test('deep nesting never throws: in process it fails cleanly, in the worker it answers', async (t) => {
  const pool = createRenderPool();
  t.after(() => pool.close());
  assert.deepEqual(renderMarkdown(deep), { html: null, failed: true });
  // The worker has a larger stack, so it may render what overflows the main thread; either way it answers.
  const result = await pool.render(deep);
  assert.equal(result.timedOut, false);
  assert.ok(result.failed || result.html.startsWith('<blockquote>'));
  assert.equal((await pool.render('after')).html, '<p>after</p>');
});

test('a full queue answers at once instead of growing without bound', async (t) => {
  const pool = createRenderPool({ timeoutMs: 2000, maxQueue: 1 });
  t.after(() => pool.close());
  const first = pool.render(slow);
  const second = pool.render('queued');
  assert.deepEqual(await pool.render('overflow'), { html: null, tooLarge: false, failed: true, timedOut: false });
  pool.close();
  assert.equal((await second).failed, true);
  await first;
});

test('a page that timed out answers at once the next time instead of holding the queue again', async (t) => {
  const pool = createRenderPool({ timeoutMs: 300 });
  t.after(() => pool.close());
  assert.equal((await pool.render(slow)).timedOut, true);
  const started = Date.now();
  assert.equal((await pool.render(slow)).timedOut, true);
  assert.ok(Date.now() - started < 100, 'a known slow page must not be rendered again');
  assert.equal((await pool.render('fine')).html, '<p>fine</p>');
});

test('closing during a render fails that page at once', async () => {
  const pool = createRenderPool({ timeoutMs: 60_000 });
  const pending = pool.render(slow);
  const started = Date.now();
  pool.close();
  assert.equal((await pending).failed, true);
  assert.ok(Date.now() - started < 1000);
});

test('a worker that cannot start fails each page instead of leaving the queue waiting', async (t) => {
  const pool = createRenderPool({ workerUrl: new URL('./does-not-exist.mjs', import.meta.url) });
  t.after(() => pool.close());
  const results = await Promise.all([pool.render('a'), pool.render('b')]);
  assert.deepEqual(results.map((result) => result.failed), [true, true]);
});
