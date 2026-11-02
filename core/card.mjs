import { CairnError } from './errors.mjs';
import * as entity from './entity.mjs';
import { parseFile, setFields, appendToSection, setAcceptance, acceptanceCounts } from './frontmatter.mjs';
import { physicalPatch } from './schema.mjs';
import { extract } from './extract.mjs';
import { ensureFresh, findById } from './index.mjs';
import { newId } from './ids.mjs';
import { keyBetween } from './position.mjs';
import { oneLine } from './text.mjs';
import { revision, write } from './store.mjs';

const invalid = (message) => new CairnError('validation', message);
const position = (card) => card.data.position ?? 'a0';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function columnFor(config, role) {
  const column = config.columns.find((column) => column.role === role);
  if (!column) throw new CairnError('no_role_column', 'No column has the requested role.');
  return column;
}

export function effectiveColumn(config, card) {
  const column = config.columns.find((column) => column.key === card.data.column);
  return { ...(column ?? config.columns[0]), warnings: column ? [] : ['unknown_column'] };
}

function knownColumn(ctx, key) {
  const column = ctx.config.columns.find((column) => column.key === key);
  if (!column) throw invalid('Unknown card column.');
  return column;
}

export function listCards(ctx, { project, column, columnRole, assignee, unassigned,
  priority, tag, includeDone = false } = {}) {
  const projectEntity = project === undefined ? null : entity.resolve(ctx, 'project', project);
  const projectRefs = projectEntity && [projectEntity.id, `@${projectEntity.path.slice(0, -3)}`, `@${projectEntity.path}`]
    .filter((ref) => ref !== null);
  return entity.list(ctx, 'card').map((card) => ({ ...card,
    warnings: [...card.warnings, ...effectiveColumn(ctx.config, card).warnings],
  })).filter((card) => {
    const effective = effectiveColumn(ctx.config, card);
    return (project === undefined || projectRefs.includes(card.data.project))
      && (column === undefined || effective.key === column)
      && (columnRole === undefined || effective.role === columnRole)
      && (includeDone || effective.role !== 'done')
      && (assignee === undefined || card.data.assignee === assignee)
      && (!unassigned || !card.data.assignee)
      && (priority === undefined || card.data.priority === priority)
      && (tag === undefined || (Array.isArray(card.data.tags) && card.data.tags.includes(tag)));
  }).sort((a, b) => compare(position(a), position(b)) || compare(a.path, b.path));
}

function actorName(ctx) {
  const colon = typeof ctx.actor === 'string' ? ctx.actor.indexOf(':') : -1;
  if (colon < 1 || colon === ctx.actor.length - 1) throw new CairnError('actor_required', 'A write actor is required.');
  return ctx.actor.slice(colon + 1);
}

function between(previous, next) {
  try {
    return keyBetween(previous ? position(previous) : null, next ? position(next) : null);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw invalid('Card positions do not define an ordered interval.');
  }
}

export function addCard(ctx, fields, body = '', opts = {}) {
  actorName(ctx);
  const column = knownColumn(ctx, fields.column ?? ctx.config.columns[0].key);
  const cards = listCards(ctx, { column: column.key, includeDone: true });
  return entity.create(ctx, 'card', { ...fields, column: column.key, position: between(cards.at(-1), null) }, body, opts);
}

function writable(ctx, card) {
  ensureFresh(ctx);
  if (card.id !== null && findById(ctx, card.id).length > 1) {
    throw new CairnError('duplicate_id', 'Entity id is duplicated.');
  }
}

function summary(ctx, path, text) {
  const item = extract(ctx.schema, path, text);
  if (!item || item.type !== 'card') throw new CairnError('not_found', 'Card was not found.');
  const { body, error, ...card } = item;
  return { ...card, revision: revision(text), warnings: effectiveColumn(ctx.config, card).warnings };
}

function mutate(ctx, ref, op, change, opts, retryClaim = false) {
  actorName(ctx);
  const initial = entity.resolve(ctx, 'card', ref);
  writable(ctx, initial);
  for (let attempt = 0; ; attempt++) {
    let entered = false, card, warnings = [];
    const extra = {};
    try {
      const result = write(ctx, { ...opts, path: initial.path, target: initial.ref, op, extra, apply: (text) => {
        entered = true;
        if (text === null) throw new CairnError('not_found', 'Card was not found.');
        const current = summary(ctx, initial.path, text);
        writable(ctx, current);
        const decision = change(text, current);
        const patch = { ...decision.patch, updated: ctx.clock.now().toISOString() };
        if (current.id === null) {
          do { patch.id = newId('c'); } while (findById(ctx, patch.id).length);
        }
        entity.validate('card', { ...current.data, title: current.title, ...patch });
        const after = setFields(decision.text ?? text, physicalPatch(ctx.schema, parseFile(text).data, patch));
        card = summary(ctx, initial.path, after);
        warnings = [...card.warnings, ...(decision.warnings ?? [])];
        Object.assign(extra, decision.extra);
        return after;
      } });
      return { ...result, entity: card, warnings };
    } catch (error) {
      if (!retryClaim || entered || error.code !== 'locked' || attempt === 9) throw error;
      // Wait only for acquisition: the loser must inspect the winner's committed owner under the file lock.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(200, 20 * (attempt + 1)));
    }
  }
}

export function moveCard(ctx, ref, { column, before, after }, opts = {}) {
  return mutate(ctx, ref, 'card.move', (text, current) => {
    knownColumn(ctx, column);
    const cards = listCards(ctx, { column, includeDone: true }).filter((card) => card.path !== current.path);
    const bound = (ref) => {
      if (ref === undefined) return null;
      const card = entity.resolve(ctx, 'card', ref);
      if (card.path === current.path) throw invalid('A card cannot be positioned relative to itself.');
      const index = cards.findIndex((item) => item.path === card.path);
      if (index === -1) throw invalid('Position reference is not in the target column.');
      return index;
    };
    const beforeIndex = bound(before), afterIndex = bound(after);
    if (beforeIndex !== null && afterIndex !== null && afterIndex >= beforeIndex) throw invalid('Position references are reversed.');
    const previous = afterIndex !== null ? cards[afterIndex] : beforeIndex !== null ? cards[beforeIndex - 1] : cards.at(-1);
    const next = beforeIndex !== null ? cards[beforeIndex] : afterIndex !== null ? cards[afterIndex + 1] : null;
    return { patch: { column, position: between(previous, next) },
      extra: { from: effectiveColumn(ctx.config, current).key, to: column } };
  }, opts);
}

export function claimCard(ctx, ref, { renew = false, steal = false } = {}, opts = {}) {
  const name = actorName(ctx);
  return mutate(ctx, ref, 'card.claim', (text, current) => {
    const column = columnFor(ctx.config, 'doing');
    const now = ctx.clock.now();
    const { assignee, lease } = current.data;
    const expired = typeof lease === 'string' && now.getTime() > Date.parse(lease) + 5 * 60 * 1000;
    if (renew ? assignee !== name : assignee && !expired && !steal) {
      throw new CairnError('claimed', 'Card is already claimed.', { current: { assignee: assignee ?? null, lease: lease ?? null } });
    }
    const claimed = now.toISOString();
    now.setTime(now.getTime() + (ctx.config.leaseMinutes ?? 120) * 60 * 1000);
    return { patch: { assignee: name, claimed, lease: now.toISOString(), column: column.key } };
  }, opts, true);
}

export function releaseCard(ctx, ref, opts = {}) {
  return mutate(ctx, ref, 'card.release', () => ({ patch: { assignee: undefined, claimed: undefined, lease: undefined } }), opts);
}

export function commentCard(ctx, ref, text, opts = {}) {
  const name = actorName(ctx);
  if (typeof text !== 'string' || !text.trim()) throw invalid('Comment must be text.');
  return mutate(ctx, ref, 'card.comment', (current) => ({
    text: appendToSection(current, 'Comments', [`- ${ctx.clock.now().toISOString()} ${name}: ${oneLine(text)}`]),
  }), opts);
}

export function checkCard(ctx, ref, n, { uncheck = false } = {}, opts = {}) {
  return mutate(ctx, ref, 'card.check', (text) => ({ text: setAcceptance(text, n, !uncheck) }), opts);
}

export function doneCard(ctx, ref, opts = {}) {
  return mutate(ctx, ref, 'card.done', (text) => {
    const column = columnFor(ctx.config, 'done');
    const { done, total } = acceptanceCounts(parseFile(text).body);
    return { patch: { column: column.key, done: ctx.clock.now().toISOString(), lease: undefined },
      warnings: done < total ? [`acceptance_open:${total - done}/${total}`] : [] };
  }, opts);
}
