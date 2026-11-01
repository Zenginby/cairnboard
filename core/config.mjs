import { relative } from 'node:path';
import * as fs from './fsx.mjs';
import { checkedPath, openForRead, realRoot } from './paths.mjs';
import { CairnError } from './errors.mjs';

const version = 1;
const invalid = () => new CairnError('validation', 'Invalid configuration.');

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

function validate(config) {
  if (!config || Array.isArray(config) || !Number.isInteger(config.formatVersion) || config.formatVersion < 0) throw invalid();
  if (config.formatVersion > version) throw new CairnError('format_too_new', 'Configuration requires a newer format.');
  if (!['tr', 'en'].includes(config.language) || !Number.isInteger(config.leaseMinutes) || config.leaseMinutes <= 0
    || !Array.isArray(config.columns) || !config.columns.length) throw invalid();
  const keys = new Set();
  for (const column of config.columns) {
    if (!column || typeof column.key !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(column.key)
      || typeof column.label !== 'string' || !column.label.trim() || !['todo', 'doing', 'done'].includes(column.role)
      || keys.has(column.key)) throw invalid();
    keys.add(column.key);
  }
  return config;
}

function readConfig(root) {
  const fd = openForRead(root, '.cairn/config.json');
  try {
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
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
  while (config.formatVersion < version) {
    const current = config.formatVersion;
    if (typeof migrations?.[current] !== 'function') throw invalid();
    config = validate(migrations[current](config));
    if (config.formatVersion !== current + 1) throw invalid();
  }
  const file = checkedPath(root, '.cairn/config.json');
  fs.writeFileAtomic(file, JSON.stringify(config, null, 2) + '\n', () => {
    // An external writer can still race the short interval between this comparison and rename.
    if (readConfig(root) !== bytes) throw new CairnError('conflict', 'Configuration changed during migration.');
  });
  return { from, to: config.formatVersion, backup };
}
