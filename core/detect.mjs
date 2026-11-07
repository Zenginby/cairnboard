import { basename } from 'node:path';
import * as fs from './fsx.mjs';
import { checkedPath, openForRead, realRoot, safeRelative } from './paths.mjs';
import { parseFile } from './frontmatter.mjs';
import { SKIPPED_DIRS } from './index.mjs';
import { PRESETS } from './presets.mjs';
import { resolveSchema } from './schema.mjs';
import { CairnError } from './errors.mjs';
import { pathKey } from './text.mjs';

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
const canonicalKinds = new Set([
  'note', 'concept', 'tool', 'query', 'overview', 'project', 'journal', 'source', 'review', 'analysis',
]);

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
  if (!budget.limited) for (const { files } of folders) for (const { data } of files) {
    const value = data.kind ?? data[schema.fields.kind ?? 'kind'];
    if (typeof value !== 'string') continue;
    const normalized = key(value);
    const aliases = PRESETS['tr-wiki'].values.kind;
    const canonical = Object.hasOwn(aliases, normalized) ? aliases[normalized]
      : canonicalKinds.has(normalized) ? normalized : null;
    if (!canonical || value === canonical || Object.hasOwn(schema.values.kind ?? {}, value)) continue;
    schema.values.kind ??= {};
    schema.values.kind[value] = canonical;
    propose('values.kind', value, 1, `Observed spelling maps exactly to ${canonical}.`);
  }
  return { schema: resolveSchema({ schema }), suggestions, warnings: [...new Set(warnings)],
    scanned: { files: budget.files, entries: budget.entries, bytes: budget.bytes, limited: budget.limited } };
}


// Extend a configured schema without replacing its roots, mappings or other existing choices.
export function extendDetection(detection, existing) {
  const schema = resolveSchema({ schema: existing }), warnings = [...detection.warnings];
  const normalize = (path) => pathKey(safeRelative(path)).replace(/\\/gu, '/');
  const paths = (root) => [root.path].flat();
  const occupied = [...Object.values(schema.roots).flatMap(paths), ...schema.sourceRoots,
    ...Object.values(schema.kindFolders), ...(schema.catalog ? [schema.catalog] : [])];
  const overlaps = (path) => occupied.some((other) =>
    inside(normalize(path), normalize(other)) || inside(normalize(other), normalize(path)));
  const accepted = new Set(), blocked = new Set();
  for (const [field, name] of Object.entries(detection.schema.fields)) {
    if (Object.hasOwn(schema.fields, field)) continue;
    if (Object.values(schema.fields).includes(name) || Object.values(schema.fields).includes(field)
      || (name !== field && Object.hasOwn(schema.fields, name))) {
      warnings.push(`field_conflict:${field}:${name}`);
    } else schema.fields[field] = name;
  }
  for (const [field, aliases] of Object.entries(detection.schema.values)) {
    schema.values[field] ??= {};
    for (const [alias, value] of Object.entries(aliases)) {
      if (!Object.hasOwn(schema.values[field], alias)) schema.values[field][alias] = value;
      else if (schema.values[field][alias] !== value) {
        warnings.push(`value_conflict:${field}:${alias}`);
        if (field === 'kind') blocked.add(['project', 'journal'].includes(value) ? value
          : researchKinds.has(value) ? 'research' : 'note');
      }
    }
  }
  for (const [type, root] of Object.entries(detection.schema.roots)) {
    if (Object.hasOwn(schema.roots, type)) {
      for (const path of paths(root)) if (!paths(schema.roots[type])
        .some((old) => normalize(old) === normalize(path))) {
        warnings.push(`existing_type:${type}:${path}`);
      }
      continue;
    }
    const additions = paths(root).filter((path) => {
      if (blocked.has(type) || overlaps(path)) {
        warnings.push(`root_conflict:${type}:${path}`);
        return false;
      }
      accepted.add(`${type}:${path}`);
      return true;
    });
    if (!additions.length) continue;
    schema.roots[type] = { ...root, path: additions.length === 1 ? additions[0] : additions };
    occupied.push(...additions);
    if (type === 'note' && schema.quickNotes === undefined) schema.quickNotes = additions[0];
  }
  for (const path of detection.schema.sourceRoots) {
    if (schema.sourceRoots.some((old) => normalize(old) === normalize(path))) continue;
    if (overlaps(path)) warnings.push(`root_conflict:sourceRoots:${path}`);
    else {
      schema.sourceRoots.push(path);
      occupied.push(path);
      accepted.add(`sourceRoots:${path}`);
    }
  }
  for (const pattern of detection.schema.ignore) if (!schema.ignore.includes(pattern)) schema.ignore.push(pattern);
  const suggestions = detection.suggestions.filter(({ target, path }) => {
    if (Object.hasOwn(detection.schema.roots, target) || target === 'sourceRoots') {
      return accepted.has(`${target}:${path}`);
    }
    if (target === 'ignore') return !existing.ignore.includes(`${path}/**`);
    if (target === 'values.kind') return !Object.hasOwn(existing.values.kind ?? {}, path)
      && schema.values.kind?.[path] === detection.schema.values.kind[path];
    return JSON.stringify(existing.fields) !== JSON.stringify(schema.fields)
      || JSON.stringify(existing.values) !== JSON.stringify(schema.values);
  });
  return { ...detection, schema: resolveSchema({ schema }), suggestions, warnings: [...new Set(warnings)] };
}
