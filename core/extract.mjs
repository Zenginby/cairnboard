import { basename } from 'node:path';
import { parseFile, acceptanceCounts } from './frontmatter.mjs';
import { classify, readCanonical } from './schema.mjs';

const blank = (char) => char === ' ' || char === '\t';

// `# Title #` as text, or null. Loops instead of a lazy group plus whitespace runs: one hostile line must not
// cost quadratic time.
function atxHeading(line) {
  if (line[0] !== '#' || !blank(line[1])) return null;
  let start = 1;
  let end = line.length;
  while (start < end && blank(line[start])) start++;
  while (end > start && blank(line[end - 1])) end--;
  let hashes = end;
  while (hashes > start && line[hashes - 1] === '#') hashes--;
  if (hashes < end && hashes > start && blank(line[hashes - 1])) {
    end = hashes;
    while (end > start && blank(line[end - 1])) end--;
  }
  return start < end ? line.slice(start, end) : null;
}

export function extract(schema, path, text) {
  const file = parseFile(text);
  const classification = classify(schema, path, file.data);
  if (!classification.entity) return null;
  const data = readCanonical(schema, file.data);
  let title = typeof data.title === 'string' && data.title ? data.title : null;
  let fence = null;
  for (const line of file.body.split(/\r?\n/u)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker && (marker[1][0] === '~' || !marker[2].includes('`'))) {
      fence = marker[1];
      continue;
    }
    if (!title) title = atxHeading(line);
    if (title) break;
  }
  const id = typeof data.id === 'string' ? data.id : null;
  return {
    path, type: classification.entity, kind: classification.kind, id, ref: id ?? `@${path.replace(/\.md$/iu, '')}`,
    title: title ?? basename(path).replace(/\.md$/iu, ''), data, body: file.body,
    acceptance: acceptanceCounts(file.body), error: file.error ? 'invalid_frontmatter' : null,
    ...(classification.unknownKind === undefined ? {} : { unknownKind: classification.unknownKind }),
  };
}
