import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Rules for design/prototypes (the reference the real screens copy): styles use tokens only, pages stay CSP-clean.
// src/styles/tokens.css is where the raw values live and is exempt (it is outside design/prototypes anyway).
const EXEMPT = new Set(['src/styles/tokens.css']);
const COLOR_FUNCTION = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/iu;
const HEX_COLOR = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![\w-])/iu;
const DURATION = /(?<![\w.#-])(?:\d+\.?\d*|\.\d+)m?s(?![\w-])/iu;
const TIMED_PROPERTY = /^(?:-webkit-)?(?:transition|animation)(?:-duration|-delay)?$/iu;

// Comments become spaces (newlines kept) so line numbers stay right.
const blank = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, ' '));
const lineAt = (text, index) => text.slice(0, index).split('\n').length;

// A value with var(...) calls and url(...) removed, so `var(--motion-duration-fast, 200ms)` and `url(#a1b)` are not read as raw.
function withoutCalls(value) {
  let result = value;
  for (let pass = 0; pass < 8; pass++) {
    const next = result.replace(/(?:var|url)\([^()]*\)/giu, ' ');
    if (next === result) break;
    result = next;
  }
  return result;
}

// Declarations only: prelude text before `{` (selectors, @media) is skipped so `#add` or `a:hover` never look like values.
function* declarations(css) {
  let start = 0;
  for (let at = 0; at < css.length; at++) {
    const char = css[at];
    if (char === '"' || char === "'") {
      const close = css.indexOf(char, at + 1);
      at = close < 0 ? css.length : close;
    } else if (char === '{') start = at + 1;
    else if (char === ';' || char === '}') {
      const text = css.slice(start, at);
      const colon = text.indexOf(':');
      if (colon > 0) yield { property: text.slice(0, colon).trim(), value: text.slice(colon + 1), index: start + text.indexOf(text.trim()) };
      start = at + 1;
    }
  }
}

export function lintCss(css) {
  const text = blank(css);
  const found = [];
  const add = (index, rule, detail) => found.push({ line: lineAt(text, index), rule, detail });
  for (const { property, value, index } of declarations(text)) {
    const bare = withoutCalls(value);
    if (COLOR_FUNCTION.test(bare)) add(index, 'raw-color', `${property}: ${value.trim()}`);
    else if (HEX_COLOR.test(bare)) add(index, 'raw-color', `${property}: ${value.trim()}`);
    if (TIMED_PROPERTY.test(property) && DURATION.test(bare)) add(index, 'raw-duration', `${property}: ${value.trim()}`);
    if (/cubic-bezier\(/iu.test(bare)) add(index, 'raw-easing', `${property}: ${value.trim()}`);
  }
  return found;
}

export function lintHtml(html) {
  const text = html.replace(/<!--[\s\S]*?-->/gu, (comment) => comment.replace(/[^\n]/gu, ' '));
  const found = [];
  const add = (index, rule, detail) => found.push({ line: lineAt(text, index), rule, detail });
  for (const match of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)) {
    if (!/\ssrc\s*=/iu.test(match[1])) add(match.index, 'inline-script', 'Script without src.');
    else if (match[2].trim()) add(match.index, 'inline-script', 'Script with both src and a body.');
  }
  for (const match of text.matchAll(/<style\b/giu)) add(match.index, 'inline-style', '<style> element.');
  for (const match of text.matchAll(/<[a-z][^>]*?\sstyle\s*=/giu)) add(match.index, 'inline-style', 'style attribute.');
  for (const match of text.matchAll(/<[a-z][^>]*?\s(on[a-z]+)\s*=/giu)) add(match.index, 'inline-handler', `${match[1]} attribute.`);
  const policy = Array.from(text.matchAll(/<meta\b[^>]*>/giu), (match) => match[0]).some((tag) => /http-equiv\s*=\s*["']?Content-Security-Policy\b/iu.test(tag) && /\scontent\s*=\s*["'][^"']*\S/iu.test(tag));
  if (!policy) add(0, 'missing-csp', 'No Content-Security-Policy <meta>.');
  return found;
}

function* files(dir, extension) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path, extension);
    else if (entry.name.endsWith(extension)) yield path;
  }
}

// → [{ file, line, rule, detail }] for every prototype stylesheet and page under root/design/prototypes.
export function lintPrototypes(root) {
  const base = join(root, 'design/prototypes');
  const found = [];
  for (const [extension, lint] of [['.css', lintCss], ['.html', lintHtml]]) {
    for (const path of files(base, extension)) {
      const file = relative(root, path).split(sep).join('/');
      if (EXEMPT.has(file)) continue;
      for (const item of lint(readFileSync(path, 'utf8'))) found.push({ file, ...item });
    }
  }
  return found;
}
