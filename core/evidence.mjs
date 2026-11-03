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

const QUOTE = /"([^"]+)"|“([^”]+)”|„([^“”]+)[“”]/gu;
const NUMBER = /(?<![\p{L}\p{N}])(?:\d+(?:[.,]\d+)?\s?(?:%|(?:k|K|M|MB|GB|KB|ms|sn|s)\b)|%\d+(?:[.,]\d+)?|\d{4}-\d{2}-\d{2})/gu;
const MIN_WORDS = 4;
const MAX_QUOTE = 400;

/** Quotes of at least four words and number patterns, in order of position: `{ line, kind, value }`. */
export function extractClaims(text) {
  const claims = [];
  const lineAt = (index) => text.slice(0, index).split('\n').length;
  let rest = text;
  for (const match of text.matchAll(QUOTE)) {
    const value = (match[1] ?? match[2] ?? match[3]).trim();
    if (value.length > MAX_QUOTE || /\n[\t ]*\n/u.test(value) || value.split(/\s+/u).length < MIN_WORDS) continue;
    claims.push({ at: match.index, line: lineAt(match.index), kind: 'quote', value });
    // Numbers inside a quote are checked with the quote.
    rest = rest.slice(0, match.index) + match[0].replace(/[^\n]/gu, ' ') + rest.slice(match.index + match[0].length);
  }
  for (const match of rest.matchAll(NUMBER)) claims.push({ at: match.index, line: lineAt(match.index), kind: 'number', value: match[0] });
  return claims.sort((a, b) => a.at - b.at).map(({ line, kind, value }) => ({ line, kind, value }));
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
