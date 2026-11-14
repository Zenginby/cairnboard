import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';

function fixture(visibility = 'visible', { notReady = false } = {}) {
  const documentEvents = {}, windowEvents = {}, requests = [], sources = [], timers = new Map();
  let now = 100_000, timerId = 0, html = 'new content', replacements = 0, probeStatus = 200, pageText;
  const status = { textContent: '', dataset: { paused: 'Live updates paused', updated: 'Updated' } };
  const focused = { id: 'card-link', isConnected: true, getAttribute: () => '/cards/c-000001',
    focus(options) { this.restored = options.preventScroll; } };
  const region = { dataset: { live: 'card project board' }, innerHTML: 'old content', contains: () => true,
    querySelectorAll: () => [], querySelector: (selector) => selector === '[data-not-ready]' && notReady ? {} : null,
    replaceChildren: (...nodes) => { replacements++; region.innerHTML = nodes.join(''); } };
  const document = { documentElement: { dataset: {} }, visibilityState: visibility, activeElement: focused,
    querySelector: (selector) => selector === '[data-live]' ? region : status,
    getElementById: () => focused, addEventListener: (type, handler) => { documentEvents[type] = handler; } };
  const window = { scrollX: 10, scrollY: 120, scrollTo(options) { this.restored = options; },
    addEventListener: (type, handler) => { windowEvents[type] = handler; } };
  class EventSource {
    static CLOSED = 2;
    constructor(url) { assert.equal(url, '/api/events'); this.handlers = new Map(); this.readyState = 0; sources.push(this); }
    addEventListener(type, handler) { this.handlers.set(type, handler); }
    close() { this.readyState = EventSource.CLOSED; this.closed = true; }
  }
  class DOMParser {
    parseFromString(text) { return { title: 'Updated board', querySelector: () => ({ innerHTML: text, childNodes: [text] }) }; }
  }
  const fetch = async (url, options) => {
    requests.push({ url, options });
    if (options?.method === 'HEAD') return { status: probeStatus };
    return { ok: true, text: async () => pageText ? pageText() : html };
  };
  runInNewContext(readFileSync(new URL('../src/scripts/live-updates.js', import.meta.url), 'utf8'), {
    document, window, location: { href: 'http://example.test/board' }, EventSource, DOMParser, fetch,
    Date: { now: () => now },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const emit = async (type, data, source = sources.at(-1)) => {
    if (type === 'open') source.readyState = 1;
    source.handlers.get(type)?.({ data: JSON.stringify(data) });
    await setImmediate();
  };
  const advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
      await setImmediate();
    }
    now = end;
  };
  const visible = async (state) => { document.visibilityState = state; documentEvents.visibilitychange(); await setImmediate(); };
  return { status, requests, document, window, focused, emit, advance, visible, sources, region,
    setPageText: (read) => { pageText = read; }, setHTML: (text) => { html = text; },
    setProbe: (status) => { probeStatus = status; },
    documentEvents, windowEvents, replacements: () => replacements };
}

test('live client replaces only affected content, preserving focus and scroll without navigation', async () => {
  const f = fixture();
  await f.emit('change', { kinds: ['journal'] });
  assert.equal(f.requests.length, 0);
  await f.emit('change', { kinds: ['card'], ids: ['c-000001'] });
  assert.equal(f.replacements(), 1);
  assert.equal(f.requests[0].url, 'http://example.test/board');
  assert.equal(f.requests[0].options.credentials, 'same-origin');
  assert.equal(f.focused.restored, true);
  assert.equal(f.window.restored.top, 120);
  assert.equal(f.window.restored.left, 10);
  assert.equal(f.window.restored.behavior, 'instant');
  assert.equal(f.status.textContent, 'Updated');
});

test('initial connection reconciles without refetching, swapping or announcing', async () => {
  const f = fixture();
  await f.emit('open');
  assert.deepEqual(f.requests.map(({ url }) => url), ['/api/reconcile']);
  assert.equal(f.replacements(), 0);
  assert.equal(f.focused.restored, undefined);
  assert.equal(f.status.textContent, '');
});

test('a not-ready page refetches after its first connection, in case the data appeared before it', async () => {
  const f = fixture('visible', { notReady: true });
  await f.emit('open');
  assert.deepEqual(f.requests.map(({ url }) => url), ['/api/reconcile', 'http://example.test/board']);
  assert.equal(f.replacements(), 1);
});

test('automatic reconnect reports three failures then refreshes missed content', async () => {
  const f = fixture();
  await f.emit('error');
  await f.emit('error');
  assert.equal(f.status.textContent, '');
  await f.emit('error');
  assert.equal(f.status.textContent, 'Live updates paused');
  await f.emit('open');
  assert.equal(f.status.textContent, 'Updated');
  assert.equal(f.sources.length, 1, 'CONNECTING errors use EventSource reconnect');
  assert.equal(f.replacements(), 1);
});

test('hidden tabs close streams, cancel retries and reopen with one reconcile and refresh', async () => {
  const f = fixture();
  const first = f.sources[0];
  await f.visible('hidden');
  assert.equal(first.closed, true);
  f.windowEvents.focus();
  assert.equal(f.requests.length, 0);
  await f.emit('error', undefined, first);
  await f.advance(60_000);
  assert.equal(f.sources.length, 1);
  await f.visible('visible');
  assert.equal(f.sources.length, 2);
  f.windowEvents.focus();
  await f.emit('open');
  assert.equal(f.requests.filter(({ url }) => url === '/api/reconcile').length, 1);
  assert.equal(f.replacements(), 1);
  const hidden = fixture('hidden');
  assert.equal(hidden.sources.length, 0);
});

test('terminal SSE failures immediately pause and retry with capped backoff', async () => {
  const f = fixture();
  for (const delay of [2000, 5000, 15_000, 60_000, 60_000]) {
    const count = f.sources.length;
    f.sources.at(-1).readyState = 2;
    await f.emit('error');
    assert.equal(f.status.textContent, 'Live updates paused');
    await f.advance(delay - 1);
    assert.equal(f.sources.length, count);
    await f.advance(1);
    assert.equal(f.sources.length, count + 1);
  }
  await f.emit('open');
  assert.equal(f.replacements(), 1);
  f.sources.at(-1).readyState = 2;
  await f.emit('error');
  const count = f.sources.length;
  await f.visible('hidden');
  await f.advance(60_000);
  assert.equal(f.sources.length, count, 'hidden tabs do not retry');
});

test('unchanged content is not swapped and update announcements clear and can repeat', async () => {
  const f = fixture();
  f.setHTML(f.region.innerHTML);
  await f.emit('change', { kinds: ['card'] });
  assert.equal(f.replacements(), 0);
  assert.equal(f.status.textContent, '');
  f.setHTML('changed');
  await f.emit('change', { kinds: ['card'] });
  assert.equal(f.status.textContent, 'Updated');
  await f.advance(3000);
  assert.equal(f.status.textContent, '');
  await f.emit('change', { kinds: ['card'] });
  assert.equal(f.replacements(), 1);
  assert.equal(f.status.textContent, '');
  f.setHTML('changed again');
  await f.emit('change', { kinds: ['card'] });
  assert.equal(f.status.textContent, 'Updated');
  assert.equal(f.replacements(), 2);
});

test('a 404 on the stream (live updates switched off) stops the retries for good', async () => {
  const f = fixture();
  f.setProbe(404);
  f.sources.at(-1).readyState = 2;
  await f.emit('error');
  assert.equal(f.status.textContent, 'Live updates paused');
  await f.advance(2000);
  assert.equal(f.sources.length, 1, 'no new connection');
  assert.equal(f.status.textContent, '', 'the paused notice is not left behind');
  await f.advance(10 * 60_000);
  assert.equal(f.sources.length, 1);
  assert.deepEqual(f.requests.map(({ options }) => options?.method), ['HEAD'], 'one probe, then silence');
  assert.equal(f.requests[0].url, '/api/events');
});

test('a failed probe or a non-404 answer keeps retrying with the usual backoff', async () => {
  const f = fixture();
  f.setProbe(503);
  f.sources.at(-1).readyState = 2;
  await f.emit('error');
  await f.advance(2000);
  assert.equal(f.sources.length, 2);
  f.sources.at(-1).readyState = 2;
  await f.emit('error');
  await f.advance(5000);
  assert.equal(f.sources.length, 3);
});

test('paused live updates coalesce into one refresh after a move resumes', async () => {
  const f = fixture();
  f.document.documentElement.dataset.livePaused = 'true';
  await f.emit('change', { kinds: ['card'] });
  await f.emit('change', { kinds: ['board'] });
  assert.equal(f.requests.length, 0);
  assert.equal(f.replacements(), 0);
  delete f.document.documentElement.dataset.livePaused;
  f.documentEvents['live:resume']();
  await setImmediate();
  assert.equal(f.requests.length, 1);
  assert.equal(f.replacements(), 1);
});

test('a page fetch already in flight cannot replace the board after a drag pauses it', async () => {
  const f = fixture();
  let release;
  f.setPageText(() => new Promise((done) => { release = done; }));
  await f.emit('change', { kinds: ['card'] });
  assert.equal(f.requests.length, 1);
  f.document.documentElement.dataset.livePaused = 'true';
  release('stale page');
  await setImmediate();
  assert.equal(f.replacements(), 0);
  f.setPageText(null);
  f.setHTML('fresh page');
  delete f.document.documentElement.dataset.livePaused;
  f.documentEvents['live:resume']();
  await setImmediate();
  assert.equal(f.requests.length, 2);
  assert.equal(f.region.innerHTML, 'fresh page');
});
