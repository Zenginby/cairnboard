// Tool snapshots: each machine may leave `.cairn/tools/<machine>.json`, written by a scanner outside Cairnboard. The
// app only reads them (no scanning, no process, no write path) and checks every field, because the file is not a
// Cairn record and anything could have written it. A bad file is skipped with a warning; it never breaks the page.
import fs from 'node:fs';
import { checkedPath, openForRead } from './paths.mjs';
import { oneLine, stripHidden } from './text.mjs';

export const TOOLS_DIR = '.cairn/tools';
export const TOOLS_VERSION = 1;
const MAX_FILES = 16;
const MAX_BYTES = 1024 * 1024;
const MAX_TOOLS = 5000;

// Reads at most MAX_BYTES + 1 bytes, so a file swapped for a larger one after the size check is never read whole.
function readBounded(root, rel) {
  const fd = openForRead(root, rel);
  try {
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    for (let n; length < buffer.length && (n = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0;) {
      length += n;
    }
    return length > MAX_BYTES ? null : buffer.subarray(0, length).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/u;
// Links open from the page: only web pages and opening an Obsidian note (`obsidian://open?`), never script or file
// URLs, and no other Obsidian action (plugins can run commands from those).
const LINK = /^(?:https?:\/\/|obsidian:\/\/open\?)[^\s<>"']+$/u;

const text = (value, max) => {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = oneLine(stripHidden(value).text).replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').trim();
  return clean ? clean.slice(0, max) : null;
};
const date = (value) => {
  const m = typeof value === 'string' ? DATE.exec(value) : null;
  if (!m || Number.isNaN(Date.parse(value))) return null;
  // Date.parse rolls 2026-02-30 over to March; the calendar day must survive the round trip.
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return day.getUTCFullYear() === Number(m[1]) && day.getUTCMonth() === Number(m[2]) - 1
    && day.getUTCDate() === Number(m[3]) ? value : null;
};

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
    // A linked or unreadable folder (unsafe_path, EACCES) is a bad snapshot, not a broken page.
    return { snapshots, warnings: ['tools_snapshot_invalid'] };
  }
  const files = names.filter((entry) => FILE_NAME.test(entry.name)).map((entry) => entry.name).sort();
  if (files.length > MAX_FILES) warnings.push('tools_snapshot_invalid');
  for (const name of files.slice(0, MAX_FILES)) {
    const rel = `${TOOLS_DIR}/${name}`;
    let parsed = null;
    try {
      const stat = fs.lstatSync(checkedPath(ctx.root, rel));
      if (stat.isFile() && stat.size <= MAX_BYTES) {
        const source = readBounded(ctx.root, rel);
        if (source !== null) parsed = parseSnapshot(source);
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
      const row = rows.get(key) ?? { ...item, machines: [], uses: null, usesUnknown: false };
      if (!row.machines.includes(machine)) row.machines.push(machine);
      for (const field of ['description', 'cost', 'link', 'profile', 'project', 'install']) row[field] ??= item[field];
      if (!item.uses) row.usesUnknown = true;
      else {
        const count = (row.uses?.count ?? 0) + item.uses.count;
        const last = [row.uses?.last, item.uses.last].filter(Boolean).sort().at(-1) ?? null;
        row.uses = { count, last };
      }
      rows.set(key, row);
    }
  }
  // A machine that did not count uses leaves the tool's use unknown unless another machine saw it used.
  for (const row of rows.values()) {
    if (row.usesUnknown && row.uses && row.uses.count === 0) row.uses = null;
    delete row.usesUnknown;
  }
  const names = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
  return [...rows.values()].sort((a, b) => names.compare(a.name, b.name) || names.compare(a.kind ?? '', b.kind ?? ''));
}
