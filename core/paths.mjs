import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import * as fs from './fsx.mjs';
import { CairnError } from './errors.mjs';
import { pathKey } from './text.mjs';

const unsafe = () => new CairnError('unsafe_path', 'Path is outside the root or contains unsafe components.');

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

function within(root, path) {
  const from = process.platform === 'linux' ? root.normalize('NFC') : pathKey(root);
  const to = process.platform === 'linux' ? path.normalize('NFC') : pathKey(path);
  const rel = relative(from, to);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
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
  const parent = fs.realpathSync(dirname(abs));
  if (!within(root, parent) || !samePath(parent, dirname(abs))) throw unsafe();
  return abs;
}

export function checkedPath(root, rel) {
  // Resolving the root again would accept a root replaced by a symlink after initialization.
  return check(resolve(root), rel);
}

export function openForRead(root, rel) {
  root = resolve(root);
  const abs = check(root, rel);
  let fd;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const actual = fs.realpathSync(abs);
    if (!within(root, actual) || !samePath(actual, abs)) throw unsafe();
    const opened = fs.fstatSync(fd);
    const resolved = fs.statSync(actual);
    if (opened.dev !== resolved.dev || opened.ino !== resolved.ino) throw unsafe();
    return fd;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (error.code === 'ELOOP') throw unsafe();
    throw error;
  }
}
