// Tool snapshots: each machine may leave `.cairn/tools/<machine>.json`, written by a scanner outside Cairnboard. The
// app only reads them (no scanning, no process, no write path) and checks every field, because the file is not a
// Cairn record and anything could have written it. A bad file is skipped with a warning; it never breaks the page.
import fs from 'node:fs';
import { checkedPath, readChecked } from './paths.mjs';

export const TOOLS_DIR = '.cairn/tools';
export const TOOLS_VERSION = 1;
const MAX_FILES = 16;
const MAX_BYTES = 1024 * 1024;
const MAX_TOOLS = 5000;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/u;
const DATE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?$/u;
// Links open from the page: only web pages and Obsidian notes, never script or file URLs.
const LINK = /^(?:https?:\/\/|obsidian:\/\/)[^\s<>"']+$/u;

const text = (value, max) => {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/gu, ' ').trim();
  return clean ? clean.slice(0, max) : null;
};
const date = (value) => (typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(value))
  ? value : null);

function tool(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = text(raw.name, 200);
  if (!name) return null;
  const link = typeof raw.link === 'string' && raw.link.length <= 2000 && LINK.test(raw.link) ? raw.link : null;
  const count = Number.isSafeInteger(raw.uses?.count) && raw.uses.count >= 0 ? raw.uses.count : null;
  return {
    name,
    kind: text(raw.kind, 40),
    profile: text(raw.profile, 80),
    project: text(raw.project, 120),
    install: text(raw.install, 200),
    description: text(raw.description, 600),
    cost: text(raw.cost, 80),
    link,
    uses: count === null ? null : { count, last: date(raw.uses.last) },
  };
}

/** Parses one snapshot; returns null when the file is not a version-1 snapshot. */
export function parseSnapshot(source) {
  let data;
  try { data = JSON.parse(source); } catch { return null; }
  if (!data || typeof data !== 'object' || data.version !== TOOLS_VERSION || !Array.isArray(data.tools)) return null;
  const machine = text(data.machine, 64);
  const scannedAt = date(data.scannedAt);
  if (!machine || !scannedAt || data.tools.length > MAX_TOOLS) return null;
  return { machine, scannedAt, tools: data.tools.map(tool).filter(Boolean) };
}

/**
 * Every readable snapshot, sorted by machine name, plus warning codes for the files that were skipped.
 * @param {{ root: string }} ctx
 */
export function readToolSnapshots(ctx) {
  const snapshots = [];
  const warnings = [];
  let names;
  try {
    names = fs.readdirSync(checkedPath(ctx.root, TOOLS_DIR), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { snapshots, warnings };
    throw error;
  }
  const files = names.filter((entry) => FILE_NAME.test(entry.name)).map((entry) => entry.name).sort();
  if (files.length > MAX_FILES) warnings.push('tools_snapshot_invalid');
  for (const name of files.slice(0, MAX_FILES)) {
    const rel = `${TOOLS_DIR}/${name}`;
    let parsed = null;
    try {
      const stat = fs.lstatSync(checkedPath(ctx.root, rel));
      if (stat.isFile() && stat.size <= MAX_BYTES) {
        const source = readChecked(ctx.root, rel, 'utf8');
        if (source !== null && Buffer.byteLength(source) <= MAX_BYTES) parsed = parseSnapshot(source);
      }
    } catch { parsed = null; }
    if (parsed) snapshots.push(parsed);
    else warnings.push('tools_snapshot_invalid');
  }
  snapshots.sort((a, b) => (a.machine < b.machine ? -1 : a.machine > b.machine ? 1 : 0));
  return { snapshots, warnings: [...new Set(warnings)] };
}

/** Cheap check for the shell: is there at least one snapshot file to show a Tools tab for? */
export function hasToolSnapshots(ctx) {
  try {
    return fs.readdirSync(checkedPath(ctx.root, TOOLS_DIR)).some((name) => FILE_NAME.test(name));
  } catch {
    return false;
  }
}

/**
 * Joins snapshots into one row per tool name and kind: which machines have it, the newest use, the first
 * description, cost and link found. Machines are listed in snapshot order.
 */
export function mergeTools(snapshots) {
  const rows = new Map();
  for (const { machine, tools } of snapshots) {
    for (const item of tools) {
      const key = JSON.stringify([item.name.toLowerCase(), item.kind ?? '']);
      const row = rows.get(key) ?? { ...item, machines: [], uses: null };
      if (!row.machines.includes(machine)) row.machines.push(machine);
      for (const field of ['description', 'cost', 'link', 'profile', 'project', 'install']) row[field] ??= item[field];
      if (item.uses) {
        const count = (row.uses?.count ?? 0) + item.uses.count;
        const last = [row.uses?.last, item.uses.last].filter(Boolean).sort().at(-1) ?? null;
        row.uses = { count, last };
      }
      rows.set(key, row);
    }
  }
  const names = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
  return [...rows.values()].sort((a, b) => names.compare(a.name, b.name) || names.compare(a.kind ?? '', b.kind ?? ''));
}
