import '../_shared/theme.js';
import { setupShell } from './shell.js';
import { initComponents, showDialog } from '../_shared/components.js';

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
export const priorities = { urgent: 'Acil', important: 'Önemli', normal: 'Diğer', low: 'Düşük' };
export function priorityChip(priority) {
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
export async function loadData() {
  const responses = await Promise.all([fetch('../_shared/sample.json'), fetch('data.json')]);
  if (responses.some((response) => !response.ok)) throw new Error('Sample data unavailable');
  const [base, extra] = await Promise.all(responses.map((response) => response.json()));
  const merge = (kind) => [...new Map([...base[kind], ...extra[kind]].map((record) => [record.id, { ...base[kind].find((item) => item.id === record.id), ...record }])).values()];
  return { ...base, ...extra, cards: merge('cards'), notes: merge('notes') };
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
  const open = (title, content, save, instant = false, saveLabel = 'Ekle') => {
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
      content.push(priorityChip(record.priority), metadata(record, data));
      const list = el('ul', 'criteria-list');
      record.criteria.forEach((criterion) => list.append(el('li', '', `${criterion.done ? '✓' : '○'} ${criterion.text}`)));
      content.push(list);
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
    priority.control.value = 'normal';
    open(kind === 'note' ? 'Hızlı not' : 'Yeni kart', [title.wrapper, project.wrapper, kind === 'note' ? body.wrapper : priority.wrapper], () => {
      const value = title.control.value.trim();
      if (!value) { title.control.setCustomValidity('Bir başlık yazın.'); title.control.reportValidity(); return false; }
      const record = { id: crypto.randomUUID(), title: value, projectId: project.control.value };
      if (kind === 'note') data.notes.unshift({ ...record, body: body.control.value.trim(), kind: 'note', pinned: false, updated: 'Şimdi' });
      else data.cards.unshift({ ...record, column, priority: priority.control.value, assigneeId: 'ada', criteria: [], comments: 0 });
      onCreate(kind);
      announce(kind === 'note' ? 'Not eklendi.' : 'Kart eklendi.');
    }, instant);
    title.control.addEventListener('input', () => title.control.setCustomValidity(''));
    title.control.focus();
  };
  const search = (instant = false) => {
    const query = field('Notlarda ve kartlarda ara');
    query.control.type = 'search';
    const results = el('div', 'stack search-results');
    const render = () => {
      const term = query.control.value.toLocaleLowerCase('tr');
      const records = [...data.cards, ...data.notes].filter((record) => `${record.title} ${record.body || ''} ${data.projects.find((project) => project.id === record.projectId)?.name || ''}`.toLocaleLowerCase('tr').includes(term));
      results.replaceChildren(...records.map((record) => button(record.title, () => inspect(record, true), 'button result-button')));
      if (!records.length) results.append(el('p', 'muted', 'Sonuç yok. Başka bir sözcük deneyin.'));
    };
    query.control.addEventListener('input', render);
    render();
    open('Ara', [query.wrapper, results], null, instant);
    query.control.focus();
  };
  const help = (instant = false) => open('Klavye kısayolları', [el('p', '', 'N — hızlı not · C — yeni kart · / veya ⌘K / Ctrl+K — ara · ? — kısayollar'), el('p', '', 'M — odaktaki kartı taşı · Ok tuşları — menü veya sütun seçimi · Escape — kapat / sürüklemeyi iptal et'), el('p', 'muted', 'Girdi alanlarında yazarken kısayollar çalışmaz.')], null, instant);
  setupShell(search);
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
  $('#diff-open').addEventListener('click', (event) => open('Dosyadaki fark', [el('p', 'muted', 'Örnek kart · dışarıdaki değişiklik'), el('p', 'type-code', `− ${data.cards[0].title}`), el('p', 'type-code', `+ ${data.cards[0].title} ve sonucu günlüğe yaz`), el('p', '', 'Yeniden yükle seçeneği dışarıdaki sürümü bu oturumda uygular.')], null, event.detail === 0));
  initComponents();
  return { open, close, inspect, create, announce };
}
export function renderState(state, retry, firstStep) {
  const panel = $('#state-content');
  const special = ['empty', 'loading', 'error'].includes(state);
  $('#screen-content').hidden = special;
  panel.hidden = !special;
  $('#conflict').hidden = state !== 'conflict';
  panel.replaceChildren();
  panel.setAttribute('aria-busy', String(state === 'loading'));
  if (!special) return;
  const title = el('h2', '', state === 'empty' ? 'Yeni bir başlangıca yer var' : state === 'loading' ? 'Çalışma alanı yükleniyor' : 'Çalışma alanı yüklenemedi');
  title.id = 'state-title';
  panel.append(title);
  if (state === 'loading') {
    const skeletons = el('div', 'stack skeletons');
    skeletons.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < 3; index++) skeletons.append(el('div', 'skeleton'));
    panel.append(skeletons, el('p', 'muted', 'Notlar ve kartlar hazırlanıyor.'));
  } else if (state === 'error') panel.append(el('p', 'muted', 'Dosyalar okunamadı. Yeniden yüklemeyi deneyin.'), button('Yeniden dene', retry));
  else panel.append(el('p', 'muted', 'İlk kartınızı ekleyerek bir sonraki adımı belirleyin.'), button('İlk kartı ekle', firstStep, 'button button--primary'));
}
