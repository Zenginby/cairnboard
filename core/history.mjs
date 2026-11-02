import { CairnError } from './errors.mjs';
import { readChecked } from './paths.mjs';
import { readEvents } from './events.mjs';
import { writeMany } from './store.mjs';

export function latestUndoable(ctx) {
  const event = readEvents(ctx).at(-1);
  if (!event || event.op === 'undo') return null;
  const text = readChecked(ctx.root, `.cairn/history/${event.tx}.json`, 'utf8');
  return text === null ? null : JSON.parse(text);
}

export function undo(ctx, { dryRun = false } = {}) {
  const record = latestUndoable(ctx);
  if (!record) throw new CairnError('nothing_to_undo', 'There is no operation to undo.');
  const result = writeMany(ctx, { op: 'undo', extra: { undid: record.tx }, dryRun,
    items: (record.items ?? [record]).map((item) => ({ path: item.path, target: item.target,
      apply: () => item.before === null ? null : item.beforeBytes ? Buffer.from(item.beforeBytes, 'base64') : item.before })) });
  const { items, ...single } = result;
  return single;
}
