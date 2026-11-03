import * as fs from '../core/fsx.mjs';
import { CairnError, ERRORS } from '../core/errors.mjs';
import * as entity from '../core/entity.mjs';
import * as journal from '../core/journal.mjs';
import * as index from '../core/index.mjs';
import * as trash from '../core/trash.mjs';
import { listCards, effectiveColumn } from '../core/card.mjs';
import { oneLine } from '../core/text.mjs';
import { toJson, compact, clean } from './output.mjs';
import { writeCommands } from './commands/write.mjs';
import { checkData } from '../core/doctor.mjs';

/** @typedef {{ data: unknown, warnings?: string[], exit?: number }} Result */
/** @typedef {{ name: string, summary: string, args: string[], options: Record<string,
 * { type: 'string'|'boolean', multiple?: boolean, summary: string }>, mode: 'read'|'write',
 * needsData: boolean, dangerous: boolean|{ option: string }, run: (ctx: object|null, args: string[], opts: object, io: object) => Result|Promise<Result> }} Command */

const string = (summary) => ({ type: 'string', summary });
const boolean = (summary) => ({ type: 'boolean', summary });

export const commonOptions = {
  json: boolean('Return a JSON envelope.'), compact: boolean('Return one line per item.'),
  data: string('Use this data directory.'), project: string('Filter by project reference.'),
  actor: string('Name the write actor.'), 'dry-run': boolean('Preview without writing.'),
  'if-revision': string('Require this revision for a write.'), raw: boolean('Keep hidden characters.'),
  'max-bytes': string('Limit body bytes (default: 65536).'),
};
const readOptions = { preset: string('Read an uninitialized directory with default or tr-wiki schema.') };

const fields = {
  project: ['id', 'title', 'created', 'updated', 'status', 'tone', 'aliases'],
  card: ['id', 'title', 'created', 'updated', 'project', 'column', 'position', 'priority', 'tags', 'assignee', 'claimed', 'lease', 'done'],
  note: ['id', 'title', 'created', 'updated', 'kind', 'project', 'tags', 'pinned', 'source', 'superseded_by', 'valid_from', 'valid_until', 'code'],
  research: ['id', 'title', 'created', 'updated', 'project', 'kind', 'date', 'tags', 'source', 'raw', 'raw_sha256', 'sourceDate', 'processed'],
  journal: ['date'],
};

function outputOptions(ctx, opts, warnings) {
  return { raw: opts.raw, maxBytes: opts['max-bytes'], columns: ctx.config.columns, warnings };
}

function result(ctx, items, opts, many = true) {
  const warnings = items.flatMap((item) => [...(item.warnings ?? []),
    ...(item.type === 'card' ? effectiveColumn(ctx.config, item).warnings : [])]);
  const options = outputOptions(ctx, opts, warnings);
  const converted = items.map((item) => opts.compact ? compact(item, { ...options,
    ...(item.type === 'card' ? { column: effectiveColumn(ctx.config, item).key } : {}) }) : toJson(item, options));
  return { data: many || opts.compact ? { items: converted } : converted[0], warnings };
}

function projectFilter(ctx, items, project) {
  if (project === undefined) return items;
  const selected = entity.resolve(ctx, 'project', project);
  const refs = [selected.id, `@${selected.path.slice(0, -3)}`, `@${selected.path}`].filter((ref) => ref !== null);
  return items.filter((item) => refs.includes(item.data.project));
}

/** @type {Command[]} */
export const commands = [];

function read(name, summary, args, options, run, needsData = true) {
  commands.push({ name, summary, args, options: { ...readOptions, ...options }, mode: 'read', needsData, dangerous: false, run });
}

for (const type of ['project', 'card', 'note', 'research']) {
  const filters = type === 'card' ? {
    column: string('Filter by column key.'), 'column-role': string('Filter by column role.'),
    assignee: string('Filter by owner, or me.'), unassigned: boolean('Only unowned cards.'),
    priority: string('Filter by priority.'), tag: string('Filter by tag.'), all: boolean('Include done cards.'),
  } : type === 'note' ? { kind: string('Filter by note kind.'), all: boolean('Include wiki pages.') } : {};
  read(`${type} list`, `List ${type} items.`, [], filters, (ctx, args, opts) => {
    if (type === 'note' && opts.kind !== undefined && !['note', 'concept', 'tool', 'query', 'overview'].includes(opts.kind)) {
      throw new CairnError('validation', 'Invalid note kind.');
    }
    const items = type === 'card' ? listCards(ctx, { project: opts.project, column: opts.column,
      columnRole: opts['column-role'], assignee: opts.assignee, unassigned: opts.unassigned,
      priority: opts.priority, tag: opts.tag, includeDone: opts.all })
      : projectFilter(ctx, entity.list(ctx, type, { kind: opts.kind, all: opts.all }), type === 'project' ? undefined : opts.project);
    return result(ctx, items, opts);
  });
  read(`${type} show`, `Show one ${type}.`, ['<ref>'], {}, (ctx, [ref], opts) => result(ctx, [entity.resolve(ctx, type, ref)], opts, false));
}

read('journal list', 'List journal days or filtered entries.', [], {
  month: string('Filter days by YYYY-MM.'), type: string('Filter decision, discovery, pitfall or lesson entries.'),
  unprocessed: boolean('Only unprocessed discoveries, pitfalls and lessons.'), since: string('Include entries since YYYY-MM-DD.'),
}, (ctx, args, opts) => {
  if (opts.type !== undefined || opts.unprocessed || opts.since !== undefined) {
    const items = journal.entries(ctx, { type: opts.type, unprocessed: opts.unprocessed, since: opts.since });
    const warnings = [];
    return { data: { items: items.map(({ heading, text, ...item }) => {
      const entry = toJson({ type: 'journal', path: item.path, ref: `@${item.path.slice(0, -3)}`,
        title: heading, data: item, body: text }, outputOptions(ctx, opts, warnings));
      entry.content.text = entry.content.body;
      delete entry.content.body;
      return opts.compact ? oneLine(entry.content.text) : entry;
    }) }, warnings };
  }
  return result(ctx, journal.list(ctx, { month: opts.month }), opts);
});
read('journal show', 'Show a journal day or reference.', ['<date|ref>'], {}, (ctx, [ref], opts) => result(ctx,
  [ref.startsWith('@') ? entity.resolve(ctx, 'journal', ref) : journal.show(ctx, ref)], opts, false));

read('search', 'Search titles and bodies.', ['<q>'], {}, (ctx, [query], opts) => {
  const matches = index.search(ctx, query);
  const summaries = new Map(index.rows(ctx).map((item) => [item.path, item]));
  return result(ctx, matches.map((item) => ({ ...summaries.get(item.path), ...item })), opts);
});

read('status', 'Show data directory and entity counts.', [], {}, (ctx) => {
  const items = index.rows(ctx);
  const cards = Object.fromEntries(ctx.config.columns.map(({ key }) => [key, 0]));
  const warnings = [];
  for (const card of items.filter((item) => item.type === 'card')) {
    const column = effectiveColumn(ctx.config, card);
    cards[column.key]++;
    warnings.push(...column.warnings);
  }
  return { data: { dataDir: ctx.root, ephemeral: ctx.ephemeral, counts: {
    projects: items.filter((item) => item.type === 'project').length,
    notes: items.filter((item) => item.type === 'note').length,
    research: items.filter((item) => item.type === 'research').length, cards,
  }, warnings: [...new Set([...ctx.warnings, ...warnings])] }, warnings };
});

read('trash list', 'List recoverable trash items.', [], {}, (ctx, args, opts) => ({ data: { items: trash.list(ctx)
  .map((item) => opts.compact ? oneLine(clean(item.path, opts)) : clean(item, opts)) } }));

commands.push(...writeCommands({ string, boolean }));

read('doctor', 'Inspect data without migration or recovery.', [], {}, (ctx, args, opts, io) => {
  const checks = checkData({ dataDir: opts.data, env: io.env, home: io.env.HOME ?? io.env.USERPROFILE,
    cwd: io.cwd, clock: io.clock });
  return { data: { checks }, exit: checks.every((check) => check.ok) ? 0 : 5 };
}, false);

read('schema', 'Describe commands, fields and error codes.', [], {}, () => ({ data: {
  cli: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  commands: commands.map(({ name, summary, args, options, mode, needsData, dangerous }) => ({
    name, summary, args, options: { ...commonOptions, ...options }, mode, needsData, dangerous,
  })),
  errors: Object.entries(ERRORS).map(([code, exit]) => ({ code, exit })), fields,
  result: { exit: 'Optional process exit code; doctor returns 5 with ok: true when a check fails.' },
} }), false);
