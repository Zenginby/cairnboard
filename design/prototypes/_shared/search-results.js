import { sectionProjectId, sectionText } from './journal.js';

// Shared search results: the full search page (search/) and the top bar's search dialog (⌘K) build the same rows.
// Records come from page data; matched words are wrapped in <mark>. The field is a combobox: arrow keys move the
// active result while focus stays in the field, Enter opens it.
export const searchKinds = { note: 'Not', card: 'Kart', wiki: 'Wiki', research: 'Araştırma', journal: 'Günlük' };
export const searchFilters = [['all', 'Tümü'], ['note', 'Notlar'], ['card', 'Kartlar'], ['wiki', 'Wiki'], ['research', 'Araştırmalar'], ['journal', 'Günlük']];
const fold = (text) => String(text || '').toLocaleLowerCase('tr');
let sequence = 0;

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
function dayLabel(iso) {
  return new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long' }).format(new Date(`${iso}T12:00:00`));
}
export function hrefFor(record) {
  const id = encodeURIComponent(record.id);
  if (record.kind === 'card') return `../card/?id=${id}`;
  if (record.kind === 'research') return `../research-item/?id=${id}`;
  if (record.kind === 'journal') return `../journal-day/?date=${encodeURIComponent(record.day || '')}`;
  return `../note/?id=${id}`;
}
// One flat list from the page's notes, cards and journal entries.
export function searchRecords(data) {
  const column = (key) => data.columns?.find((item) => item.key === key)?.label || '';
  return [
    ...(data.notes || []).map((note) => ({ id: note.id, kind: note.kind || 'note', title: note.title, body: note.body || '', projectId: note.projectId, date: note.updated || '' })),
    ...(data.cards || []).map((card) => ({ id: card.id, kind: 'card', title: card.title, body: (card.criteria || []).map((item) => item.text).join(' · '), projectId: card.projectId, date: column(card.column) })),
    ...(data.journal || []).map((section) => ({ id: section.id, kind: 'journal', title: `${dayLabel(section.date)} günlüğü · ${section.title}`, body: sectionText(section), projectId: sectionProjectId(section, data.projects || []), day: section.date, date: dayLabel(section.date) })),
  ].filter((record) => record.title);
}
export function searchTerms(query) {
  return fold(query).split(/\s+/).filter(Boolean);
}
// Every word must appear in the title, text or project name; title hits rank first.
export function findRecords(records, terms, projects) {
  if (!terms.length) return [];
  const projectName = (id) => projects.find((project) => project.id === id)?.name || '';
  return records
    .map((record, index) => {
      const title = fold(record.title);
      const haystack = `${title} ${fold(record.body)} ${fold(projectName(record.projectId))}`;
      if (!terms.every((term) => haystack.includes(term))) return null;
      return { record, index, score: terms.filter((term) => title.includes(term)).length };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.record);
}
// Text with each matched word in <mark>. Turkish lower-casing keeps string length, so offsets carry over.
export function highlight(text, terms) {
  const fragment = document.createDocumentFragment();
  const source = String(text || '');
  const folded = fold(source);
  const ranges = [];
  if (folded.length === source.length) {
    terms.forEach((term) => {
      for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + term.length)) ranges.push([at, at + term.length]);
    });
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  ranges.forEach(([start, end]) => {
    if (end <= cursor) return;
    start = Math.max(start, cursor);
    if (start > cursor) fragment.append(source.slice(cursor, start));
    fragment.append(node('mark', 'search-mark', source.slice(start, end)));
    cursor = end;
  });
  if (cursor < source.length) fragment.append(source.slice(cursor));
  return fragment;
}
// A window of the text around the first match, cut at word boundaries.
export function snippet(text, terms, size = 150) {
  const source = String(text || '');
  if (source.length <= size) return source;
  const folded = fold(source);
  const first = Math.min(...terms.map((term) => folded.indexOf(term)).filter((at) => at >= 0), source.length);
  let start = first === source.length ? 0 : Math.max(0, first - Math.round(size / 3));
  if (start > 0) start = source.indexOf(' ', start) + 1 || start;
  let end = Math.min(source.length, start + size);
  if (end < source.length) end = source.lastIndexOf(' ', end) > start ? source.lastIndexOf(' ', end) : end;
  return `${start > 0 ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`;
}
export function resultRow(record, terms, project, listId) {
  const row = node('li', 'search-hit');
  row.id = `${listId}-${record.kind}-${record.id}`;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', 'false');
  row.dataset.href = hrefFor(record);
  const top = node('div', 'search-hit-top');
  const title = node('span', 'search-hit-title');
  title.append(highlight(record.title, terms));
  top.append(title, node('span', `chip search-hit-kind search-hit-kind--${record.kind}`, searchKinds[record.kind]));
  const meta = node('p', 'search-hit-meta');
  if (project) {
    const dot = node('span', 'search-hit-dot');
    dot.setAttribute('aria-hidden', 'true');
    dot.style.setProperty('--hit-tone', `var(--color-tone-${project.tone})`);
    meta.append(dot, node('span', 'search-hit-project', project.name));
  }
  if (record.date) meta.append(node('span', 'search-hit-date', record.date));
  const text = node('p', 'search-hit-snippet');
  text.append(highlight(snippet(record.body, terms), terms));
  row.append(top, meta, text);
  return row;
}
// Wires a search field to a result list. render() returns per-kind counts for the current query.
export function createSearch({ input, records, projects, limit = Infinity, onOpen = (row) => location.assign(row.dataset.href), projectFor }) {
  const listId = `search-list-${++sequence}`;
  const list = node('ul', 'search-hits');
  list.id = listId;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Arama sonuçları');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');
  input.autocomplete = 'off';
  let active = -1;
  let kind = 'all';
  const rows = () => [...list.querySelectorAll('.search-hit')];
  const activate = (index, scroll = true) => {
    const items = rows();
    active = items.length ? (index + items.length) % items.length : -1;
    items.forEach((row, at) => {
      row.setAttribute('aria-selected', String(at === active));
      row.classList.toggle('is-active', at === active);
    });
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', items[active].id);
      if (scroll) items[active].scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };
  const render = (nextKind = kind) => {
    kind = nextKind;
    const terms = searchTerms(input.value);
    const found = findRecords(records(), terms, projects());
    const counts = Object.fromEntries(searchFilters.map(([id]) => [id, id === 'all' ? found.length : found.filter((record) => record.kind === id).length]));
    const shown = found.filter((record) => kind === 'all' || record.kind === kind).slice(0, limit);
    list.replaceChildren(...shown.map((record) => resultRow(record, terms, (projectFor || ((item) => projects().find((project) => project.id === item.projectId)))(record), listId)));
    input.setAttribute('aria-expanded', String(shown.length > 0));
    activate(shown.length ? 0 : -1, false);
    return { terms, counts, shown: shown.length, total: kind === 'all' ? found.length : counts[kind] };
  };
  input.addEventListener('keydown', (event) => {
    const items = rows();
    if (!items.length) return;
    const moves = { ArrowDown: active + 1, ArrowUp: active - 1, Home: 0, End: items.length - 1 };
    if (event.key in moves && !(['Home', 'End'].includes(event.key) && !event.ctrlKey)) {
      event.preventDefault();
      activate(moves[event.key]);
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      onOpen(items[active]);
    }
  });
  list.addEventListener('pointermove', (event) => {
    const row = event.target.closest('.search-hit');
    if (row && rows().indexOf(row) !== active) activate(rows().indexOf(row), false);
  });
  list.addEventListener('click', (event) => {
    const row = event.target.closest('.search-hit');
    if (row) onOpen(row);
  });
  return { list, render, rows, activate, get active() { return active; } };
}
