import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { __setFsHooks } from '../core/fsx.mjs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import * as index from '../core/index.mjs';
import { projectMap } from '../server/read.mjs';
import { WEB_SEARCH_TYPES, snippetHtml, searchView } from '../server/search.mjs';
import { tempDir, fixedClock } from './support/env.mjs';

function fixture(t) {
  const data = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(data, { home, env: {}, clock });
  const put = (path, fields, body = '') => {
    mkdirSync(dirname(join(data, path)), { recursive: true });
    const front = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
    writeFileSync(join(data, path), `---\n${front}\n---\n${body}`);
  };
  put('projects/alpha.md', { id: 'p-000001', title: 'Alpha', tone: 3 });
  for (let n = 1; n <= 7; n++) {
    put(`cards/card-${n}.md`, { id: `c-00000${n}`, title: `Card ${n}`, column: 'doing', project: 'p-000001',
      updated: `2026-11-0${n}T00:00:00Z` }, `Release plan step ${n}`);
  }
  put('notes/attack.md', { id: 'n-000001', title: 'Attack \uE000title\uE001' }, '<img src=x onerror=1> \uE000 plan');
  put('notes/plain.md', { id: 'n-000002', title: 'Plain <b>note</b>' }, 'A plan & more');
  put('notes/other.md', { id: 'n-000003', title: 'Other' }, 'Nothing here');
  const reopen = () => {
    const ctx = openContext({ mode: 'read', dataDir: data, home, env: {}, clock });
    return { ctx, projects: projectMap(ctx) };
  };
  return { ...reopen(), data, put, reopen };
}

test('WEB_SEARCH_TYPES lists the searchable web types and is frozen', () => {
  assert.deepEqual(WEB_SEARCH_TYPES, ['card', 'note']);
  assert.ok(Object.isFrozen(WEB_SEARCH_TYPES));
});

test('snippetHtml escapes text and turns only balanced marks into <mark>', () => {
  assert.equal(snippetHtml('a \uE000<b>\uE001 & c', { marked: true, terms: [] }), 'a <mark>&lt;b&gt;</mark> &amp; c');
  assert.equal(snippetHtml('x \uE000y', { marked: true, terms: [] }), 'x y'); // unbalanced → plain
  assert.equal(snippetHtml('\uE000a\uE000b\uE001\uE001', { marked: true, terms: [] }), 'ab'); // nested → plain
  assert.equal(snippetHtml('\uE001a\uE000', { marked: true, terms: [] }), 'a'); // close before open → plain
  assert.equal(snippetHtml(`"q" 'r'`, { marked: true, terms: [] }), '&quot;q&quot; &#39;r&#39;');
});

test('snippetHtml fallback marks whole words whose fold equals a term', () => {
  assert.equal(snippetHtml('ıstanbul ve istanbullu', { marked: false, terms: ['istanbul'] }),
    '<mark>ıstanbul</mark> ve istanbullu');
  assert.equal(snippetHtml('<x> plan \uE000', { marked: false, terms: ['plan'] }), '&lt;x&gt; <mark>plan</mark> ');
});

test('searchView splits types, caps limit and q, counts with a ceiling', (t) => {
  const { ctx, projects } = fixture(t);
  const view = searchView(ctx, { q: 'plan', limit: 5 }, projects);
  assert.equal(view.query, 'plan');
  assert.equal(view.type, null);
  assert.equal(view.results.card.length, 5);
  assert.equal(view.more.card, true);
  assert.equal(view.counts.card, 7);
  assert.equal(view.results.note.length, 2);
  assert.equal(view.more.note, false);
  assert.equal(view.counts.note, 2);
  const [card] = view.results.card;
  assert.deepEqual(Object.keys(card).sort(), ['column', 'project', 'ref', 'snippetHtml', 'title', 'type', 'updated']);
  assert.equal(card.type, 'card');
  assert.match(card.ref, /^c-00000\d$/u);
  assert.deepEqual(card.project, { id: 'p-000001', name: 'Alpha', tone: 3 });
  assert.equal(card.column, 'Doing');
  assert.match(card.updated, /^2026-11-0\dT/u);
  assert.match(card.snippetHtml, /<mark>plan<\/mark>/u);
  const plain = view.results.note.find((row) => row.ref === 'n-000002');
  assert.equal(plain.title, 'Plain <b>note</b>', 'titles are plain text, never HTML');
  assert.equal(plain.project, null);
  assert.equal(plain.column, null);
  assert.equal(searchView(ctx, { q: 'x'.repeat(500) }, projects).query.length, 200);
  assert.equal(searchView(ctx, { q: '  plan  ' }, projects).query, 'plan');
  assert.equal(searchView(ctx, { q: 'plan', limit: 999 }, projects).results.card.length, 7); // clamped to 50
  for (const limit of [undefined, 0, -1, 2.5, Number.NaN]) {
    assert.equal(searchView(ctx, { q: 'plan', limit }, projects).results.card.length, 5, String(limit)); // default
  }
  const cards = searchView(ctx, { q: 'plan', type: 'card' }, projects);
  assert.equal(cards.type, 'card');
  assert.deepEqual(cards.results.note, []);
  assert.equal(cards.more.note, false);
  assert.deepEqual(cards.counts, { card: 7, note: 2 }, 'filter pills keep counts for every type');
});

test('symbol-only and empty queries return empty results', (t) => {
  const { ctx, projects } = fixture(t);
  for (const q of ['', '   ', '%%', '++', '"', '()*']) {
    const view = searchView(ctx, { q }, projects);
    assert.deepEqual([view.results.card, view.results.note], [[], []]);
    assert.deepEqual(view.counts, { card: 0, note: 0 });
  }
  // FTS syntax never reaches SQLite raw
  assert.doesNotThrow(() => searchView(ctx, { q: 'c++ "a" OR NEAR(' }, projects));
});

test('invalid type throws validation', (t) => {
  const { ctx, projects } = fixture(t);
  for (const type of ['project', 'raw', 'CARD']) {
    assert.throws(() => searchView(ctx, { q: 'a', type }, projects), { code: 'validation' });
  }
});

test('file containing marker characters cannot inject html', (t) => {
  const { ctx, projects } = fixture(t);
  const note = searchView(ctx, { q: 'plan' }, projects).results.note.find((row) => row.ref === 'n-000001');
  assert.equal(note.snippetHtml.includes('<img'), false);
  assert.ok(note.snippetHtml.includes('&lt;img'));
  assert.equal(/[\uE000\uE001]/u.test(note.snippetHtml), false);
  const tags = note.snippetHtml.replace(/&[a-z]+;|&#\d+;/gu, '').match(/<\/?[a-z]+/gu);
  assert.equal(tags?.every((tag) => /^<\/?mark$/u.test(tag)) ?? true, true);
  assert.equal(note.title, 'Attack title');
});

test('searchView marks query words itself when the index is unavailable', (t) => {
  const { ctx, projects } = fixture(t);
  searchView(ctx, { q: 'plan' }, projects);
  const blocker = new DatabaseSync(ctx.indexPath);
  t.after(() => { if (blocker.isOpen) blocker.close(); });
  blocker.exec('BEGIN IMMEDIATE');
  const fallback = { ...ctx, warnings: [], indexTimeoutMs: 50 };
  const view = searchView(fallback, { q: 'PLAN' }, projects);
  blocker.exec('ROLLBACK');
  blocker.close();
  assert.ok(fallback.warnings.includes('index_unavailable'));
  assert.equal(view.counts.card, 7);
  const note = view.results.note.find((row) => row.ref === 'n-000001');
  assert.equal(note.snippetHtml, '&lt;img src=x onerror=1&gt; <mark>plan</mark>');
});

test('snippet keeps original casing and Turkish letters', (t) => {
  let { ctx, projects, put , reopen } = fixture(t);
  put('notes/trip.md', { id: 'n-000010', title: 'Trip' }, 'Yarın\nİstanbul Toplantısı var');
  ({ ctx, projects } = reopen());
  const [note] = searchView(ctx, { q: 'istanbul toplantisi' }, projects).results.note;
  assert.equal(note.snippetHtml, 'Yarın <mark>İstanbul</mark> <mark>Toplantısı</mark> var');
});

test('snippet is a window of words around the first hit, with ellipses where cut', (t) => {
  let { ctx, projects, put , reopen } = fixture(t);
  const words = Array.from({ length: 40 }, (_, n) => `w${n}`);
  words[20] = 'Needle';
  put('notes/long.md', { id: 'n-000011', title: 'Long' }, `# Head\n\n${words.join(' ')}.`);
  ({ ctx, projects } = reopen());
  const [note] = searchView(ctx, { q: 'needle' }, projects).results.note;
  assert.equal(note.snippetHtml,
    `… ${words.slice(12, 20).join(' ')} <mark>Needle</mark> ${words.slice(21, 36).join(' ')} …`);
  const head = Array.from({ length: 30 }, (_, n) => `h${n}`);
  put('notes/title.md', { id: 'n-000012', title: 'Budget' }, `${head.join(' ')}\n`);
  ({ ctx, projects } = reopen());
  const [titled] = searchView(ctx, { q: 'budget' }, projects).results.note;
  assert.equal(titled.snippetHtml, `${head.slice(0, 24).join(' ')} …`,
    'a title-only hit shows the start of the body, unmarked');
});

test('an unreadable file falls back to the folded index snippet', (t) => {
  let { ctx, projects, put, data , reopen } = fixture(t);
  put('notes/trip.md', { id: 'n-000010', title: 'Trip' }, 'Yarın İstanbul <b>Toplantısı</b> var');
  ({ ctx, projects } = reopen());
  searchView(ctx, { q: 'istanbul' }, projects);
  const path = join(data, 'notes/trip.md');
  __setFsHooks({ openSync(target, ...args) {
    if (target === path) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return openSync(target, ...args);
  } });
  t.after(() => __setFsHooks());
  const [note] = searchView(ctx, { q: 'istanbul' }, projects).results.note;
  assert.equal(note.snippetHtml, 'yarin <mark>istanbul</mark> &lt;b&gt;toplantisi&lt;/b&gt; var');
});

test('cards without an id are left out of results and counts', (t) => {
  let { ctx, projects, put , reopen } = fixture(t);
  put('cards/idless.md', { title: 'Idless plan', column: 'doing' }, 'Another plan');
  ({ ctx, projects } = reopen());
  assert.ok(index.search(ctx, 'plan', { type: 'card', limit: 50 }).some((hit) => hit.id === null),
    'the index finds the idless card');
  const view = searchView(ctx, { q: 'plan', type: 'card', limit: 50 }, projects);
  assert.equal(view.counts.card, 7);
  assert.equal(view.results.card.length, 7);
  assert.ok(view.results.card.every((row) => /^c-\d{6}$/u.test(row.ref)));
});

test('snippet length is capped even for bodies without words or with one huge word', (t) => {
  const { put, reopen, data } = fixture(t);
  put('notes/symbols.md', { id: 'n-000010', title: 'Needle symbols' }, '<'.repeat(300 * 1024));
  put('notes/word.md', { id: 'n-000011', title: 'Needle word' }, 'a'.repeat(100 * 1024));
  const { ctx, projects } = reopen();
  const check = () => {
    const notes = searchView(ctx, { q: 'needle' }, projects).results.note;
    assert.equal(notes.length, 2);
    for (const note of notes) {
      assert.ok(note.snippetHtml.length < 2000, `${note.ref}: ${note.snippetHtml.length} characters`);
      assert.match(note.snippetHtml, /…$/u);
    }
  };
  check();
  // Unreadable originals must not expose an unbounded FTS snippet either.
  __setFsHooks({ openSync(target, ...args) {
    if (target === join(data, 'notes/symbols.md') || target === join(data, 'notes/word.md')) {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }
    return openSync(target, ...args);
  } });
  t.after(() => __setFsHooks());
  check();
});

test('ineligible cards ranked before an eligible card do not hide it', (t) => {
  const { put, reopen } = fixture(t);
  for (let n = 0; n < 4; n++) put(`cards/a-idless-${n}.md`, { title: 'Needle' }, 'Needle');
  put('cards/z-eligible.md', { id: 'c-000010', title: 'Eligible' }, `Needle ${'padding '.repeat(40)}`);
  const { ctx, projects } = reopen();
  const check = (context) => {
    assert.equal(index.search(context, 'needle', { type: 'card', limit: 1 })[0].id, null);
    // Exercise the same eligibility used by the web count/results with a SQL/scan limit of one.
    const hits = index.search(context, 'needle', { type: 'card', limit: 1, validIdsOnly: true });
    assert.deepEqual(hits.map((hit) => hit.ref), ['c-000010']);
    const view = searchView(context, { q: 'needle', limit: 1 }, projects);
    assert.deepEqual(view.results.card.map((hit) => hit.ref), ['c-000010']);
    assert.equal(view.counts.card, 1);
    assert.equal(view.more.card, false);
  };
  check(ctx);
  const blocker = new DatabaseSync(ctx.indexPath);
  t.after(() => { if (blocker.isOpen) blocker.close(); });
  blocker.exec('BEGIN IMMEDIATE');
  check({ ...ctx, warnings: [], indexTimeoutMs: 10 });
  blocker.exec('ROLLBACK');
  blocker.close();
});

test('combining marks stay inside a word for windows and highlights', (t) => {
  const { put, reopen } = fixture(t);
  put('notes/trip.md', { id: 'n-000010', title: 'Trip' }, `${'intro '.repeat(40)}İstanbul meeting`);
  const { ctx, projects } = reopen();
  const check = (context) => {
    const [note] = searchView(context, { q: 'istanbul' }, projects).results.note;
    assert.equal(note.snippetHtml, `… ${'intro '.repeat(8)}<mark>İstanbul</mark> meeting`);
  };
  check(ctx);
  const blocker = new DatabaseSync(ctx.indexPath);
  t.after(() => { if (blocker.isOpen) blocker.close(); });
  blocker.exec('BEGIN IMMEDIATE');
  check({ ...ctx, warnings: [], indexTimeoutMs: 10 });
  blocker.exec('ROLLBACK');
  blocker.close();
});

test('cards with an id the detail route rejects are left out', (t) => {
  const { put, reopen } = fixture(t);
  put('cards/legacy.md', { id: 'legacy-42', title: 'Needle legacy' }, 'Needle');
  put('cards/noncanonical.md', { id: 'C-OOOOIO', title: 'Needle noncanonical' }, 'Needle');
  put('cards/eligible.md', { id: 'c-000010', title: 'Needle eligible' }, 'Needle');
  const { ctx, projects } = reopen();
  const check = (context) => {
    const view = searchView(context, { q: 'needle' }, projects);
    assert.equal(view.counts.card, 1);
    assert.deepEqual(view.results.card.map((hit) => hit.ref), ['c-000010']);
  };
  check(ctx);
  const blocker = new DatabaseSync(ctx.indexPath);
  t.after(() => { if (blocker.isOpen) blocker.close(); });
  blocker.exec('BEGIN IMMEDIATE');
  check({ ...ctx, warnings: [], indexTimeoutMs: 10 });
  blocker.exec('ROLLBACK');
  blocker.close();
});

test('searchView treats an empty type like all types', (t) => {
  const { ctx, projects } = fixture(t);
  const view = searchView(ctx, { q: 'plan', type: '' }, projects);
  assert.equal(view.type, null);
  assert.ok(view.results.card.length > 0 && view.results.note.length > 0);
});

test('snippet window is as long when the hit is near the start as for a title-only match', (t) => {
  let { ctx, projects, put, reopen } = fixture(t);
  const words = Array.from({ length: 40 }, (_, n) => `w${n}`);
  words[2] = 'Needle';
  put('notes/early.md', { id: 'n-000013', title: 'Early' }, `${words.join(' ')}.`);
  ({ ctx, projects } = reopen());
  const [note] = searchView(ctx, { q: 'needle' }, projects).results.note;
  assert.equal(note.snippetHtml,
    `${words.slice(0, 2).join(' ')} <mark>Needle</mark> ${words.slice(3, 24).join(' ')} …`);
});

test('snippetHtml with unbalanced marks still highlights whole-word terms', () => {
  assert.equal(snippetHtml('x plan <b>', { marked: true, terms: ['plan'] }), 'x <mark>plan</mark> &lt;b&gt;');
});

test('searchView with a null type works when the index is unavailable', (t) => {
  const { ctx, projects } = fixture(t);
  searchView(ctx, { q: 'plan' }, projects);
  const blocker = new DatabaseSync(ctx.indexPath);
  t.after(() => { if (blocker.isOpen) blocker.close(); });
  blocker.exec('BEGIN IMMEDIATE');
  const fallback = { ...ctx, warnings: [], indexTimeoutMs: 50 };
  const found = index.search(fallback, 'plan', { type: null });
  const count = index.searchCount(fallback, 'plan', { type: null });
  blocker.exec('ROLLBACK');
  blocker.close();
  assert.ok(fallback.warnings.includes('index_unavailable'));
  assert.ok(found.length > 0);
  assert.ok(count >= found.length);
});

test('search results carry project and column after the per-path lookup', (t) => {
  const { ctx, projects } = fixture(t);
  const view = searchView(ctx, { q: 'plan', limit: 2 }, projects);
  assert.equal(view.results.card.length, 2);
  for (const card of view.results.card) {
    assert.deepEqual(card.project, { id: 'p-000001', name: 'Alpha', tone: 3 });
    assert.equal(typeof card.column, 'string');
    assert.ok(card.updated);
  }
});

test('rowsByPath returns only the requested rows, with the index and without it', (t) => {
  const { ctx } = fixture(t);
  index.rows(ctx, 'card');
  const paths = ['cards/card-2.md', 'notes/plain.md', 'cards/missing.md'];
  const shape = (rows) => rows.map((row) => [row.path, row.type, row.id]);
  const expected = [['cards/card-2.md', 'card', 'c-000002'], ['notes/plain.md', 'note', 'n-000002']];
  assert.deepEqual(shape(index.rowsByPath(ctx, paths)), expected);
  assert.deepEqual(index.rowsByPath(ctx, []), []);
  const blocker = new DatabaseSync(ctx.indexPath);
  t.after(() => { if (blocker.isOpen) blocker.close(); });
  blocker.exec('BEGIN IMMEDIATE');
  const fallback = { ...ctx, warnings: [], indexTimeoutMs: 50 };
  assert.deepEqual(shape(index.rowsByPath(fallback, paths)), expected);
  blocker.exec('ROLLBACK');
  blocker.close();
  assert.ok(fallback.warnings.includes('index_unavailable'));
});
