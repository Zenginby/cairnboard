import { isUtf8 } from 'node:buffer';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

function files(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

function spellings(path) {
  const forward = path.replaceAll('\\', '/'), backward = path.replaceAll('/', '\\');
  const escaped = (value) => JSON.stringify(value).slice(1, -1);
  return [pathToFileURL(path).href, forward, backward, escaped(forward), escaped(backward)];
}

function absolutePaths(paths) {
  const absolute = paths.filter((path) => path && isAbsolute(path)).map((path) => resolve(path));
  return new Set(absolute.flatMap((path) => existsSync(path) ? [path, realpathSync(path)] : [path]));
}

export function assertNoPaths(dir, paths) {
  const needles = [...new Set([...absolutePaths(paths)].flatMap(spellings))].map((path) => Buffer.from(path));
  for (const file of files(dir)) {
    const bytes = readFileSync(file);
    if (needles.some((path) => bytes.includes(path))) {
      throw new Error(`Local build or home path found in ${relative(dir, file)}.`);
    }
  }
}

export function makeAppPortable(root, out) {
  const placeholder = ['file:///C:/cairnboard', '/C:/cairnboard', 'C:\\cairnboard',
    '/C:/cairnboard', 'C:\\\\cairnboard'];
  const roots = absolutePaths([root]);
  const outputs = absolutePaths([out]);
  const replacements = [...roots].flatMap((path) => spellings(path).map((value, i) => [value, placeholder[i]]));
  for (const path of outputs) {
    if ([...roots].some((rootPath) => path.startsWith(rootPath + sep))) continue;
    spellings(path).forEach((value, i) => {
      const suffix = i === 2 ? '\\dist\\app' : i === 4 ? '\\\\dist\\\\app' : '/dist/app';
      replacements.push([value, placeholder[i] + suffix]);
    });
  }
  replacements.sort(([a], [b]) => b.length - a.length);
  for (const file of files(join(out, 'server'))) {
    const bytes = readFileSync(file);
    if (!isUtf8(bytes)) continue;
    const original = bytes.toString('utf8');
    let text = original;
    for (const [from, to] of replacements) text = text.replaceAll(from, () => to);
    if (text !== original) writeFileSync(file, text);
  }
  assertNoPaths(out, [...roots, ...outputs]);
}
