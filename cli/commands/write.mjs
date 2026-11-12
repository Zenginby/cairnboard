import { platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import * as fs from '../../core/fsx.mjs';
import * as entity from '../../core/entity.mjs';
import * as card from '../../core/card.mjs';
import * as journal from '../../core/journal.mjs';
import * as trash from '../../core/trash.mjs';
import { latestUndoable, undo } from '../../core/history.mjs';
import { extract } from '../../core/extract.mjs';
import { revision } from '../../core/store.mjs';
import { acceptanceCounts, parseFile } from '../../core/frontmatter.mjs';
import { checkedPath, readChecked, realRoot } from '../../core/paths.mjs';
import { findDataDir, initDataDir, findRepoRoot, recordRepo, writeProjectLink } from '../../core/roots.mjs';
import { defaultConfig, loadConfig } from '../../core/config.mjs';
import { PRESETS } from '../../core/presets.mjs';
import { exportBoard } from '../../core/export.mjs';
import { CairnError } from '../../core/errors.mjs';
import { clean, toJson } from '../output.mjs';
import { oneLine } from '../../core/text.mjs';
import { confirm } from '../confirm.mjs';
import { detectSchema, extendDetection } from '../../core/detect.mjs';
import { destination, resolveSchema } from '../../core/schema.mjs';
import { readBody, readFileBytes, readStdinBytes } from '../body.mjs';
import { ingest, MAX_INPUT } from '../../core/ingest.mjs';
import { lockName, withLock } from '../../core/lock.mjs';
import { readShadow, recordShadow, shadowEntry } from '../../core/shadow.mjs';

// Card status lines (one line each): what happens now, what comes next, what the owner is needed for.
const CARD_LINES = ['now', 'next', 'needs'];
const mutationOptions = (opts) => ({ ifRevision: opts['if-revision'], dryRun: opts['dry-run'] === true });
const environment = (io) => ({ home: io.env.HOME ?? io.env.USERPROFILE, env: io.env,
  platform: platform(), clock: io.clock });

function summary(ctx, item, opts, warnings) {
  return toJson(item, { raw: opts.raw, maxBytes: opts['max-bytes'], columns: ctx.config.columns, warnings });
}

function mutation(ctx, changed, opts, preview) {
  const warnings = [...(changed.warnings ?? [])];
  let item = changed.entity ?? preview;
  if (!changed.entity && !changed.dryRun && changed.revision !== null) {
    const text = readChecked(ctx.root, changed.path, 'utf8');
    if (text !== null) item = extract(ctx.schema, changed.path, text);
  }
  if (item?.type === 'card') warnings.push(...card.effectiveColumn(ctx.config, item).warnings);
  const data = item ? summary(ctx, { ...item, revision: changed.revision }, opts, warnings)
    : { path: changed.path, revision: changed.revision };
  if (changed.items?.length > 1) data.items = changed.items;
  return { data, warnings };
}

function patchFields(ctx, type, opts) {
  const patch = {};
  const names = {
    title: 'title', project: 'project', status: 'status', tone: 'tone', alias: 'aliases', tag: 'tags',
    column: 'column', priority: 'priority', kind: 'kind', pin: 'pinned', source: 'source', sources: 'sources',
    'valid-from': 'valid_from', 'valid-until': 'valid_until', 'superseded-by': 'superseded_by', code: 'code',
    date: 'date', 'source-date': 'sourceDate', processed: 'processed',
  };
  for (const [option, field] of Object.entries(names)) if (opts[option] !== undefined) patch[field] = opts[option];
  // A card's status lines: an empty or blank value removes the field (undefined deletes the frontmatter key).
  if (type === 'card') {
    for (const field of CARD_LINES) {
      if (opts[field] === undefined) continue;
      if (typeof opts[field] !== 'string') throw new CairnError('validation', `Invalid card ${field} line.`);
      const value = opts[field].trim();
      patch[field] = value === '' ? undefined : value;
    }
  }
  if (opts.unpin) patch.pinned = false;
  if (patch.tone !== undefined) {
    if (!/^[1-8]$/u.test(patch.tone)) throw new CairnError('validation', 'Invalid project tone.');
    patch.tone = Number(patch.tone);
  }
  if (type === 'project') delete patch.project;
  else if (patch.project !== undefined) {
    const project = entity.resolve(ctx, 'project', patch.project);
    patch.project = project.id ?? project.ref;
  }
  if (type === 'card' && patch.column !== undefined && !ctx.config.columns.some(({ key }) => key === patch.column)) {
    throw new CairnError('validation', 'Unknown card column.');
  }
  return patch;
}

function configChangeLines(field, before, after) {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const display = (value) => value == null ? '(none)' : typeof value === 'string' ? value : JSON.stringify(value);
  if (field === 'schema.roots') {
    const describe = (root, type) => root
      ? `${[root.path].flat().join(', ')} (flat: ${root.flat ?? type !== 'note'})` : '(none)';
    return [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].flatMap((type) =>
      JSON.stringify(before?.[type]) === JSON.stringify(after?.[type]) ? []
        : [`  ${type} → ${describe(after?.[type], type)}; was ${describe(before?.[type], type)}`]);
  }
  if (Array.isArray(before) || Array.isArray(after)) {
    const lines = [...(before ?? []).filter((value) => !(after ?? []).includes(value))
      .map((value) => `  ${field} - ${display(value)}`),
    ...(after ?? []).filter((value) => !(before ?? []).includes(value))
      .map((value) => `  ${field} + ${display(value)}`)];
    return lines.length ? lines : [`  ${field}: ${display(before)} → ${display(after)}`];
  }
  if ((before && typeof before === 'object') || (after && typeof after === 'object')) {
    return [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].flatMap((key) =>
      configChangeLines(`${field}.${key}`, before?.[key], after?.[key]));
  }
  return [`  ${field}: ${display(before)} → ${display(after)}`];
}

function detectionPreview(detection, changes, existingSchema) {
  const rows = [['Target', 'Path', 'Confidence', 'Reason'], ...detection.suggestions.map((item) =>
    [item.target, item.path, `${Math.round(item.confidence * 100)}%`, item.reason])];
  const table = rows.map((row) => row.map((cell) => oneLine(clean(cell))).join('\t')).join('\n');
  const diff = changes.flatMap(({ field, before, after }) =>
    configChangeLines(field, field === 'schema' ? existingSchema ?? before : before, after))
    .map((line) => oneLine(clean(line))).join('\n');
  const folder = detection.schema.roots.note && dirname(destination(detection.schema, 'note', 'note', 'new-note'));
  const notes = `New notes: ${folder ? folder === '.' ? './' : `${folder}/` : '(not configured)'}\n`;
  const preserved = existingSchema ? ['Preserved schema:',
    ...configChangeLines('schema.roots', null, existingSchema.roots).map((line) => line.replace('; was (none)', '')),
    ...['kindFolders', 'fields', 'values', 'sourceRoots', 'catalog', 'ignore', 'quickNotes', 'entryTypes']
      .filter((field) => Object.hasOwn(existingSchema, field))
      .map((field) => `  schema.${field}: existing settings preserved`),
  ].map((line) => oneLine(clean(line))).join('\n') + '\n' : '';
  const added = existingSchema ? `Added schema entries:\n${diff || '  (none)'}\n` : diff && `${diff}\n`;
  return `${table}\n${notes}${preserved}${added ? `Config changes:\n${added}` : ''}`;
}

async function initDetected(root, opts, io, settings, current) {
  let detectedRoot, identity;
  try {
    identity = fs.lstatSync(root, { bigint: true });
    if (!identity.isDirectory()) throw new Error('Invalid root.');
    detectedRoot = realRoot(root);
  } catch {
    throw new CairnError('validation', 'Detection requires an existing directory without symlinks.');
  }
  const checkRoot = () => {
    try {
      const now = fs.lstatSync(root, { bigint: true });
      if (!now.isDirectory() || realRoot(root) !== detectedRoot
        || now.dev !== identity.dev || now.ino !== identity.ino) throw new Error('Root changed.');
      const saved = fs.lstatSync(detectedRoot, { bigint: true });
      if (!saved.isDirectory() || saved.dev !== identity.dev || saved.ino !== identity.ino) {
        throw new Error('Root changed.');
      }
    } catch {
      throw new CairnError('conflict', 'Data directory changed during detection.');
    }
  };
  checkRoot();
  const previous = current === null ? null : loadConfig(detectedRoot);
  const existingSchema = previous === null ? null : resolveSchema(previous);
  let detection = detectSchema(detectedRoot, { existingSchema });
  if (existingSchema) detection = extendDetection(detection, existingSchema);
  const config = { ...(previous ?? defaultConfig(opts.language ?? 'en')), schema: detection.schema };
  if (opts.language !== undefined) config.language = defaultConfig(opts.language).language;
  const changes = ['schema', 'language'].filter((field) =>
    JSON.stringify(previous?.[field]) !== JSON.stringify(config[field])).map((field) =>
    ({ field, before: previous?.[field] ?? null, after: config[field] }));
  const preview = detectionPreview(detection, changes, existingSchema);
  const text = JSON.stringify(config, null, 2) + '\n';
  const currentRevision = current === null ? null : revision(current);
  if (!opts['dry-run']) {
    // The proposal and config diff must be visible before any confirmation or metadata write.
    io.stderr.write(opts.json ? JSON.stringify(clean({ ...detection, changes })) + '\n' : preview);
    if (!opts.yes) {
      if (!io.isTTY) throw new CairnError('confirmation_required',
        'Detection writes require confirmation; use --yes in a non-interactive environment.',
        { current: { revision: currentRevision, ...detection, changes } });
      if (!await confirm(io, `Apply detected schema to ${root}/.cairn/config.json?`)) {
        throw new CairnError('confirmation_required', 'Confirmation was declined.');
      }
    }
    const checkCurrent = () => {
      checkRoot();
      const bytes = readChecked(detectedRoot, '.cairn/config.json');
      if ((bytes === null ? null : revision(bytes)) !== currentRevision) {
        throw new CairnError('conflict', 'Configuration has changed.',
          { current: { revision: bytes === null ? null : revision(bytes) } });
      }
    };
    checkCurrent();
    checkRoot();
    // Reuse init's path validation and private metadata layout, without writing outside the vault.
    initDataDir(detectedRoot, { ...settings, language: opts.language, register: false });
    checkRoot();
    const expected = current ?? Buffer.from(JSON.stringify(defaultConfig(opts.language ?? 'en'), null, 2) + '\n');
    fs.writeFileAtomic(checkedPath(detectedRoot, '.cairn/config.json'), text, () => {
      checkRoot();
      const bytes = readChecked(detectedRoot, '.cairn/config.json');
      if (bytes === null || !bytes.equals(expected)) {
        throw new CairnError('conflict', 'Configuration changed during detection.');
      }
    });
  }
  const data = { path: root, config, revision: opts['dry-run'] ? currentRevision : revision(text),
    ...detection, changes, written: !opts['dry-run'] };
  return opts.json ? { data, warnings: detection.warnings }
    : { data: `${preview}${opts['dry-run'] ? 'Dry run; no files written.' : 'Detected schema saved.'}`,
      warnings: detection.warnings };
}

export function writeCommands({ string, boolean }) {
  const commands = [];
  const add = (name, summary, args, options, run, { mode = 'write', needsData = true, dangerous = false, actor } = {}) => {
    commands.push({ name, summary, args, options, mode, needsData, dangerous, ...(actor === false ? { actor } : {}), run });
  };
  const bodyOptions = { body: string('Read body from stdin; accepts only -.'), 'body-file': string('Read body from a file relative to cwd.') };
  const multiple = (summary) => ({ ...string(summary), multiple: true });
  for (const type of ['project', 'card', 'note', 'research']) {
    const options = { title: string('Set the title.'), ...bodyOptions,
      ...(type === 'project' ? { status: string('Set active, paused or archived.'), tone: string('Set tone from 1 to 8.'),
        alias: multiple('Add an alias; repeat for multiple aliases.') } : { tag: multiple('Set tags; repeat for multiple tags.') }),
      ...(type === 'card' ? { column: string('Set the column key.'), priority: string('Set urgent, important or low.'),
        now: string('Set the one-line "now" status; an empty value removes it.'),
        next: string('Set the one-line "next" status; an empty value removes it.'),
        needs: string('Set what the owner is needed for, one line; an empty value removes it.') } : {}),
      ...(['note', 'research'].includes(type) ? { kind: string('Set the entity kind.'), source: string('Set the source.'),
        sources: multiple('Set sources; repeat for multiple sources.') } : {}),
      ...(type === 'note' ? { pin: boolean('Pin the note; cannot be combined with --unpin.'),
        unpin: boolean('Unpin the note; cannot be combined with --pin.') } : {}),
      ...(['note', 'research'].includes(type) ? { 'valid-from': string('Set the first valid date.'),
        'valid-until': string('Set the last valid date.'), 'superseded-by': string('Set the replacement reference.') } : {}),
      ...(type === 'note' ? { code: multiple('Set code paths; repeat for multiple paths.') } : {}),
      ...(type === 'research' ? { date: string('Set the research date.'), 'source-date': string('Set the source date.'),
        processed: boolean('Mark as processed.') } : {}),
    };
    add(`${type} add`, `Create a ${type}.`, [], options, async (ctx, args, opts, io) => {
      const body = await readBody(opts, io);
      if (opts.project === undefined && opts.linkedProjectError) throw opts.linkedProjectError;
      const fields = patchFields(ctx, type, { ...opts, project: opts.project ?? opts.linkedProject });
      const changed = type === 'card' ? card.addCard(ctx, fields, body ?? '', mutationOptions(opts))
        : entity.create(ctx, type, fields, body ?? '', mutationOptions(opts));
      return mutation(ctx, changed, opts);
    });
    add(`${type} update`, `Update a ${type}.`, ['<ref>'], options, async (ctx, [ref], opts, io) => {
      const body = await readBody(opts, io), patch = patchFields(ctx, type, opts);
      const before = entity.resolve(ctx, type, ref);
      const changed = entity.update(ctx, type, ref, patch, { ...mutationOptions(opts), body });
      return mutation(ctx, changed, opts, { ...before, title: patch.title ?? before.title,
        data: { ...before.data, ...patch, updated: ctx.clock.now().toISOString() },
        ...(body === undefined ? {} : { body, acceptance: acceptanceCounts(body) }) });
    });
    add(`${type} rm`, `Move a ${type} to trash.`, ['<ref>'], {}, (ctx, [ref], opts) => {
      const before = entity.resolve(ctx, type, ref);
      return mutation(ctx, entity.remove(ctx, type, ref, mutationOptions(opts)), opts, before);
    }, { dangerous: type === 'project' });
  }

  add('card move', 'Move a card to a column and position.', ['<ref>', '[column]'], {
    column: string('Set the target column key.'), before: string('Place before this card.'), after: string('Place after this card.'),
  }, (ctx, [ref, column], opts) => {
    if (column !== undefined && opts.column !== undefined) throw new CairnError('usage', 'Specify the column once.');
    return mutation(ctx, card.moveCard(ctx, ref, { column: column ?? opts.column, before: opts.before, after: opts.after }, mutationOptions(opts)), opts);
  });
  add('card claim', 'Claim a card or renew its lease.', ['<ref>'], {
    renew: boolean('Renew your current lease.'), steal: boolean('Take an unexpired claim with confirmation.'),
  }, (ctx, [ref], opts) => mutation(ctx, card.claimCard(ctx, ref, { renew: opts.renew, steal: opts.steal }, mutationOptions(opts)), opts),
  { dangerous: { option: 'steal' } });
  for (const [name, fn] of [['release', card.releaseCard], ['done', card.doneCard]]) {
    add(`card ${name}`, `${name === 'release' ? 'Release' : 'Complete'} a card.`, ['<ref>'], {},
      (ctx, [ref], opts) => mutation(ctx, fn(ctx, ref, mutationOptions(opts)), opts));
  }
  add('card comment', 'Append a card comment.', ['<ref>', '[text]'], bodyOptions, async (ctx, [ref, text], opts, io) => {
    if (text !== undefined && (opts.body !== undefined || opts['body-file'] !== undefined)) throw new CairnError('usage', 'Specify comment text once.');
    return mutation(ctx, card.commentCard(ctx, ref, (await readBody(opts, io)) ?? text, mutationOptions(opts)), opts);
  });
  add('card check', 'Check or uncheck an acceptance item.', ['<ref>', '<n>'], { uncheck: boolean('Uncheck the item.') }, (ctx, [ref, n], opts) => {
    if (!/^[1-9]\d*$/u.test(n) || !Number.isSafeInteger(Number(n))) throw new CairnError('usage', 'Acceptance item must be a positive integer.');
    return mutation(ctx, card.checkCard(ctx, ref, Number(n), { uncheck: opts.uncheck }, mutationOptions(opts)), opts);
  });
  add('journal add', 'Append a journal job with ordered items.', [], {
    title: string('Set the job title.'), label: string('Set the job label.'), date: string('Use YYYY-MM-DD; defaults to today.'),
    ...Object.fromEntries(['decision', 'discovery', 'pitfall', 'lesson', 'item'].map((type) => [type, multiple(`Append a ${type}; repeat as needed.`)])),
  }, (ctx, args, opts) => {
    const date = opts.date ?? entity.localDate(ctx);
    const changed = journal.addEntry(ctx, { title: opts.title, label: opts.label, date, entries: opts.entries }, mutationOptions(opts));
    return mutation(ctx, changed, opts, { type: 'journal', path: changed.path,
      ref: `@${changed.path.slice(0, -3)}`, title: date, data: { date } });
  });

  add('ingest', 'Store a raw source and an unprocessed research record in one operation.', [], {
    title: string('Set the source title.'), file: string('Read the source from a .md or .txt file relative to cwd.'),
    body: string('Read the source from stdin; accepts only -.'), url: string('Record the source url (never fetched).'),
    date: string('Set the source date, YYYY-MM-DD; defaults to today.'), into: string('Store under this raw/ subfolder.'),
  }, async (ctx, args, opts, io) => {
    if (opts.title === undefined) throw new CairnError('usage', 'ingest needs --title.');
    if ((opts.file === undefined) === (opts.body === undefined)) throw new CairnError('usage', 'Choose --file or --body -.');
    // --max-bytes lowers the 5 MB input limit only when given; its default bounds output text.
    const limit = opts.maxBytesSet ? Math.min(opts['max-bytes'], MAX_INPUT) : MAX_INPUT;
    if (opts.file !== undefined && !/\.(?:md|txt)$/iu.test(opts.file)) throw new CairnError('validation', 'Only .md and .txt files can be ingested.');
    const bytes = opts.file !== undefined ? readFileBytes(io, opts.file, limit, 'Source') : await readStdinBytes(io, limit, 'Source');
    if (opts.project === undefined && opts.linkedProjectError) throw opts.linkedProjectError;
    const done = ingest(ctx, { title: opts.title, bytes, url: opts.url, date: opts.date, into: opts.into,
      project: opts.project ?? opts.linkedProject, maxBytes: limit }, mutationOptions(opts));
    const { raw, research, input_sha256, duplicate, todo, related } = done;
    return { data: { raw, research, input_sha256, duplicate, todo, related }, warnings: done.warnings };
  });
  add('trash restore', 'Restore a trash item.', ['<id>'], {}, (ctx, [id], opts) => {
    const changed = trash.restore(ctx, id, mutationOptions(opts));
    const text = readChecked(ctx.root, `.cairn/trash/${id}`, 'utf8');
    return mutation(ctx, changed, opts, text === null ? undefined : extract(ctx.schema, changed.path, text));
  });
  add('undo', 'Undo the latest operation.', [], {}, (ctx, args, opts) => {
    const record = latestUndoable(ctx);
    const before = record && readChecked(ctx.root, record.path, 'utf8');
    const changed = undo(ctx, { dryRun: opts['dry-run'] === true });
    const items = (record.items ?? [record]).map((item) => {
      const text = item.before === null ? null : item.beforeBytes ? Buffer.from(item.beforeBytes, 'base64').toString('utf8') : item.before;
      return { path: item.path, revision: item.before === null ? null : revision(item.beforeBytes ? Buffer.from(item.beforeBytes, 'base64') : item.before), text };
    });
    const first = items[0];
    return mutation(ctx, { ...changed, items: items.map(({ text, ...item }) => item) }, opts,
      (first.text ?? before) === null ? undefined : extract(ctx.schema, first.path, first.text ?? before));
  });
  add('init', 'Initialize a data directory.', ['[path]'], {
    detect: string('Detect an existing vault schema; preview with --dry-run, confirm with --yes.'),
    yes: boolean('Apply a detected schema without prompting; only with --detect.'),
    language: string('Use tr or en (default: en).'), preset: string('Use default or tr-wiki (default: default).'),
    'set-default': boolean('Make this the default data directory, replacing an existing default.'),
  }, async (ctx, [path], opts, io) => {
    const settings = environment(io);
    const root = resolve(io.cwd, opts.detect ?? path ?? findDataDir({ ...settings,
      flag: opts.data && resolve(io.cwd, opts.data), env: { ...io.env,
        ...(io.env.CAIRN_DATA ? { CAIRN_DATA: resolve(io.cwd, io.env.CAIRN_DATA) } : {}) } }).path);
    const config = defaultConfig(opts.language ?? 'en');
    if (!Object.hasOwn(PRESETS, opts.preset ?? 'default')) throw new CairnError('validation', 'Invalid preset.');
    if (opts.preset === 'tr-wiki') config.schema = structuredClone(PRESETS['tr-wiki']);
    let loaded, current = null;
    try {
      if (fs.existsSync(root)) current = readChecked(realRoot(root), '.cairn/config.json');
    } catch (error) {
      if (error instanceof CairnError) throw error;
      throw new CairnError('validation', 'Invalid data directory.');
    }
    if (opts['if-revision'] !== undefined && opts['if-revision'] !== (current === null ? null : revision(current))) {
      throw new CairnError('conflict', 'Configuration has changed.', { current: { revision: current === null ? null : revision(current) } });
    }
    if (opts.detect !== undefined) return initDetected(root, opts, io, settings, current);
    if (opts['dry-run']) {
      // Validate existing config without running initialization or writing discovery state.
      loaded = current === null ? config : loadConfig(realRoot(root));
    } else {
      // An agent must not be able to redirect every later session to another folder.
      loaded = initDataDir(root, { ...settings, language: opts.language, preset: opts.preset,
        register: opts['set-default'] ? true : 'if-unset' });
    }
    const recorded = findDataDir({ ...settings, env: {} });
    const warnings = recorded.source === 'state' && resolve(recorded.path) !== resolve(root) && !opts['dry-run']
      ? [`not_default:${recorded.path}`] : [];
    return { data: { path: root, config: loaded, revision: revision(current ?? JSON.stringify(loaded, null, 2) + '\n') }, warnings };
  }, { needsData: false, dangerous: { option: 'set-default' } });
  commands.at(-1).prepare = (args, opts, io) => {
    const [path] = args;
    if (opts.detect !== undefined && (opts.preset !== undefined || path !== undefined || opts['set-default'])) {
      throw new CairnError('validation', 'Use --detect without --preset, a positional path or --set-default.');
    }
    if (opts.yes && opts.detect === undefined) throw new CairnError('validation', '--yes requires --detect.');
  };
  add('link', 'Link a git repository to a project.', ['<project>'], { gitignore: boolean('Ignore the project link in git.') }, (ctx, [ref], opts, io) => {
    const root = findRepoRoot(io.cwd);
    if (!root || !fs.lstatSync(checkedPath(realRoot(root), '.git'), { throwIfNoEntry: false })) throw new CairnError('validation', 'A git repository is required.');
    const project = entity.resolve(ctx, 'project', ref);
    if (project.id === null) throw new CairnError('validation', 'The project needs an id before linking.');
    const text = `project = ${project.id}\n`;
    if (fs.lstatSync(checkedPath(realRoot(root), '.cairn'), { throwIfNoEntry: false })?.isDirectory()) {
      throw new CairnError('validation', 'A data directory cannot be a project link.');
    }
    const before = readChecked(realRoot(root), '.cairn', 'utf8');
    if (opts['if-revision'] !== undefined && opts['if-revision'] !== (before === null ? null : revision(before))) {
      throw new CairnError('conflict', 'Project link has changed.', { current: { revision: before === null ? null : revision(before) } });
    }
    const ignore = opts.gitignore ? readChecked(realRoot(root), '.gitignore', 'utf8') ?? '' : null;
    if (!opts['dry-run']) {
      writeProjectLink(root, project.id);
      try {
        recordRepo(ctx.stateDir, project.id, realRoot(root));
      } catch (error) {
        if (!(error instanceof CairnError)) throw error;
        ctx.warnings.push('repo_not_recorded');
      }
      if (ignore !== null && !ignore.split(/\r?\n/u).includes('.cairn')) {
        fs.writeFileAtomic(checkedPath(realRoot(root), '.gitignore'), `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}.cairn\n`, () => {
          if ((readChecked(realRoot(root), '.gitignore', 'utf8') ?? '') !== ignore) throw new CairnError('conflict', 'Git ignore file has changed.');
        });
      }
    }
    return { data: { ...summary(ctx, project, opts, []), revision: revision(text) } };
  }, { dangerous: true });
  add('export board', 'Export the derived Obsidian board; writing board.md needs an actor.', [], { stdout: boolean('Return board text instead of writing board.md.') }, (ctx, args, opts) => {
    const text = exportBoard(ctx);
    if (opts.stdout) return { data: text };
    if (!ctx.actor) throw new CairnError('actor_required', 'Writing board.md requires an actor.');
    const path = checkedPath(ctx.root, 'board.md');
    // board.md is derived and kept out of history, so only a board this command generated may be replaced.
    const before = readChecked(ctx.root, 'board.md', 'utf8');
    const generated = (content) => parseFile(content).data?.cairnboard === 'export';
    if (before !== null && !generated(before)) {
      throw new CairnError('conflict', 'board.md was not generated by Cairnboard; move it away first.',
        { current: { path: 'board.md', revision: revision(before) } });
    }
    const warnings = [];
    if (!opts['dry-run']) withLock(ctx, lockName('board.md'), () => {
      const shadow = readShadow(ctx);
      // Without a baseline (trail skipped or off) the atomic write's own comparison below still guards the file.
      if (shadow.initialized && (shadowEntry(shadow, 'board.md')?.rev ?? null)
        !== (before === null ? null : revision(before))) {
        throw new CairnError('conflict', 'board.md changed during export; retry to reconcile it.');
      }
      fs.writeFileAtomic(path, text, () => {
        if (readChecked(ctx.root, 'board.md', 'utf8') !== before) {
          throw new CairnError('conflict', 'board.md changed during export.');
        }
      });
      try { recordShadow(ctx, [{ path: 'board.md', bytes: Buffer.from(text) }]); }
      catch { warnings.push('shadow_write_failed'); }
    });
    return { data: { path: 'board.md', revision: revision(text) }, warnings };
  }, { actor: false });
  return commands;
}
