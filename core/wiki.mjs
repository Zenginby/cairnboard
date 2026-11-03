import { basename } from 'node:path';
import { parseFile } from './frontmatter.mjs';
import { readFile } from './store.mjs';
import { withIndex } from './index.mjs';
import { foldTr, oneLine, stripHidden } from './text.mjs';

const SUMMARY_MAX = 200;
const heading = (line) => /^ {0,3}#{1,6}(?:[ \t]|$)/u.test(line);

// `[[name|label]]` reads as its label (or name) so a catalog line never turns into a link of its own.
function plain(text) {
  return text.replace(/\[\[([^[\]\n]+)\]\]/gu, (match, inner) => {
    const [target, ...label] = inner.split('|');
    return label.length ? label.join('|').trim() : target.split('#')[0].trim().replace(/\.md$/iu, '');
  });
}

// First sentence of the first paragraph after the title: headings, code fences and blank lines are skipped.
export function firstSentence(body) {
  let fence = null;
  const paragraph = [];
  for (const line of body.split(/\r?\n/u)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker && (marker[1][0] === '~' || !marker[2].includes('`'))) {
      if (paragraph.length) break;
      fence = marker[1];
      continue;
    }
    if (!line.trim() || heading(line)) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(line.trim());
  }
  const text = stripHidden(plain(paragraph.join(' '))).text.replace(/\s+/gu, ' ').trim();
  const end = text.search(/[.!?](?:\s|$)/u);
  return (end < 0 ? text : text.slice(0, end + 1)).slice(0, SUMMARY_MAX).trim();
}

/** Wiki pages (notes of a kind other than `note`): { path, kind, title, summary, out, in }. */
export function wikiIndex(ctx, { kind } = {}) {
  const language = ctx.config?.language ?? 'en';
  // Everything comes from one strict cache read: no per-row query can fall back to scanning files.
  const pages = withIndex(ctx, (db) => {
    const outs = db.prepare('SELECT COUNT(*) AS n FROM links WHERE src_path = ?');
    const ins = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT src_path, line, field FROM links WHERE target_path = ?)`);
    return db.prepare("SELECT path, kind, title, error, bad_encoding FROM files WHERE type = 'note' AND kind != 'note' ORDER BY path").all()
      .filter((row) => kind === undefined || row.kind === kind)
      .map((row) => ({ ...row, out: outs.get(row.path).n, in: ins.get(row.path).n }));
  });
  const entries = pages.map((row) => {
    const file = row.error === 'too-large' || row.bad_encoding ? null : readFile(ctx, row.path);
    return { path: row.path, kind: row.kind, title: row.title, summary: file ? firstSentence(parseFile(file.text).body) : '',
      out: row.out, in: row.in };
  });
  return entries.sort((a, b) => a.kind.localeCompare(b.kind, language) || a.title.localeCompare(b.title, language)
    || a.path.localeCompare(b.path));
}

/** `- [[file name]] — summary` lines under one heading per kind (the schema's value alias when it has one). */
export function formatCatalog(entries, ctx) {
  const alias = Object.fromEntries(Object.entries(ctx?.schema?.values?.kind ?? {}).map(([name, canonical]) => [canonical, name]));
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.kind)) groups.set(entry.kind, []);
    groups.get(entry.kind).push(entry);
  }
  return [...groups].map(([kind, items]) => [`## ${alias[kind] ?? kind}`, ...items.map((entry) => {
    const name = basename(entry.path).replace(/\.md$/iu, '');
    return `- [[${name}]]${entry.summary ? ` — ${oneLine(entry.summary)}` : ''}`;
  })].join('\n')).join('\n\n') + (groups.size ? '\n' : '');
}

const WAKEUP = /^(?:uyanis|wake-up)$/u;

/**
 * The first `## Uyanış` (`## Wake-up`) section of a page, optionally titled `(YYYY-MM-DD)`: { heading, line, text,
 * words }, or null. It runs to the next heading of level one or two; `line` is the heading's line in the file.
 */
export function wakeupSection(text) {
  const file = parseFile(text);
  let line = text.slice(0, file.bodyStart).split('\n').length - 1;
  let fence = null;
  let found = null;
  const body = [];
  for (const content of file.body.split(/\r?\n/u)) {
    line++;
    const marker = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      if (found) body.push(content);
      continue;
    }
    if (marker && (marker[1][0] === '~' || !marker[2].includes('`'))) fence = marker[1];
    else {
      const title = content.match(/^ {0,3}(#{1,2})[ \t]+(.*?)[ \t]*#*[ \t]*$/u);
      if (found && title) break;
      if (!found && title?.[1] === '##'
        && WAKEUP.test(foldTr(title[2].replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/u, '').trim()))) {
        found = { heading: title[2], line };
        continue;
      }
    }
    if (found) body.push(content);
  }
  if (!found) return null;
  const section = body.join('\n');
  return { ...found, text: section, words: section.split(/\s+/u).filter(Boolean).length };
}
