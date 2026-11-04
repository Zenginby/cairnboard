import { CairnError } from './errors.mjs';
import { readChecked } from './paths.mjs';
import { readEvents } from './events.mjs';
import { writeMany } from './store.mjs';

function latest(ctx) {
  const event = readEvents(ctx).at(-1);
  if (!event || event.op === 'undo') return { event, record: null };
  const text = readChecked(ctx.root, `.cairn/history/${event.tx}.json`, 'utf8');
  return { event, record: text === null ? null : JSON.parse(text) };
}

export function latestUndoable(ctx) {
  return latest(ctx).record;
}

export function undo(ctx, { dryRun = false } = {}) {
  const { event, record } = latest(ctx);
  if (!record) throw new CairnError('nothing_to_undo', 'There is no operation to undo.');
  // Undo is single-step and global, so it only reverts the caller's own latest operation.
  if (event.actor !== ctx.actor) {
    throw new CairnError('conflict', 'The latest operation belongs to another actor.', { current: { actor: event.actor, op: event.op } });
  }
  let checked = false;
  const result = writeMany(ctx, { op: 'undo', extra: { undid: record.tx }, dryRun,
    items: (record.items ?? [record]).map((item) => ({ path: item.path, target: item.target,
      apply: () => {
        // Re-checked under the lock: another process may have written after the event was read.
        if (!checked && readEvents(ctx).at(-1)?.tx !== event.tx) {
          throw new CairnError('conflict', 'Another operation happened since; undo again to revert it.');
        }
        checked = true;
        return item.before === null ? null : item.beforeBytes ? Buffer.from(item.beforeBytes, 'base64') : Buffer.from(item.before);
      } })) });
  const { items, ...single } = result;
  return single;
}
