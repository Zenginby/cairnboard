import { platform } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { CairnError } from '../../core/errors.mjs';
import { features, loadConfig } from '../../core/config.mjs';
import { readChecked, realRoot } from '../../core/paths.mjs';
import { findDataDir } from '../../core/roots.mjs';
import {
  clearShadow, CONFIG_LIMITS, LANGUAGES, previewConfig, readSettings, setConfig, setFeature, setLanguage,
} from '../../core/settings.mjs';
import { shadowStats } from '../../core/shadow.mjs';
import { revision } from '../../core/store.mjs';
import { oneLine, stripHidden } from '../../core/text.mjs';
import { actorPattern } from '../output.mjs';

const FEATURES = [
  ['change-trail', 'changeTrail'],
  ['change-content', 'changeContent'],
  ['live-updates', 'liveUpdates'],
  ['mentions', 'mentions'],
];
const cliToKey = new Map(FEATURES);
const keyToCli = new Map(FEATURES.map(([cli, key]) => [key, cli]));
const AGENT_MARKERS = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'GEMINI_CLI', 'CURSOR_AGENT',
];
const OWNER_ONLY = 'Change settings from your own terminal or the Settings page.';

function dataLocation(opts, io) {
  const env = io.env ?? {};
  const cwd = io.cwd ?? process.cwd();
  const resolved = { ...env, ...(env.CAIRN_DATA ? { CAIRN_DATA: resolve(cwd, env.CAIRN_DATA) } : {}) };
  return findDataDir({
    flag: opts.data && resolve(cwd, opts.data),
    env: resolved,
    home: env.HOME ?? env.USERPROFILE,
    platform: platform(),
  }).path;
}

export function readConfiguredFeatures(opts = {}, io = {}) {
  try {
    return features(loadConfig(realRoot(dataLocation(opts, io))));
  } catch {
    return features({});
  }
}

// `language` is the one setting that is not an on/off feature; it shares `config get` and `config set`.
const LANGUAGE = 'language';
// Board settings go through the guarded `setConfig` writer; `columns` is read-only, one column is set by name.
const LEASE = 'lease-minutes';
const COLUMNS = 'columns';
const COLUMNS_ORDER = 'columns-order';
const COLUMN_NAME = /^column\.([a-z][a-z0-9-]*)\.(label|hidden)$/u;
const UNKNOWN_GET = 'Unknown setting. Use change-trail, change-content, live-updates, mentions, language, '
  + 'lease-minutes or columns.';
const UNKNOWN_SET = 'Unknown setting. Use change-trail, change-content, live-updates, mentions, language, '
  + 'lease-minutes, column.<key>.label, column.<key>.hidden or columns-order.';

function parseFeature(name, { write = false } = {}) {
  if (name === LANGUAGE) return { cli: name, key: name, language: true };
  if (name === LEASE) return { cli: name, key: 'leaseMinutes', board: 'lease' };
  if (!write && name === COLUMNS) return { cli: name, key: name, board: 'columns' };
  if (write && name === COLUMNS_ORDER) return { cli: name, key: 'columns.order', board: 'order' };
  const column = write ? COLUMN_NAME.exec(name) : null;
  if (column) return { cli: name, key: `columns.${column[2]}`, board: column[2], column: column[1] };
  const key = cliToKey.get(name);
  if (!key) throw new CairnError('validation', write ? UNKNOWN_SET : UNKNOWN_GET);
  return { cli: name, key };
}

function parseLanguage(value) {
  if (LANGUAGES.includes(value)) return value;
  throw new CairnError('validation', 'Invalid language. Use tr or en.');
}

function parseToggle(value) {
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new CairnError('validation', 'Invalid feature value. Use on or off.');
}

/** The `setConfig` changes for a board setting, and the value reported back. Labels are checked by the writer. */
function boardChange(feature, input) {
  switch (feature.board) {
    case 'lease': {
      const minutes = /^[0-9]{1,5}$/u.test(input) ? Number(input) : NaN;
      if (!(minutes >= CONFIG_LIMITS.leaseMin && minutes <= CONFIG_LIMITS.leaseMax)) {
        throw new CairnError('validation', 'Invalid setting: leaseMinutes',
          { field: 'leaseMinutes', reason: 'lease_range' });
      }
      return { changes: { leaseMinutes: minutes }, value: minutes };
    }
    case 'label':
      return { changes: { columns: { labels: { [feature.column]: input } } }, value: input.normalize('NFC').trim() };
    case 'hidden': {
      if (input !== 'on' && input !== 'off') throw new CairnError('validation', 'Invalid column value. Use on or off.');
      return { changes: { columns: { hidden: { [feature.column]: input === 'on' } } }, value: input === 'on' };
    }
    default: {
      const order = input.split(',').map((key) => key.trim());
      return { changes: { columns: { order } }, value: order };
    }
  }
}

function boardText(feature, value) {
  if (feature.board === 'hidden') return value ? 'on' : 'off';
  if (feature.board === 'order') return value.join(',');
  return oneLine(stripHidden(String(value)).text);
}

const columnLine = ({ key, label, role, hidden }) => [key, oneLine(stripHidden(label).text), role,
  ...(hidden ? ['hidden'] : [])].join('\t');

function writeActor(opts) {
  if (opts.actor === undefined) return 'cli:owner';
  if (!actorPattern.test(opts.actor)) throw new CairnError('usage', 'Invalid actor name.');
  return `cli:${opts.actor}`;
}

function requireOwnerTerminal(io) {
  const agent = AGENT_MARKERS.find((name) => io.env?.[name]);
  const tty = Boolean(io.isTTY) && io.stdin?.isTTY === true && io.stdout?.isTTY === true;
  if (agent || !tty) throw new CairnError('owner_only', OWNER_ONLY);
}

async function confirmWord(io, message, expected) {
  io.stderr.write(`${oneLine(stripHidden(message).text)} Type ${expected}: `);
  const lines = createInterface({ input: io.stdin, crlfDelay: Infinity, terminal: false });
  let answer = null;
  try {
    for await (const line of lines) {
      answer = line.trim();
      break;
    }
  } finally {
    lines.close();
  }
  if (answer !== expected) throw new CairnError('usage', `Confirmation did not match "${expected}".`);
}

function currentSettings(ctx) {
  if (ctx.ephemeral) {
    return { features: features(ctx.config), language: ctx.config.language,
      leaseMinutes: ctx.config.leaseMinutes,
      columns: ctx.config.columns
        .map(({ key, label, role, hidden }) => ({ key, label, role, hidden: hidden === true })),
      revision: null, shadow: { blobs: 0, bytes: 0 }, lastChange: null };
  }
  return readSettings(ctx);
}

function formatChange(change) {
  if (!change) return 'none';
  const when = oneLine(String(change.ts ?? ''));
  const who = oneLine(String(change.actor ?? 'unknown'));
  if (Array.isArray(change.feature)) {
    const items = change.feature.map((key) => `${keyToCli.get(key) ?? key}=${change.after?.[key] ? 'on' : 'off'}`);
    return `${when} ${who} (${items.join(', ')})`;
  }
  const name = keyToCli.get(change.feature) ?? change.feature;
  return `${when} ${who} (${name}=${change.after ? 'on' : 'off'})`;
}

function formatSettings(settings) {
  const { blobs, bytes } = settings.shadow;
  return [
    ...FEATURES.map(([cli, key]) => `${cli}: ${settings.features[key] ? 'on' : 'off'}`),
    `${LANGUAGE}: ${settings.language}`,
    `shadow: ${blobs} ${blobs === 1 ? 'blob' : 'blobs'}, ${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`,
    `last-change: ${formatChange(settings.lastChange)}`,
  ].join('\n');
}

function diskRevision(ctx) {
  const bytes = readChecked(ctx.root, '.cairn/config.json');
  return bytes === null ? null : revision(bytes);
}

export function configCommands() {
  return [
    {
      name: 'config',
      summary: 'Show feature settings, shadow size and last change.',
      args: [],
      options: {},
      mode: 'read',
      needsData: true,
      dangerous: false,
      run: (ctx, args, opts) => {
        const data = currentSettings(ctx);
        return { data: opts.json ? data : formatSettings(data) };
      },
    },
    {
      name: 'config get',
      summary: 'Get one feature setting, the language, the claim lease or the board columns.',
      args: ['<feature>'],
      options: {},
      mode: 'read',
      needsData: true,
      dangerous: false,
      prepare: ([name]) => parseFeature(name),
      run: (ctx, args, opts, io, feature) => {
        const settings = currentSettings(ctx);
        if (feature.language) {
          const data = { name: LANGUAGE, value: settings.language, revision: settings.revision };
          return { data: opts.json ? data : settings.language };
        }
        if (feature.board === 'lease') {
          const data = { name: LEASE, value: settings.leaseMinutes, revision: settings.revision };
          return { data: opts.json ? data : String(settings.leaseMinutes) };
        }
        if (feature.board === 'columns') {
          const data = { name: COLUMNS, value: settings.columns, revision: settings.revision };
          return { data: opts.json ? data : settings.columns.map(columnLine).join('\n') };
        }
        const value = settings.features[feature.key];
        const data = { name: feature.cli, feature: feature.key, value, revision: settings.revision };
        return { data: opts.json ? data : (value ? 'on' : 'off') };
      },
    },
    {
      name: 'config set',
      summary: 'Enable or disable a feature, or set the language, the claim lease or a board column.',
      args: ['<feature>', '<value>'],
      options: {},
      mode: 'write',
      actor: false,
      agentVisible: false,
      needsData: true,
      dangerous: false,
      prepare: async ([name, value], opts, io) => {
        const feature = parseFeature(name, { write: true });
        const board = feature.board ? boardChange(feature, value) : null;
        const enabled = board ? board.value : feature.language ? parseLanguage(value) : parseToggle(value);
        const actor = writeActor(opts);
        if (!opts['dry-run']) {
          requireOwnerTerminal(io);
          let where = null;
          try { where = dataLocation(opts, io); } catch {}
          const target = where ? ` (data: ${where})` : '';
          await confirmWord(io, `Set ${feature.cli} to ${value}${target}?`, feature.cli);
        }
        return { feature, enabled, value, actor, changes: board?.changes };
      },
      run: (ctx, args, opts, io, prepared) => {
        const { feature, enabled, value, actor, changes } = prepared;
        if (opts['dry-run']) {
          const rev = diskRevision(ctx);
          if (opts['if-revision'] !== undefined && opts['if-revision'] !== rev) {
            throw new CairnError('conflict', 'Configuration changed since it was read.');
          }
          if (changes) {
            const { fields } = previewConfig(ctx.config, changes);
            const data = { name: feature.cli, value: enabled, changed: fields.length > 0, revision: rev, fields };
            return { data: opts.json ? data : `${feature.cli}: ${boardText(feature, enabled)} (dry-run)` };
          }
          const current = feature.language ? ctx.config.language : features(ctx.config)[feature.key];
          const data = { name: feature.cli, ...(feature.language ? {} : { feature: feature.key }), value: enabled,
            changed: current !== enabled, revision: rev };
          return { data: opts.json ? data : `${feature.cli}: ${value} (dry-run)` };
        }
        const expectedRevision = opts['if-revision'] ?? readSettings(ctx).revision;
        if (changes) {
          const saved = setConfig({ ...ctx, actor }, { changes, expectedRevision, actor });
          const data = { name: feature.cli, value: enabled, changed: saved.changed, revision: saved.revision,
            fields: saved.fields };
          const text = `${feature.cli}: ${boardText(feature, enabled)}${saved.changed ? '' : ' (unchanged)'}`;
          return { data: opts.json ? data : text };
        }
        if (feature.language) {
          const saved = setLanguage({ ...ctx, actor }, { language: enabled, expectedRevision, actor });
          const data = { name: LANGUAGE, value: enabled, changed: saved.changed, revision: saved.revision };
          // A running web server keeps its interface language until it restarts or the Settings page saves it.
          const text = saved.changed ? `${LANGUAGE}: ${value}` : `${LANGUAGE}: ${value} (unchanged)`;
          return { data: opts.json ? data : text };
        }
        const result = setFeature({ ...ctx, actor }, { name: feature.key, value: enabled, expectedRevision, actor });
        if (feature.key === 'changeTrail' && enabled) {
          ctx.warnings = ctx.warnings.filter((warning) => warning !== 'trail_disabled');
        }
        const data = {
          name: feature.cli, feature: feature.key, value: enabled, changed: result.changed, revision: result.revision,
        };
        const text = result.changed ? `${feature.cli}: ${value}` : `${feature.cli}: ${value} (unchanged)`;
        return { data: opts.json ? data : text, ...(result.warnings?.length ? { warnings: result.warnings } : {}) };
      },
    },
    {
      name: 'config clear-shadow',
      summary: 'Delete stored shadow content blobs while keeping change-trail revisions.',
      args: [],
      options: {},
      mode: 'write',
      actor: false,
      agentVisible: false,
      needsData: true,
      dangerous: false,
      prepare: async (args, opts, io) => {
        const actor = writeActor(opts);
        if (!opts['dry-run']) {
          requireOwnerTerminal(io);
          let where = null;
          try { where = dataLocation(opts, io); } catch {}
          const target = where ? ` (data: ${where})` : '';
          await confirmWord(io, `Clear shadow content blobs${target}?`, 'clear');
        }
        return { actor };
      },
      run: (ctx, args, opts, io, prepared) => {
        const cleared = opts['dry-run'] ? shadowStats(ctx) : clearShadow({ ...ctx, actor: prepared.actor }, prepared);
        const { blobs, bytes } = cleared;
        const unit = `${blobs} ${blobs === 1 ? 'blob' : 'blobs'} (${bytes} ${bytes === 1 ? 'byte' : 'bytes'})`;
        const text = opts['dry-run'] ? `${unit} to clear (dry-run).` : `Cleared ${unit}.`;
        return { data: opts.json ? cleared : text };
      },
    },
  ];
}
