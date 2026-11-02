import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import * as fs from '../core/fsx.mjs';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { parseFile } from '../core/frontmatter.mjs';
import { readFile, revision } from '../core/store.mjs';
import { readEvents } from '../core/events.mjs';
import { refresh } from '../core/index.mjs';
import * as entity from '../core/entity.mjs';
import { keyBetween } from '../core/position.mjs';
import { columnFor, effectiveColumn, listCards, addCard, moveCard, claimCard,
  releaseCard, commentCard, checkCard, doneCard } from '../core/card.mjs';
import { fixedClock, tempDir } from './support/env.mjs';

function fixture(t) {
  const root = tempDir(t), home = tempDir(t), clock = fixedClock('2026-11-01T12:00:00Z');
  initDataDir(root, { home, env: {}, clock });
  return openContext({ mode: 'write', dataDir: root, home, env: {}, clock, actor: 'cli:acme' });
}

function put(ctx, path, text) {
  fs.mkdirSync(dirname(join(ctx.root, path)), { recursive: true });
  fs.writeFileSync(join(ctx.root, path), text);
  refresh(ctx);
}

const show = (ctx, ref) => entity.resolve(ctx, 'card', ref);

test('cards have defaults, append in order, and validate columns and priorities', (t) => {
  const ctx = fixture(t);
  const first = addCard(ctx, { title: 'Acme' });
  const second = addCard(ctx, { title: 'Zorblax', priority: 'urgent' }, '# Body\n');
  assert.match(first.entity.id, /^c-[a-z0-9]{6}$/u);
  assert.equal(first.entity.data.column, 'backlog');
  assert.equal(first.entity.data.position, keyBetween(null, null));
  assert.deepEqual(first.entity.data.tags, []);
  assert.equal(second.entity.data.position, keyBetween(first.entity.data.position, null));
  assert.equal(first.entity.revision, first.revision);
  assert.equal(Object.hasOwn(second.entity, 'body'), false);
  assert.equal(show(ctx, second.entity.id).body, '# Body\n');
  assert.equal(entity.create(ctx, 'card', { title: 'Direct' }).entity.type, 'card');
  assert.throws(() => addCard(ctx, { title: 'Bad', column: 'missing' }), { code: 'validation' });
  assert.throws(() => addCard(ctx, { title: 'Bad', priority: 'high' }), { code: 'validation' });
  assert.deepEqual(readEvents(ctx).map(({ op }) => op), ['card.create', 'card.create', 'card.create']);
});

test('claims enforce ownership, grace period, renewal and stealing', (t) => {
  const ctx = fixture(t);
  const { entity: card } = addCard(ctx, { title: 'Acme' });
  const other = { ...ctx, actor: 'ui:zorblax' };
  const claimed = claimCard(ctx, card.id, {});
  assert.equal(claimed.entity.data.assignee, 'acme');
  assert.equal(claimed.entity.data.column, 'doing');
  assert.equal(claimed.entity.data.claimed, '2026-11-01T12:00:00.000Z');
  assert.equal(claimed.entity.data.lease, '2026-11-01T14:00:00.000Z');
  const blocked = (fn) => assert.throws(fn, (error) => {
    assert.equal(error.code, 'claimed');
    assert.equal(error.exit, 4);
    assert.deepEqual(error.details.current, { assignee: 'acme', lease: '2026-11-01T14:00:00.000Z' });
    return true;
  });
  blocked(() => claimCard(other, card.id, {}));
  blocked(() => claimCard(other, card.id, { renew: true }));
  ctx.clock.advance(124 * 60 * 1000);
  blocked(() => claimCard(other, card.id, {}));
  ctx.clock.advance(60 * 1000);
  blocked(() => claimCard(other, card.id, {}));
  ctx.clock.advance(60 * 1000);
  const taken = claimCard(other, card.id, {});
  assert.equal(taken.entity.data.assignee, 'zorblax');
  ctx.clock.advance(60 * 1000);
  const renewed = claimCard(other, card.id, { renew: true });
  assert.equal(renewed.entity.data.lease, '2026-11-01T16:07:00.000Z');
  assert.equal(claimCard(ctx, card.id, { steal: true }).entity.data.assignee, 'acme');
  const released = releaseCard(ctx, card.id);
  for (const key of ['assignee', 'claimed', 'lease']) assert.equal(Object.hasOwn(released.entity.data, key), false);
  assert.equal(released.entity.data.column, 'doing');
  assert.equal(readEvents(ctx).at(-1).op, 'card.release');
  assert.throws(() => claimCard(ctx, card.id, { renew: true }), { code: 'claimed' });
});

test('missing roles fail with exit 5 and no write', (t) => {
  const ctx = fixture(t);
  const { entity: card } = addCard(ctx, { title: 'Acme' });
  ctx.config = { ...ctx.config, columns: [ctx.config.columns[0]] };
  assert.throws(() => columnFor(ctx.config, 'doing'), { code: 'no_role_column', exit: 5 });
  assert.throws(() => claimCard(ctx, card.id, {}), { code: 'no_role_column' });
  assert.throws(() => doneCard(ctx, card.id), { code: 'no_role_column' });
  assert.equal(show(ctx, card.id).revision, card.revision);
});

test('effective columns govern every list filter and manual cards retain body bytes on claim', (t) => {
  const ctx = fixture(t);
  const body = '# Yeni iş\r\n\r\nİçerik 😀\u200B\r\n';
  put(ctx, 'cards/yeni-is.md', body);
  put(ctx, 'cards/unknown.md', '---\ncolumn: vanished\nposition: a1\n---\n# Unknown\n');
  const before = readFile(ctx, 'cards/yeni-is.md').text;
  const cards = listCards({ ...ctx, actor: null }, { unassigned: true, columnRole: 'todo' });
  assert.deepEqual(cards.map(({ ref }) => ref), ['@cards/yeni-is', '@cards/unknown']);
  assert.ok(cards.every(({ warnings }) => warnings.includes('unknown_column')));
  assert.equal(listCards(ctx, { column: 'backlog' }).length, 2);
  assert.equal(listCards(ctx, { column: 'vanished' }).length, 0);
  assert.equal(readFile(ctx, 'cards/yeni-is.md').text, before);
  assert.equal(effectiveColumn(ctx.config, cards[1]).key, 'backlog');
  const result = claimCard(ctx, '@cards/yeni-is', {});
  assert.match(result.entity.id, /^c-/u);
  assert.equal(parseFile(readFile(ctx, result.path).text).body, body);
  assert.equal(result.entity.data.column, 'doing');
});

test('list filters combine, match project selectors and order by position then path', (t) => {
  const ctx = fixture(t);
  const project = entity.create(ctx, 'project', { title: 'Acme' }).entity;
  const first = addCard(ctx, { title: 'Acme', project: project.id, priority: 'low', tags: ['green'] }).entity;
  const second = addCard(ctx, { title: 'Zorblax', project: project.id, priority: 'urgent', tags: ['green'] }).entity;
  claimCard(ctx, second.id, {});
  assert.deepEqual(listCards(ctx, { project: '@projects/acme', columnRole: 'todo', unassigned: true,
    priority: 'low', tag: 'green' }).map(({ id }) => id), [first.id]);
  assert.deepEqual(listCards(ctx, { project: project.id, assignee: 'acme' }).map(({ id }) => id), [second.id]);
  assert.deepEqual(listCards(ctx, { tag: 'absent' }), []);
  doneCard(ctx, second.id);
  assert.deepEqual(listCards(ctx).map(({ id }) => id), [first.id]);
  assert.equal(listCards(ctx, { includeDone: true, columnRole: 'done' }).length, 1);
  put(ctx, 'cards/b.md', '---\nposition: a0\n---\n# B\n');
  put(ctx, 'cards/a.md', '---\nposition: a0\n---\n# A\n');
  assert.deepEqual(listCards(ctx).map(({ path }) => path), ['cards/a.md', 'cards/acme.md', 'cards/b.md']);
});

test('moves place cards before, after, between and at the end, with event columns', (t) => {
  const ctx = fixture(t);
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((title) => addCard(ctx, { title }).entity);
  moveCard(ctx, d.id, { column: 'backlog', before: b.id });
  assert.deepEqual(listCards(ctx).map(({ id }) => id), [a.id, d.id, b.id, c.id]);
  moveCard(ctx, d.id, { column: 'backlog', after: b.id });
  assert.deepEqual(listCards(ctx).map(({ id }) => id), [a.id, b.id, d.id, c.id]);
  moveCard(ctx, d.id, { column: 'backlog', after: a.id, before: b.id });
  assert.deepEqual(listCards(ctx).map(({ id }) => id), [a.id, d.id, b.id, c.id]);
  const moved = moveCard(ctx, a.id, { column: 'review' });
  assert.equal(moved.entity.data.column, 'review');
  const event = readEvents(ctx).at(-1);
  assert.equal(event.op, 'card.move');
  assert.deepEqual([event.from, event.to], ['backlog', 'review']);
  moveCard(ctx, d.id, { column: 'backlog' });
  assert.deepEqual(listCards(ctx, { column: 'backlog' }).map(({ id }) => id), [b.id, c.id, d.id]);
  for (const options of [{ column: 'missing' }, { column: 'backlog', before: d.id },
    { column: 'backlog', after: d.id }, { column: 'backlog', before: a.id },
    { column: 'backlog', before: b.id, after: c.id }]) {
    assert.throws(() => moveCard(ctx, d.id, options), { code: 'validation' });
  }
});

test('check edits only the selected acceptance marker; comments and completion preserve other bytes', (t) => {
  const ctx = fixture(t);
  const body = '# Acme\r\n\u200B\r\n## Acceptance\r\n- [ ] First 😀\r\n- [ ] Second\r\n\r\n## Other\r\nKeep\r\n';
  const { entity: card } = addCard(ctx, { title: 'Acme', 'x-extra': ['a', 'b'] }, body);
  const before = readFile(ctx, card.path).text.replace(/\r?\n/gu, '\r\n');
  put(ctx, card.path, before);
  const checked = checkCard(ctx, card.id, 2, {});
  assert.equal(readFile(ctx, card.path).text, before.replace('- [ ] Second', '- [x] Second'));
  assert.deepEqual(checked.entity.acceptance, { done: 1, total: 2 });
  assert.throws(() => checkCard(ctx, card.id, 9, {}), { code: 'validation' });
  assert.throws(() => checkCard(ctx, card.id, 0, {}), { code: 'validation' });
  checkCard(ctx, card.id, 2, { uncheck: true });
  assert.equal(readFile(ctx, card.path).text, before);
  commentCard(ctx, card.id, 'One\r\ntwo\tthree');
  assert.ok(show(ctx, card.id).body.startsWith(body));
  assert.ok(show(ctx, card.id).body.endsWith('## Comments\r\n\r\n- 2026-11-01T12:00:00.000Z acme: One two three\r\n'));
  claimCard(ctx, card.id, {});
  const done = doneCard(ctx, card.id, { ifRevision: show(ctx, card.id).revision });
  assert.deepEqual(done.warnings, ['acceptance_open:2/2']);
  assert.equal(done.entity.data.column, 'done');
  assert.equal(done.entity.data.done, ctx.clock.now().toISOString());
  assert.equal(Object.hasOwn(done.entity.data, 'lease'), false);
  assert.deepEqual(done.entity.data['x-extra'], ['a', 'b']);
  assert.equal(done.entity.revision, done.revision);
  assert.deepEqual(readEvents(ctx).slice(-5).map(({ op }) => op),
    ['card.check', 'card.check', 'card.comment', 'card.claim', 'card.done']);
});

test('all mutations require an actor, reject duplicate ids and honor revisions and dry-run', (t) => {
  const ctx = fixture(t);
  const { entity: card } = addCard(ctx, { title: 'Acme' }, '## Acceptance\n- [ ] Next\n');
  const mutations = [
    (context, opts) => addCard(context, { title: 'Preview' }, '', opts),
    (context, opts) => moveCard(context, card.id, { column: 'review' }, opts),
    (context, opts) => claimCard(context, card.id, {}, opts),
    (context, opts) => releaseCard(context, card.id, opts),
    (context, opts) => commentCard(context, card.id, 'Preview', opts),
    (context, opts) => checkCard(context, card.id, 1, {}, opts),
    (context, opts) => doneCard(context, card.id, opts),
  ];
  for (const mutate of mutations) assert.throws(() => mutate({ ...ctx, actor: null }), { code: 'actor_required' });
  const before = readFile(ctx, card.path).text;
  for (const mutate of mutations) {
    const preview = mutate({ ...ctx, mode: 'dry-run' });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.entity.revision, preview.revision);
    assert.throws(() => mutate(ctx, { ifRevision: 'stale' }), { code: 'conflict' });
  }
  assert.equal(readFile(ctx, card.path).text, before);
  assert.equal(readEvents(ctx).length, 1);
  assert.deepEqual(fs.readdirSync(join(ctx.root, '.cairn/locks')), []);
  put(ctx, 'cards/copy.md', before);
  for (const mutate of mutations.slice(1)) assert.throws(() => mutate(ctx), { code: 'duplicate_id' });
});

test('claim decides from the locked text, including a changed owner and lease', (t) => {
  const ctx = fixture(t);
  const { entity: card } = addCard(ctx, { title: 'Acme' });
  const original = ctx.clock.now;
  let changed = false;
  ctx.clock.now = () => {
    if (!changed) {
      changed = true;
      const file = readFile(ctx, card.path).text;
      fs.writeFileSync(join(ctx.root, card.path), file.replace('column: backlog',
        'column: review\nassignee: zorblax\nlease: "2026-11-01T15:00:00Z"'));
    }
    return original();
  };
  assert.throws(() => claimCard(ctx, card.id, {}), (error) => error.code === 'claimed'
    && error.details.current.assignee === 'zorblax');
});

test('two processes claiming simultaneously produce one winner and one claimed error', async (t) => {
  const ctx = fixture(t);
  const { entity: card } = addCard(ctx, { title: 'Acme' });
  const script = `
    import { openContext } from './core/context.mjs';
    import { fixedClock } from './core/clock.mjs';
    import { claimCard } from './core/card.mjs';
    const ctx = openContext({ mode: 'write', dataDir: process.env.CAIRN_DATA, home: process.env.HOME,
      env: {}, clock: fixedClock('2026-11-01T12:00:00Z'), actor: process.env.CAIRN_ACTOR });
    process.stdout.write('ready\\n');
    process.stdin.once('data', () => {
      try {
        console.log(JSON.stringify({ owner: claimCard(ctx, process.env.CAIRN_REF, {}).entity.data.assignee }));
      } catch (error) {
        console.log(JSON.stringify({ code: error.code, exit: error.exit, ...error.details }));
      }
      process.stdin.destroy();
    });
  `;
  const children = ['acme', 'zorblax'].map((actor) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HOME: tempDir(t), CAIRN_DATA: ctx.root, CAIRN_REF: card.id, CAIRN_ACTOR: `cli:${actor}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stdout = '', stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const ready = new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.includes('ready\n')) resolve(); });
      child.once('error', reject);
      child.once('exit', () => reject(new Error(stderr || 'Child exited before ready.')));
    });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve(JSON.parse(stdout.trim().split('\n').at(-1))) : reject(new Error(stderr)));
    });
    return { child, ready, done };
  });
  await Promise.all(children.map(({ ready }) => ready));
  for (const { child } of children) child.stdin.end('go');
  const results = await Promise.all(children.map(({ done }) => done));
  const winner = results.find(({ owner }) => owner);
  const loser = results.find(({ code }) => code);
  assert.ok(winner);
  assert.equal(loser?.code, 'claimed');
  assert.equal(loser.exit, 4);
  assert.equal(loser.current.assignee, winner.owner);
  assert.equal(show(ctx, card.id).data.assignee, winner.owner);
  assert.equal(readEvents(ctx).filter(({ op }) => op === 'card.claim').length, 1);
  assert.equal(revision(readFile(ctx, card.path).text), show(ctx, card.id).revision);
});
