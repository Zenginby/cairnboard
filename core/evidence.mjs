import { visibleLines, withoutCode } from './links.mjs';
import { SOURCE_HEADING } from './rules.mjs';

// Wiki spec §13: does a quote or number a page states occur in the raw source it cites? The comparison is the same
// normalisation on both sides; it says nothing about whether the claim is true.

const MARKS = /[*_`~>#|[\]()]/gu;
const INVISIBLE = /[­​-‏⁠﻿]/gu;
const DOUBLE = /[“”„‟«»″"]/gu;
const SINGLE = /[‘’‚‛′']/gu;
const DASH = /[‐-―−-]/gu;

/** Markdown marks dropped, spacing, quotes and dashes unified, NFC, all four I variants folded together. */
export function normalizeForEvidence(text) {
  // Match foldTr's I/ı folding, but keep accents: evidence must still distinguish café from cafe.
  return String(text).normalize('NFC').replace(/[Iıİ]/gu, 'i').toLowerCase().normalize('NFC')
    .replace(INVISIBLE, '').replace(DOUBLE, '"').replace(SINGLE, "'").replace(DASH, '-').replace(MARKS, '').replace(/\s+/gu, ' ').trim();
}

const NUMBER = /(?<![\p{L}\p{N}])(?:\d+(?:[.,]\d+)?\s?(?:%|(?:k|K|M|MB|GB|KB|ms|sn|s)\b)|%\d+(?:[.,]\d+)?|\d{4}-\d{2}-\d{2})/gu;
const MIN_WORDS = 4;
const MAX_QUOTE = 400;
const CLOSERS = { '"': '"', '“': '”', '„': '“”' };

/**
 * Quotes of at least four words and number patterns, in order of position: `{ line, kind, value }`. Linear in the
 * text and stops after `limit` claims. A quote pairs an opener with the next closer, however far; one that is too long
 * or holds a blank line is skipped whole (its closer never becomes an opener), and the nearest closer of each kind is
 * cached, so no region of the text is scanned twice.
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
  for (let at = 0; at < text.length && claims.length < limit; at++) {
    if (!Object.hasOwn(CLOSERS, text[at])) continue;
    const close = Math.min(...[...CLOSERS[text[at]]].map((char) => nearest(char, at + 1)));
    if (close === Infinity || close === at + 1) continue;
    const start = at;
    at = close;
    const value = text.slice(start + 1, close).trim();
    if (value.length > MAX_QUOTE || /\r?\n[\t \r]*\n/u.test(value) || value.split(/\s+/u).length < MIN_WORDS) continue;
    spans.push([start, close + 1]);
    claims.push({ at: start, kind: 'quote', value });
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
  const lines = text.split(/\r?\n/u);
  const keep = new Array(lines.length).fill(false);
  const sources = new Set();
  let inSources = false;
  for (const { content, line } of visibleLines(text)) {
    if (SOURCE_HEADING.test(content.toLocaleLowerCase('tr'))) inSources = true;
    else if (/^ {0,3}#{1,2}[ \t]/u.test(content)) inSources = false;
    if (inSources) sources.add(line);
    else keep[line - 1] = true;
  }
  const visible = lines.map((line, index) => keep[index] ? line : '').join('\n');
  const claimText = withoutCode(visible).replace(/\[\[[^\[\]\n]*\]\]/gu, blank)
    .replace(/\bhttps?:\/\/[^\s)>\]]+/giu, blank);
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
