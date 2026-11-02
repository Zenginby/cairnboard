import * as fs from './fsx.mjs';
import { CairnError } from './errors.mjs';
import { checkedPath, openForAppend, openForRead, readChecked } from './paths.mjs';
import { withLock } from './lock.mjs';

const contentKeys = new Set(['title', 'body', 'text', 'content']);
const monthFormat = new Intl.DateTimeFormat('en', { timeZone: 'UTC', year: 'numeric', month: '2-digit' });
const monthFile = /^\d{4}-\d{2}\.jsonl$/u;
const maxRecord = 16 * 1024;
const tailSize = 64 * 1024;
const invalid = () => new CairnError('validation', 'Invalid event log.');

function validMonth(month) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/u.test(month)) return false;
  const [year, m] = month.split('-').map(Number);
  return year >= 2000 && year <= 2100 && m >= 1 && m <= 12;
}

function isMonthFile(name) {
  return monthFile.test(name) && validMonth(name.slice(0, 7));
}

function records(text) {
  if (!text) return [];
  const end = text.lastIndexOf('\n');
  const lines = end === -1 ? [] : text.slice(0, end).split('\n');
  return lines.filter(Boolean).flatMap((line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    if (event?.v !== 1 || !Number.isSafeInteger(event.seq) || event.seq < 1) return [];
    return [event];
  });
}

function findLastNewline(fd, fromPos) {
  let pos = fromPos;
  const buf = Buffer.alloc(tailSize);
  while (pos > 0) {
    const chunk = Math.min(pos, tailSize);
    pos -= chunk;
    let count = 0;
    while (count < chunk) {
      const n = fs.readSync(fd, buf, count, chunk - count, pos + count);
      if (!n) break;
      count += n;
    }
    const idx = buf.subarray(0, count).lastIndexOf(0x0a);
    if (idx !== -1) return pos + idx + 1;
  }
  return 0;
}

// Records are capped at 16 KB, so the last 64 KB always holds the newest complete records.
function tail(ctx, month) {
  let fd;
  try {
    fd = openForRead(ctx.root, `.cairn/events/${month}.jsonl`);
    const size = fs.fstatSync(fd).size;
    if (size === 0) return [];
    const start = Math.max(0, size - tailSize);
    // Include the preceding byte so a record exactly on the boundary is retained.
    const offset = start ? start - 1 : 0;
    const bytes = Buffer.alloc(size - offset);
    let count = 0;
    while (count < bytes.length) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, offset + count);
      if (!n) break;
      count += n;
    }
    if (count > 0 && bytes[count - 1] !== 0x0a) {
      const lastNl = bytes.subarray(0, count).lastIndexOf(0x0a);
      let validSize = 0;
      if (lastNl !== -1) {
        validSize = offset + lastNl + 1;
      } else if (offset > 0) {
        validSize = findLastNewline(fd, offset);
      }
      fs.closeSync(fd);
      fd = undefined;
      fs.truncateSync(checkedPath(ctx.root, `.cairn/events/${month}.jsonl`), validSize);
      if (validSize === 0) return [];
      if (validSize < offset) return tail(ctx, month);
      const text = bytes.subarray(0, validSize - offset).toString('utf8');
      return records(start ? text.slice(text.indexOf('\n') + 1) : text);
    }
    const text = bytes.subarray(0, count).toString('utf8');
    return records(start ? text.slice(text.indexOf('\n') + 1) : text);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// `<seq> <YYYY-MM>`: every event up to seq is durable and only that month may hold a newer one.
// The older bare `<seq>` form leaves the month to the newest file.
function parseMirror(text) {
  if (!text) return { seq: 0, month: null };
  const match = /^(\d+)(?: (\d{4}-\d{2}))?\n?$/u.exec(text);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw invalid();
  if (match[2] !== undefined && !validMonth(match[2])) throw invalid();
  return { seq: Number(match[1]), month: match[2] ?? null };
}

export function readEvents(ctx, { sinceSeq = 0 } = {}) {
  if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0) throw new TypeError('Invalid event cursor.');
  let names;
  try {
    names = fs.readdirSync(checkedPath(ctx.root, '.cairn/events'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return names.filter(isMonthFile)
    .flatMap((name) => records(readChecked(ctx.root, `.cairn/events/${name}`, 'utf8') ?? ''))
    .filter((event) => event.seq > sinceSeq).sort((a, b) => a.seq - b.seq);
}

export function appendEvent(ctx, input) {
  if (ctx.mode !== 'write') throw new TypeError('Events require write mode.');
  const { tx, op, target, rev, actor = ctx.actor, ts = ctx.clock.now().toISOString(), ...extra } = input;
  if (Object.hasOwn(extra, 'v') || Object.hasOwn(extra, 'seq')
    || ![tx, op, target].every((value) => typeof value === 'string' && value.length)
    || rev === undefined || (actor !== null && typeof actor !== 'string')
    || typeof ts !== 'string' || !Number.isFinite(Date.parse(ts))) throw new TypeError('Invalid event.');
  const data = JSON.parse(JSON.stringify({ ts, actor, op, target, ...extra, tx, rev }, (key, value) => {
    if (contentKeys.has(key)) throw new TypeError('Event content keys are forbidden.');
    return value;
  }));
  const line = (seq) => JSON.stringify({ v: 1, seq, ...data }) + '\n';
  if (Buffer.byteLength(line(Number.MAX_SAFE_INTEGER)) > maxRecord) throw new TypeError('Event exceeds 16 KB.');
  const parts = Object.fromEntries(monthFormat.formatToParts(Date.parse(ts)).map(({ type, value }) => [type, value]));
  const month = `${parts.year}-${parts.month}`;
  if (!validMonth(month)) throw new TypeError('Invalid event.');
  return withLock(ctx, '_events', () => {
    const dir = checkedPath(ctx.root, '.cairn/events');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const counter = readChecked(ctx.root, '.cairn/events/seq', 'utf8');
    const saved = parseMirror(counter);
    const newest = fs.readdirSync(dir).filter(isMonthFile).sort().at(-1)?.slice(0, 7) ?? null;
    const recentMonths = new Set([saved.month ?? newest, newest].filter(Boolean));
    const recent = [...recentMonths].flatMap((name) => tail(ctx, name));
    // Recover an event persisted before its sequence mirror without reading older months.
    const last = recent.reduce((seq, event) => Math.max(seq, event.seq), saved.seq);
    const mirror = (seq, name) => {
      const text = `${seq} ${name}\n`;
      if (text !== counter) fs.writeFileAtomic(checkedPath(ctx.root, '.cairn/events/seq'), text);
    };
    const previous = recent.find((event) => event.tx === tx);
    if (previous) {
      mirror(last, saved.month ?? newest);
      return previous.seq;
    }
    if (!recentMonths.has(month)) tail(ctx, month);
    const seq = last + 1;
    if (!Number.isSafeInteger(seq)) throw invalid();
    // An older month is not found by recovery unless the mirror names it before the append.
    if (newest !== null && newest > month && saved.month !== month) mirror(last, month);
    const fd = openForAppend(ctx.root, `.cairn/events/${month}.jsonl`);
    try {
      fs.writeFileSync(fd, line(seq));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    mirror(seq, month);
    ctx.faults?.('after-event');
    return seq;
  });
}
