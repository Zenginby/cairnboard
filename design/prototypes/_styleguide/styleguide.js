import '../_shared/theme.js';
import { initComponents, lessMotion, moveCard, showDialog } from '../_shared/components.js';

const $ = (selector) => document.querySelector(selector);
const live = $('#announcements');
const statuses = { planned: 'Planlandı', doing: 'Sürüyor', done: 'Bitti', urgent: 'Acil', important: 'Önemli', warning: 'Uyarı', danger: 'Tehlike' };
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function labelledSample(label, sample) {
  const wrapper = element('div', 'state-sample');
  wrapper.append(element('span', 'type-label muted', label), sample);
  return wrapper;
}

const colorNames = [...getComputedStyle(document.documentElement)].filter((name) => name.startsWith('--color-'));
function renderColors() {
  const groups = { 'Yüzeyler': [], 'Metin': [], 'Vurgu': [], 'Proje tonları': [], 'Durumlar': [] };
  const surfaces = ['canvas', 'surface', 'surface-inset', 'surface-inset-2', 'line', 'line-strong', 'material', 'pill-bg', 'pill-indicator'];
  colorNames.sort().forEach((name) => {
    const key = name.slice('--color-'.length);
    const group = surfaces.includes(key) ? 'Yüzeyler' : key.startsWith('text') ? 'Metin' : key.startsWith('tone-') ? 'Proje tonları' : Object.keys(statuses).some((status) => key === status || key === `${status}-bg`) ? 'Durumlar' : 'Vurgu';
    groups[group].push(name);
  });
  const computed = getComputedStyle(document.documentElement);
  $('#color-groups').replaceChildren(...Object.entries(groups).map(([title, names]) => {
    const group = element('section', 'stack');
    group.append(element('h3', '', title));
    const swatches = element('div', 'swatches');
    names.forEach((name) => {
      const figure = element('figure', 'swatch');
      const color = element('div', 'swatch-color');
      color.setAttribute('aria-hidden', 'true');
      color.style.setProperty('--swatch-color', `var(${name})`);
      const caption = element('figcaption');
      caption.append(element('code', '', name), element('code', 'token-value', computed.getPropertyValue(name).trim()));
      figure.append(color, caption);
      swatches.append(figure);
    });
    group.append(swatches);
    return group;
  }));
}
renderColors();
document.documentElement.addEventListener('themechange', renderColors);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderColors);

const computed = getComputedStyle(document.documentElement);
['display', 'title', 'body', 'label', 'code'].forEach((type) => {
  const sample = element('div', 'stack');
  sample.append(element('code', 'muted', `--font-${type}-* · ${computed.getPropertyValue(`--font-${type}-size`).trim()} / ${computed.getPropertyValue(`--font-${type}-line-height`).trim()}`), element('p', `type-${type}`, 'Bir fikre yer aç. İı Şş Ğğ — 0123456789'));
  $('#type-scale').append(sample);
});
[
  ['Aralıklar', 'space', ['xs', 'sm', 'md', 'lg', 'xl']],
  ['Köşeler', 'radius', ['sm', 'md', 'lg', 'full']],
  ['Gölgeler', 'shadow', ['box', 'box-raised']],
].forEach(([title, prefix, names]) => {
  const group = element('section', 'box stack');
  group.append(element('h3', '', title));
  names.forEach((name) => {
    const token = `--${prefix}-${name}`;
    const row = element('div', 'scale-sample');
    const sample = element('div', `${prefix === 'space' ? 'spacing' : prefix}-sample`);
    sample.setAttribute('aria-hidden', 'true');
    sample.style.setProperty(`--sample-${prefix === 'space' ? 'size' : prefix}`, `var(${token})`);
    const label = element('div', 'stack');
    label.append(element('code', '', token));
    const value = element('code', 'token-value');
    const update = () => { value.textContent = getComputedStyle(document.documentElement).getPropertyValue(token).trim(); };
    update();
    document.documentElement.addEventListener('themechange', update);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', update);
    label.append(value);
    row.append(sample, label);
    group.append(row);
  });
  $('#foundation-scales').append(group);
});

[['Normal', ''], ['Büyük kutu', 'box--hero'], ['Üzerinde', 'is-hover'], ['Odak', 'is-focus']].forEach(([label, state]) => {
  const box = element('div', `box stack ${state}`);
  box.append(element('h3', '', label), element('p', 'muted', 'İçeriğe yer açan sakin bir yüzey.'), element('div', 'inset', 'İç alan'));
  $('#box-states').append(box);
});
[
  ['Birincil', 'primary'], ['İkincil', 'secondary'], ['Sessiz', 'quiet'], ['Tehlike', 'danger'],
].forEach(([label, variant]) => {
  const group = element('div', 'stack');
  group.append(element('h3', 'type-label', label));
  const row = element('div', 'state-row');
  [['Normal', ''], ['Üzerinde', 'is-hover'], ['Odak', 'is-focus'], ['Basılı', 'is-pressed'], ['Devre dışı', 'disabled'], ['Yükleniyor', 'loading']].forEach(([stateLabel, state]) => {
    const button = element('button', `button button--${variant} ${state.startsWith('is-') ? state : ''}`, state === 'loading' ? 'Kaydediliyor' : 'Kaydet');
    button.type = 'button';
    button.disabled = state === 'disabled' || state === 'loading';
    if (state === 'loading') {
      button.setAttribute('aria-busy', 'true');
      const spinner = element('span', 'spinner');
      spinner.setAttribute('aria-hidden', 'true');
      button.prepend(spinner);
    }
    button.addEventListener('click', () => { live.textContent = `${label}: örnek düğmeye basıldı.`; });
    row.append(labelledSample(stateLabel, button));
  });
  group.append(row);
  $('#button-states').append(group);
});
$('#chips').append(element('span', 'badge', '8 proje'));
for (let tone = 1; tone <= 8; tone++) $('#chips').append(element('span', `chip chip--tone-${tone}`, `Ton ${tone}`));
Object.entries(statuses).forEach(([status, label]) => $('#chips').append(element('span', `chip chip--${status}`, label)));

['Normal', 'Üzerinde', 'Odak', 'Etkin', 'Devre dışı', 'Yükleniyor', 'Hata', 'Boş'].forEach((state, index) => {
  ['input', 'textarea'].forEach((tag) => {
    const label = element('label', 'field');
    const id = `${tag}-state-${index}`;
    label.htmlFor = id;
    label.append(element('span', 'type-label', `${tag === 'input' ? 'Başlık' : 'Açıklama'} · ${state}`));
    const input = element(tag, tag === 'input' ? 'input' : 'textarea');
    input.id = id;
    input.value = state === 'Boş' ? '' : tag === 'input' ? 'İlk taslak' : 'Bir sonraki adımı birlikte seçelim.';
    input.placeholder = tag === 'input' ? 'Proje adı' : 'Kısa bir not yazın';
    if (state === 'Odak' || state === 'Etkin') input.classList.add('is-focus');
    if (state === 'Üzerinde') input.classList.add('is-hover');
    input.disabled = state === 'Devre dışı';
    if (state === 'Yükleniyor') { input.readOnly = true; input.setAttribute('aria-busy', 'true'); }
    label.append(input);
    if (state === 'Hata') {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', `${id}-error`);
      const error = element('span', 'field-error type-label', 'Bu alanı yeniden kontrol edin.');
      error.id = `${id}-error`;
      label.append(error);
    }
    $('#input-states').append(label);
  });
});

function createBoard(container, data, mini = false) {
  const project = data.projects[0];
  const columns = mini ? ['planned', 'done'] : ['planned', 'doing', 'done'];
  columns.forEach((status) => {
    const column = element('section', 'kanban-column');
    column.append(element('h3', 'type-label', statuses[status]));
    const list = element('ul', 'kanban-list');
    list.dataset.status = status;
    list.dataset.label = statuses[status];
    column.append(list);
    container.append(column);
  });
  (mini ? data.cards.slice(0, 1) : data.cards).forEach((record, index) => {
    const recordProject = mini ? project : data.projects.find((item) => item.id === record.projectId);
    const person = data.people.find((item) => item.id === record.assigneeId);
    const card = element('li', `kanban-card${!mini && index === 1 ? ' is-hover' : !mini && index === 2 ? ' is-focus' : ''}`);
    card.append(element('h3', '', mini ? 'İlk taslağı incele' : record.title));
    card.append(element('span', `chip chip--tone-${recordProject.tone}`, recordProject.name));
    const status = element('span', `chip chip--${record.status}`, statuses[record.status]);
    status.dataset.cardStatus = '';
    card.append(status);
    const footer = element('div', 'card-footer');
    const avatar = element('span', 'avatar', person.initials);
    avatar.setAttribute('aria-label', person.name);
    const dropdown = element('div', 'dropdown');
    const trigger = element('button', 'button button--quiet', 'Taşı…');
    trigger.type = 'button';
    trigger.dataset.moveTrigger = '';
    trigger.setAttribute('aria-label', `${mini ? 'İlk taslağı incele' : record.title}: taşı`);
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    const menu = element('div', 'menu');
    menu.id = `${container.id}-move-${index}`;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Hedef sütun');
    trigger.setAttribute('aria-controls', menu.id);
    menu.inert = true;
    columns.forEach((destination) => {
      const button = element('button', '', statuses[destination]);
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.tabIndex = -1;
      button.addEventListener('click', () => moveCard(card, container.querySelector(`[data-status="${destination}"]`), live));
      menu.append(button);
    });
    dropdown.append(trigger, menu);
    footer.append(avatar, dropdown);
    card.append(footer);
    container.querySelector(`[data-status="${record.status}"]`).append(card);
  });
}

function replayStagger() {
  const list = $('#stagger-list');
  list.classList.add('is-reset');
  void list.offsetWidth;
  requestAnimationFrame(() => list.classList.remove('is-reset'));
}
const motionNames = [...computed].filter((name) => name.startsWith('--motion-')).sort();
function renderMotionTokens() {
  const values = getComputedStyle(document.documentElement);
  $('#motion-tokens').replaceChildren(...motionNames.flatMap((name) => [
    element('dt', 'type-code', name), element('dd', 'type-code muted', values.getPropertyValue(name).trim()),
  ]));
}
renderMotionTokens();
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', renderMotionTokens);
const maxDelayed = Number(computed.getPropertyValue('--motion-stagger-max-items'));
for (let index = 0; index < 8; index++) {
  const item = element('li', 'stagger-item', `${index + 1}. Küçük bir adım`);
  // Only the first token-limited items receive a delay; remaining items appear immediately.
  item.style.setProperty('--item-delay', `calc(var(--motion-duration-stagger) * ${index < maxDelayed ? index : 0})`);
  $('#stagger-list').append(item);
}
$('#toast-in').addEventListener('click', () => { $('#demo-toast').classList.add('is-open'); live.textContent = 'Değişiklikler kaydedildi.'; });
$('#toast-out').addEventListener('click', () => $('#demo-toast').classList.remove('is-open'));
$('#modal-open').addEventListener('click', (event) => showDialog($('#demo-modal'), event.detail === 0));
$('#stagger-replay').addEventListener('click', replayStagger);
$('#slide-tab').addEventListener('click', () => {
  const tabs = [...document.querySelectorAll('[role="tab"]:not(:disabled)')];
  const index = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
  tabs[(index + 1) % tabs.length].click();
});
$('#drop-card').addEventListener('click', () => {
  const card = $('#sample-board .kanban-card');
  if (!card) return;
  const lists = [...document.querySelectorAll('#sample-board .kanban-list')];
  moveCard(card, lists[(lists.indexOf(card.parentElement) + 1) % lists.length], live);
});
$('#add-note').addEventListener('click', () => {
  $('#empty-example h3').textContent = 'İlk not';
  $('#empty-example p').textContent = 'Yeni bir düşünce için yer hazır.';
  live.textContent = 'İlk not eklendi.';
});
$('#retry').addEventListener('click', () => { $('#demo-toast').classList.add('is-open'); live.textContent = 'Örnek not kaydedildi.'; });
document.querySelectorAll('[data-menu-action]').forEach((button) => button.addEventListener('click', () => { live.textContent = `${button.textContent}: örnek işlem tamamlandı.`; }));

try {
  const response = await fetch('../_shared/sample.json');
  if (!response.ok) throw new Error('Sample data unavailable');
  const data = await response.json();
  ['bento', 'bento-dark', 'paper', 'graphite'].forEach((theme) => {
    const preview = element('section', 'theme-preview stack');
    preview.dataset.theme = theme;
    preview.append(element('h2', 'type-title', { bento: 'Bento', 'bento-dark': 'Bento Dark', paper: 'Paper', graphite: 'Graphite' }[theme]));
    const board = element('div', 'mini-board');
    board.id = `mini-${theme}`;
    board.dataset.board = '';
    createBoard(board, data, true);
    preview.append(board);
    $('#theme-strip').append(preview);
  });
  createBoard($('#sample-board'), data);
  $('#panel-notes').textContent = data.notes[0].body;
  $('#panel-journal').textContent = data.journal[0].body;
  [...data.cards[0].criteria, { text: 'Sonraki adım henüz açılmadı', done: false, disabled: true }].forEach((criterion) => {
    const item = element('li');
    const label = element('label');
    const input = element('input');
    input.type = 'checkbox';
    input.checked = criterion.done;
    input.disabled = Boolean(criterion.disabled);
    label.append(input, element('span', '', criterion.text));
    item.append(label);
    $('#criteria').append(item);
  });
} catch {
  $('#load-error').hidden = false;
}
initComponents();
replayStagger();
// CSS also handles a preference change in the middle of a transition.
document.documentElement.addEventListener('motionchange', () => {
  if (lessMotion()) document.querySelectorAll('.kanban-card').forEach((card) => { card.style.transform = ''; });
});
