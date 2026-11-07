import { basename } from 'node:path';
import * as fs from './fsx.mjs';
import { CairnError } from './errors.mjs';
import { requireCardOwner, resolve } from './entity.mjs';
import { extract } from './extract.mjs';
import { assertRules, checkPage, ruleWarnings } from './check.mjs';
import { mentionCandidates, withIndex } from './index.mjs';
import { linkTarget, visibleLines, withoutCode } from './links.mjs';
import { openForRead, safeRelative } from './paths.mjs';
import { foldTr, pathKey } from './text.mjs';
import { revision, write } from './store.mjs';

const invalid = (message, details) => new CairnError('validation', message, details);
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
const word = /[\p{L}\p{N}]/u;

function namesOf(target) {
  const aliases = target.data.aliases;
  return [...new Set([target.title, basename(target.path).replace(/\.md$/iu, ''),
    ...(Array.isArray(aliases) ? aliases : [aliases])].filter((name) => typeof name === 'string')
    .map(foldTr).filter((name) => name.trim()))].sort((a, b) => b.length - a.length);
}

function linkName(ctx, path) {
  const full = path.replace(/\.md$/iu, '');
  const name = basename(full);
  if (linkTarget(name).targetName !== name.normalize('NFC')) {
    return linkTarget(full).targetName === full.normalize('NFC') ? full : path;
  }
  try {
    return withIndex(ctx, (db) => {
      const paths = db.prepare('SELECT path FROM targets WHERE name = ?').all(pathKey(name));
      return paths.length === 1 && paths[0].path === path ? name : full;
    });
  } catch (error) {
    if (error.code !== 'index_unavailable') throw error;
    // Without the target inventory, only the full path is known to be unambiguous.
    return full;
  }
}

function readPage(ctx, path) {
  const fd = openForRead(ctx.root, path);
  try {
    if (fs.fstatSync(fd).size > 5 * 1024 * 1024) throw invalid('Page exceeds 5 MB.');
    const bytes = fs.readFileSync(fd);
    const text = bytes.toString('utf8');
    if (!bytes.equals(Buffer.from(text))) throw invalid('Page is not UTF-8.');
    return { text, revision: revision(bytes) };
  } finally {
    fs.closeSync(fd);
  }
}

// Fold graphemes with source offsets: folding can remove marks or expand a ligature. Only whole graphemes
// may be patched, and the Unicode letter/number boundary uses the same folding as the index.
function lineMatches(visible, names) {
  const folded = foldTr(visible);
  if (!names.some((name) => folded.includes(name))) return [];
  const starts = [], ends = [];
  let mapped = '';
  for (const { segment, index } of segmenter.segment(visible)) {
    const part = foldTr(segment);
    mapped += part;
    for (let at = 0; at < part.length; at++) {
      starts.push(index);
      ends.push(index + segment.length);
    }
  }
  const found = [];
  for (const name of names) {
    let at = 0;
    while ((at = mapped.indexOf(name, at)) !== -1) {
      const end = at + name.length;
      const start = starts[at], stop = ends[end - 1];
      if ((at === 0 || starts[at - 1] !== start) && (end === starts.length || ends[end] !== stop)
        && !word.test([...mapped.slice(Math.max(0, at - 2), at)].at(-1) ?? '')
        && !word.test(String.fromCodePoint(mapped.codePointAt(end) ?? 32))) found.push({ start, end: stop });
      at++;
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  // A title and its shorter alias at the same position describe one mention, not two.
  const matches = [];
  for (const hit of found) if (!matches.length || hit.start >= matches.at(-1).end) matches.push(hit);
  return matches;
}

// Tabs advance to four-column stops. List content indentation is measured in the same columns.
function columns(text, start = 0) {
  let column = start;
  for (const char of text) column += char === '\t' ? 4 - column % 4 : 1;
  return column;
}

function* mentionLines(text) {
  const lists = [];
  let blank = true;
  let codeIndent = null;
  let previous = 0;
  for (const item of visibleLines(text)) {
    const { content, line } = item;
    if (previous && line !== previous + 1) {
      lists.length = 0;
      codeIndent = null;
      blank = true;
    }
    previous = line;
    if (!content.trim()) {
      blank = true;
      continue;
    }
    const space = content.match(/^[ \t]*/u)[0];
    const indent = columns(space);
    if (codeIndent !== null && indent >= codeIndent) continue;
    codeIndent = null;
    while (lists.length && indent < lists.at(-1)) lists.pop();
    const base = lists.at(-1) ?? 0;
    // Indented code cannot interrupt a paragraph, and a list's content indentation is not code indentation.
    if (blank && indent >= base + 4) {
      codeIndent = base + 4;
      continue;
    }
    const marker = content.slice(space.length).match(/^(?:[-+*]|\d{1,9}[.)])([ \t]+)/u);
    if (marker && indent < base + 4) lists.push(columns(marker[0], indent));
    blank = /^ {0,3}#{1,6}(?:[ \t]|$)/u.test(content);
    yield item;
  }
}

function scan(text, names) {
  const lines = [...mentionLines(text)];
  const body = text.split('\n').map(() => '');
  for (const { content, line } of lines) body[line - 1] = content;
  const visible = withoutCode(body.join('\n'))
    .replace(/\[\[[^[\]\n]*\]\]/gu, (link) => ' '.repeat(link.length)).split('\n');
  return lines.map(({ content, line }) => ({ content, line, matches: lineMatches(visible[line - 1], names) }))
    .filter(({ matches }) => matches.length);
}

export function mentions(ctx, ref, { limit = 50 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 500) throw invalid('Limit must be an integer from 0 to 500.');
  const target = resolve(ctx, 'note', ref);
  const names = namesOf(target);
  const result = [];
  if (!limit) return result;
  for (const page of mentionCandidates(ctx, target.path, names)) {
    const { text } = readPage(ctx, page.path);
    for (const { content, line, matches } of scan(text, names)) {
      const start = Math.max(0, matches[0].start - 60);
      result.push({ ...page, line, snippet: content.slice(start, start + 160) });
      if (result.length === limit) return result;
    }
  }
  return result;
}

/**
 * @param {*} ctx @param {string} ref @param {string} location
 * @param {import('./store.mjs').MutationOptions} [options]
 */
export function linkMention(ctx, ref, location, { ifRevision, dryRun = false } = {}) {
  const selected = typeof location === 'string' && /^(.*):([1-9]\d*)$/u.exec(location);
  if (!selected || !Number.isSafeInteger(Number(selected[2]))) throw invalid('Link needs a path:line location.');
  const path = safeRelative(selected[1]).replace(/\\/gu, '/');
  const line = Number(selected[2]);
  const target = resolve(ctx, 'note', ref);
  const names = namesOf(target);
  const file = readPage(ctx, path);
  if (ifRevision !== undefined && ifRevision !== file.revision) throw new CairnError('conflict', 'File changed since it was read.');
  if (!mentionCandidates(ctx, target.path, names).some((page) => page.path === path)) throw invalid('Page is not an unlinked mention.');
  const hit = scan(file.text, names).find((item) => item.line === line);
  const count = hit?.matches.length ?? 0;
  if (count !== 1) throw invalid(`Line has ${count} matches; exactly one is required.`, { current: { count } });
  const { start, end } = hit.matches[0];
  const label = hit.content.slice(start, end);
  const name = linkName(ctx, target.path);
  if (/[\[\]|#\r\n]/u.test(name) || /[\[\]|\r\n]/u.test(label)) throw invalid('Mention cannot be represented as a wiki link.');
  const link = label === name ? `[[${name}]]` : `[[${name}|${label}]]`;
  let offset = 0;
  for (let number = 1; number < line; number++) offset = file.text.indexOf('\n', offset) + 1;
  if (line === 1 && file.text.startsWith('\uFEFF')) offset++;
  const patched = file.text.slice(0, offset + start) + link + file.text.slice(offset + end);
  let warnings = [];
  const result = write(ctx, { path, target: `@${path.replace(/\.md$/iu, '')}`, op: 'mentions.link', ifRevision: file.revision, dryRun,
    apply: (text) => {
      const page = extract(ctx.schema, path, text);
      if (page?.type === 'card') requireCardOwner(ctx, page.data);
      if (page?.type === 'note' || page?.type === 'research') {
        const checked = checkPage(ctx, { path, text: patched, lenient: true });
        assertRules(checked.errors);
        warnings = ruleWarnings(checked.warnings);
      }
      return patched;
    } });
  return { ...result, warnings: [...result.warnings, ...warnings] };
}
