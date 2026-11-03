import { $, el, button, priorityChip, projectChip, metadata, lockMessage, field, loadData, setupUI, renderState } from './ui.js';

let data;
let fixtures;
let ui;
let state = 'full';
let lowOpen = false;
let journalDraft = '';
let sequence = 0;
const today = new Date();
const entries = [];
const projectFor = (record) => {
  const project = data.projects.find((item) => item.id === record.projectId);
  return state === 'long' ? { ...project, name: data.longText.projectName } : project;
};
const titleFor = (record, index = 0) => state === 'long' ? `${record.title} — ${index % 2 ? data.longText.english : data.longText.title}` : record.title;
const openCards = () => data.cards.filter((card) => data.columns.find((column) => column.id === card.column).role !== 'done');
function section(title, className) {
  const node = el('section', `box stack ${className}`);
  const heading = el('h2', '', title);
  heading.id = `section-${++sequence}`;
  node.setAttribute('aria-labelledby', heading.id);
  node.append(heading);
  return node;
}
function move(record, instant) {
  const target = field('Hedef sütun', 'select');
  data.columns.forEach((column) => {
    const option = el('option', '', column.label);
    option.value = column.id;
    target.control.append(option);
  });
  target.control.value = record.column;
  ui.open('Kartı taşı', [el('p', '', record.title), target.wrapper], () => {
    const previous = data.columns.find((column) => column.id === record.column).label;
    record.column = target.control.value;
    render();
    const destination = data.columns.find((column) => column.id === record.column).label;
    ui.announce(`'${record.title}' kartı '${previous}' sütunundan '${destination}' sütununa taşındı.`);
    requestAnimationFrame(() => (document.getElementById(record.id) || $('#card-open')).focus());
  }, instant, 'Taşı');
}
function task(record, index) {
  const item = el('li', 'task');
  item.id = record.id;
  item.tabIndex = 0;
  const title = button(titleFor(record, index), (event) => ui.inspect({ ...record, title: titleFor(record, index) }, event.detail === 0), 'card-title');
  const tags = el('div', 'row');
  tags.append(projectChip(projectFor(record)), priorityChip(record.priority));
  const footer = el('div', 'row card-footer');
  const locked = state === 'locked' && record.id === 'card-2';
  const trigger = button('Taşı…', (event) => move(record, event.detail === 0), 'button button--quiet');
  trigger.setAttribute('aria-label', `${record.title}: taşı`);
  trigger.disabled = locked;
  footer.append(metadata(locked ? { ...record, assigneeId: 'claude' } : record, data), trigger);
  item.append(title, tags, footer);
  if (locked) {
    const message = lockMessage();
    message.id = `${record.id}-lock`;
    trigger.setAttribute('aria-describedby', message.id);
    item.append(message);
  }
  item.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() === 'm' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (locked) ui.announce('claude üzerinde çalışıyor. Kilit kalkana kadar taşınamaz.');
      else move(record, true);
    }
  });
  return item;
}
function noteList(records) {
  const list = el('ul', 'note-list');
  records.forEach((record, index) => {
    const item = el('li', 'note');
    const tags = el('div', 'row');
    tags.append(projectChip(projectFor(record)), el('span', 'type-label muted', record.kind === 'wiki' ? 'Wiki sayfası' : `Not · ${record.updated}`));
    item.append(tags, button(titleFor(record, index), (event) => ui.inspect(record, event.detail === 0), 'note-title'), el('p', 'note-excerpt', record.body));
    list.append(item);
  });
  return list;
}
function render() {
  if (!data) return;
  const dashboard = $('#dashboard');
  dashboard.replaceChildren();
  const hero = el('section', 'box box--hero hero');
  hero.setAttribute('aria-labelledby', 'greeting');
  const intro = el('div', 'stack hero-intro');
  const greeting = el('h1', '', 'Merhaba, Ada.');
  greeting.id = 'greeting';
  intro.append(el('p', 'type-label muted', new Intl.DateTimeFormat('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(today)), greeting, el('p', 'muted', 'Düşüncelerine yer aç, bir sonraki adımı seç.'));
  const stats = el('div', 'row');
  stats.append(el('span', 'badge', `${openCards().length} açık iş`), el('span', 'badge', `${new Set(openCards().filter((card) => ['claude', 'codex'].includes(card.assigneeId)).map((card) => card.assigneeId)).size} ajanla birlikte`));
  intro.append(stats);
  const journal = el('div', 'stack journal');
  journal.append(el('h2', '', 'Bugünün günlüğü'));
  const list = el('ul', 'journal-list');
  entries.forEach((entry) => {
    const item = el('li', 'journal-entry');
    item.append(el('span', 'type-label muted', entry.time), el('p', '', entry.body));
    list.append(item);
  });
  if (!entries.length) list.append(el('li', 'muted', 'Henüz bir kayıt yok. Bugünden küçük bir not bırakın.'));
  const form = el('form', 'row journal-form');
  const input = field('Bugüne ekle');
  input.control.placeholder = 'Aklında ne var?';
  input.control.required = true;
  input.control.value = journalDraft;
  input.control.addEventListener('input', () => { journalDraft = input.control.value; });
  const save = el('button', 'button button--primary', 'Ekle');
  save.type = 'submit';
  form.append(input.wrapper, save);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.control.value.trim();
    if (!value) return;
    entries.push({ time: new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(new Date()), body: value });
    journalDraft = '';
    render();
    $('#dashboard .journal input').focus();
    ui.announce('Bugünün günlüğüne eklendi.');
  });
  journal.append(list, form);
  hero.append(intro, journal);
  const priorities = section('Açık işler', 'priorities');
  const heading = el('div', 'row section-heading');
  heading.append(el('p', 'type-label muted', 'Önce önemli olanlar'), el('a', 'button button--quiet', 'Panoya git →'));
  heading.lastChild.href = '../board-a/';
  priorities.append(heading);
  [['urgent', 'Acil'], ['important', 'Önemli'], ['normal', 'Diğer'], ['low', 'Düşük']].forEach(([priority, label]) => {
    const records = openCards().filter((record) => record.priority === priority);
    const group = el(priority === 'low' ? 'details' : 'div', priority === 'low' ? 'low-priority' : 'priority-group');
    if (priority === 'low') {
      group.open = lowOpen;
      group.append(el('summary', 'type-label', `Düşük öncelikli ${records.length} iş`));
      group.addEventListener('toggle', () => { lowOpen = group.open; });
    } else group.append(el('h3', 'type-label', `${label} · ${records.length}`));
    const list = el('ul', 'task-list');
    records.forEach((record, index) => list.append(task(record, index)));
    if (!records.length) group.append(el('p', 'type-label muted', 'Bu öncelikte açık iş yok.'));
    group.append(list);
    priorities.append(group);
  });
  const pinned = section('Sabitlenenler', 'pinned');
  pinned.append(noteList(data.notes.filter((note) => note.pinned)));
  if (!data.notes.some((note) => note.pinned)) pinned.append(el('p', 'muted', 'Sabitlenen bir not henüz yok.'));
  const recent = section('Son hızlı notlar', 'recent');
  recent.append(noteList(data.notes.filter((note) => note.kind === 'note').slice(0, 3)));
  if (!data.notes.some((note) => note.kind === 'note')) recent.append(el('p', 'muted', 'Henüz hızlı not yok. Not ekle ile bir düşünce yakalayın.'));
  const projects = section('Projeler', 'projects');
  const strip = el('div', 'project-strip');
  data.projects.forEach((project) => {
    const link = el('a', 'inset project-link');
    link.href = `../board-a/?project=${encodeURIComponent(project.id)}`;
    link.append(projectChip(state === 'long' ? { ...project, name: data.longText.projectName } : project), el('span', 'type-label muted', `${openCards().filter((record) => record.projectId === project.id).length} açık iş`));
    strip.append(link);
  });
  projects.append(strip);
  dashboard.append(hero, priorities, pinned, recent, projects);
}
function setState(value) {
  state = value;
  if (value === 'empty') { data.cards = []; data.notes = []; entries.length = 0; }
  $('#prototype-state').value = value;
  renderState(value, () => setState('full'), () => ui.create('card'));
  render();
}
async function start() {
  try {
    data = await loadData();
    fixtures = structuredClone(data);
    entries.push(...data.journal.map((entry, index) => ({ time: index ? '10.15 · Deniz' : '09.00 · Ada', body: entry.body })));
    ui = setupUI(data, (kind) => { if (state === 'empty') setState('full'); else render(); if (kind === 'card') requestAnimationFrame(() => document.getElementById(data.cards[0].id)?.focus()); }, (instant) => ui.create('card', instant));
    $('#prototype-state').addEventListener('change', (event) => {
      Object.assign(data, structuredClone(fixtures));
      entries.splice(0, entries.length, ...data.journal.map((entry, index) => ({ time: index ? '10.15 · Deniz' : '09.00 · Ada', body: entry.body })));
      setState(event.target.value);
    });
    $('#reload').addEventListener('click', () => { data.cards[0].title += ' ve sonucu günlüğe yaz'; setState('full'); ui.announce('Dosyanın dışarıdaki sürümü yüklendi.'); });
    setState('full');
  } catch {
    renderState('error', start, () => {});
  }
}
start();
