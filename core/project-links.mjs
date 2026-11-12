import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { oneLine, stripHidden } from './text.mjs';

const ALLOWED_SCHEMES = new Set(['https:', 'http:', 'obsidian:']);
const MAX_INPUT = 5 * 1024 * 1024;
const parser = unified().use(remarkParse).use(remarkGfm);

/**
 * Returns true only for `https:` and `http:` URLs and for `obsidian://open?vault=…&file=…` (the one action the
 * body renderer allows), without whitespace, control characters, or backslashes. Rejects relative paths,
 * `javascript:`, `data:`, any other scheme and any other `obsidian:` action.
 * @param {unknown} href
 */
export function isAllowedLinkScheme(href) {
  if (typeof href !== 'string' || /[\s\p{Cc}\p{Cf}\\]/u.test(href)) return false;
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(href)) return false;
  try {
    const parsed = new URL(href);
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) return false;
    if (parsed.protocol !== 'obsidian:') return Boolean(parsed.hostname);
    // Same rule as the body renderer: only the `open` action with a vault and a file, nothing else.
    const params = [...parsed.searchParams];
    return parsed.hostname === 'open' && !parsed.hash && ['', '/'].includes(parsed.pathname) && params.length === 2
      && Boolean(parsed.searchParams.get('vault')) && Boolean(parsed.searchParams.get('file'));
  } catch {
    return false;
  }
}

function textOf(node) {
  if (!node) return '';
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(textOf).join('');
}

function hostHint(parsed) {
  if (parsed.protocol === 'obsidian:') return 'obsidian';
  return parsed.hostname.replace(/^www\./iu, '');
}

/**
 * Extracts unique allowed links (`https:`, `http:`, `obsidian:`) from a Markdown body in document order.
 * @param {unknown} markdown
 * @returns {Array<{ href: string, label: string, host: string, external: boolean }>}
 */
export function extractProjectLinks(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return [];
  if (Buffer.byteLength(markdown, 'utf8') > MAX_INPUT) return [];
  let tree;
  try {
    tree = parser.parse(stripHidden(markdown).text);
  } catch (error) {
    if (error instanceof RangeError) return [];
    throw error;
  }
  const definitions = new Map();
  const collectDefinitions = (node) => {
    if (node.type === 'definition' && typeof node.identifier === 'string') {
      const key = node.identifier.toLowerCase();
      if (!definitions.has(key)) definitions.set(key, node.url);
    }
    for (const child of node.children ?? []) collectDefinitions(child);
  };
  collectDefinitions(tree);

  const seen = new Set();
  const links = [];
  const walk = (node) => {
    if (node.type === 'code' || node.type === 'inlineCode') return;
    if (node.type === 'link' || node.type === 'linkReference') {
      const url = node.type === 'link' ? node.url : definitions.get(node.identifier?.toLowerCase());
      if (isAllowedLinkScheme(url)) {
        const parsed = new URL(url);
        if (!seen.has(parsed.href)) {
          seen.add(parsed.href);
          const host = hostHint(parsed);
          const label = oneLine(textOf(node)).trim() || host || url;
          links.push({
            href: url,
            label,
            host,
            external: parsed.protocol === 'http:' || parsed.protocol === 'https:',
          });
        }
      }
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return links;
}
