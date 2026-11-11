import { dirname, join, relative } from 'node:path';
import * as fs from './fsx.mjs';
import { checkedPath, readChecked, realRoot } from './paths.mjs';
import { CairnError } from './errors.mjs';
import { resolveSchema } from './schema.mjs';
import { LINT_CODES, RULE_NAMES, RULE_SEVERITIES, SEVERITIES } from './rules.mjs';

const version = 1;
const invalid = () => new CairnError('validation', 'Invalid configuration.');
const featureNames = ['changeTrail', 'changeContent', 'liveUpdates', 'mentions'];

export function features(config) {
  const values = config.features;
  if (values !== undefined && (!values || typeof values !== 'object' || Array.isArray(values))) {
    throw new CairnError('validation', 'Invalid configuration: features');
  }
  for (const [key, value] of Object.entries(values ?? {})) {
    if (!featureNames.includes(key) || typeof value !== 'boolean') {
      throw new CairnError('validation', `Invalid configuration: features.${key}`);
    }
  }
  return Object.fromEntries(featureNames.map((name) => [name, values?.[name] ?? true]));
}

export function defaultConfig(language = 'en') {
  if (!['tr', 'en'].includes(language)) throw invalid();
  const labels = language === 'tr' ? ['Bekleyen', 'Yapılıyor', 'İncelemede', 'Bitti'] : ['Backlog', 'Doing', 'Review', 'Done'];
  return {
    formatVersion: version,
    language,
    columns: ['backlog', 'doing', 'review', 'done'].map((key, index) => ({
      key, label: labels[index], role: ['todo', 'doing', 'doing', 'done'][index],
    })),
    leaseMinutes: 120,
  };
}

// `lint`: a severity (`error|warn|info|off`) per lint code, and `staleDays` (0 turns `stale` off).
function validateLint(lint) {
  if (lint === undefined) return;
  if (!lint || typeof lint !== 'object' || Array.isArray(lint)) throw invalid();
  for (const [key, value] of Object.entries(lint)) {
    if (key === 'staleDays' ? !Number.isSafeInteger(value) || value < 0 : !LINT_CODES.includes(key) || !SEVERITIES.includes(value)) throw invalid();
  }
}

// `rules`: a severity (`error|warn|off`) per write rule (wiki spec §10).
function validateRules(rules) {
  if (rules === undefined) return;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) throw invalid();
  for (const [key, value] of Object.entries(rules)) if (!RULE_NAMES.includes(key) || !RULE_SEVERITIES.includes(value)) throw invalid();
}

export function validate(config) {
  if (!config || Array.isArray(config) || !Number.isInteger(config.formatVersion) || config.formatVersion < 0) throw invalid();
  if (config.formatVersion > version) throw new CairnError('format_too_new', 'Configuration requires a newer format.');
  if (!['tr', 'en'].includes(config.language) || !Number.isInteger(config.leaseMinutes) || config.leaseMinutes <= 0
    || !Array.isArray(config.columns) || !config.columns.length) throw invalid();
  const keys = new Set();
  for (const column of config.columns) {
    if (!column || typeof column.key !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(column.key)
      || typeof column.label !== 'string' || !column.label.trim() || !['todo', 'doing', 'done'].includes(column.role)
      || keys.has(column.key)
      || (column.hidden !== undefined && typeof column.hidden !== 'boolean')) throw invalid();
    keys.add(column.key);
  }
  // `hidden`: the web board leaves the column out (an archive); the CLI and card moves still use it.
  if (config.columns.every((column) => column.hidden === true)) throw invalid();
  // `agents.project`: the project whose cards form the agent board instead of the owner's board.
  const { agents } = config;
  if (agents !== undefined && (!agents || typeof agents !== 'object' || Array.isArray(agents)
    || (agents.project !== undefined && typeof agents.project !== 'string'))) throw invalid();
  resolveSchema(config);
  validateLint(config.lint);
  validateRules(config.rules);
  features(config);
  return config;
}

function readConfig(root) {
  const bytes = readChecked(root, '.cairn/config.json', 'utf8');
  if (bytes === null) throw new CairnError('not_found', 'Configuration not found.');
  return bytes;
}

function parseConfig(bytes) {
  let config;
  try {
    config = JSON.parse(bytes);
  } catch {
    throw invalid();
  }
  return validate(config);
}

export function loadConfig(root) {
  return parseConfig(readConfig(root));
}

export function needsMigration(config) {
  return validate(config).formatVersion < version;
}

function backupMarkdown(root, backup, rel = '') {
  const dir = rel ? checkedPath(root, rel) : root;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!rel && entry.name === '.cairn')) continue;
    const child = join(rel, entry.name);
    if (entry.isDirectory()) {
      backupMarkdown(root, backup, child);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const bytes = readChecked(root, child);
      if (bytes === null) continue;
      const target = join(backup, child);
      fs.mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileAtomic(checkedPath(root, relative(root, target)), bytes);
    }
  }
}

export function migrate(root, { migrations, clock }) {
  root = realRoot(root);
  const bytes = readConfig(root);
  let config = parseConfig(bytes);
  const from = config.formatVersion;
  if (!needsMigration(config)) return { from, to: from, backup: null };
  const backupRoot = checkedPath(root, '.cairn/backup');
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const stamp = clock.now().toISOString().slice(0, 19).replace(/:/gu, '');
  const name = `${stamp}-v${from}`;
  let backup;
  for (let attempt = 1; ; attempt++) {
    backup = checkedPath(root, `.cairn/backup/${name}${attempt === 1 ? '' : `-${attempt}`}`);
    try {
      fs.mkdirSync(backup, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  fs.writeFileAtomic(checkedPath(root, `${relative(root, backup)}/config.json`), bytes);
  backupMarkdown(root, backup);
  while (config.formatVersion < version) {
    const current = config.formatVersion;
    if (typeof migrations?.[current] !== 'function') throw invalid();
    config = validate(migrations[current](config));
    if (config.formatVersion !== current + 1) throw invalid();
  }
  const file = checkedPath(root, '.cairn/config.json');
  fs.writeFileAtomic(file, JSON.stringify(config, null, 2) + '\n', () => {
    // An external writer can still race the short interval between this comparison and rename.
    if (readChecked(root, '.cairn/config.json', 'utf8') !== bytes) {
      throw new CairnError('conflict', 'Configuration changed during migration.');
    }
  });
  return { from, to: config.formatVersion, backup };
}
