import { createHash } from 'node:crypto';
import { CairnError } from './errors.mjs';
import { safeRelative } from './paths.mjs';
import { isRawPath } from './schema.mjs';
import { slugify, stripHidden, uniqueName } from './text.mjs';
import { rows, search } from './index.mjs';
import { readFile, writeMany } from './store.mjs';
import { createFolder, directoryLock, draft, localDate, names, resolve, validateDate } from './entity.mjs';

/** @typedef {import('./store.mjs').MutationOptions} MutationOptions */

export const MAX_INPUT = 5 * 1024 * 1024;
const MAX_URL = 2048;
const MAX_RELATED = 10;
const MAX_TERMS = 32;
const MAX_TITLE = 200;

const invalid = (message, details) => new CairnError('validation', message, details);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The agent's work list (wiki spec §12). It names only the research path, never text from the source.
export const todo = (path) => [`write a short source summary in ${path}`, 'update only pages this source directly changes',
  'leave deeper compilation for when a question needs it'];

function checkInput(bytes, maxBytes) {
  if (!Buffer.isBuffer(bytes)) throw invalid('Input must be bytes.');
  const limit = maxBytes === undefined ? MAX_INPUT : maxBytes;
  if (!Number.isSafeInteger(limit) || limit < 0) throw invalid('Invalid input limit.');
  if (bytes.length > Math.min(limit, MAX_INPUT)) throw invalid(`Input is larger than ${Math.min(limit, MAX_INPUT)} bytes.`);
  // Binary ingest comes later (wiki spec §12): a NUL byte or anything that is not UTF-8 is refused.
  if (bytes.includes(0)) throw invalid('Input is binary, not text.');
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw invalid('Input is not valid UTF-8 text.');
  }
}

// `--into` names a folder under `raw/` (or another source root); no dot segments, never outside the data folder.
function rawFolder(ctx, into) {
  if (into === undefined) return 'raw';
  if (typeof into !== 'string' || !into.trim()) throw invalid('Invalid raw folder.');
  let rel;
  try {
    rel = safeRelative(into.trim()).replace(/\\/gu, '/').replace(/\/+$/u, '');
  } catch {
    throw invalid('Invalid raw folder.');
  }
  if (!rel || rel === '.' || rel.split('/').some((part) => !part || part.startsWith('.')) || !isRawPath(ctx.schema, rel)) {
    throw invalid('The raw folder must be raw/ or a folder under it.');
  }
  return rel;
}

function checkUrl(url) {
  if (url === undefined) return;
  // The url is a citation line in the raw file: one visible line, no control or hidden characters.
  if (typeof url !== 'string' || !url || url.length > MAX_URL || /[\u0000-\u001f\u007f]/u.test(url) || stripHidden(url).removed) {
    throw invalid('Invalid source url.');
  }
}

// Pages whose text shares words with the title and the first three lines of the source, best first (wiki spec §12).
function related(ctx, title, text) {
  const lines = text.replace(/^﻿/u, '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).slice(0, 3);
  const words = `${title}\n${lines.join('\n')}`.match(/[\p{L}\p{N}]+/gu) ?? [];
  const query = [...new Set(words.map((word) => word.slice(0, 64)))].slice(0, MAX_TERMS).join(' ');
  return search(ctx, query, { any: true, limit: MAX_RELATED })
    .map((item) => ({ path: item.path, content: { title: stripHidden(String(item.title)).text.slice(0, MAX_TITLE) } }));
}

function existingSource(ctx, digest) {
  return rows(ctx, 'research').find((row) => row.data?.input_sha256 === digest) ?? null;
}

function duplicateResult(ctx, record, digest, dryRun) {
  const raw = typeof record.data.raw === 'string' ? record.data.raw : null;
  let rawRevision = null;
  try {
    rawRevision = raw && isRawPath(ctx.schema, raw) ? readFile(ctx, raw)?.revision ?? null : null;
  } catch (error) {
    if (!(error instanceof CairnError) && !['ENOTDIR', 'EISDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(error.code)) throw error;
  }
  return { raw: { path: raw, revision: rawRevision }, research: { path: record.path, revision: record.revision },
    input_sha256: digest, duplicate: true, dryRun, todo: todo(record.path), related: [], warnings: ['duplicate_source'] };
}

/**
 * `cairn ingest` (wiki spec §12): stores `bytes` under `<into|raw>/<date>-<slug>.md` behind `Source:`/`Date:` lines and
 * creates an unprocessed research record pointing at it, both in one transaction. The same input bytes already
 * ingested return the existing record with `duplicate: true` and write nothing.
 * @param {{ title: string, bytes: Buffer, url?: string, date?: string, into?: string, project?: string, maxBytes?: number }} input
 * @param {MutationOptions} opts
 */
export function ingest(ctx, { title, bytes, url, date, into, project, maxBytes }, opts = {}) {
  if (typeof title !== 'string' || !title.trim()) throw invalid('Title is required.');
  checkInput(bytes, maxBytes);
  checkUrl(url);
  const day = date ?? localDate(ctx);
  validateDate(day);
  const folder = rawFolder(ctx, into);
  const dryRun = opts.dryRun === true || ctx.mode === 'dry-run';
  const digest = sha256(bytes);
  const fields = { title, kind: 'source' };
  return directoryLock(ctx, createFolder(ctx, 'research', fields), opts, () => {
    const existing = existingSource(ctx, digest);
    if (existing) return duplicateResult(ctx, existing, digest, dryRun);
    let projectRef;
    if (project !== undefined) {
      const found = resolve(ctx, 'project', project);
      projectRef = found.id ?? found.ref;
    }
    const header = `${url === undefined ? '' : `Source: ${url}\n`}Date: ${day}\n\n`;
    const stored = Buffer.concat([Buffer.from(header), bytes]);
    const rawPath = `${folder}/${uniqueName(names(ctx, folder), `${day}-${slugify(title)}`)}.md`;
    if (!isRawPath(ctx.schema, rawPath)) throw invalid('The raw folder must be raw/ or a folder under it.');
    const record = draft(ctx, 'research', { ...fields, raw: rawPath, raw_sha256: sha256(stored), input_sha256: digest,
      sourceDate: day, processed: false, ...(url === undefined ? {} : { source: 'web' }),
      ...(projectRef === undefined ? {} : { project: projectRef }) });
    const found = related(ctx, title, bytes.toString('utf8'));
    const result = writeMany(ctx, { ...opts, op: 'ingest', items: [
      { path: rawPath, target: rawPath, createOnly: true, apply: () => stored },
      { path: record.path, target: record.data.id, expectAbsent: true, apply: () => record.text },
    ] });
    const [raw, research] = result.items;
    return { raw, research, input_sha256: digest, duplicate: false, dryRun, todo: todo(research.path), related: found,
      warnings: [...result.warnings, ...record.warnings] };
  });
}
