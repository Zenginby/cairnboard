import { platform } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { CairnError } from '../../core/errors.mjs';
import { features, loadConfig } from '../../core/config.mjs';
import { readChecked, realRoot } from '../../core/paths.mjs';
import { findDataDir } from '../../core/roots.mjs';
import { clearShadow, readSettings, setFeature } from '../../core/settings.mjs';
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

function parseFeature(name) {
  const key = cliToKey.get(name);
  if (!key) {
    throw new CairnError('validation', 'Unknown feature. Use change-trail, change-content, live-updates or mentions.');
  }
  return { cli: name, key };
}

function parseToggle(value) {
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new CairnError('validation', 'Invalid feature value. Use on or off.');
}

function writeActor(opts) {
  if (opts.actor === undefined) return 'cli:owner';
  if (!actorPattern.test(opts.actor)) throw new CairnError('usage', 'Invalid actor name.');
  return `cli:${opts.actor}`;
}

function requireOwnerTerminal(io) {
  const agent = AGENT_MARKERS.find((name) => io.env?.[name]);
  const tty = Boolean(io.isTTY) && io.stdin?.isTTY !== false && io.stdout?.isTTY !== false;
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
    return { features: features(ctx.config), revision: null, shadow: { blobs: 0, bytes: 0 }, lastChange: null };
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
      summary: 'Get one feature setting.',
      args: ['<feature>'],
      options: {},
      mode: 'read',
      needsData: true,
      dangerous: false,
      prepare: ([name]) => parseFeature(name),
      run: (ctx, args, opts, io, feature) => {
        const settings = currentSettings(ctx);
        const value = settings.features[feature.key];
        const data = { name: feature.cli, feature: feature.key, value, revision: settings.revision };
        return { data: opts.json ? data : (value ? 'on' : 'off') };
      },
    },
    {
      name: 'config set',
      summary: 'Enable or disable a feature.',
      args: ['<feature>', '<value>'],
      options: {},
      mode: 'write',
      actor: false,
      agentVisible: false,
      needsData: true,
      dangerous: false,
      prepare: async ([name, value], opts, io) => {
        const feature = parseFeature(name);
        const enabled = parseToggle(value);
        const actor = writeActor(opts);
        if (!opts['dry-run']) {
          requireOwnerTerminal(io);
          let where = null;
          try { where = dataLocation(opts, io); } catch {}
          const target = where ? ` (data: ${where})` : '';
          await confirmWord(io, `Set ${feature.cli} to ${value}${target}?`, feature.cli);
        }
        return { feature, enabled, value, actor };
      },
      run: (ctx, args, opts, io, prepared) => {
        const { feature, enabled, value, actor } = prepared;
        if (opts['dry-run']) {
          const rev = diskRevision(ctx);
          if (opts['if-revision'] !== undefined && opts['if-revision'] !== rev) {
            throw new CairnError('conflict', 'Configuration changed since it was read.');
          }
          const changed = features(ctx.config)[feature.key] !== enabled;
          const data = { name: feature.cli, feature: feature.key, value: enabled, changed, revision: rev };
          return { data: opts.json ? data : `${feature.cli}: ${value} (dry-run)` };
        }
        const expectedRevision = opts['if-revision'] ?? readSettings(ctx).revision;
        const result = setFeature({ ...ctx, actor }, { name: feature.key, value: enabled, expectedRevision, actor });
        if (feature.key === 'changeTrail' && enabled) {
          ctx.warnings = ctx.warnings.filter((warning) => warning !== 'trail_disabled');
        }
        const data = {
          name: feature.cli, feature: feature.key, value: enabled, changed: result.changed, revision: result.revision,
        };
        const text = result.changed ? `${feature.cli}: ${value}` : `${feature.cli}: ${value} (unchanged)`;
        return { data: opts.json ? data : text };
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
