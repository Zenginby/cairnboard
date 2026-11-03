import { dirname, isAbsolute, join, resolve, sep, win32 } from 'node:path';
import * as fs from './fsx.mjs';
import { CairnError } from './errors.mjs';
import { pathKey } from './text.mjs';

const unsafe = () => new CairnError('unsafe_path', 'Path is outside the root or contains unsafe components.');
const nofollow = fs.constants.O_NOFOLLOW ?? 0;
// Containment compares real paths exactly: Linux can hold distinct NFC and NFD names side by side.
// APFS treats both forms as one name, so macOS folds them (Finder writes NFD).
const real = {
  darwin: (path) => path.normalize('NFC').toLowerCase(),
  win32: (path) => path.toLowerCase(),
}[process.platform] ?? ((path) => path);

export function samePath(a, b, platform = process.platform) {
  return platform === 'darwin' || platform === 'win32'
    ? pathKey(a) === pathKey(b)
    : a.normalize('NFC') === b.normalize('NFC');
}

export function realRoot(path) {
  return fs.realpathSync(path);
}

export function safeRelative(rel) {
  if (typeof rel !== 'string' || !rel || /[\0:]/u.test(rel) || isAbsolute(rel) || win32.isAbsolute(rel)) throw unsafe();
  const parts = rel.split(/[\\/]/u);
  if (parts.some((part) => part === '..' || /[<>"|?*\x00-\x1f]/u.test(part)
    || (/[. ]$/u.test(part) && part !== '.')
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\s*\.|$)/iu.test(part))) throw unsafe();
  const clean = parts.filter((part) => part && part !== '.');
  if (!clean.length) throw unsafe();
  return join(...clean);
}

function check(root, rel) {
  rel = safeRelative(rel);
  const abs = resolve(root, rel);
  let current = root;
  const parts = rel.split(sep);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw unsafe();
    } catch (error) {
      if (error.code !== 'ENOENT' || index !== parts.length - 1) throw error;
    }
  }
  fs.afterCheck(abs);
  // The lexical parent lies under the root, so an unchanged real parent proves containment.
  if (real(fs.realpathSync(dirname(abs))) !== real(dirname(abs))) throw unsafe();
  return abs;
}

export function checkedPath(root, rel) {
  // Resolving the root again would accept a root replaced by a symlink after initialization.
  return check(resolve(root), rel);
}

function openChecked(root, rel, flags) {
  // A concurrent atomic save replaces the file between open and stat; only a lasting mismatch is suspicious.
  for (let attempt = 0; ; attempt++) {
    const abs = check(resolve(root), rel);
    let fd;
    try {
      fd = fs.openSync(abs, flags | nofollow, 0o600);
      if (real(fs.realpathSync(abs)) !== real(abs)) throw unsafe();
      const opened = fs.fstatSync(fd);
      const resolved = fs.statSync(abs);
      if (opened.dev === resolved.dev && opened.ino === resolved.ino) return fd;
      fs.closeSync(fd);
      fd = undefined;
      if (attempt === 4) throw unsafe();
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      if (error.code === 'ELOOP') throw unsafe();
      throw error;
    }
  }
}

export function openForRead(root, rel) {
  return openChecked(root, rel, fs.constants.O_RDONLY);
}

export function openForAppend(root, rel) {
  return openChecked(root, rel, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND);
}

export function readChecked(root, rel, encoding) {
  let fd;
  try {
    fd = openForRead(root, rel);
    return fs.readFileSync(fd, encoding);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
