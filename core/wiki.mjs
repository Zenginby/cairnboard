import { basename } from 'node:path';
import { parseFile } from './frontmatter.mjs';
import { readFile } from './store.mjs';
import { backlinks, outlinks, rows } from './index.mjs';
import { oneLine, stripHidden } from './text.mjs';

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
  const entries = rows(ctx, 'note').filter((row) => row.kind !== 'note' && (kind === undefined || row.kind === kind))
    .map((row) => {
      const file = readFile(ctx, row.path);
      return { path: row.path, kind: row.kind, title: row.title,
        summary: file ? firstSentence(parseFile(file.text).body) : '',
        out: outlinks(ctx, row.path).length, in: backlinks(ctx, row.path).length };
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
