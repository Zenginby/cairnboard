import { lessMotion, tokenTime } from '../_shared/components.js';
import { families, isDark, setTheme, setMode } from '../_shared/theme.js';
import { $, el, button, field, lockMessage, loadData, setupUI, renderState } from '../_shared/app-ui.js';

let data;
let page;
let fixture;
let ui;
let state = 'full';
let sequence = 0;
let saveTimer;
const roles = { todo: 'Yapılacak', doing: 'Sürüyor', done: 'Bitti' };
const root = document.documentElement;
const copy = {
  empty: ['Ayar dosyası yok', 'Bu çalışma alanında henüz config.yml yok. Varsayılanlarla başlayıp istediğini değiştirebilirsin.', 'Varsayılanları oluştur'],
  loading: ['Ayarlar yükleniyor', 'config.yml okunuyor.'],
  error: ['Ayarlar okunamadı', 'config.yml açılamadı ya da bozuk. Dosyayı denetleyip yeniden dene.'],
};
const easing = (name) => getComputedStyle(root).getPropertyValue(name).trim();
const locked = () => state === 'locked';

function saved(message = 'Kaydedildi') {
  const status = $('#save-state');
  status.textContent = 'Kaydediliyor…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { status.textContent = `${message} · config.yml`; }, tokenTime('--motion-duration-slow'));
}
function section(title, description, className = '') {
  const node = el('section', `box panel settings-box ${className}`);
  const heading = el('h2', 'settings-title', title);
  heading.id = `settings-${++sequence}`;
  node.setAttribute('aria-labelledby', heading.id);
  node.append(heading);
  if (description) node.append(el('p', 'settings-description', description));
  return node;
}
function group(legend) {
  const set = el('fieldset', 'settings-group');
  set.append(el('legend', 'settings-legend', legend));
  return set;
}
function segmented(name, choices, current, onChange) {
  const wrap = el('div', 'segmented');
  choices.forEach(([value, label]) => {
    const option = el('label', 'segmented-option');
    const input = el('input');
    input.type = 'radio';
    input.name = name;
    input.value = value;
    input.checked = value === current;
    input.addEventListener('change', () => onChange(value, option));
    option.append(input, el('span', '', label));
    wrap.append(option);
  });
  return wrap;
}
function preview(family) {
  const node = el('span', 'theme-preview');
  node.dataset.theme = family;
  node.dataset.mode = isDark() ? 'dark' : 'light';
  node.setAttribute('aria-hidden', 'true');
  const bar = el('span', 'preview-bar');
  bar.append(el('span', 'preview-logo'), el('span', 'preview-pill'));
  const box = el('span', 'preview-box');
  box.append(el('span', 'preview-line preview-line--title'), el('span', 'preview-line'), el('span', 'preview-chips'));
  box.lastChild.append(el('span', 'preview-chip preview-chip--1'), el('span', 'preview-chip preview-chip--2'), el('span', 'preview-button'));
  node.append(bar, box);
  return node;
}
function appearance() {
  const node = section('Görünüm', 'Değişiklikler hemen uygulanır ve bu tarayıcıda saklanır.', 'settings-box--wide');
  const themes = group('Tema');
  const list = el('div', 'theme-options');
  Object.entries(families).forEach(([value, label]) => {
    const option = el('label', 'theme-option');
    const input = el('input');
    input.type = 'radio';
    input.name = 'settings-theme';
    input.value = value;
    input.checked = root.dataset.theme === value;
    input.addEventListener('change', () => { setTheme(value, option); ui.announce(`Tema: ${label}.`); });
    option.append(input, preview(value), el('span', 'theme-name', label));
    list.append(option);
  });
  themes.append(list);
  const modes = group('Görünüm');
  modes.append(segmented('settings-mode', [['system', 'Sistem'], ['light', 'Açık'], ['dark', 'Koyu']], root.dataset.mode || 'system', (value, origin) => { setMode(value, origin); ui.announce(`Görünüm: ${{ system: 'Sistem', light: 'Açık', dark: 'Koyu' }[value]}.`); }));
  const motion = group('Hareket');
  const toggle = el('label', 'switch');
  const input = el('input');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.dataset.motionToggle = ''; // theme.js applies it with setLessMotion and keeps the top bar menu in step.
  input.checked = root.dataset.motion === 'less';
  toggle.append(input, el('span', 'switch-track'), el('span', '', 'Hareket: az'));
  motion.append(toggle, el('p', 'settings-hint', 'Kayma ve büyüme yerine yalnız kısa geçişler. Sistemde “hareketi azalt” açıksa zaten böyle davranır.'));
  const language = group('Dil');
  language.append(segmented('settings-language', [['tr', 'Türkçe'], ['en', 'English']], page.language, (value) => {
    page.language = value;
    saved();
    ui.announce(value === 'en' ? 'Dil: English. Arayüz bir sonraki açılışta İngilizce olur.' : 'Dil: Türkçe.');
  }), el('p', 'settings-hint', 'Notların ve kartların dili değişmez; yalnız arayüz.'));
  const grid = el('div', 'appearance-grid');
  grid.append(themes, modes, motion, language);
  node.append(grid);
  return node;
}
function dataFolder() {
  const node = section('Veri klasörü', 'Notlar, kartlar ve günlük bu klasörde düz Markdown olarak durur.');
  const { wrapper, control } = field('Klasör yolu');
  control.value = state === 'long' ? `${page.dataPath}/${'cok-uzun-bir-alt-klasor-adi/'.repeat(4)}calisma-alani` : page.dataPath;
  control.readOnly = true;
  control.classList.add('path-input');
  const hint = el('p', 'settings-hint');
  hint.id = 'path-hint';
  hint.append('Değiştirmek için ', el('code', '', 'cairn init'), ' komutunu yeni klasörde çalıştır.');
  control.setAttribute('aria-describedby', hint.id);
  node.append(wrapper, hint);
  return node;
}
function claim() {
  const node = section('Sahiplenme süresi', 'Bir ajan ya da kişi kartı üstlendiğinde kart bu süre boyunca kilitli kalır; ses gelmezse kilit kendiliğinden kalkar.');
  const { wrapper, control } = field('Süre (dakika)');
  control.type = 'number';
  control.min = '5';
  control.max = '240';
  control.step = '5';
  control.inputMode = 'numeric';
  control.value = String(page.claimMinutes);
  control.classList.add('minutes-input');
  const error = el('p', 'field-error type-label');
  error.id = 'claim-error';
  error.hidden = true;
  control.addEventListener('change', () => {
    const value = Number(control.value);
    const valid = Number.isInteger(value) && value >= 5 && value <= 240;
    error.hidden = valid;
    error.textContent = valid ? '' : '5 ile 240 dakika arasında bir sayı yaz.';
    control.setAttribute('aria-invalid', String(!valid));
    if (valid) { control.removeAttribute('aria-describedby'); page.claimMinutes = value; saved(); ui.announce(`Sahiplenme süresi ${value} dakika.`); } else control.setAttribute('aria-describedby', error.id);
  });
  wrapper.append(error);
  node.append(wrapper);
  return node;
}
function agents() {
  const node = section('Ajanlar', 'Bu klasörde bulunan ajan becerileri. Yalnız okunur; yüklemek ya da güncellemek için komut satırını kullan.');
  const list = el('ul', 'agent-list');
  page.agents.forEach((agent) => {
    const item = el('li', 'agent-row');
    const copyNode = el('div', 'agent-copy');
    const name = el('p', 'agent-name');
    name.append(el('span', 'agent-badge', agent.name), document.createTextNode(` · ${agent.skill} becerisi`));
    copyNode.append(name, el('p', 'agent-path', `${agent.path} · sürüm ${agent.version}`));
    const status = agent.status === 'current' ? el('span', 'chip chip--done', 'Güncel') : el('span', 'chip chip--warning', 'Eski sürüm');
    item.append(copyNode, status);
    list.append(item);
  });
  const hint = el('p', 'settings-hint');
  hint.append('Güncellemek için ', el('code', '', 'cairn agents install'), '.');
  node.append(list, hint);
  return node;
}
// Board columns: rename, role, reorder (up and down buttons), add, remove with confirmation.
function columnRow(column, index, total) {
  const item = el('li', 'column-row');
  item.dataset.id = column.id;
  const number = el('span', 'column-number counter', String(index + 1));
  number.setAttribute('aria-hidden', 'true');
  const name = el('input', 'input column-name');
  name.value = column.label;
  name.setAttribute('aria-label', `${index + 1}. sütunun adı`);
  name.maxLength = 40;
  name.disabled = locked();
  name.addEventListener('change', () => {
    const value = name.value.trim();
    if (!value || page.columns.some((other) => other !== column && other.label.toLocaleLowerCase('tr') === value.toLocaleLowerCase('tr'))) {
      name.setAttribute('aria-invalid', 'true');
      ui.announce(value ? 'Bu adda bir sütun zaten var.' : 'Sütun adı boş olamaz.');
      name.value = column.label;
      requestAnimationFrame(() => name.removeAttribute('aria-invalid'));
      return;
    }
    column.label = value;
    saved();
    ui.announce(`Sütun adı: ${value}.`);
  });
  const role = el('select', 'column-role');
  role.setAttribute('aria-label', `${column.label}: rol`);
  Object.entries(roles).forEach(([value, label]) => {
    const option = el('option', '', label);
    option.value = value;
    role.append(option);
  });
  role.value = column.role;
  role.disabled = locked();
  role.addEventListener('change', () => { column.role = role.value; saved(); ui.announce(`${column.label} rolü: ${roles[role.value]}.`); });
  const actions = el('div', 'column-actions');
  const up = button('↑', () => moveColumn(column, -1, 'up'), 'icon-button');
  up.setAttribute('aria-label', `${column.label}: yukarı taşı`);
  up.dataset.dir = 'up';
  up.disabled = locked() || index === 0;
  const down = button('↓', () => moveColumn(column, 1, 'down'), 'icon-button');
  down.setAttribute('aria-label', `${column.label}: aşağı taşı`);
  down.dataset.dir = 'down';
  down.disabled = locked() || index === total - 1;
  const remove = button('Kaldır', (event) => removeColumn(column, event.detail === 0), 'button button--quiet column-remove');
  remove.setAttribute('aria-label', `${column.label}: kaldır`);
  remove.disabled = locked() || total === 1;
  actions.append(up, down, remove);
  item.append(number, name, role, actions);
  return item;
}
function renderColumns() {
  const list = $('#column-list');
  list.replaceChildren(...page.columns.map((column, index) => columnRow(column, index, page.columns.length)));
  const count = (role) => page.columns.filter((column) => column.role === role).length;
  const warning = $('#column-warning');
  const missing = ['todo', 'done'].filter((role) => !count(role));
  warning.hidden = !missing.length;
  warning.textContent = missing.length ? `En az bir “${missing.map((role) => roles[role]).join('” ve bir “')}” sütunu olmalı; yoksa kartlar bitmiş sayılamaz.` : '';
}
function flip(mutate) {
  const rows = [...document.querySelectorAll('.column-row')];
  const first = new Map(rows.map((row) => [row.dataset.id, row.getBoundingClientRect().top]));
  mutate();
  if (lessMotion()) return;
  document.querySelectorAll('.column-row').forEach((row) => {
    const before = first.get(row.dataset.id);
    if (before === undefined) return;
    const delta = before - row.getBoundingClientRect().top;
    if (delta) row.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { duration: tokenTime('--motion-duration-fast'), easing: easing('--motion-ease-settle') });
  });
}
function moveColumn(column, offset, direction) {
  const from = page.columns.indexOf(column);
  const to = from + offset;
  if (to < 0 || to >= page.columns.length) return;
  flip(() => {
    page.columns.splice(from, 1);
    page.columns.splice(to, 0, column);
    renderColumns();
  });
  const row = document.querySelector(`.column-row[data-id="${column.id}"]`);
  (row.querySelector(`[data-dir="${direction}"]:not(:disabled)`) || row.querySelector('[data-dir]:not(:disabled)'))?.focus();
  saved();
  ui.announce(`${column.label} ${to + 1}. sıraya taşındı.`);
}
function removeColumn(column, instant) {
  const index = page.columns.indexOf(column);
  const target = page.columns[index === 0 ? 1 : index - 1];
  const cards = data.cards.filter((card) => card.column === column.id).length;
  const select = field('Kartları şuraya taşı', 'select');
  page.columns.filter((other) => other !== column).forEach((other) => {
    const option = el('option', '', other.label);
    option.value = other.id;
    select.control.append(option);
  });
  select.control.value = target.id;
  const body = [el('p', '', cards ? `“${column.label}” sütununda ${cards} kart var. Kartlar silinmez, seçtiğin sütuna taşınır.` : `“${column.label}” sütunu boş. Kaldırınca panodan çıkar.`)];
  if (cards) body.push(select.wrapper);
  ui.open('Sütunu kaldır', body, () => {
    const destination = page.columns.find((other) => other.id === select.control.value) || target;
    data.cards.forEach((card) => { if (card.column === column.id) card.column = destination.id; });
    const row = document.querySelector(`.column-row[data-id="${column.id}"]`);
    const commit = () => {
      flip(() => { page.columns.splice(page.columns.indexOf(column), 1); renderColumns(); });
      const next = document.querySelector(`.column-row[data-id="${page.columns[Math.min(index, page.columns.length - 1)].id}"] .column-name`);
      next?.focus();
      saved();
      ui.announce(cards ? `${column.label} kaldırıldı; ${cards} kart ${destination.label} sütununa taşındı.` : `${column.label} kaldırıldı.`);
    };
    const fade = row.animate([{ opacity: 1 }, { opacity: 0 }], { duration: tokenTime('--motion-duration-quick'), easing: easing('--motion-ease-out'), fill: 'forwards' });
    fade.finished.catch(() => {}).then(commit);
  }, instant, 'Kaldır');
  $('#editor-save').classList.add('button--danger');
  $('#editor-save').classList.remove('button--primary');
  $('#editor').addEventListener('close', () => { $('#editor-save').classList.add('button--primary'); $('#editor-save').classList.remove('button--danger'); }, { once: true });
}
function addColumn() {
  const id = `column-${crypto.randomUUID().slice(0, 6)}`;
  let label = 'Yeni sütun';
  for (let index = 2; page.columns.some((column) => column.label === label); index++) label = `Yeni sütun ${index}`;
  const doneIndex = page.columns.findIndex((column) => column.role === 'done');
  const column = { id, label, role: 'doing' };
  page.columns.splice(doneIndex === -1 ? page.columns.length : doneIndex, 0, column);
  flip(renderColumns);
  const row = document.querySelector(`.column-row[data-id="${id}"]`);
  row.animate(lessMotion() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(var(--motion-distance-base))' }, { opacity: 1, transform: 'none' }], { duration: tokenTime('--motion-duration-fast'), easing: easing('--motion-ease-spring') });
  const input = row.querySelector('.column-name');
  input.focus();
  input.select();
  saved();
  ui.announce(`${label} eklendi. Adını yazabilirsin.`);
}
function boardColumns() {
  const node = section('Pano sütunları', 'Sıra panodaki soldan sağa sıradır. Rol, kartın bitmiş ya da sürüyor sayılmasını belirler.', 'settings-box--wide');
  if (locked()) {
    const message = lockMessage();
    message.lastChild.textContent = 'claude panoda bir kartı taşıyor. Kilit kalkana kadar sütunlar değiştirilemez.';
    message.id = 'columns-lock';
    node.append(message);
  }
  const head = el('div', 'column-head type-label');
  head.setAttribute('aria-hidden', 'true');
  head.append(el('span', '', '#'), el('span', '', 'Ad'), el('span', '', 'Rol'), el('span', '', ''));
  const list = el('ol', 'column-list');
  list.id = 'column-list';
  list.setAttribute('aria-label', 'Pano sütunları');
  if (locked()) list.setAttribute('aria-describedby', 'columns-lock');
  const warning = el('p', 'chip chip--warning column-warning');
  warning.id = 'column-warning';
  warning.hidden = true;
  const add = button('Sütun ekle', addColumn, 'button column-add');
  add.disabled = locked();
  node.append(head, list, warning, add);
  return node;
}
function render() {
  sequence = 0;
  $('#settings').replaceChildren(appearance(), dataFolder(), claim(), boardColumns(), agents());
  renderColumns();
  initSwitch();
}
function initSwitch() {
  const input = document.querySelector('.switch input');
  input?.addEventListener('change', () => ui.announce(input.checked ? 'Hareket: az açık.' : 'Hareket: az kapalı.'));
}
function syncAppearance() {
  document.querySelectorAll('input[name="settings-theme"]').forEach((input) => { input.checked = input.value === root.dataset.theme; });
  document.querySelectorAll('input[name="settings-mode"]').forEach((input) => { input.checked = input.value === (root.dataset.mode || 'system'); });
  document.querySelectorAll('.theme-preview').forEach((node) => { node.dataset.mode = isDark() ? 'dark' : 'light'; });
}
function setState(value) {
  state = value;
  $('#prototype-state').value = value;
  renderState(value, () => setState('full'), () => { setState('full'); $('#save-state').textContent = 'Varsayılanlar oluşturuldu · config.yml'; }, copy);
  if (!['empty', 'loading', 'error'].includes(value)) render();
  $('#save-state').hidden = ['empty', 'loading', 'error'].includes(value);
  $('#save-state').textContent = 'Tüm değişiklikler kaydedildi';
}
root.addEventListener('themechange', syncAppearance);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncAppearance);
async function start() {
  try {
    const [loaded, response] = await Promise.all([loadData('../_shared/workspace.json'), fetch('data.json')]);
    if (!response.ok) throw new Error('Settings unavailable');
    data = loaded;
    page = await response.json();
    fixture = structuredClone(page);
    ui = setupUI(data, () => {}, (instant) => ui.create('card', instant));
    $('#reload').addEventListener('click', () => {
      page = structuredClone(fixture);
      page.columns.splice(3, 0, { id: 'test', label: 'Test', role: 'doing' });
      page.claimMinutes = 45;
      setState('full');
      $('#main').focus();
      ui.announce('Güncel ayarlar yüklendi: Test sütunu eklendi, sahiplenme süresi 45 dakika.');
    });
    $('#conflict-diff').addEventListener('click', (event) => ui.open('Dosyadaki fark', [el('p', 'muted', 'config.yml · dışarıdaki değişiklik'), el('p', 'type-code', '+ - { id: test, label: Test, role: doing }'), el('p', 'type-code', '− claimMinutes: 30'), el('p', 'type-code', '+ claimMinutes: 45'), el('p', '', 'Yeniden yükle, dışarıdaki sürümü bu oturumda uygular.')], null, event.detail === 0));
    $('#prototype-state').addEventListener('change', (event) => { page = structuredClone(fixture); setState(event.target.value); });
    setState('full');
  } catch {
    renderState('error', start, null, copy);
  }
}
start();
