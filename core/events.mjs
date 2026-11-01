import * as fs from './fsx.mjs';
import { CairnError } from './errors.mjs';
import { checkedPath, openForRead } from './paths.mjs';
import { withLock } from './lock.mjs';

const contentKeys = new Set(['title', 'body', 'text', 'content']);
const monthFormat = new Intl.DateTimeFormat('en', { timeZone: 'UTC', year: 'numeric', month: '2-digit' });
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

function read(ctx, rel, tail = false) {
  let fd;
  try {
    fd = openForRead(ctx.root, rel);
    if (!tail) return fs.readFileSync(fd, 'utf8');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - 64 * 1024);
    const offset = start ? start - 1 : 0;
    const bytes = Buffer.alloc(size - offset);
    let count = 0;
    while (count < bytes.length) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, offset + count);
      if (!n) break;
      count += n;
    }
    const text = bytes.subarray(0, count).toString('utf8');
    // Include the preceding byte so a record exactly on the boundary is retained.
    return start ? text.slice(text.indexOf('\n') + 1) : text;
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
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
  return names.filter((name) => /^\d{4}-\d{2}\.jsonl$/u.test(name))
    .flatMap((name) => records(read(ctx, `.cairn/events/${name}`)))
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
  const parts = Object.fromEntries(monthFormat.formatToParts(Date.parse(ts)).map(({ type, value }) => [type, value]));
  const rel = `.cairn/events/${parts.year}-${parts.month}.jsonl`;
  return withLock(ctx, '_events', () => {
    fs.mkdirSync(checkedPath(ctx.root, '.cairn/events'), { recursive: true, mode: 0o700 });
    const newest = fs.readdirSync(checkedPath(ctx.root, '.cairn/events'))
      .filter((name) => /^\d{4}-\d{2}\.jsonl$/u.test(name)).sort().at(-1);
    const tail = newest ? records(read(ctx, `.cairn/events/${newest}`, true)) : [];
    const counter = read(ctx, '.cairn/events/seq');
    const saved = Number(counter);
    if (!Number.isSafeInteger(saved) || saved < 0) throw invalid();
    const previous = tail.find((event) => event.tx === tx);
    // Recover an event persisted before its sequence mirror without reading older months.
    const last = tail.reduce((seq, event) => Math.max(seq, event.seq), saved);
    if (previous) {
      if (counter !== `${last}\n`) {
        fs.writeFileAtomic(checkedPath(ctx.root, '.cairn/events/seq'), `${last}\n`);
      }
      return previous.seq;
    }
    const seq = last + 1;
    if (!Number.isSafeInteger(seq)) throw invalid();
    const path = checkedPath(ctx.root, rel);
    const fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND
      | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ v: 1, seq, ...data }) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.writeFileAtomic(checkedPath(ctx.root, '.cairn/events/seq'), `${seq}\n`);
    ctx.faults?.('after-event');
    return seq;
  });
}
