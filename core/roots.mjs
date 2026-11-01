import { homedir } from 'node:os';
import { dirname, join, parse, relative, resolve, win32 } from 'node:path';
import * as fs from './fsx.mjs';
import { checkedPath, openForRead, realRoot, samePath } from './paths.mjs';
import { defaultConfig, loadConfig } from './config.mjs';
import { CairnError } from './errors.mjs';

const invalid = () => new CairnError('validation', 'Data directory or project link is invalid or not writable.');
const projectId = /^p-[0-9a-hjkmnp-tv-z]{6}$/u;

export function stateDir({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'Cairnboard');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Cairnboard');
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'cairnboard');
}

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

export function initDataDir(path, { language = 'en', home = homedir(), platform = process.platform, env = process.env, clock } = {}) {
  const config = defaultConfig(language);
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
    for (const rel of ['projects', 'cards', 'notes', 'research', 'journal', '.cairn/events', '.cairn/history',
      '.cairn/pending', '.cairn/trash', '.cairn/locks', '.cairn/backup']) {
      fs.mkdirSync(checkedPath(root, rel), { recursive: true, mode: 0o700 });
    }
    const file = checkedPath(root, '.cairn/config.json');
    if (!fs.existsSync(file)) fs.writeFileAtomic(file, JSON.stringify(config, null, 2) + '\n');
    const loaded = loadConfig(root);
    fs.writeFileAtomic(checkedPath(root, '.cairn/.gitignore'), 'index.db*\nhistory/\npending/\ntrash/\nlocks/\nbackup/\n');
    const state = stateDir({ platform, env, home });
    makeDirectory(state);
    fs.writeFileAtomic(checkedPath(realRoot(state), 'state.json'), JSON.stringify({ data: root }));
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
  try {
    return fs.lstatSync(join(dir, name));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

export function findProjectLink(cwd) {
  for (const dir of ancestors(cwd)) {
    if (!marker(dir, '.cairn')?.isFile()) continue;
    const fd = openForRead(realRoot(dir), '.cairn');
    let text;
    try {
      text = fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
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
