import { homedir } from 'node:os';
import { dirname, join, parse, posix, relative, resolve, win32 } from 'node:path';
import * as fs from './fsx.mjs';
import { checkedPath, readChecked, realRoot, samePath } from './paths.mjs';
import { defaultConfig, loadConfig } from './config.mjs';
import { CairnError } from './errors.mjs';
import { PRESETS } from './presets.mjs';

const invalid = () => new CairnError('validation', 'Data directory or project link is invalid or not writable.');
const projectId = /^p-[0-9a-hjkmnp-tv-z]{6}$/u;

export function stateDir({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'Cairnboard');
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', 'Cairnboard');
  return posix.join(env.XDG_STATE_HOME || posix.join(home, '.local', 'state'), 'cairnboard');
}

/**
 * @param {{ flag?: string, env?: NodeJS.ProcessEnv, home?: string, platform?: NodeJS.Platform }} [options]
 */
export function findDataDir({ flag, env = process.env, home = homedir(), platform = process.platform } = {}) {
  const paths = platform === 'win32' ? win32 : { resolve, join };
  if (flag) return { path: paths.resolve(flag), source: 'flag' };
  if (env.CAIRN_DATA) return { path: paths.resolve(env.CAIRN_DATA), source: 'env' };
  try {
    const saved = JSON.parse(fs.readFileSync(paths.join(stateDir({ platform, env, home }), 'state.json'), 'utf8'));
    if (!saved || typeof saved.data !== 'string' || !saved.data) throw invalid();
    return { path: paths.resolve(saved.data), source: 'state' };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error instanceof CairnError ? error : invalid();
  }
  return { path: paths.join(home, 'Cairn'), source: 'default' };
}

function protectedPath(path, home, platform) {
  const root = platform === 'win32' ? win32.parse(path).root : parse(path).root;
  if (samePath(path, home, platform) || samePath(path, root, platform) || /^[a-z]:[\\/]?$/iu.test(path)) return true;
  const posix = path.replace(/\\/gu, '/').normalize('NFC');
  return /^(?:\/(?:private\/)?etc|\/usr|\/bin|\/System|\/Library)(?:\/|$)/iu.test(posix)
    || /^[a-z]:\/(?:Windows|Program Files)(?:\/|$)/iu.test(posix);
}

function writable(path) {
  fs.accessSync(path, fs.constants.W_OK);
  if (process.platform !== 'win32' && !(fs.statSync(path).mode & 0o222)) throw invalid();
}

function makeDirectory(path) {
  let ancestor = path;
  while (!fs.existsSync(ancestor)) ancestor = dirname(ancestor);
  writable(ancestor);
  fs.mkdirSync(path, { recursive: true, mode: 0o700 });
}

// `register`: true replaces the default data directory, 'if-unset' only records the first one, false never records.
/**
 * @param {string} path
 * @param {{ language?: string, preset?: string, home?: string, platform?: NodeJS.Platform,
 *   env?: NodeJS.ProcessEnv, clock?: { now: () => Date }, register?: boolean|'if-unset' }} [options]
 */
export function initDataDir(path, { language = 'en', preset = 'default', home = homedir(), platform = process.platform, env = process.env, clock, register = true } = {}) {
  const config = defaultConfig(language);
  if (!Object.hasOwn(PRESETS, preset)) throw invalid();
  if (preset !== 'default') config.schema = structuredClone(PRESETS[preset]);
  if (typeof path !== 'string' || !path || path.includes('\0') || protectedPath(path, home, platform)) throw invalid();
  try {
    const abs = resolve(path);
    let ancestor = abs;
    while (!fs.existsSync(ancestor)) ancestor = dirname(ancestor);
    const actual = resolve(realRoot(ancestor), relative(ancestor, abs));
    if (protectedPath(abs, resolve(home), platform) || protectedPath(actual, realRoot(home), platform)) throw invalid();
    makeDirectory(abs);
    const root = realRoot(abs);
    writable(root);
    const metadata = checkedPath(root, '.cairn');
    fs.mkdirSync(metadata, { recursive: true, mode: 0o700 });
    fs.chmodSync(metadata, 0o700);
    for (const rel of ['.cairn/events', '.cairn/history',
      '.cairn/pending', '.cairn/trash', '.cairn/locks', '.cairn/backup']) {
      fs.mkdirSync(checkedPath(root, rel), { recursive: true, mode: 0o700 });
    }
    const file = checkedPath(root, '.cairn/config.json');
    if (!fs.existsSync(file)) fs.writeFileAtomic(file, JSON.stringify(config, null, 2) + '\n');
    const loaded = loadConfig(root);
    fs.writeFileAtomic(checkedPath(root, '.cairn/.gitignore'), 'index.db*\nhistory/\npending/\ntrash/\nlocks/\nbackup/\n');
    const state = stateDir({ platform, env, home });
    const recorded = fs.existsSync(join(state, 'state.json'));
    if (register === true || (register === 'if-unset' && !recorded)) {
      makeDirectory(state);
      fs.writeFileAtomic(checkedPath(realRoot(state), 'state.json'), JSON.stringify({ data: root }));
    }
    return loaded;
  } catch (error) {
    if (error instanceof CairnError) throw error;
    throw invalid();
  }
}

function* ancestors(cwd) {
  let dir = resolve(cwd);
  for (;;) {
    yield dir;
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

function marker(dir, name) {
  return fs.lstatSync(join(dir, name), { throwIfNoEntry: false });
}

export function findProjectLink(cwd) {
  for (const dir of ancestors(cwd)) {
    if (!marker(dir, '.cairn')?.isFile()) continue;
    const text = readChecked(realRoot(dir), '.cairn', 'utf8');
    if (text === null) continue;
    const match = /^project\s*=\s*(p-[0-9a-hjkmnp-tv-z]{6})\s*$/u.exec(text);
    if (!match) throw invalid();
    return match[1];
  }
  return null;
}

export function writeProjectLink(dir, id) {
  if (typeof id !== 'string' || !projectId.test(id)) throw invalid();
  const root = realRoot(dir);
  const file = checkedPath(root, '.cairn');
  if (marker(root, '.cairn')?.isDirectory()) throw invalid();
  fs.writeFileAtomic(file, `project = ${id}\n`);
}

export function findRepoRoot(cwd) {
  for (const dir of ancestors(cwd)) if (marker(dir, '.git')) return dir;
  return resolve(cwd);
}

const linksFile = (dir) => join(dir, 'links.json');

function readRepoLinks(dir) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(linksFile(dir), 'utf8'));
  } catch (error) {
    return error.code === 'ENOENT' ? {} : null;
  }
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

/**
 * Remembers where this machine keeps a project's repository: `{ "<project id>": "<repository root>" }` in the state
 * directory (wiki spec §14). It is machine specific, so it never lands in the data folder.
 */
export function recordRepo(dir, id, repoRoot) {
  if (typeof id !== 'string' || !projectId.test(id) || typeof repoRoot !== 'string' || !repoRoot || repoRoot.includes('\0')
    || !(posix.isAbsolute(repoRoot) || win32.isAbsolute(repoRoot))) throw invalid();
  try {
    makeDirectory(dir);
    // A file that cannot be read is never overwritten: it may hold other projects' entries.
    const current = readRepoLinks(dir);
    if (current === null) throw invalid();
    const links = Object.fromEntries(Object.entries(current).filter(([key, value]) => projectId.test(key) && typeof value === 'string'));
    links[id] = repoRoot;
    fs.writeFileAtomic(linksFile(dir), JSON.stringify(links, null, 2) + '\n');
  } catch (error) {
    if (error instanceof CairnError) throw error;
    throw invalid();
  }
}

/** The repository root recorded for a project on this machine, or null (also for an unreadable file). */
export function repoFor(dir, id) {
  if (typeof dir !== 'string' || typeof id !== 'string' || !projectId.test(id)) return null;
  const links = readRepoLinks(dir) ?? {};
  return Object.hasOwn(links, id) && typeof links[id] === 'string' && links[id] ? links[id] : null;
}
