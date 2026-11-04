import { lessMotion, tokenTime } from '../_shared/components.js';
import { $, el, button, lockMessage, loadData, setupUI, renderState } from '../_shared/app-ui.js';
import { searchKinds } from '../_shared/search-results.js';

let data;
let fixtures;
let page;
let ui;
let state = 'full';
const selected = new Set();
const agents = ['claude', 'codex'];
const copy = {
  empty: ['Çöp boş', 'Silinen notlar ve kartlar burada durur; buradan hiçbir şey kalıcı olarak silinmez.'],
  loading: ['Çöp yükleniyor', 'Silinen notlar ve kartlar okunuyor.'],
  error: ['Çöp okunamadı', '.cairn/trash klasörü açılamadı. Klasör yerinde mi bak, sonra yeniden dene.'],
};
const isLocked = (item) => state === 'locked' && item.id === 'trash-2';
const easing = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function when(iso) {
  const date = new Date(iso);
  const now = new Date(page.now);
  const time = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(date).replace(':', '.');
  const days = Math.round((new Date(now.toDateString()) - new Date(date.toDateString())) / 86400000);
  if (days === 0) return `Bugün ${time}`;
  if (days === 1) return `Dün ${time}`;
  return new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long' }).format(date);
}
function who(id) {
  const person = data.people.find((item) => item.id === id);
  const wrapper = el('span', 'trash-who');
  if (person) {
    const avatar = el('span', 'avatar trash-avatar', person.initials);
    avatar.setAttribute('aria-hidden', 'true');
    wrapper.append(avatar, el('span', '', person.name));
  } else {
    const badge = el('span', 'trash-agent', id);
    wrapper.append(badge, el('span', 'muted type-label', 'ajan'));
  }
  return wrapper;
}
function titleFor(item, index) {
  return state === 'long' ? `${item.title} — ${index % 2 ? data.longText.english : data.longText.title}` : item.title;
}
function projectName(item) {
  return state === 'long' ? data.longText.projectName : data.projects.find((project) => project.id === item.projectId)?.name || 'Projesiz';
}
function updateSelection() {
  const items = page.trash.filter((item) => !isLocked(item));
  [...selected].forEach((id) => { if (!items.some((item) => item.id === id)) selected.delete(id); });
  const all = $('#trash-all');
  all.checked = items.length > 0 && selected.size === items.length;
  all.indeterminate = selected.size > 0 && selected.size < items.length;
  all.disabled = !items.length;
  $('#trash-selected').textContent = selected.size ? `${selected.size} seçili` : '';
  const restore = $('#restore-selected');
  restore.disabled = !selected.size;
  restore.textContent = selected.size ? `Seçilenleri geri yükle (${selected.size})` : 'Seçilenleri geri yükle';
  document.querySelectorAll('.trash-item').forEach((row) => row.classList.toggle('is-selected', selected.has(row.dataset.id)));
}
function row(item, index) {
  const node = el('div', 'trash-row trash-item');
  node.setAttribute('role', 'row');
  node.dataset.id = item.id;
  const check = el('span', 'trash-cell trash-cell--check');
  check.setAttribute('role', 'cell');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = selected.has(item.id);
  box.disabled = isLocked(item);
  box.setAttribute('aria-label', `${titleFor(item, index)}: seç`);
  box.addEventListener('change', () => {
    if (box.checked) selected.add(item.id); else selected.delete(item.id);
    updateSelection();
  });
  check.append(box);
  const name = el('span', 'trash-cell trash-cell--name');
  name.setAttribute('role', 'cell');
  name.append(el('span', `chip trash-kind trash-kind--${item.kind}`, searchKinds[item.kind]), el('span', 'trash-title', titleFor(item, index)));
  const project = el('span', 'trash-cell trash-cell--project');
  project.setAttribute('role', 'cell');
  const tone = data.projects.find((entry) => entry.id === item.projectId)?.tone;
  const dot = el('span', 'trash-dot');
  dot.setAttribute('aria-hidden', 'true');
  if (tone) dot.style.setProperty('--dot', `var(--color-tone-${tone})`);
  project.append(dot, el('span', 'trash-project-name', projectName(item)));
  const date = el('span', 'trash-cell trash-cell--date counter');
  date.setAttribute('role', 'cell');
  const time = el('time', '', when(item.deletedAt));
  time.dateTime = item.deletedAt;
  date.append(el('span', 'trash-mobile-label', 'Silinme: '), time);
  const by = el('span', 'trash-cell trash-cell--by');
  by.setAttribute('role', 'cell');
  by.append(el('span', 'trash-mobile-label', 'Silen: '), who(item.deletedBy));
  const action = el('span', 'trash-cell trash-cell--action');
  action.setAttribute('role', 'cell');
  const restore = button('Geri yükle', () => restoreItems([item.id]), 'button trash-restore');
  restore.setAttribute('aria-label', `${titleFor(item, index)}: geri yükle`);
  restore.disabled = isLocked(item);
  action.append(restore);
  node.append(check, name, project, date, by, action);
  if (isLocked(item)) {
    const message = lockMessage();
    message.lastChild.textContent = 'claude bu kartın panosunda çalışıyor. Kilit kalkana kadar geri yüklenemez.';
    message.id = `${item.id}-lock`;
    message.classList.add('trash-lock');
    restore.setAttribute('aria-describedby', message.id);
    box.setAttribute('aria-describedby', message.id);
    node.append(message);
  }
  return node;
}
function render() {
  const rows = $('#trash-rows');
  rows.replaceChildren(...page.trash.map(row));
  const people = page.trash.filter((item) => !agents.includes(item.deletedBy)).length;
  $('#trash-summary').textContent = page.trash.length ? `${page.trash.length} öğe · ${people} kişi, ${page.trash.length - people} ajan tarafından silindi` : 'Çöp boş';
  $('#trash-toolbar').hidden = !page.trash.length;
  if (!page.trash.length) {
    const empty = el('div', 'trash-row trash-empty');
    empty.setAttribute('role', 'row');
    const cell = el('span', 'muted');
    cell.setAttribute('role', 'cell');
    cell.textContent = 'Çöp boş. Geri yüklenecek bir şey kalmadı.';
    empty.append(cell);
    rows.append(empty);
  }
  updateSelection();
}
function restoreItems(ids) {
  const items = page.trash.filter((item) => ids.includes(item.id) && !isLocked(item));
  if (!items.length) return;
  const rows = items.map((item) => document.querySelector(`.trash-item[data-id="${item.id}"]`)).filter(Boolean);
  const all = [...document.querySelectorAll('.trash-item')];
  const next = all.slice(all.indexOf(rows.at(-1)) + 1).find((node) => !rows.includes(node)) || all.slice(0, all.indexOf(rows[0])).reverse().find((node) => !rows.includes(node));
  const nextId = next?.dataset.id;
  const finish = () => {
    page.trash = page.trash.filter((item) => !items.includes(item));
    items.forEach((item) => selected.delete(item.id));
    render();
    const target = nextId && document.querySelector(`.trash-item[data-id="${nextId}"] .trash-restore:not(:disabled)`);
    (target || $('#main')).focus({ preventScroll: true });
    const message = items.length === 1 ? `“${items[0].title}” geri yüklendi; ${projectName(items[0])} içinde eski yerinde.` : `${items.length} öğe geri yüklendi; her biri eski yerine döndü.`;
    const status = $('#restore-status');
    status.textContent = message;
    status.hidden = false;
    ui.announce(message);
  };
  const less = lessMotion();
  const animations = rows.map((node) => node.animate(less ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(var(--motion-distance-medium))' }], { duration: tokenTime('--motion-duration-quick'), easing: easing('--motion-ease-out'), fill: 'forwards' }));
  Promise.all(animations.map((animation) => animation.finished.catch(() => {}))).then(finish);
}
function setState(value) {
  state = value;
  if (value === 'empty') page.trash = [];
  selected.clear();
  $('#prototype-state').value = value;
  $('#restore-status').hidden = true;
  renderState(value, () => setState('full'), null, copy);
  render();
}
async function start() {
  try {
    const [loaded, response] = await Promise.all([loadData('../_shared/workspace.json'), fetch('data.json')]);
    if (!response.ok) throw new Error('Trash unavailable');
    data = loaded;
    page = await response.json();
    fixtures = structuredClone({ data, page });
    ui = setupUI(data, () => {}, (instant) => ui.create('card', instant));
    const status = el('p', 'restore-status');
    status.id = 'restore-status';
    status.hidden = true;
    $('#trash-toolbar').before(status);
    $('#trash-all').addEventListener('change', (event) => {
      page.trash.filter((item) => !isLocked(item)).forEach((item) => { if (event.target.checked) selected.add(item.id); else selected.delete(item.id); });
      document.querySelectorAll('.trash-item input[type="checkbox"]:not(:disabled)').forEach((box) => { box.checked = event.target.checked; });
      updateSelection();
    });
    $('#restore-selected').addEventListener('click', () => restoreItems([...selected]));
    $('#reload').addEventListener('click', () => {
      page.trash = page.trash.filter((item) => item.id !== 'trash-1');
      state = 'full';
      $('#prototype-state').value = 'full';
      renderState('full', null, null, copy);
      render();
      $('#main').focus();
      ui.announce('Liste yenilendi. “Eski toplantı notu” başka bir oturumda geri yüklenmişti.');
    });
    $('#conflict-diff').addEventListener('click', (event) => ui.open('Dosyadaki fark', [el('p', 'muted', 'eski-toplanti-notu.md · başka bir oturum'), el('p', 'type-code', '+ notes/eski-toplanti-notu.md (geri yüklendi, 17.12)'), el('p', 'type-code', '− .cairn/trash/eski-toplanti-notu.md'), el('p', '', 'Yeniden yükle, listeyi güncel durumla eşitler. Hiçbir dosya silinmez.')], null, event.detail === 0));
    $('#prototype-state').addEventListener('change', (event) => {
      Object.assign(data, structuredClone(fixtures.data));
      page = structuredClone(fixtures.page);
      setState(event.target.value);
    });
    setState('full');
  } catch {
    renderState('error', start, null, copy);
  }
}
start();
