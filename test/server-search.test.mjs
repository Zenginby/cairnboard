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
    writeFileSync(join(data, path), `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n${body}`);
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
  assert.equal(snippetHtml('ıstanbul ve istanbullu', { marked: false, terms: ['istanbul'] }), '<mark>ıstanbul</mark> ve istanbullu');
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
  assert.doesNotThrow(() => searchView(ctx, { q: 'c++ "a" OR NEAR(' }, projects)); // FTS syntax never reaches SQLite raw
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
  assert.equal(note.snippetHtml.replace(/&[a-z]+;|&#\d+;/gu, '').match(/<\/?[a-z]+/gu)?.every((tag) => /^<\/?mark$/u.test(tag)) ?? true, true);
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
  assert.equal(note.snippetHtml, `… ${words.slice(12, 20).join(' ')} <mark>Needle</mark> ${words.slice(21, 36).join(' ')} …`);
  const head = Array.from({ length: 30 }, (_, n) => `h${n}`);
  put('notes/title.md', { id: 'n-000012', title: 'Budget' }, `${head.join(' ')}\n`);
  ({ ctx, projects } = reopen());
  const [titled] = searchView(ctx, { q: 'budget' }, projects).results.note;
  assert.equal(titled.snippetHtml, `${head.slice(0, 24).join(' ')} …`, 'a title-only hit shows the start of the body, unmarked');
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
  assert.ok(index.search(ctx, 'plan', { type: 'card', limit: 50 }).some((hit) => hit.id === null), 'the index finds the idless card');
  const view = searchView(ctx, { q: 'plan', type: 'card', limit: 50 }, projects);
  assert.equal(view.counts.card, 7);
  assert.equal(view.results.card.length, 7);
  assert.ok(view.results.card.every((row) => /^c-\d{6}$/u.test(row.ref)));
});
