import * as index from '../core/index.mjs';
import { foldTr } from '../core/text.mjs';
import { CairnError } from '../core/errors.mjs';
import { effectiveColumn } from '../core/card.mjs';

// Types with a web detail page; adding a type here adds it to `/api/search`, `/search` and the dialog.
export const WEB_SEARCH_TYPES = Object.freeze(['card', 'note']);

// Private-use marks that SQLite places around snippet hits; only these become <mark> after escaping.
const OPEN = '\uE000', CLOSE = '\uE001';
const MARKS = /[\uE000\uE001]/gu;
const WORD = /[\p{L}\p{N}]+/gu;
const MAX_QUERY = 200, MAX_LIMIT = 50, DEFAULT_LIMIT = 5, COUNT_CEILING = 1000;

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text) => text.replace(/[&<>"']/gu, (char) => ENTITIES[char]);

// Marks are trusted only when they alternate open/close and end closed; a file may contain the same characters.
function balanced(text) {
  let open = false;
  for (const char of text) {
    if (char === OPEN) { if (open) return false; open = true; } else if (char === CLOSE) {
      if (!open) return false;
      open = false;
    }
  }
  return !open;
}

/**
 * Turns a search snippet into safe HTML: everything is escaped, and only `<mark>` elements are produced.
 * `marked` snippets carry SQLite marks; otherwise whole words whose fold equals a query term are marked.
 * @param {string} text @param {{ marked: boolean, terms: string[] }} options
 */
export function snippetHtml(text, { marked, terms }) {
  text = typeof text === 'string' ? text : '';
  if (marked && balanced(text)) {
    return text.split(OPEN).map((part, at) => {
      if (at === 0) return escapeHtml(part);
      const [hit, rest] = part.split(CLOSE);
      return `<mark>${escapeHtml(hit)}</mark>${escapeHtml(rest)}`;
    }).join('');
  }
  text = text.replace(MARKS, '');
  if (marked) return escapeHtml(text);
  const wanted = new Set(terms);
  let html = '', last = 0;
  for (const match of text.matchAll(WORD)) {
    html += escapeHtml(text.slice(last, match.index));
    html += wanted.has(foldTr(match[0])) ? `<mark>${escapeHtml(match[0])}</mark>` : escapeHtml(match[0]);
    last = match.index + match[0].length;
  }
  return html + escapeHtml(text.slice(last));
}

const BEFORE = 8, AFTER = 16;

// A window of words from the original body around the first word whose fold is a query term (the body's start when
// only the title matched), with line breaks collapsed and an ellipsis wherever the body was cut.
function excerpt(body, terms) {
  const text = body.replace(MARKS, '').replace(/\s+/gu, ' ').trim();
  const words = [...text.matchAll(WORD)];
  if (!words.length) return text;
  const wanted = new Set(terms);
  const at = words.findIndex((word) => wanted.has(foldTr(word[0])));
  const start = at < 0 ? 0 : Math.max(0, at - BEFORE);
  const end = Math.min(words.length, at < 0 ? BEFORE + AFTER : at + AFTER);
  const from = start === 0 ? 0 : words[start].index;
  const to = end === words.length ? text.length : words[end].index;
  return `${start > 0 ? '… ' : ''}${text.slice(from, to).trim()}${end < words.length ? ' …' : ''}`;
}

const clampLimit = (limit) => Number.isInteger(limit) && limit >= 1 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT;

/**
 * Grouped web search over `WEB_SEARCH_TYPES`. `type` limits the results to one type; counts cover every type.
 * @param {*} ctx
 * @param {{ q: string, type?: string, limit?: number }} params
 * @param {Map<string, { id: string, title: string, tone: number }>} projects project references from the read layer
 */
export function searchView(ctx, { q, type, limit }, projects) {
  if (type !== undefined && type !== null && !WEB_SEARCH_TYPES.includes(type)) {
    throw new CairnError('validation', 'Invalid search type.');
  }
  const query = Array.from(typeof q === 'string' ? q.trim() : '').slice(0, MAX_QUERY).join('').trim();
  const terms = [...new Set(foldTr(query).match(WORD) ?? [])];
  const max = clampLimit(limit);
  const view = { query, type: type ?? null, results: {}, counts: {}, more: {} };
  for (const kind of WEB_SEARCH_TYPES) {
    // Only results with a detail page are listed and counted: a card needs an id, a note key always opens.
    const hits = terms.length ? index.search(ctx, query, { type: kind, limit: COUNT_CEILING + 1, mark: [OPEN, CLOSE] })
      .filter((hit) => kind !== 'card' || hit.id) : [];
    view.counts[kind] = hits.length > COUNT_CEILING ? `${COUNT_CEILING}+` : hits.length;
    view.results[kind] = [];
    view.more[kind] = false;
    if (!hits.length || (type && type !== kind)) continue;
    const rows = new Map(index.rows(ctx, kind).map((row) => [row.path, row]));
    view.more[kind] = hits.length > max;
    view.results[kind] = hits.slice(0, max).map((hit) => {
      const row = rows.get(hit.path);
      const project = row ? projects.get(row.data.project) : undefined;
      // The index holds folded text; show the original body when it can still be read, else the folded snippet.
      const body = index.searchBody(ctx, hit.path);
      return {
        type: kind,
        ref: hit.ref,
        title: String(hit.title ?? '').replace(MARKS, ''),
        snippetHtml: body === null ? snippetHtml(hit.snippet, { marked: hit.marked === true, terms })
          : snippetHtml(excerpt(body, terms), { marked: false, terms }),
        project: project ? { id: project.id, name: project.title, tone: project.tone } : null,
        column: kind === 'card' && row ? effectiveColumn(ctx.config, row).label : null,
        updated: typeof row?.data.updated === 'string' ? row.data.updated : null,
      };
    });
  }
  return view;
}
