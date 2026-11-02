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

function records(text) {
  if (text && !text.endsWith('\n')) throw invalid();
  return text.split('\n').filter(Boolean).map((line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw invalid();
    }
    if (event?.v !== 1 || !Number.isSafeInteger(event.seq) || event.seq < 1) throw invalid();
    return event;
  });
}

// Records are capped at 16 KB, so the last 64 KB always holds the newest complete records.
function tail(ctx, month) {
  let fd;
  try {
    fd = openForRead(ctx.root, `.cairn/events/${month}.jsonl`);
    const size = fs.fstatSync(fd).size;
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
  return names.filter((name) => monthFile.test(name))
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
  return withLock(ctx, '_events', () => {
    const dir = checkedPath(ctx.root, '.cairn/events');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const counter = readChecked(ctx.root, '.cairn/events/seq', 'utf8');
    const saved = parseMirror(counter);
    const newest = fs.readdirSync(dir).filter((name) => monthFile.test(name)).sort().at(-1)?.slice(0, 7) ?? null;
    const recent = [...new Set([saved.month ?? newest, newest])].filter(Boolean).flatMap((name) => tail(ctx, name));
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
