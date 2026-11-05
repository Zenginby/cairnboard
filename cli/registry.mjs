import { platform } from 'node:os';
import { isAbsolute } from 'node:path';
import { CairnError, ERRORS } from '../core/errors.mjs';
import * as entity from '../core/entity.mjs';
import * as journal from '../core/journal.mjs';
import * as index from '../core/index.mjs';
import * as trash from '../core/trash.mjs';
import { listCards, effectiveColumn } from '../core/card.mjs';
import { oneLine } from '../core/text.mjs';
import { toJson, compact, clean } from './output.mjs';
import { writeCommands } from './commands/write.mjs';
import { agentCommands } from './commands/agent.mjs';
import { packageVersion } from '../core/agent.mjs';
import { checkData } from '../core/doctor.mjs';
import { wikiIndex, formatCatalog } from '../core/wiki.mjs';
import { lint } from '../core/lint.mjs';
import { LINT_CODES } from '../core/rules.mjs';
import { checkPage } from '../core/check.mjs';
import { buildContext, formatContext } from '../core/context-pack.mjs';
import { readFile } from '../core/store.mjs';
import { safeRelative } from '../core/paths.mjs';
import { readStdin, readStdinBytes } from './body.mjs';
import { evaluateHook, hookOutput } from '../core/hook.mjs';
import { mentions, linkMention } from '../core/mentions.mjs';

/** @typedef {{ data: unknown, warnings?: string[], exit?: number }} Result */
/** @typedef {{ name: string, summary: string, args: string[], options: Record<string,
 * { type: 'string'|'boolean', multiple?: boolean, summary: string }>, mode: 'read'|'write',
 * actor?: boolean, writeOption?: string, prepare?: (args: string[], opts: object, io: object) => unknown,
 * needsData: boolean, dangerous: boolean|{ option: string }, run: (ctx: object|null, args: string[], opts: object, io: object, prepared?: unknown) => Result|Promise<Result> }} Command */

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
  research: ['id', 'title', 'created', 'updated', 'project', 'kind', 'date', 'tags', 'source', 'raw', 'raw_sha256', 'input_sha256', 'sourceDate', 'processed', 'superseded_by', 'valid_from', 'valid_until'],
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

// An explicit --project must resolve; a stale repository link only warns, so reads keep working.
function listProject(ctx, opts) {
  if (opts.project !== undefined || opts.linkedProject === undefined) return opts.project;
  try {
    return entity.resolve(ctx, 'project', opts.linkedProject).id ?? opts.linkedProject;
  } catch (error) {
    if (error.code !== 'not_found') throw error;
    ctx.warnings.push('invalid_project_link');
    return undefined;
  }
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
    const items = type === 'card' ? listCards(ctx, { project: listProject(ctx, opts), column: opts.column,
      columnRole: opts['column-role'], assignee: opts.assignee, unassigned: opts.unassigned,
      priority: opts.priority, tag: opts.tag, includeDone: opts.all })
      : projectFilter(ctx, entity.list(ctx, type, { kind: opts.kind, all: opts.all }), type === 'project' ? undefined : listProject(ctx, opts));
    return result(ctx, items, opts);
  });
  read(`${type} show`, `Show one ${type}.`, ['<ref>'], {}, (ctx, [ref], opts) => {
    const shown = result(ctx, [entity.resolve(ctx, type, ref)], opts, false);
    if (type === 'note' && !opts.compact) {
      const { links, backlinks } = noteLinks(ctx, shown.data.path, opts);
      shown.data.meta = { ...shown.data.meta, backlinks };
      // Link text is page text, so it lives under content like the rest of the page.
      Object.defineProperty(shown.data.content, 'links', { value: links, enumerable: true, configurable: true, writable: true });
    }
    return shown;
  });
}

// Resolved links of one page plus the pages that link to it; paths and line numbers, bounded in count.
const MAX_LINKS = 500;
const MAX_EXPR = 300;
function noteLinks(ctx, path, opts) {
  const out = index.outlinks(ctx, path).slice(0, MAX_LINKS).map((link) => ({ expr: clean(link.expr.slice(0, MAX_EXPR), opts),
    target_path: link.target_path ?? null, status: link.status, line: link.line }));
  const back = index.backlinks(ctx, path).slice(0, MAX_LINKS).map(({ src_path, line }) => ({ src_path: clean(src_path, opts), line }));
  return { links: out, backlinks: back };
}

read('wiki index', 'List wiki pages with summaries and link counts.', [], {
  kind: string('Filter by wiki page kind.'), format: string('json (default) or markdown catalog.'),
}, (ctx, args, opts) => {
  if (opts.kind !== undefined && !['concept', 'tool', 'query', 'overview'].includes(opts.kind)) {
    throw new CairnError('validation', 'Invalid wiki page kind.');
  }
  if (opts.format !== undefined && !['json', 'markdown'].includes(opts.format)) throw new CairnError('validation', 'Invalid format.');
  const entries = wikiIndex(ctx, { kind: opts.kind });
  if (opts.format === 'markdown') {
    const markdown = clean(formatCatalog(entries, ctx), opts);
    return { data: opts.json ? { markdown } : markdown };
  }
  return { data: { items: entries.map((entry) => opts.compact ? oneLine(clean(`${entry.kind}\t${entry.title}\t${entry.path}`, opts))
    : clean({ path: entry.path, kind: entry.kind, out: entry.out, in: entry.in,
      content: { title: entry.title, summary: entry.summary } }, opts)) } };
});

read('wiki lint', 'Check wiki pages, links and sources.', [], {
  verify: boolean('Recompute every raw source digest.'), evidence: boolean('Also check quotes and numbers against raw sources.'),
  code: boolean('Also check referenced code files.'), only: string('Comma-separated lint codes to run.'),
  strict: boolean('Exit 5 when an error or warning is found.'),
}, (ctx, args, opts) => {
  const only = opts.only === undefined ? undefined : opts.only.split(',').map((code) => code.trim()).filter(Boolean);
  if (only && (!only.length || only.some((code) => !LINT_CODES.includes(code)))) throw new CairnError('validation', 'Invalid lint code.');
  const { findings } = lint(ctx, { only, verify: opts.verify, evidence: opts.evidence, code: opts.code });
  const counts = Object.fromEntries(['error', 'warn', 'info'].map((level) => [level, findings.filter((item) => item.severity === level).length]));
  return { data: { findings: clean(findings, opts), counts },
    exit: opts.strict && (counts.error || counts.warn) ? ERRORS.validation : 0 };
});

read('wiki check', 'Check a page or stdin draft against the write rules.', ['<path|->'], {
  path: string('Target path of a draft read from stdin (decides classification and file name rule).'),
}, async (ctx, [target], opts, io) => {
  let path, text;
  if (target === '-') {
    if (opts.path === undefined) throw new CairnError('usage', 'A stdin draft needs --path.');
    path = safeRelative(opts.path).replace(/\\/gu, '/');
    text = await readStdin(io);
  } else {
    if (opts.path !== undefined) throw new CairnError('usage', '--path is only for a stdin draft.');
    path = safeRelative(target).replace(/\\/gu, '/');
    const file = readFile(ctx, path);
    if (!file) throw new CairnError('not_found', 'Page was not found.');
    text = file.text;
  }
  const { errors, warnings } = checkPage(ctx, { path, text });
  return { data: clean({ errors, warnings }, opts), exit: errors.length ? ERRORS.validation : 0 };
});

// Internal: Claude Code calls this before Write and Edit. It answers in the hook format on stdout, not in the
// envelope, and always exits 0: whatever it cannot read or judge is allowed (fail open).
async function openHookContext(input, opts, io) {
  const { openContext } = await import('../core/context.mjs');
  const cwd = typeof input.cwd === 'string' && isAbsolute(input.cwd) ? input.cwd : io.cwd;
  try {
    return openContext({ mode: 'read', dataDir: opts.data, preset: opts.preset,
      env: io.env, home: io.env.HOME ?? io.env.USERPROFILE, platform: platform(), cwd, clock: io.clock });
  } catch (error) {
    // No data folder (yet): nothing to guard.
    if (error.code === 'validation' && /Initialization is required/u.test(error.message)) return null;
    throw error;
  }
}

read('wiki hook', 'Internal: Claude Code write hook; reads the hook input from stdin.', [], {}, async (ctx, args, opts, io) => {
  let verdict;
  try {
    const input = JSON.parse((await readStdinBytes(io, 2 * 1024 * 1024, 'Hook input')).toString('utf8'));
    const tool = input !== null && typeof input === 'object' && ['Write', 'Edit'].includes(input.tool_name);
    verdict = evaluateHook(tool ? await openHookContext(input, opts, io) : null, input);
  } catch {
    verdict = { decision: 'allow', warnings: ['hook_error'] };
  }
  return { data: null, stdout: hookOutput(verdict), exit: 0 };
}, false);
commands.at(-1).hidden = true;

read('context', 'Print the session-start context pack.', [], {
  budget: string('Token budget, characters / 4 (default: 1200).'),
}, (ctx, args, opts) => {
  if (opts.budget !== undefined && !/^\d+$/u.test(opts.budget)) throw new CairnError('validation', 'Invalid budget.');
  const pack = buildContext(ctx, { budget: opts.budget === undefined ? undefined : Number(opts.budget), project: opts.project });
  const data = clean({ sections: pack.sections }, opts);
  return { data: opts.json ? data : formatContext(data), warnings: pack.warnings };
});

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

read('search', 'Search titles and bodies.', ['<q>'], {
  type: string('Filter by type; raw searches raw sources instead of pages.'),
}, (ctx, [query], opts) => {
  if (opts.type !== undefined && !index.SEARCH_TYPES.includes(opts.type)) throw new CairnError('validation', 'Invalid search type.');
  const matches = index.search(ctx, query, { type: opts.type });
  const summaries = new Map(index.rows(ctx).map((item) => [item.path, item]));
  return result(ctx, matches.map((item) => ({ ...summaries.get(item.path), ...item })), opts);
});

read('mentions', 'Find unlinked mentions of a note.', ['<note>'], {
  limit: string('Maximum results, 0 to 500 (default: 50).'),
  link: string('Link the single mention at path:line; requires confirmation.'),
}, (ctx, [ref], opts) => {
  if (opts.limit !== undefined && !/^\d+$/u.test(opts.limit)) throw new CairnError('validation', 'Invalid limit.');
  const limit = opts.limit === undefined ? 50 : Number(opts.limit);
  if (!Number.isSafeInteger(limit) || limit > 500) throw new CairnError('validation', 'Invalid limit.');
  if (opts.link !== undefined) return { data: linkMention(ctx, ref, opts.link,
    { ifRevision: opts['if-revision'], dryRun: opts['dry-run'] }) };
  return { data: { items: clean(mentions(ctx, ref, { limit }), opts) } };
});
commands.at(-1).writeOption = 'link';
commands.at(-1).dangerous = { option: 'link' };

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
commands.push(...agentCommands(commands));

read('doctor', 'Inspect data without migration or recovery.', [], {}, (ctx, args, opts, io) => {
  const checks = checkData({ dataDir: opts.data, env: io.env, home: io.env.HOME ?? io.env.USERPROFILE,
    cwd: io.cwd, clock: io.clock });
  return { data: { checks }, exit: checks.every((check) => check.ok) ? 0 : 5 };
}, false);

read('open', 'Open the running web interface.', [], {}, async (ctx, args, opts, io) => {
  // Loaded on demand so other commands never load the browser launcher.
  const { isAlive, readServerState } = await import('../server/state.mjs');
  const { loginUrl, sessionKey } = await import('../server/session.mjs');
  const where = { env: io.env, home: io.env.HOME ?? io.env.USERPROFILE };
  const state = readServerState(where);
  // A record left by a crashed server must not send a login token to whatever took its port.
  if (!state || !Number.isSafeInteger(state.port) || !(io.isAlive ?? isAlive)(state.pid)) {
    throw new CairnError('not_found', 'Cairnboard is not running; start it with npm start.');
  }
  const opener = io.openBrowser ?? (await import('../server/open-browser.mjs')).openBrowser;
  // The token is a secret for 60 s: it goes to the browser only, never to stdout or the JSON envelope.
  opener(loginUrl(state.port, sessionKey(where)), { stderr: io.stderr });
  return { data: { url: state.url } };
}, false);

read('schema', 'Describe commands, fields and error codes.', [], {}, () => ({ data: {
  cli: packageVersion,
  commands: commands.map(({ name, summary, args, options, mode, actor, writeOption, needsData, dangerous }) => ({
    name, summary, args, options: { ...commonOptions, ...options }, mode, needsData, dangerous, ...(actor === false ? { actor } : {}),
    ...(writeOption ? { writeOption } : {}),
  })),
  errors: Object.entries(ERRORS).map(([code, exit]) => ({ code, exit })), fields,
  result: { exit: 'Optional process exit code; doctor returns 5 with ok: true when a check fails.' },
} }), false);
