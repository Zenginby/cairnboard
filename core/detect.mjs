import { basename } from 'node:path';
import * as fs from './fsx.mjs';
import { checkedPath, openForRead, realRoot } from './paths.mjs';
import { parseFile } from './frontmatter.mjs';
import { SKIPPED_DIRS } from './index.mjs';
import { PRESETS } from './presets.mjs';
import { resolveSchema } from './schema.mjs';
import { CairnError } from './errors.mjs';

export const DETECT_LIMITS = {
  files: 10000, entries: 50000, depth: 64, fileBytes: 5 * 1024 * 1024,
  frontmatterBytes: 64 * 1024, totalBytes: 16 * 1024 * 1024,
};
const threshold = 0.7;
const key = (value) => value.normalize('NFC').toLocaleLowerCase('tr');
const inside = (path, parent) => path === parent || path.startsWith(`${parent}/`);
const templates = new Set(['templates', 'şablonlar', 'sablonlar']);
const projects = new Set(['projects', 'projeler']);
const sources = new Set(['raw', 'sources', 'kaynaklar', 'references', 'clippings']);
const strongRaw = new Set(['raw', 'clippings']);
const researchKinds = new Set(['source', 'review', 'analysis', 'kaynak']);

// Read a bounded prefix in one block (retry short reads); parse only the frontmatter within it.
function metadata(root, path, budget, limits, warnings) {
  const fd = openForRead(root, path);
  try {
    const size = fs.fstatSync(fd).size;
    if (size > limits.fileBytes) {
      warnings.push(`file_size_limit:${path}`);
      return {};
    }
    const available = limits.totalBytes - budget.bytes;
    if (available <= 0) {
      budget.limited = true;
      warnings.push('total_bytes_limit');
      return {};
    }
    const wanted = Math.min(size, limits.frontmatterBytes);
    const buffer = Buffer.alloc(Math.min(wanted, available));
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
      budget.bytes += count;
    }
    const limited = available < wanted && length === available;
    if (limited) {
      budget.limited = true;
      warnings.push('total_bytes_limit');
    }
    const text = buffer.subarray(0, length).toString('utf8');
    const opening = /^\uFEFF?---[\t ]*\r?\n/u.exec(text);
    if (!opening) return {};
    const delimiter = /^---[\t ]*\r?(?:\n|$)/gmu;
    delimiter.lastIndex = opening[0].length;
    const closing = delimiter.exec(text);
    if (closing && (closing[0].endsWith('\n') || length === size)) {
      const parsed = parseFile(text.slice(0, closing.index + closing[0].length));
      if (parsed.error) warnings.push(`invalid_frontmatter:${path}`);
      return parsed.data ?? {};
    }
    if (!limited) warnings.push(`frontmatter_limit_or_unclosed:${path}`);
    return {};
  } finally {
    fs.closeSync(fd);
  }
}

/** Read a vault and return a schema, evidence and warnings; never creates metadata or discovery state. */
export function detectSchema(directory, { limits = DETECT_LIMITS } = {}) {
  let root;
  try {
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('Not a directory.');
    root = realRoot(directory);
  } catch {
    throw new CairnError('validation', 'Detection requires an existing directory without symlinks.');
  }
  limits = { ...DETECT_LIMITS, ...limits };
  const warnings = [], suggestions = [], folders = [], ignored = [];
  const budget = { files: 0, entries: 0, bytes: 0, limited: false };
  function walk(path = '', depth = 0) {
    const folder = { path, files: [] };
    folders.push(folder);
    const entries = fs.readdirSync(path ? checkedPath(root, path) : root, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (++budget.entries > limits.entries) {
        budget.limited = true;
        warnings.push('entry_count_limit');
        return;
      }
      if (entry.isSymbolicLink() || entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (templates.has(key(entry.name))) {
          ignored.push(child);
          continue;
        }
        if (depth >= limits.depth) {
          budget.limited = true;
          warnings.push(`depth_limit:${child}`);
        } else walk(child, depth + 1);
      } else if (entry.isFile() && /\.md$/iu.test(entry.name)) {
        if (budget.files >= limits.files) {
          budget.limited = true;
          warnings.push('file_count_limit');
          return;
        }
        budget.files++;
        let data = {};
        try {
          data = metadata(root, child, budget, limits, warnings);
        } catch (error) {
          if (!['EACCES', 'EPERM', 'ENOENT', 'unsafe_path'].includes(error.code)) throw error;
          warnings.push(`unreadable:${child}`);
        }
        folder.files.push({ name: entry.name, data });
      }
      if (budget.limited) return;
    }
  }
  walk();
  const schema = {
    schemaVersion: 1, roots: {}, kindFolders: {}, quickNotes: '', fields: {}, values: {},
    ignore: [...PRESETS.default.ignore, ...ignored.map((path) => `${path}/**`)],
    sourceRoots: [], catalog: null, entryTypes: structuredClone(PRESETS.default.entryTypes),
  };
  const propose = (target, path, confidence, reason) => suggestions.push({ target, path, confidence, reason });
  for (const path of ignored) propose('ignore', path, 0.95, 'Template folder name; excluded from content.');
  const assigned = new Map(), ambiguous = [];
  if (!budget.limited) for (const folder of folders) {
    const { path, files } = folder;
    if (!path || [...schema.sourceRoots, ...ambiguous].some((parent) => inside(path, parent))) continue;
    const name = key(basename(path)), count = files.length;
    const kinds = files.map(({ data }) => ['type', 'kind', 'tur'].map((field) =>
      typeof data[field] === 'string' ? key(data[field]) : ''));
    const dates = files.filter(({ name }) => /^\d{4}-\d{2}-\d{2}\.md$/iu.test(name)).length;
    const projectCount = kinds.filter((values) => values.some((kind) => ['project', 'proje'].includes(kind))).length;
    const researchCount = files.filter(({ data }, index) =>
      kinds[index].some((kind) => researchKinds.has(kind))
      || ['raw', 'ham', 'processed'].some((field) => Object.hasOwn(data, field))).length;
    const rawCount = files.filter(({ data }) => typeof data.url === 'string'
      || typeof data.source_url === 'string').length;
    const majority = (hits) => count >= 2 && hits / count >= threshold;
    const candidates = [];
    if (majority(dates)) candidates.push(['journal', dates / count, `${dates}/${count} filenames are YYYY-MM-DD.md.`]);
    if (projects.has(name) || majority(projectCount)) candidates.push(['project', projects.has(name) ? 0.9
      : projectCount / count, projects.has(name) ? 'Project folder name.'
        : `${projectCount}/${count} files declare type/kind/tur project or proje.`]);
    if (majority(researchCount)) candidates.push(['research', researchCount / count,
      `${researchCount}/${count} files have research kinds or processing metadata; treated as records.`]);
    if (name === 'cards') candidates.push(['card', 0.95, 'Explicit cards folder.']);
    if (sources.has(name) && researchCount === 0 && (strongRaw.has(name) || majority(rawCount))) {
      candidates.push(['sourceRoots', strongRaw.has(name) ? 0.9 : rawCount / count,
        'Capture folder with a raw name or URL metadata; no majority of research records.']);
    }
    if (candidates.length > 1 || (name === 'raw' && majority(researchCount))) {
      ambiguous.push(path);
      warnings.push(`ambiguous:${path}:${candidates.map(([target]) => target).join(',')}`);
      continue;
    }
    if (!candidates.length) {
      if (sources.has(name) || dates || projectCount || researchCount) warnings.push(`uncertain:${path}`);
      continue;
    }
    const [target, confidence, reason] = candidates[0];
    assigned.set(path, target);
    if (target === 'sourceRoots') schema.sourceRoots.push(path);
    else {
      schema.roots[target] ??= { path: [], flat: true };
      schema.roots[target].path.push(path);
    }
    propose(target, path, confidence, reason);
  }
  // Root paths '' and '.' are invalid. Keep the default note roots rather than selecting an archive
  // or another arbitrary content folder; unmatched Markdown still uses the existing note fallback.
  const reserved = [...assigned.keys(), ...ambiguous];
  const notePaths = PRESETS.default.roots.note.path.filter((path) =>
    !reserved.some((parent) => key(path) === key(parent))
    && !schema.sourceRoots.some((parent) => inside(key(path), key(parent))));
  let fallback = 'notes', suffix = 2;
  while (reserved.some((path) => key(path) === key(fallback))) fallback = `notes-${suffix++}`;
  schema.roots.note = { path: notePaths.length ? notePaths : [fallback], flat: false };
  schema.quickNotes = schema.roots.note.path[0];
  for (const path of schema.roots.note.path) propose('note', path, 1,
    'Default note folder; vault-root roots are unsupported. Unmatched Markdown remains notes.');
  for (const root of Object.values(schema.roots)) if (root.path.length === 1) root.path = root.path[0];
  const trFields = Object.values(PRESETS['tr-wiki'].fields);
  const enFields = Object.keys(PRESETS['tr-wiki'].fields);
  let tr = 0, en = 0;
  for (const { files } of folders) for (const { data } of files) {
    const names = Object.keys(data);
    tr += names.filter((name) => trFields.includes(name)).length;
    en += names.filter((name) => enFields.includes(name)).length;
  }
  if (!budget.limited && tr > en) {
    schema.fields = structuredClone(PRESETS['tr-wiki'].fields);
    schema.values = structuredClone(PRESETS['tr-wiki'].values);
    propose('fields/values', 'tr-wiki', tr / (tr + en),
      `${tr}/${tr + en} recognized frontmatter field names are Turkish.`);
  }
  return { schema: resolveSchema({ schema }), suggestions, warnings: [...new Set(warnings)],
    scanned: { files: budget.files, entries: budget.entries, bytes: budget.bytes, limited: budget.limited } };
}
