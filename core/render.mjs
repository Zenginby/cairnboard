import { createHash } from 'node:crypto';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { linkTarget } from './links.mjs';
import { normalizeId } from './ids.mjs';
import { slugify, stripHidden } from './text.mjs';

export const RENDER_POLICY = '2';
const MAX_INPUT = 5 * 1024 * 1024;
const MAX_ENTRIES = 200;
const MAX_HTML = 20 * 1024 * 1024;
const cache = new Map();
let cachedBytes = 0;

// Retain the default clobber protection, but expose only attributes needed by Markdown.
const schema = {
  ...defaultSchema,
  tagNames: defaultSchema.tagNames.filter((tag) => !['img', 'picture', 'source'].includes(tag)),
  attributes: {
    a: ['href', 'title', ['className', 'wikilink']],
    span: [['className', 'wikilink', 'wikilink-ghost']],
    ul: [['className', 'contains-task-list']],
    ol: ['start', ['className', 'contains-task-list']],
    li: [['className', 'task-list-item']],
    input: [['type', 'checkbox'], ['disabled', true], 'checked', 'ariaLabel'],
    th: ['align'], td: ['align'],
  },
  protocols: { href: ['http', 'https', 'mailto', 'obsidian'] },
};

function allowedLink(href) {
  if (typeof href !== 'string' || /[\s\p{Cc}\p{Cf}\\]/u.test(href)) return false;
  if (href.startsWith('#')) return true;
  if (href.startsWith('/') && !href.startsWith('//')) {
    try {
      const decoded = decodeURIComponent(href);
      return !decoded.startsWith('//') && !/[\\\p{Cc}]/u.test(decoded);
    } catch { return false; }
  }
  if (/^(?:https?:\/\/|mailto:)/u.test(href)) {
    try { return ['http:', 'https:', 'mailto:'].includes(new URL(href).protocol); } catch { return false; }
  }
  if (!/^obsidian:\/\/open\?[^#]+$/u.test(href)) return false;
  const params = new URL(href).searchParams;
  return [...params].length === 2 && params.has('vault') && params.has('file')
    && Boolean(params.get('vault')) && Boolean(params.get('file'));
}

function wikiHref(resolved, heading) {
  const routes = { note: 'notes', research: 'research', card: 'cards', project: 'projects', journal: 'journal' };
  if (!resolved || !Object.hasOwn(routes, resolved.type)) return null;
  const id = normalizeId(resolved.id)
    ?? (resolved.type === 'journal' && /^\d{4}-\d{2}-\d{2}$/u.test(resolved.id) ? resolved.id : null);
  if (!id) return null;
  return `/${routes[resolved.type]}/${id}${heading ? `#${slugify(heading)}` : ''}`;
}

// Visit text only; link labels must not acquire nested anchors, and code is never traversed.
function wikiText(tree, visit) {
  if (['link', 'linkReference', 'code', 'inlineCode'].includes(tree.type)) return;
  if (!tree.children) return;
  tree.children = tree.children.flatMap((node) => {
    if (node.type === 'text') return visit(node);
    wikiText(node, visit);
    return [node];
  });
}

const wikiPattern = /\[\[([^[\]\n]+)\]\]/gu;
const targetKey = ({ targetName, heading }) => JSON.stringify([targetName, heading]);

function wikiLinks() {
  return (tree, file) => {
    wikiText(tree, (node) => {
      const nodes = [];
      let start = 0;
      for (const match of node.value.matchAll(wikiPattern)) {
        if (match.index > start) nodes.push({ type: 'text', value: node.value.slice(start, match.index) });
        const target = linkTarget(match[0]);
        const label = match[1].includes('|') ? match[1].slice(match[1].indexOf('|') + 1) : target.targetName;
        const href = file.data.resolutions.get(targetKey(target));
        nodes.push({ type: 'text', value: label, data: {
          hName: href ? 'a' : 'span',
          hProperties: { className: href ? ['wikilink'] : ['wikilink', 'wikilink-ghost'], ...(href ? { href } : {}) },
          hChildren: [{ type: 'text', value: label }],
        } });
        start = match.index + match[0].length;
      }
      if (start < node.value.length) nodes.push({ type: 'text', value: node.value.slice(start) });
      return nodes;
    });
  };
}

function imageLinks() {
  return (tree) => {
    function walk(node) {
      if (node.type === 'element' && node.tagName === 'img') {
        node.tagName = 'a';
        node.children = [{ type: 'text', value: node.properties.alt ?? '' }];
        node.properties = { href: node.properties.src, title: node.properties.title };
      }
      for (const child of node.children ?? []) walk(child);
    }
    walk(tree);
  };
}

function textOf(node) {
  return node.type === 'text' ? node.value : (node.children ?? []).map(textOf).join('');
}

function taskLabels() {
  return (tree) => {
    function walk(node, item) {
      if (node.type === 'element' && node.tagName === 'li') {
        item = node.properties.className?.includes('task-list-item') ? node : null;
      }
      if (item && node.type === 'element' && node.tagName === 'input' && node.properties.type === 'checkbox') {
        node.properties.ariaLabel = textOf(item).trim().slice(0, 120).trimEnd();
      }
      for (const child of node.children ?? []) walk(child, item);
    }
    walk(tree, null);
  };
}

function safeLinks() {
  return (tree) => {
    function walk(node) {
      if (!node.children) return;
      node.children = node.children.map((child) => {
        walk(child);
        if (child.type !== 'element' || child.tagName !== 'a') return child;
        if (!allowedLink(child.properties.href)) return { type: 'text', value: textOf(child) };
        if (/^https?:/u.test(child.properties.href)) child.properties.rel = ['noopener', 'noreferrer'];
        return child;
      });
    }
    walk(tree);
  };
}

const processor = unified().use(remarkParse).use(remarkGfm).use(wikiLinks)
  .use(remarkRehype).use(imageLinks).use(taskLabels).use(rehypeSanitize, schema).use(safeLinks).use(rehypeStringify).freeze();

// Very deep nesting overflows the parser's stack; such a page is shown without its rendered body.
export function renderMarkdown(markdown, options = {}) {
  try {
    return render(markdown, options);
  } catch (error) {
    if (error instanceof RangeError) return { html: null, failed: true };
    throw error;
  }
}

function render(markdown, { resolveLink = () => null } = {}) {
  if (Buffer.byteLength(markdown, 'utf8') > MAX_INPUT) return { html: null, tooLarge: true };
  const cleaned = stripHidden(markdown).text;
  const tree = processor.parse(cleaned);
  const resolutions = new Map();
  wikiText(tree, (node) => {
    for (const match of node.value.matchAll(wikiPattern)) {
      const target = linkTarget(match[0]);
      const key = targetKey(target);
      if (!resolutions.has(key)) resolutions.set(key, wikiHref(resolveLink(target), target.heading));
    }
    return [node];
  });
  const digest = createHash('sha256').update(cleaned).update('\0').update(RENDER_POLICY)
    .update('\0').update(JSON.stringify([...resolutions])).digest('hex');
  const hit = cache.get(digest);
  if (hit) {
    cache.delete(digest);
    cache.set(digest, hit);
    return { html: hit.html };
  }
  const html = processor.stringify(processor.runSync(tree, { data: { resolutions } }));
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes <= MAX_HTML) {
    cache.set(digest, { html, bytes });
    cachedBytes += bytes;
    while (cache.size > MAX_ENTRIES || cachedBytes > MAX_HTML) {
      const oldest = cache.keys().next().value;
      cachedBytes -= cache.get(oldest).bytes;
      cache.delete(oldest);
    }
  }
  return { html };
}
