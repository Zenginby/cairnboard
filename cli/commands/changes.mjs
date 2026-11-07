import { CairnError } from '../../core/errors.mjs';
import { changeDiff, changeSince, listChanges } from '../../core/changes.mjs';
import { readEvents } from '../../core/events.mjs';
import { changesView } from '../views.mjs';

export function prepareChanges(args, opts) {
  changeSince(opts.since);
  if (opts.limit !== undefined && (!/^\d+$/u.test(opts.limit)
    || !Number.isSafeInteger(Number(opts.limit)) || Number(opts.limit) < 1 || Number(opts.limit) > 200)) {
    throw new CairnError('validation', 'Invalid --limit. Use an integer from 1 to 200.');
  }
  return { since: opts.since, target: opts.target,
    limit: opts.limit === undefined ? 20 : Number(opts.limit) };
}

export function runChanges(ctx, args, opts, io, filters) {
  const events = readEvents(ctx);
  // --actor selects event attribution here; the context actor is never needed to list changes.
  const selected = listChanges(ctx, { ...filters, actor: opts.actor }, events);
  const changes = selected.map((event) => opts.diff ? { ...event, ...changeDiff(ctx, event, events) } : event);
  const data = { changes, cursor: changes.at(-1)?.seq ?? 0 };
  return { data: opts.json ? data : changesView(data) };
}
