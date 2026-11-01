import { isAlias, isMap, isScalar, parseAllDocuments, parseDocument, Scalar, stringify, visit } from 'yaml';
import { CairnError } from './errors.mjs';

function* lines(text, start = 0) {
  let number = 1;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? text.length : newline + 1;
    const content = text.slice(start, newline < 0 ? end : newline).replace(/\r$/, '');
    yield { start, end, content, number };
    start = end;
    number++;
  }
}

function inspectFile(text) {
  const bom = text.startsWith('\uFEFF');
  const offset = bom ? 1 : 0;
  const file = {
    bom, eol: text.match(/\r?\n/)?.[0] ?? '\n', hasFrontmatter: false,
    data: null, error: null, editable: false, yamlStart: offset, yamlEnd: offset,
    bodyStart: offset, body: text.slice(offset),
  };
  const opening = text.slice(offset).match(/^---[\t ]*(?:\r?\n|$)/);
  if (!opening) return { file, doc: null };
  file.hasFrontmatter = true;
  file.yamlStart = offset + opening[0].length;
  let closing;
  for (const line of lines(text, file.yamlStart)) {
    if (/^---[\t ]*$/.test(line.content)) {
      closing = line;
      break;
    }
  }
  file.yamlEnd = closing?.start ?? text.length;
  file.bodyStart = closing?.end ?? text.length;
  file.body = text.slice(file.bodyStart);
  if (!closing) {
    file.error = 'Unclosed frontmatter.';
    return { file, doc: null };
  }
  try {
    const yaml = text.slice(file.yamlStart, file.yamlEnd);
    const doc = parseDocument(yaml, { keepSourceTokens: true, logLevel: 'error' });
    let multiple = false;
    if (doc.errors.some((error) => error.code === 'MULTIPLE_DOCS')) {
      const docs = parseAllDocuments(yaml, { logLevel: 'error' });
      multiple = docs.length > 1 && docs.every((part) => part.errors.length === 0);
    }
    const errors = doc.errors.filter((error) => !multiple || error.code !== 'MULTIPLE_DOCS');
    if (errors.length) throw new Error(errors.map((error) => error.message).join('\n'));
    const data = doc.toJS();
    file.data = data !== null && typeof data === 'object' ? data : null;
    file.editable = isMap(doc.contents) && !doc.contents.flow && !multiple;
    visit(doc, (_key, node) => {
      if (isAlias(node) || node?.anchor || node?.tag) file.editable = false;
    });
    return { file, doc };
  } catch (error) {
    file.error = error.message;
    file.editable = false;
    return { file, doc: null };
  }
}

export function parseFile(text) {
  return inspectFile(text).file;
}

function encode(value) {
  try {
    const result = stringify(value, (_key, item) => {
      if (typeof item !== 'string' || !/[\r\n]/.test(item)) return item;
      const node = new Scalar(item);
      node.type = 'QUOTE_DOUBLE';
      return node;
    }, {
      collectionStyle: 'flow', flowCollectionPadding: false, lineWidth: 0,
      blockQuote: false, singleQuote: false, doubleQuotedAsJSON: true,
      aliasDuplicateObjects: false,
    }).replace(/\n$/, '');
    if (/[\r\n]/.test(result)) throw new Error('Value must fit on one YAML line.');
    return result;
  } catch {
    throw new CairnError('validation', 'Value cannot be written as single-line YAML.');
  }
}

const lineStart = (text, offset) => text.lastIndexOf('\n', offset - 1) + 1;

function pairStart(yaml, pair) {
  const explicit = pair.srcToken.start.find((token) => token.type === 'explicit-key-ind');
  return lineStart(yaml, explicit?.offset ?? pair.key.range[0]);
}

function keyName(key) {
  if (isScalar(key)) return key.value === null ? '' : String(key.value);
  return stringify(key, { collectionStyle: 'flow', lineWidth: 0 }).replace(/\n$/, '');
}

export function setFields(text, patch) {
  const { file, doc } = inspectFile(text);
  if (file.error) throw new CairnError('validation', file.error);
  if (file.hasFrontmatter && !file.editable) {
    throw new CairnError('unsupported_frontmatter', 'Frontmatter is not an editable block mapping.');
  }
  const entries = Object.entries(patch);
  if (!file.hasFrontmatter) {
    const added = entries.filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${encode(key)}: ${encode(value)}${file.eol}`).join('');
    if (!added) return text;
    return text.slice(0, file.bodyStart) + `---${file.eol}${added}---${file.eol}` + file.body;
  }
  const yaml = text.slice(file.yamlStart, file.yamlEnd);
  const pairs = doc.contents.items;
  const indent = ' '.repeat(doc.contents.srcToken.indent);
  const edits = [];
  let added = '';
  for (const [key, value] of entries) {
    const index = pairs.findIndex((pair) => keyName(pair.key) === key);
    if (index < 0) {
      if (value !== undefined) added += `${indent}${encode(key)}: ${encode(value)}${file.eol}`;
      continue;
    }
    const pair = pairs[index];
    const start = pairStart(yaml, pair);
    const end = index + 1 < pairs.length ? pairStart(yaml, pairs[index + 1]) : yaml.length;
    let edit = { start, end, value: '' };
    if (value !== undefined) {
      const encoded = encode(value);
      const node = pair.value;
      const colon = pair.srcToken.sep.find((token) => token.type === 'map-value-ind');
      const inline = isScalar(node) && lineStart(yaml, node.range[0]) === start
        && !/[\r\n]/.test(yaml.slice(pair.key.range[0], node.range[1]))
        && !['BLOCK_LITERAL', 'BLOCK_FOLDED'].includes(node.type);
      if (inline && node.range[0] !== node.range[1]) {
        edit = { start: node.range[0], end: node.range[1], value: encoded };
      } else if (inline && colon) {
        edit = { start: colon.offset + 1, end: colon.offset + 1, value: ` ${encoded}` };
      } else {
        // Replacing a whole pair deliberately drops comments inside its old block.
        const rawKey = yaml.slice(pair.key.range[0], pair.key.range[1]);
        const writtenKey = isScalar(pair.key) && !/[\r\n]/.test(rawKey) && rawKey
          ? rawKey : encode(key);
        edit.value = `${indent}${writtenKey}: ${encoded}${file.eol}`;
      }
    }
    edits.push({ ...edit, start: file.yamlStart + edit.start, end: file.yamlStart + edit.end });
  }
  if (added) {
    if (doc.directives.docEnd) {
      throw new CairnError('unsupported_frontmatter', 'Cannot append fields after a YAML document end marker.');
    }
    edits.push({ start: file.yamlEnd, end: file.yamlEnd, value: added });
  }
  edits.sort((a, b) => b.start - a.start);
  for (const edit of edits) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  return text;
}

function* markdownLines(text, start = 0) {
  let fence = null;
  for (const line of lines(text, start)) {
    const marker = line.content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length
        && /^[\t ]*$/.test(marker[2])) fence = null;
      continue;
    }
    if (marker && (marker[1][0] === '~' || !marker[2].includes('`'))) {
      fence = marker[1];
      continue;
    }
    yield line;
  }
}

function findSection(text, heading, bodyStart = 0) {
  let start = null;
  for (const line of markdownLines(text, bodyStart)) {
    const match = line.content.match(/^##[\t ]+(.*?)[\t ]*$/);
    if (!match) continue;
    if (start !== null) return [start, line.start];
    if (match[1] === heading) start = line.start;
  }
  return start === null ? null : [start, text.length];
}

// A section includes its heading line, up to (but excluding) the next level-two heading.
export function sectionRange(text, heading) {
  return findSection(text, heading, parseFile(text).bodyStart);
}

export function appendToSection(text, heading, addedLines) {
  if (!addedLines.length) return text;
  const file = parseFile(text);
  const range = sectionRange(text, heading);
  const added = addedLines.join(file.eol).replace(/\r?\n/g, file.eol) + file.eol;
  if (range) {
    const end = range[1];
    const separator = text[end - 1] === '\n' ? '' : file.eol;
    return text.slice(0, end) + separator + added + text.slice(end);
  }
  const separator = !file.body ? (file.hasFrontmatter && !text.endsWith('\n') ? file.eol : '')
    : /\r?\n\r?\n$/.test(text) ? ''
    : text.endsWith('\n') ? file.eol : file.eol + file.eol;
  return text + separator + `## ${heading}${file.eol}${file.eol}` + added;
}

export function replaceBody(text, body) {
  return text.slice(0, parseFile(text).bodyStart) + body;
}

function acceptanceEntries(body) {
  const range = findSection(body, 'Acceptance');
  if (!range) return [];
  const items = [];
  for (const line of markdownLines(body)) {
    if (line.start < range[0] || line.start >= range[1]) continue;
    const match = line.content.match(/^([\t ]*- \[)([ xX])\](?:[\t ]+(.*))?$/);
    if (match) items.push({
      line: line.number, checked: match[2].toLowerCase() === 'x', text: match[3] ?? '',
      offset: line.start + match[1].length,
    });
  }
  return items;
}

export function acceptanceItems(body) {
  return acceptanceEntries(body).map(({ line, checked, text }) => ({ line, checked, text }));
}

export function acceptanceCounts(body) {
  const items = acceptanceEntries(body);
  return { done: items.filter((item) => item.checked).length, total: items.length };
}

export function setAcceptance(text, n, checked) {
  const file = parseFile(text);
  const item = Number.isInteger(n) && n >= 1 ? acceptanceEntries(file.body)[n - 1] : null;
  if (!item) throw new CairnError('validation', 'Acceptance item is out of range.');
  const offset = file.bodyStart + item.offset;
  return text.slice(0, offset) + (checked ? 'x' : ' ') + text.slice(offset + 1);
}
