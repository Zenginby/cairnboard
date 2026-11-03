import { visibleLines } from './links.mjs';
import { SOURCE_HEADING } from './rules.mjs';

// Wiki spec §13: does a quote or number a page states occur in the raw source it cites? The comparison is the same
// normalisation on both sides; it says nothing about whether the claim is true.

const MARKS = /[*_`~>#|[\]()]/gu;
const INVISIBLE = /[­​-‏⁠﻿]/gu;
const DOUBLE = /[“”„‟«»″"]/gu;
const SINGLE = /[‘’‚‛′']/gu;
const DASH = /[‐-―−-]/gu;

/** Markdown marks dropped, spacing, quotes and dashes unified, NFC, case folded (Turkish). */
export function normalizeForEvidence(text) {
  return String(text).normalize('NFC').toLocaleLowerCase('tr').normalize('NFC')
    .replace(INVISIBLE, '').replace(DOUBLE, '"').replace(SINGLE, "'").replace(DASH, '-').replace(MARKS, '').replace(/\s+/gu, ' ').trim();
}

const NUMBER = /(?<![\p{L}\p{N}])(?:\d+(?:[.,]\d+)?\s?(?:%|(?:k|K|M|MB|GB|KB|ms|sn|s)\b)|%\d+(?:[.,]\d+)?|\d{4}-\d{2}-\d{2})/gu;
const MIN_WORDS = 4;
const MAX_QUOTE = 400;
const CLOSERS = { '"': '"', '“': '”', '„': '“”' };

// The quote that opens at `at`, as { end, value } (end after the closer), or null. At most MAX_QUOTE characters are
// looked at and no blank line may intervene, so an unclosed quote costs a bounded scan, never the rest of the text.
function quoteAt(text, at, nearest) {
  const closers = CLOSERS[text[at]];
  // The nearest closer is cached per character (positions only grow), so an unclosed opener costs O(1).
  if (Math.min(...[...closers].map((char) => nearest(char, at + 1))) - at > MAX_QUOTE + 1) return null;
  const stop = Math.min(text.length, at + 1 + MAX_QUOTE + 1);
  for (let index = at + 1; index < stop; index++) {
    const char = text[index];
    if (closers.includes(char)) return index - at - 1 > MAX_QUOTE || index === at + 1 ? null : { end: index + 1, value: text.slice(at + 1, index).trim() };
    if (char === '\n') {
      let next = index + 1;
      while (text[next] === ' ' || text[next] === '\t') next++;
      if (text[next] === '\n') return null;
    }
  }
  return null;
}

/**
 * Quotes of at least four words and number patterns, in order of position: `{ line, kind, value }`. Linear in the text
 * and stops after `limit` claims.
 */
export function extractClaims(text, limit = Infinity) {
  const claims = [];
  const spans = [];
  const cache = new Map();
  const nearest = (char, from) => {
    if (!(cache.get(char) >= from)) {
      const found = text.indexOf(char, from);
      cache.set(char, found < 0 ? Infinity : found);
    }
    return cache.get(char);
  };
  for (let at = 0; at < text.length && spans.length < limit; at++) {
    if (!Object.hasOwn(CLOSERS, text[at])) continue;
    const quote = quoteAt(text, at, nearest);
    if (!quote) continue;
    spans.push([at, quote.end]);
    if (quote.value.split(/\s+/u).length >= MIN_WORDS) claims.push({ at, kind: 'quote', value: quote.value });
    at = quote.end - 1;
  }
  // Numbers inside a quote are checked with the quote.
  let span = 0;
  let numbers = 0;
  for (const match of text.matchAll(NUMBER)) {
    if (numbers >= limit) break;
    while (span < spans.length && spans[span][1] <= match.index) span++;
    if (span < spans.length && spans[span][0] <= match.index) continue;
    claims.push({ at: match.index, kind: 'number', value: match[0] });
    numbers++;
  }
  claims.sort((a, b) => a.at - b.at);
  let line = 1;
  let scanned = 0;
  return claims.slice(0, limit).map(({ at, kind, value }) => {
    for (; scanned < at; scanned++) if (text[scanned] === '\n') line++;
    return { line, kind, value };
  });
}

const blank = (line) => ' '.repeat(line.length);

/**
 * The parts of a page that make claims: its text with frontmatter, code (fenced or inline), links, addresses and the
 * Sources section blanked out (line numbers stay), plus the line numbers inside the Sources section.
 */
export function analyzePage(text) {
  const lines = text.split('\n');
  const keep = new Array(lines.length).fill(false);
  const sources = new Set();
  let inSources = false;
  for (const { content, line } of visibleLines(text)) {
    if (SOURCE_HEADING.test(content.toLocaleLowerCase('tr'))) inSources = true;
    else if (/^ {0,3}#{1,2}[ \t]/u.test(content)) inSources = false;
    if (inSources) sources.add(line);
    else keep[line - 1] = true;
  }
  const claimText = lines.map((line, index) => keep[index]
    ? line.replace(/`[^`]*`/gu, blank).replace(/\[\[[^\]]*\]\]/gu, blank).replace(/\bhttps?:\/\/[^\s)>\]]+/giu, blank) : '').join('\n');
  return { claimText, sources };
}

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** Claims no source text contains; `sources` are already normalised raw texts. A claim is checked against all of them. */
export function unsupported(claims, sources) {
  const haystack = sources.join('\n');
  return claims.filter((claim) => {
    const needle = normalizeForEvidence(claim.value);
    if (claim.kind === 'quote') return !haystack.includes(needle);
    // "20 MB" and "20MB" are the same number; a longer number never contains a shorter one.
    const tight = needle.replace(/\s+/gu, '');
    const variants = [tight, tight.replace(/^(\d+(?:[.,]\d+)?)(\D)/u, '$1 $2')];
    return !variants.some((variant) => new RegExp(`(?<![\\p{N}.,])${escape(variant)}(?![\\p{N}]|[.,]\\p{N})`, 'u').test(haystack));
  });
}
