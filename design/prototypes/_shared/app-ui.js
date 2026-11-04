import '../_shared/theme.js';
import { setupShell } from './shell.js';
import { initComponents, showDialog } from '../_shared/components.js';
import { createSearch, searchRecords } from './search-results.js';
import { pinNote } from './pins.js';

export const $ = (selector) => document.querySelector(selector);
export function el(tag, className = '', text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function button(text, action, className = 'button') {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
// The core accepts only urgent, important and low; an ordinary card simply has no priority field. The empty key is that
// "Diğer" group, so a priority-less record reads as '' everywhere (see priorityOf).
export const priorities = { urgent: 'Acil', important: 'Önemli', '': 'Diğer', low: 'Düşük' };
export const priorityOf = (record) => record.priority || '';
export function priorityChip(priority = '') {
  return el('span', `chip${['urgent', 'important'].includes(priority) ? ` chip--${priority}` : ''}`, priorities[priority]);
}
export function projectChip(project) {
  const chip = el('span', `chip chip--tone-${project.tone}`, project.name);
  chip.title = project.name;
  return chip;
}
export function metadata(record, data) {
  const row = el('div', 'row type-label muted');
  const person = data.people.find((item) => item.id === record.assigneeId);
  const owner = el('span', person ? 'avatar' : 'badge', person?.initials || record.assigneeId || 'Atanmamış');
  owner.setAttribute('aria-label', person?.name || `${record.assigneeId || 'Atanmamış'} · ajan`);
  const progress = `${record.criteria.filter((item) => item.done).length}/${record.criteria.length}`;
  const criteria = el('span', 'counter', `✓ ${progress}`);
  criteria.setAttribute('aria-label', `Kabul ölçütleri: ${progress}`);
  row.append(owner, criteria, el('span', 'counter', `${record.comments} yorum`));
  return row;
}
// The 404 card of the not-found screen, for a document page whose ?id= names nothing. Same copy and classes.
export function notFoundCard() {
  const page = el('div', 'status-page');
  page.id = 'not-found';
  const card = el('section', 'status-card');
  card.setAttribute('aria-labelledby', 'not-found-title');
  const number = el('p', 'status-number', '404');
  number.setAttribute('aria-hidden', 'true');
  const title = el('h1', 'status-title');
  title.id = 'not-found-title';
  title.append(el('span', 'sr-only', '404: '), 'Bu sayfa burada değil.');
  const actions = el('div', 'row status-actions');
  const home = el('a', 'button button--primary', 'Ana sayfaya dön');
  home.href = '../home/';
  actions.append(home, button('Ara', () => $('#search-open')?.click()));
  card.append(number, title, el('p', 'status-text', 'Taşınmış, adı değişmiş ya da hiç olmamış olabilir. Ana sayfadan devam edebilirsin.'), actions);
  page.append(card);
  return page;
}
export function lockMessage() {
  const line = el('p', 'type-label muted lock-message');
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(icon.namespaceURI, 'path');
  path.setAttribute('d', 'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5z');
  icon.append(path);
  line.append(icon, document.createTextNode('claude üzerinde çalışıyor. Kilit kalkana kadar taşınamaz.'));
  return line;
}
// Notes written in this browser session (quick notes, Not ekle) survive moving between pages.
const createdKey = 'prototype-created-notes';
function readCreatedNotes() {
  try { const value = JSON.parse(sessionStorage.getItem(createdKey) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
}
function saveCreatedNote(note) {
  try { sessionStorage.setItem(createdKey, JSON.stringify([note, ...readCreatedNotes().filter((item) => item.id !== note.id)])); } catch { /* Kept on this page only. */ }
}
export async function loadData(source = 'data.json') {
  const responses = await Promise.all([fetch('../_shared/sample.json'), fetch(source)]);
  if (responses.some((response) => !response.ok)) throw new Error('Sample data unavailable');
  const [base, extra] = await Promise.all(responses.map((response) => response.json()));
  const merge = (kind) => [...new Map([...base[kind], ...extra[kind]].map((record) => [record.id, { ...base[kind].find((item) => item.id === record.id), ...record }])).values()];
  const notes = merge('notes');
  const created = readCreatedNotes().filter((note) => !notes.some((item) => item.id === note.id));
  return { ...base, ...extra, cards: merge('cards'), notes: [...created, ...notes] };
}
export function field(label, tag = 'input') {
  const wrapper = el('label', 'field');
  const control = el(tag, tag === 'textarea' ? 'textarea' : tag === 'input' ? 'input' : '');
  wrapper.append(el('span', 'type-label', label), control);
  return { wrapper, control };
}
export function setupUI(data, onCreate, openCard) {
  const dialog = $('#editor');
  let submit = null;
  const announce = (text) => { $('#announcements').textContent = text; };
  const close = () => dialog.close();
  const open = (title, content, save, instant = false, saveLabel = 'Değişiklikleri kaydet') => {
    $('#editor-title').textContent = title;
    $('#editor-body').replaceChildren(...content);
    $('#editor-save').hidden = !save;
    $('#editor-save').textContent = saveLabel;
    submit = save;
    showDialog(dialog, instant);
    ($('#editor-body').querySelector('input, textarea, select, button:not(:disabled)') || $('#editor-close')).focus({ preventScroll: true });
  };
  $('#editor-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (submit?.() !== false) close();
  });
  $('#editor-close').addEventListener('click', close);
  const inspect = (record, instant = false) => {
    const content = [];
    if (record.projectId) content.push(projectChip(data.projects.find((project) => project.id === record.projectId)));
    if (record.body) content.push(el('p', '', record.body));
    if (record.criteria) {
      content.push(priorityChip(priorityOf(record)), metadata(record, data));
      const list = el('ul', 'criteria-list');
      record.criteria.forEach((criterion) => list.append(el('li', '', `${criterion.done ? '✓' : '○'} ${criterion.text}`)));
      content.push(list);
    }
    // The quick look always offers the way to the record's own page.
    if (record.id && (record.criteria || record.kind)) {
      const page = record.criteria ? 'card' : record.kind === 'research' ? 'research-item' : 'note';
      const go = el('a', 'action-link', record.criteria ? 'Kartı aç' : 'Sayfayı aç');
      go.href = `../${page}/?id=${encodeURIComponent(record.id)}`;
      content.push(go);
    }
    open(record.title, content, null, instant);
  };
  const create = (kind, instant = false, column = 'todo') => {
    const title = field(kind === 'note' ? 'Not başlığı' : 'Kart başlığı');
    title.control.required = true;
    const project = field('Proje', 'select');
    data.projects.forEach((record) => {
      const option = el('option', '', record.name);
      option.value = record.id;
      project.control.append(option);
    });
    const body = field('Not', 'textarea');
    const priority = field('Öncelik', 'select');
    Object.entries(priorities).forEach(([value, label]) => {
      const option = el('option', '', label);
      option.value = value;
      priority.control.append(option);
    });
    priority.control.value = '';
    // A new note can be pinned right away; pinned notes show in the pinned rail and the Sabitlenenler lists.
    const pin = el('label', 'row type-label quick-pin');
    const pinBox = el('input');
    pinBox.type = 'checkbox';
    pin.append(pinBox, document.createTextNode('Sabitle'));
    open(kind === 'note' ? 'Hızlı not' : 'Yeni kart', [title.wrapper, project.wrapper, ...(kind === 'note' ? [body.wrapper, pin] : [priority.wrapper])], () => {
      const value = title.control.value.trim();
      if (!value) { title.control.setCustomValidity('Bir başlık yaz.'); title.control.reportValidity(); return false; }
      const record = { id: crypto.randomUUID(), title: value, projectId: project.control.value };
      if (kind === 'note') {
        const note = { ...record, body: body.control.value.trim(), kind: 'note', pinned: pinBox.checked, updated: 'Şimdi' };
        data.notes.unshift(note);
        saveCreatedNote(note);
        if (note.pinned) {
          const owner = data.projects.find((item) => item.id === note.projectId);
          pinNote({ id: note.id, kind: 'note', title: note.title, projectId: note.projectId, updated: note.updated, body: note.body, project: owner && { name: owner.name, tone: owner.tone } });
        }
      }
      else data.cards.unshift({ ...record, column, ...(priority.control.value ? { priority: priority.control.value } : {}), assigneeId: 'ada', criteria: [], comments: 0 });
      onCreate(kind);
      announce(kind === 'note' ? (pinBox.checked ? 'Not eklendi ve sabitlendi.' : 'Not eklendi.') : 'Kart eklendi.');
    }, instant, kind === 'note' ? 'Not ekle' : 'Kartı ekle');
    title.control.addEventListener('input', () => title.control.setCustomValidity(''));
    title.control.focus();
  };
  const search = (instant = false) => {
    const query = field('Notlarda, kartlarda ve günlükte ara');
    query.control.type = 'search';
    const results = createSearch({ input: query.control, records: () => searchRecords(data), projects: () => data.projects, limit: 8 });
    const status = el('p', 'muted type-label search-status');
    status.setAttribute('aria-live', 'polite');
    const all = el('a', 'search-all type-label', 'Tüm sonuçları arama sayfasında aç');
    const render = () => {
      const { total, shown } = results.render();
      const value = query.control.value.trim();
      all.href = `../search/${value ? `?q=${encodeURIComponent(value)}` : ''}`;
      status.textContent = !value ? 'Aramak için yazmaya başla. Ok tuşlarıyla seç, Enter ile aç.' : total ? `${total} sonuç${total > shown ? `, ilk ${shown} gösteriliyor` : ''}.` : 'Sonuç yok. Başka bir sözcük dene.';
    };
    query.control.addEventListener('input', render);
    render();
    open('Ara', [query.wrapper, status, results.list, all], null, instant);
    query.control.focus();
  };
  const help = (instant = false) => open('Klavye kısayolları', [el('p', '', 'N — hızlı not · C — yeni kart · / veya ⌘K / Ctrl+K — ara · ? — kısayollar'), el('p', '', 'M — odaktaki kartı taşı · Ok tuşları — menü veya sütun seçimi · Escape — kapat / sürüklemeyi iptal et'), el('p', 'muted', 'Girdi alanlarında yazarken kısayollar çalışmaz.')], null, instant);
  setupShell(search);
  // A quick note is one press away on every page: a floating button (N on the keyboard does the same).
  if (!document.querySelector('.quick-note-fab')) {
    const fab = button('', (event) => create('note', event.detail === 0), 'quick-note-fab');
    fab.setAttribute('aria-label', 'Hızlı not al');
    fab.setAttribute('aria-keyshortcuts', 'N');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(icon.namespaceURI, 'path');
    path.setAttribute('d', 'M4 20h4L19 9l-4-4L4 16v4Zm9.5-13.5 4 4');
    icon.append(path);
    fab.append(icon, el('span', 'quick-note-label', 'Hızlı not'));
    document.body.append(fab);
  }
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (!dialog.open) search(true);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || dialog.open || event.target.closest('input, textarea, select, [contenteditable="true"], [role="menu"], #theme-panel')) return;
    const actions = { n: () => create('note', true), c: () => openCard(true), '/': () => search(true), '?': () => help(true) };
    if (actions[event.key.toLowerCase()]) { event.preventDefault(); actions[event.key.toLowerCase()](); }
  });
  $('#diff-open')?.addEventListener('click', (event) => open('Dosyadaki fark', [el('p', 'muted', 'Kart · dışarıdaki değişiklik'), el('p', 'type-code', `− ${data.cards[0].title}`), el('p', 'type-code', `+ ${data.cards[0].title} ve sonucu günlüğe yaz`), el('p', '', 'Yeniden yükle seçeneği dışarıdaki sürümü bu oturumda uygular.')], null, event.detail === 0));
  initComponents();
  return { open, close, inspect, create, announce };
}
// copy (optional) replaces the default texts per state: { empty: [title, text, action], loading: [title, text], error: [title, text] }.
export function renderState(state, retry, firstStep, copy = {}) {
  const panel = $('#state-content');
  const special = ['empty', 'loading', 'error'].includes(state);
  $('#screen-content').hidden = special;
  panel.hidden = !special;
  if ($('#conflict')) $('#conflict').hidden = state !== 'conflict';
  panel.replaceChildren();
  panel.setAttribute('aria-busy', String(state === 'loading'));
  if (!special) return;
  const texts = {
    empty: ['Panoda kart yok', 'Yapacağın işi bir karta yaz.', 'Kartı ekle'],
    loading: ['Çalışma alanı yükleniyor', 'Notlar ve kartlar hazırlanıyor.'],
    error: ['Çalışma alanı yüklenemedi', 'Çalışma alanı dosyaları okunamadı. Veri klasörüne erişimi kontrol et.'],
    ...copy,
  }[state];
  const title = el('h2', '', texts[0]);
  title.id = 'state-title';
  panel.append(title);
  if (state === 'loading') {
    const skeletons = el('div', 'stack skeletons');
    skeletons.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < 3; index++) skeletons.append(el('div', 'skeleton'));
    panel.append(skeletons, el('p', 'muted', texts[1]));
  } else if (state === 'error') panel.append(el('p', 'muted', texts[1]), button('Yeniden dene', retry));
  else {
    panel.append(el('p', 'muted', texts[1]));
    if (texts[2] && firstStep) panel.append(button(texts[2], firstStep, 'button button--primary'));
  }
}
