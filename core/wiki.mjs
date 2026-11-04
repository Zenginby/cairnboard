import { basename } from 'node:path';
import { parseFile } from './frontmatter.mjs';
import { withIndex } from './index.mjs';
import { foldTr, oneLine } from './text.mjs';

export { firstSentence } from './text.mjs';

/** Wiki pages (notes of a kind other than `note`): { path, kind, title, summary, out, in }. */
export function wikiIndex(ctx, { kind } = {}) {
  const language = ctx.config?.language ?? 'en';
  // Everything comes from one strict cache read: no per-row query can fall back to scanning files.
  const entries = withIndex(ctx, (db) => {
    const outs = db.prepare('SELECT COUNT(*) AS n FROM links WHERE src_path = ?');
    const ins = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT src_path, line, field FROM links WHERE target_path = ?)`);
    return db.prepare("SELECT path, kind, title, summary FROM files WHERE type = 'note' AND kind != 'note' ORDER BY path").all()
      .filter((row) => kind === undefined || row.kind === kind)
      .map((row) => ({ ...row, out: outs.get(row.path).n, in: ins.get(row.path).n }));
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
