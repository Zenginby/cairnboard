import { CairnError } from './errors.mjs';
import { backlinks, journalEntries, rows } from './index.mjs';
import { listCards } from './card.mjs';
import { liveClaim } from './entity.mjs';
import * as entity from './entity.mjs';
import { readFile } from './store.mjs';
import { oneLine, stripHidden } from './text.mjs';
import { wakeupSection } from './wiki.mjs';
import { LESSONS, LESSON_DAYS, isUnprocessedSource } from './lint-checks.mjs';
import * as fs from './fsx.mjs';
import { checkedPath, readChecked } from './paths.mjs';
import { readEvents } from './events.mjs';
import { listChanges } from './changes.mjs';
import { withLock } from './lock.mjs';
import { ensureDataIgnore } from './roots.mjs';

const DAY = 86_400_000;
const SECTION_MAX_BYTES = 16 * 1024;
const LIMIT = 10;
const LINE_MAX = 200;
const OPEN_PRIORITIES = ['urgent', 'important'];

const line = (value, max = LINE_MAX) => oneLine(stripHidden(String(value ?? '')).text).replace(/\s+/gu, ' ').trim().slice(0, max);
const bullets = (items) => items.map((item) => `- ${item}`).join('\n');

// Cuts at a line boundary when one exists in the second half, never inside a surrogate pair.
function fit(text, max) {
  if (text.length <= max) return text;
  let cut = text.slice(0, Math.max(0, max));
  if (/[\uD800-\uDBFF]$/u.test(cut)) cut = cut.slice(0, -1);
  const newline = cut.lastIndexOf('\n');
  return newline > cut.length / 2 ? cut.slice(0, newline) : cut;
}

function byteCut(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char);
    if (bytes > maxBytes) break;
    end += char.length;
  }
  return text.slice(0, end);
}

function wakeup(ctx, warnings) {
  const overviews = rows(ctx, 'note', { kind: 'overview' }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (overviews.length > 1) warnings.push('overview_multiple');
  const selected = overviews[0];
  const path = selected?.path;
  const file = !selected || selected.error === 'too-large' || selected.badEncoding ? null : readFile(ctx, path);
  const section = file && wakeupSection(file.text);
  return section ? { name: 'wakeup', source: { path, revision: file.revision }, text: section.text.trim() } : null;
}

function readCursors(ctx) {
  const text = readChecked(ctx.root, '.cairn/agents/cursors.json', 'utf8');
  const cursors = text === null ? {} : JSON.parse(text);
  if (!cursors || typeof cursors !== 'object' || Array.isArray(cursors)
    || Object.values(cursors).some((seq) => !Number.isSafeInteger(seq) || seq < 0)) {
    throw new CairnError('validation', 'Invalid agent cursors.');
  }
  return cursors;
}

function ownerChanges(ctx, warnings) {
  const events = readEvents(ctx);
  let cursors = {}, writable = !ctx.ephemeral;
  if (ctx.actor && writable) {
    try { cursors = readCursors(ctx); } catch { warnings.push('cursor_read_failed'); writable = false; }
  }
  const since = ctx.actor ? (Object.hasOwn(cursors, ctx.actor) ? cursors[ctx.actor] : 0)
    : new Date(ctx.clock.now().getTime() - DAY).toISOString();
  const owner = events.filter((event) => event.actor === 'owner:external' && event.op === 'external.change'
    && (typeof since === 'number' ? event.seq > since : Date.parse(event.ts) >= Date.parse(since)));
  const changes = listChanges(ctx, { since, actor: 'owner:external', limit: 200 }, owner).slice(0, LIMIT);
  let text = bullets(changes.map((event) => `${event.seq} ${line(event.ts)} ${line(event.change ?? event.op)} `
    + event.paths.map((path) => line(path, 1024)).join(', ')));
  if (owner.length > LIMIT) text += `\nand ${owner.length - LIMIT} more; run changes --since ${changes.at(-1).seq}`;
  return { text, advance() {
    if (!ctx.actor || !writable || ['dry-run', 'inspect'].includes(ctx.mode)) return;
    try {
      const write = { ...ctx, mode: 'write' };
      withLock(write, '_cursors', () => {
        const latest = readCursors(ctx), seq = events.at(-1)?.seq ?? 0;
        const previous = Object.hasOwn(latest, ctx.actor) ? latest[ctx.actor] : 0;
        if (Object.hasOwn(latest, ctx.actor) && previous >= seq) return;
        Object.defineProperty(latest, ctx.actor, { value: Math.max(previous, seq), enumerable: true });
        ensureDataIgnore(ctx.root);
        fs.mkdirSync(checkedPath(ctx.root, '.cairn/agents'), { recursive: true, mode: 0o700 });
        fs.writeFileAtomic(checkedPath(ctx.root, '.cairn/agents/cursors.json'), JSON.stringify(latest));
      });
    } catch { warnings.push('cursor_write_failed'); }
  } };
}

/**
 * The session-start context pack (wiki spec §11): sections in priority order, each `{ name, source, content: { text },
 * truncated }`, plus warnings. Reads the cache through the ordinary readers (no strict index), never writes pages.
 */
/** @param {*} ctx @param {{ budget?: number, project?: string, advanceCursor?: boolean }} [options] */
export function buildContext(ctx, { budget = 1200, project, advanceCursor = true } = {}) {
  if (!Number.isSafeInteger(budget) || budget < 0) throw new CairnError('validation', 'Invalid budget.');
  const warnings = [];
  const selected = project === undefined ? null : entity.resolve(ctx, 'project', project);
  const actor = typeof ctx.actor === 'string' && ctx.actor.includes(':') ? ctx.actor.slice(ctx.actor.indexOf(':') + 1) : null;
  const cardLine = (card) => `${card.id ?? card.path} ${line(card.title)}${card.data.priority ? ` [${card.data.priority}]` : ''}`;
  const raw = [];
  const add = (name, text, source = null) => { if (text) raw.push({ name, source, text }); };

  const first = wakeup(ctx, warnings);
  if (first) add('wakeup', first.text, first.source);

  const projects = selected ? [selected] : entity.list(ctx, 'project').filter((item) => (item.data.status ?? 'active') === 'active');
  add('projects', bullets(projects.map((item) => `${line(item.title)} (${item.data.status ?? 'active'}) ${item.id ?? item.path}`)));
  const owner = ownerChanges(ctx, warnings);
  add('owner_changes', owner.text);

  const cards = listCards(ctx, { project: selected ? selected.id ?? selected.ref : undefined });
  if (actor) {
    add('my_cards', bullets(cards.filter((card) => card.data.assignee === actor && liveClaim(ctx, card.data)).map(cardLine)));
  }
  const rank = (card) => OPEN_PRIORITIES.indexOf(card.data.priority);
  add('urgent_cards', bullets(cards.filter((card) => rank(card) >= 0).sort((a, b) => rank(a) - rank(b)).slice(0, LIMIT).map(cardLine)));

  const since = new Date(ctx.clock.now().getTime() - 7 * DAY).toISOString().slice(0, 10);
  const decisions = journalEntries(ctx, { type: 'decision', since }).reverse().slice(0, LIMIT);
  add('decisions', bullets(decisions.map((item) => `${item.date} ${line(item.text)}`)));

  const hubs = rows(ctx, 'note').filter((row) => row.kind !== 'note')
    .map((row) => ({ row, count: new Set(backlinks(ctx, row.path).filter((link) => link.src_path !== row.path)
      .map((link) => link.src_path)).size }))
    .filter((hub) => hub.count > 0).sort((a, b) => b.count - a.count || a.row.path.localeCompare(b.row.path)).slice(0, LIMIT);
  add('hubs', bullets(hubs.map(({ row }) => `${line(row.title)} (${line(row.path, 1024)})`)));

  const lessonSince = new Date(ctx.clock.now().getTime() - LESSON_DAYS * DAY).toISOString().slice(0, 10);
  const sources = rows(ctx, 'research').filter((row) => isUnprocessedSource(row.data)).length;
  const lessons = journalEntries(ctx, { unprocessed: true, since: lessonSince })
    .filter((entry) => LESSONS.includes(entry.type) && /^\d{4}-\d{2}-\d{2}$/u.test(entry.date)).length;
  add('pending', `unprocessed_sources: ${sources}\nunprocessed_lessons: ${lessons}`);

  // Page text is cleaned of hidden characters; the 16 KB safety cut applies to every section, wakeup included.
  const sections = raw.map(({ name, source, text }) => {
    let clean = stripHidden(text).text;
    const cut = byteCut(clean, SECTION_MAX_BYTES);
    if (cut !== clean) warnings.push(`section_cut:${name}`);
    return { name, source, content: { text: cut }, truncated: cut !== clean };
  });

  // Over budget: trim from the last section backwards; wakeup is never trimmed for budget.
  const limit = budget * 4;
  const used = () => sections.reduce((sum, section) => sum + section.content.text.length, 0);
  if (used() > limit) {
    for (let i = sections.length - 1; i >= 0 && used() > limit; i--) {
      if (sections[i].name === 'wakeup') continue;
      const text = sections[i].content.text;
      const room = limit - (used() - text.length);
      sections[i].content.text = fit(text, room);
      sections[i].truncated = true;
    }
    if (used() > limit) warnings.push('wakeup_over_budget');
  }
  if (advanceCursor) owner.advance();
  return { sections, warnings };
}

/** Human-readable form: each section starts `# <name> (<source path>)`. */
export function formatContext({ sections }) {
  return sections.map((section) => `# ${section.name}${section.source ? ` (${section.source.path})` : ''}\n${section.content.text}`)
    .join('\n\n') + (sections.length ? '\n' : '');
}
