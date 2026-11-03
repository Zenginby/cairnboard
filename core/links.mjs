import { parseFile } from './frontmatter.mjs';

export function* visibleLines(text) {
  const file = parseFile(text);
  let fence = null;
  let line = text.slice(0, file.bodyStart).split('\n').length;
  for (const content of file.body.split(/\r?\n/u)) {
    const number = line++;
    const marker = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker && (marker[1][0] === '~' || !marker[2].includes('`'))) {
      fence = marker[1];
      continue;
    }
    yield { content, line: number };
  }
}

// Code spans never cross a blank line (CommonMark), so backticks are paired paragraph by paragraph.
export function withoutCode(text) {
  return text.split(/(\n[\t ]*\n)/u).map((part, index) => index % 2 ? part : withoutCodeSpans(part)).join('');
}

function withoutCodeSpans(text) {
  const runs = [...text.matchAll(/`+/gu)];
  const next = new Map();
  const closing = [];
  for (let at = runs.length - 1; at >= 0; at--) {
    closing[at] = next.get(runs[at][0].length);
    next.set(runs[at][0].length, at);
  }
  let result = '';
  let start = 0;
  for (let at = 0; at < runs.length; at++) {
    if (closing[at] === undefined) continue;
    const end = runs[closing[at]].index + runs[at][0].length;
    // Preserve UTF-16 offsets as well as newlines, including surrogate pairs in code spans.
    result += text.slice(start, runs[at].index) + text.slice(runs[at].index, end).replace(/[^\n]/g, ' ');
    start = end;
    at = closing[at];
  }
  return result + text.slice(start);
}

// `[[name#heading|label]]` (or an unclosed `[[name`) → its target name and heading.
export function linkTarget(expr) {
  const inner = expr.startsWith('[[') ? expr.slice(2).replace(/\]\]$/u, '') : expr;
  const [target, ...heading] = inner.split('|')[0].split('#');
  return { targetName: target.trim().replace(/\.md$/iu, '').normalize('NFC'), heading: heading.length ? heading.join('#').trim() : null };
}

// Targets exclude `[` so an unclosed `[[` stops at the next one; line numbers are counted forward, never by
// re-reading the text before each match. Both keep a hostile line linear.
function matches(text, field, line) {
  let at = 0;
  return Array.from(text.matchAll(/\[\[([^[\]\n]+)\]\]/gu), (match) => {
    for (; at < match.index; at++) if (text[at] === '\n') line++;
    // `\[[a]]` is literal text in Obsidian.
    if (text[match.index - 1] === '\\') return null;
    const { targetName, heading } = linkTarget(match[0]);
    return targetName ? { field, expr: match[0], targetName, heading, line } : null;
  }).filter(Boolean);
}

// `## Topic: Title · label` split on a middle dot with whitespace on both sides, without a regex over the runs.
function sectionParts(text) {
  const parts = [];
  let start = 0;
  for (let at = 1; at < text.length - 1; at++) {
    if (text[at] === '·' && /\s/u.test(text[at - 1]) && /\s/u.test(text[at + 1])) {
      parts.push(text.slice(start, at).trim());
      start = at + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

function sectionTitle(content) {
  if (!content.startsWith('##') || (content[2] !== ' ' && content[2] !== '\t')) return null;
  const text = content.slice(3).trim();
  return text || null;
}

// Broken YAML: the spec's `[[name` pattern, so an unclosed link still names its target.
function looseMatches(text, line) {
  let at = 0;
  return Array.from(text.matchAll(/\[\[([^[\]|#\n"]+)/gu), (match) => {
    for (; at < match.index; at++) if (text[at] === '\n') line++;
    const targetName = match[1].trim().replace(/\.md$/iu, '').normalize('NFC');
    return targetName && text[match.index - 1] !== '\\' ? { field: null, expr: match[0], targetName, heading: null, line } : null;
  }).filter(Boolean);
}

export function parseLinks(text, options = {}) {
  const file = parseFile(text);
  const links = [];
  const yaml = text.slice(file.yamlStart, file.yamlEnd);
  // Without options the frontmatter comes from the text itself.
  const frontmatter = 'frontmatter' in options ? options.frontmatter : (file.error ? null : file.data);
  const frontmatterText = 'frontmatterText' in options ? options.frontmatterText : (file.error ? yaml : null);
  const firstLine = text.slice(0, file.yamlStart).split('\n').length;
  if (frontmatter) {
    const seen = new WeakSet();
    let offset = 0;
    function values(value, field) {
      if (typeof value === 'string') {
        for (const link of matches(value, field, firstLine)) {
          let at = yaml.indexOf(link.expr, offset);
          if (at < 0) at = yaml.indexOf(link.expr);
          if (at >= 0) {
            link.line = firstLine + yaml.slice(0, at).split('\n').length - 1;
            offset = at + link.expr.length;
          }
          links.push(link);
        }
      } else if (value && typeof value === 'object' && !seen.has(value)) {
        seen.add(value);
        for (const child of Object.values(value)) values(child, field);
        seen.delete(value);
      }
    }
    for (const [field, value] of Object.entries(frontmatter)) values(value, field);
  } else if (frontmatterText !== null && frontmatterText !== undefined) {
    links.push(...looseMatches(frontmatterText, firstLine));
  }
  const body = text.split('\n').map(() => '');
  for (const { content, line } of visibleLines(text)) body[line - 1] = content;
  links.push(...matches(withoutCode(body.join('\n')), null, 1));
  return links;
}

export function parseJournal(text, entryTypes) {
  const entries = [];
  let heading = null;
  let label = null;
  let current = null;
  for (const { content, line } of visibleLines(text)) {
    const section = sectionTitle(content);
    if (section) {
      const parts = sectionParts(section);
      label = parts.length > 1 ? parts.pop() : null;
      heading = parts.join(' · ').replace(/^[^:]+:\s+/u, '');
      current = null;
      continue;
    }
    // A top-level heading closes the journal section; deeper ones only end the current entry.
    if (/^#[\t ]/u.test(content)) [heading, label] = [null, null];
    if (/^#{1,6}\s/u.test(content)) current = null;
    // Items indented two or more spaces are nested under the previous entry and continue it below.
    const item = content.match(/^ ?[-+*][\t ]+(.*)$/u);
    if (heading !== null && item) {
      current = { heading, label, type: null, line, text: item[1], links: [], processed: false };
      const prefix = current.text.match(/^(?:\*\*([^*]+):\*\*|\*\*([^*]+)\*\*:|([^:]+):)\s*/u);
      if (prefix) {
        const name = (prefix[1] ?? prefix[2] ?? prefix[3]).trim().toLocaleLowerCase('tr');
        for (const type of ['decision', 'discovery', 'pitfall', 'lesson']) {
          if ((entryTypes[type] ?? []).some((value) => value.toLocaleLowerCase('tr') === name)) current.type = type;
        }
        if (current.type) current.text = current.text.slice(prefix[0].length);
      }
      entries.push(current);
    } else if (current && /^[\t ]+\S/u.test(content)) {
      current.text += `\n${content.trim()}`;
    } else if (content.trim()) {
      current = null;
    }
  }
  for (const entry of entries) {
    const visible = withoutCode(entry.text);
    entry.links = matches(visible, null, entry.line).map((link) => link.targetName);
    entry.processed = ['discovery', 'pitfall', 'lesson'].includes(entry.type) && /→\s*\[\[[^[\]\n]+\]\]\s*$/u.test(visible);
  }
  return entries;
}
