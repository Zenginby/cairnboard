import { lessMotion, tokenTime } from '../_shared/components.js';
import { $, el, button, priorityChip, projectChip, metadata, lockMessage, field, loadData, setupUI, renderState } from './ui.js';

let data;
let fixtures;
let ui;
let state = 'full';
let projectFilter = new URLSearchParams(location.search).get('project') || 'all';
let priorityFilter = 'all';
let activeColumn = 'todo';
let cards = [];
let drag = null;
let menuCard = null;
let lastMoved = null;
const mobile = matchMedia('(max-width: 46rem)');
const visible = new Set();
const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
  if (entry.isIntersecting) visible.add(entry.target);
  else visible.delete(entry.target);
}));
const menu = el('div', 'menu move-menu');
menu.id = 'move-menu';
menu.setAttribute('role', 'menu');
menu.setAttribute('aria-label', 'Kartı taşı');
menu.inert = true;
document.body.append(menu);
const marker = el('div', 'drop-marker');
marker.hidden = true;
marker.setAttribute('aria-hidden', 'true');
document.body.append(marker);
const lists = () => [...document.querySelectorAll('.kanban-list')];
const recordFor = (node) => cards.find((record) => record.id === node.dataset.id);
const isLocked = (record) => state === 'locked' && record.id === 'card-2';
const passes = (record) => (projectFilter === 'all' || record.projectId === projectFilter) && (priorityFilter === 'all' || record.priority === priorityFilter);
function titleFor(record, index = 0) {
  return state === 'long' ? `${record.title} — ${index % 2 ? data.longText.english : data.longText.title}` : record.title;
}
function projectFor(record) {
  const project = data.projects.find((item) => item.id === record.projectId);
  return state === 'long' ? { ...project, name: data.longText.projectName } : project;
}
function closeMenu(restore = false) {
  menu.classList.remove('is-open');
  menu.inert = true;
  menuCard?.querySelector('[data-move]').setAttribute('aria-expanded', 'false');
  if (restore) menuCard?.focus();
  menuCard = null;
}
function openMenu(card, instant = false) {
  const record = recordFor(card);
  if (isLocked(record)) { ui.announce('claude üzerinde çalışıyor. Kilit kalkana kadar taşınamaz.'); return; }
  closeMenu();
  menuCard = card;
  menu.replaceChildren();
  const current = card.parentElement;
  const add = (label, list, ref) => {
    const item = button(label, () => { closeMenu(); commitMove(card, list, ref); }, '');
    item.setAttribute('role', 'menuitem');
    item.tabIndex = -1;
    menu.append(item);
  };
  add('Bir sıra yukarı', current, card.previousElementSibling || card);
  add('Bir sıra aşağı', current, card.nextElementSibling?.nextElementSibling || null);
  lists().forEach((list) => {
    add(`${list.dataset.label}, en üste`, list, list.firstElementChild);
    add(`${list.dataset.label}, en alta`, list, null);
  });
  card.querySelector('[data-move]').setAttribute('aria-expanded', 'true');
  menu.classList.toggle('is-instant', instant);
  menu.classList.add('is-open');
  menu.inert = false;
  const rect = card.querySelector('[data-move]').getBoundingClientRect();
  const gutter = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-md'));
  menu.style.left = `${Math.max(gutter, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - gutter))}px`;
  menu.style.top = `${Math.max(gutter, Math.min(rect.bottom, innerHeight - menu.offsetHeight - gutter))}px`;
  menu.querySelector('button').focus();
}
menu.addEventListener('keydown', (event) => {
  const items = [...menu.querySelectorAll('button')];
  const index = items.indexOf(document.activeElement);
  const positions = { ArrowDown: (index + 1) % items.length, ArrowUp: (index - 1 + items.length) % items.length, Home: 0, End: items.length - 1 };
  if (event.key in positions) { event.preventDefault(); items[positions[event.key]].focus(); }
  else if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); }
  else if (event.key === 'Tab') closeMenu(true);
});
document.addEventListener('pointerdown', (event) => {
  if (!menu.contains(event.target) && !event.target.closest('[data-move]')) closeMenu();
});
menu.addEventListener('focusout', (event) => { if (!menu.contains(event.relatedTarget)) closeMenu(); });
function positionIndicator() {
  const tab = $(`#tab-${activeColumn}`);
  if (!tab || !mobile.matches) return;
  const indicator = $('#column-tabs .tab-indicator');
  for (const [name, value] of Object.entries({ width: tab.offsetWidth, height: tab.offsetHeight, x: tab.offsetLeft, y: tab.offsetTop })) indicator.style.setProperty(`--indicator-${name}`, `${value}px`);
}
function selectColumn(id) {
  activeColumn = id;
  document.querySelectorAll('.kanban-column').forEach((column) => {
    column.classList.toggle('is-active', column.dataset.column === id);
    column.setAttribute('role', mobile.matches ? 'tabpanel' : 'region');
    column.setAttribute('aria-labelledby', mobile.matches ? `tab-${column.dataset.column}` : `heading-${column.dataset.column}`);
  });
  document.querySelectorAll('#column-tabs .tab').forEach((tab) => {
    const selected = tab.dataset.column === id;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  positionIndicator();
}
mobile.addEventListener('change', () => selectColumn(activeColumn));
new ResizeObserver(positionIndicator).observe($('#column-tabs'));
$('#column-tabs').addEventListener('keydown', (event) => {
  const tabs = [...document.querySelectorAll('#column-tabs .tab')];
  const index = tabs.indexOf(document.activeElement);
  const positions = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 };
  if (event.key in positions) { event.preventDefault(); const tab = tabs[positions[event.key]]; selectColumn(tab.dataset.column); tab.focus(); }
});
function updateCounts() {
  data.columns.forEach((column) => {
    const count = cards.filter((record) => record.column === column.id && passes(record)).length;
    $(`#count-${column.id}`).textContent = count;
    $(`#tab-${column.id}`).textContent = `${column.label} ${count}`;
    $(`#empty-${column.id}`).hidden = count > 0;
  });
  $('#board-summary').textContent = `${cards.filter(passes).length} kart · ${data.columns.length} sütun`;
  positionIndicator();
}
function makeCard(record, index) {
  const card = el('li', 'kanban-card');
  card.id = record.id;
  card.dataset.id = record.id;
  card.tabIndex = 0;
  const top = el('div', 'card-top');
  const handle = el('span', 'drag-handle', '⠿');
  handle.title = 'Sürüklemek için tutun. Taşımak için Taşı… düğmesini de kullanabilirsiniz.';
  handle.setAttribute('aria-hidden', 'true');
  top.append(projectChip(projectFor(record)), handle);
  const title = button(titleFor(record, index), (event) => ui.inspect({ ...record, title: titleFor(record, index) }, event.detail === 0), 'card-title');
  const footer = el('div', 'row card-footer');
  const move = button('Taşı…', (event) => openMenu(card, event.detail === 0), 'button button--quiet');
  move.dataset.move = '';
  move.setAttribute('aria-haspopup', 'menu');
  move.setAttribute('aria-expanded', 'false');
  move.setAttribute('aria-controls', menu.id);
  move.setAttribute('aria-label', `${record.title}: taşı`);
  move.disabled = isLocked(record);
  footer.append(metadata(record, data), move);
  card.append(top, title, priorityChip(record.priority), footer);
  if (isLocked(record)) {
    const message = lockMessage();
    message.id = `${record.id}-lock`;
    move.setAttribute('aria-describedby', message.id);
    card.setAttribute('aria-describedby', message.id);
    card.append(message);
  }
  observer.observe(card);
  return card;
}
function inlineAdd(column, form, instant = false) {
  form.hidden = false;
  form.querySelector('input').focus();
  selectColumn(column.id);
  if (instant) form.classList.add('is-instant');
}
function buildBoard() {
  closeMenu();
  endDrag(false);
  observer.disconnect();
  visible.clear();
  $('#board').replaceChildren();
  $('#column-tabs').replaceChildren(el('span', 'tab-indicator'));
  $('#column-tabs .tab-indicator').setAttribute('aria-hidden', 'true');
  data.columns.forEach((column) => {
    const tab = button(column.label, () => selectColumn(column.id), 'tab');
    tab.id = `tab-${column.id}`;
    tab.dataset.column = column.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `column-${column.id}`);
    $('#column-tabs').append(tab);
    const section = el('section', 'kanban-column');
    section.id = `column-${column.id}`;
    section.dataset.column = column.id;
    const header = el('div', 'column-header');
    const headingRow = el('div', 'column-heading');
    const heading = el('h2', '', column.label);
    heading.id = `heading-${column.id}`;
    const count = el('span', 'counter type-label');
    count.id = `count-${column.id}`;
    headingRow.append(heading, count);
    const form = el('form', 'inline-add');
    form.hidden = true;
    const title = field('Kart başlığı');
    title.control.required = true;
    title.control.addEventListener('input', () => title.control.setCustomValidity(''));
    const actions = el('div', 'row');
    const save = el('button', 'button button--primary', 'Ekle');
    save.type = 'submit';
    actions.append(save, button('Vazgeç', () => { form.hidden = true; add.focus(); }));
    form.append(title.wrapper, actions);
    const add = button('Kart ekle', (event) => inlineAdd(column, form, event.detail === 0), 'button');
    add.dataset.add = column.id;
    form.addEventListener('keydown', (event) => { if (event.key === 'Escape') { form.hidden = true; add.focus(); } });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = title.control.value.trim();
      if (!value) { title.control.setCustomValidity('Bir başlık yazın.'); title.control.reportValidity(); return; }
      const record = { id: crypto.randomUUID(), title: value, projectId: projectFilter === 'all' ? data.projects[0].id : projectFilter, column: column.id, priority: priorityFilter === 'all' ? 'normal' : priorityFilter, assigneeId: 'ada', criteria: [], comments: 0 };
      data.cards.unshift(record);
      if (cards !== data.cards) cards.unshift(record);
      list.prepend(makeCard(record, 0));
      title.control.value = '';
      form.hidden = true;
      updateCounts();
      document.getElementById(record.id).focus();
      ui.announce(`'${value}' kartı '${column.label}' sütununa eklendi.`);
    });
    header.append(headingRow, add, form);
    const list = el('ul', 'kanban-list');
    list.dataset.column = column.id;
    list.dataset.label = column.label;
    list.setAttribute('aria-label', `${column.label} kartları`);
    cards.filter((record) => record.column === column.id && passes(record)).forEach((record, index) => list.append(makeCard(record, index)));
    const empty = el('p', 'muted type-label column-empty', 'Burada henüz kart yok. Kart ekle ile başlayın veya buraya bir kart taşıyın.');
    empty.id = `empty-${column.id}`;
    section.append(header, list, empty);
    $('#board').append(section);
  });
  selectColumn(activeColumn);
  updateCounts();
}
function buildFilters() {
  const filters = $('#project-filters');
  filters.replaceChildren();
  [{ id: 'all', name: 'Tüm projeler' }, ...data.projects].forEach((project) => {
    const chip = button(state === 'long' && project.id !== 'all' ? data.longText.projectName : project.name, () => {
      projectFilter = project.id;
      buildFilters();
      buildBoard();
      [...filters.children].find((item) => item.dataset.project === project.id)?.focus();
      ui.announce('Proje filtresi uygulandı.');
    }, `button filter-chip${project.tone ? ` chip--tone-${project.tone}` : ''}`);
    chip.dataset.project = project.id;
    chip.setAttribute('aria-pressed', String(projectFilter === project.id));
    filters.append(chip);
  });
}
function visibleRects() {
  return new Map([...visible].filter((card) => card.isConnected).map((card) => [card, card.getBoundingClientRect()]));
}
function commitMove(card, list, ref = null, ghostRect = null) {
  const record = recordFor(card);
  if (isLocked(record)) return;
  if (ref === card) ref = card.nextElementSibling;
  const before = visibleRects();
  if (ghostRect) before.set(card, ghostRect);
  const from = card.parentElement.dataset.label;
  card.getAnimations().forEach((animation) => animation.cancel());
  list.insertBefore(card, ref);
  record.column = list.dataset.column;
  // Keep the backing order in sync so a subsequent filter never undoes a move.
  const index = cards.indexOf(record);
  cards.splice(index, 1);
  const next = card.nextElementSibling ? recordFor(card.nextElementSibling) : null;
  if (next) cards.splice(cards.indexOf(next), 0, record);
  else {
    const last = cards.findLastIndex((item) => item.column === record.column);
    cards.splice(last + 1, 0, record);
  }
  selectColumn(record.column);
  updateCounts();
  card.focus({ preventScroll: true });
  card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  const position = [...list.children].indexOf(card) + 1;
  ui.announce(`'${record.title}' kartı '${from}' sütunundan '${list.dataset.label}' sütununa taşındı, ${position}/${list.children.length}.`);
  const settles = [];
  if (!lessMotion()) {
    const computed = getComputedStyle(document.documentElement);
    for (const [item, previous] of before) {
      const current = item.getBoundingClientRect();
      const bounds = item.closest('.kanban-column').getBoundingClientRect();
      if (current.bottom < bounds.top || current.top > bounds.bottom || current.right < 0 || current.left > innerWidth) continue;
      item.getAnimations().forEach((animation) => animation.cancel());
      const dx = previous.left - current.left;
      const dy = previous.top - current.top;
      if (!dx && !dy) continue;
      const animation = item.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: tokenTime('--motion-duration-fast'), easing: computed.getPropertyValue('--motion-ease-settle').trim() });
      settles.push(animation.finished.catch(() => {}));
    }
  }
  const move = {};
  lastMoved = move;
  Promise.all(settles).then(() => {
    if (lastMoved !== move || !card.isConnected) return;
    card.classList.add('is-highlighted');
    void card.offsetWidth;
    requestAnimationFrame(() => card.classList.remove('is-highlighted'));
  });
}
$('#board').addEventListener('keydown', (event) => {
  if (event.target.closest('input, textarea, select') || event.ctrlKey || event.metaKey || event.altKey) return;
  const card = event.target.closest('.kanban-card');
  if (card && event.key.toLowerCase() === 'm') { event.preventDefault(); openMenu(card, true); }
});
// Pointer dragging uses a touch handle so vertical card-list scrolling remains native.
$('#board').addEventListener('pointerdown', (event) => {
  const card = event.target.closest('.kanban-card');
  if (!card || event.button !== 0 || drag || event.target.closest('button') || isLocked(recordFor(card))) return;
  if (event.pointerType !== 'mouse' && !event.target.closest('.drag-handle')) return;
  closeMenu();
  drag = { card, id: event.pointerId, sx: event.clientX, sy: event.clientY, x: event.clientX, y: event.clientY, started: false, ghost: null, list: null, ref: null, frame: 0 };
  card.setPointerCapture(event.pointerId);
});
$('#board').addEventListener('pointermove', (event) => {
  if (!drag || event.pointerId !== drag.id) return;
  drag.x = event.clientX;
  drag.y = event.clientY;
  if (!drag.started) {
    const threshold = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-xs'));
    if (Math.hypot(drag.x - drag.sx, drag.y - drag.sy) < threshold) return;
    const rect = drag.card.getBoundingClientRect();
    drag.offsetX = drag.sx - rect.left;
    drag.offsetY = drag.sy - rect.top;
    drag.ghost = drag.card.cloneNode(true);
    drag.ghost.removeAttribute('id');
    drag.ghost.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
    drag.ghost.classList.add('drag-ghost');
    drag.ghost.inert = true;
    drag.ghost.setAttribute('aria-hidden', 'true');
    drag.ghost.style.width = `${rect.width}px`;
    document.body.append(drag.ghost);
    drag.card.classList.add('is-dragging');
    drag.started = true;
    drag.frame = requestAnimationFrame(dragFrame);
  }
});
function dragFrame() {
  if (!drag?.started) return;
  const { x, y } = drag;
  // Direct manipulation still follows the pointer when shared reduced-motion CSS removes transforms.
  if (lessMotion()) {
    drag.ghost.style.transform = '';
    drag.ghost.style.left = `${x - drag.offsetX}px`;
    drag.ghost.style.top = `${y - drag.offsetY}px`;
  } else {
    drag.ghost.style.left = '0px';
    drag.ghost.style.top = '0px';
    drag.ghost.style.transform = `translate(${x - drag.offsetX}px, ${y - drag.offsetY}px)`;
  }
  const target = document.elementFromPoint(x, y);
  const list = target?.closest('.kanban-list') || target?.closest('.kanban-column')?.querySelector('.kanban-list');
  const board = $('#board');
  const edge = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-xl'));
  const speed = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-md'));
  const bounds = board.getBoundingClientRect();
  if (!mobile.matches && y > bounds.top && y < bounds.bottom) {
    if (x < bounds.left + edge) board.scrollLeft -= speed;
    else if (x > bounds.right - edge) board.scrollLeft += speed;
  }
  drag.list = list || null;
  marker.hidden = !list;
  if (list) {
    const column = list.closest('.kanban-column');
    const rect = column.getBoundingClientRect();
    if (y < rect.top + edge) column.scrollTop -= speed;
    else if (y > rect.bottom - edge) column.scrollTop += speed;
    // Hit testing and the observer avoid measuring all 300 cards on every frame.
    const candidates = [...visible].filter((card) => card.parentElement === list && card !== drag.card)
      .map((card) => [card, card.getBoundingClientRect()]).sort((a, b) => a[1].top - b[1].top);
    let ref = candidates.find(([, rect]) => y < rect.top + rect.height / 2)?.[0]
      || candidates.at(-1)?.[0].nextElementSibling || null;
    if (ref === drag.card) ref = ref.nextElementSibling;
    drag.ref = ref;
    const listRect = list.getBoundingClientRect();
    const lineY = ref ? ref.getBoundingClientRect().top : list.lastElementChild?.getBoundingClientRect().bottom || listRect.top;
    marker.style.width = `${listRect.width}px`;
    marker.style.transform = `translate(${listRect.left}px, ${Math.max(rect.top, Math.min(lineY, rect.bottom))}px)`;
  }
  drag.frame = requestAnimationFrame(dragFrame);
}
function endDrag(commit) {
  if (!drag) return;
  const current = drag;
  drag = null;
  cancelAnimationFrame(current.frame);
  if (current.card.hasPointerCapture(current.id)) current.card.releasePointerCapture(current.id);
  marker.hidden = true;
  if (!current.started) return;
  const rect = current.ghost.getBoundingClientRect();
  current.ghost.remove();
  current.card.classList.remove('is-dragging');
  if (commit && current.list) commitMove(current.card, current.list, current.ref, rect);
  else { current.card.focus(); ui.announce('Taşıma iptal edildi.'); }
}
$('#board').addEventListener('pointerup', (event) => { if (drag?.id === event.pointerId) endDrag(true); });
$('#board').addEventListener('pointercancel', (event) => { if (drag?.id === event.pointerId) endDrag(false); });
$('#board').addEventListener('lostpointercapture', () => endDrag(false));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && drag) { event.preventDefault(); endDrag(false); } });
function cancelMovement() {
  if (lessMotion()) document.querySelectorAll('.kanban-card').forEach((card) => card.getAnimations().forEach((animation) => animation.cancel()));
}
document.documentElement.addEventListener('motionchange', cancelMovement);
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', cancelMovement);
function setState(value) {
  state = value;
  if (value === 'empty') { data.cards = []; data.notes = []; }
  $('#prototype-state').value = value;
  if (value === 'many') {
    cards = Array.from({ length: 300 }, (_, index) => ({ ...structuredClone(data.cards[index % data.cards.length]), id: `stress-${index}`, title: `${data.cards[index % data.cards.length].title} · ${index + 1}`, column: 'todo' }));
    activeColumn = 'todo';
  } else cards = data.cards;
  if (['many', 'locked'].includes(value)) { projectFilter = 'all'; priorityFilter = 'all'; }
  if (value === 'locked') activeColumn = 'doing';
  $('#priority-filter').value = priorityFilter;
  renderState(value, () => setState('full'), () => ui.create('card', false, activeColumn));
  buildFilters();
  buildBoard();
}
async function start() {
  try {
    data = await loadData();
    fixtures = structuredClone(data);
    if (!data.projects.some((project) => project.id === projectFilter)) projectFilter = 'all';
    cards = data.cards;
    ui = setupUI(data, (kind) => { if (kind === 'note') return; projectFilter = 'all'; priorityFilter = 'all'; setState('full'); selectColumn(data.cards[0].column); requestAnimationFrame(() => document.getElementById(data.cards[0].id)?.focus()); }, (instant) => {
      if (['empty', 'loading', 'error'].includes(state)) ui.create('card', instant, activeColumn);
      else { const form = $(`#column-${activeColumn} .inline-add`); inlineAdd(data.columns.find((column) => column.id === activeColumn), form, instant); }
    });
    $('#priority-filter').addEventListener('change', (event) => { priorityFilter = event.target.value; buildBoard(); ui.announce('Öncelik filtresi uygulandı.'); });
    $('#prototype-state').addEventListener('change', (event) => { Object.assign(data, structuredClone(fixtures)); setState(event.target.value); });
    $('#reload').addEventListener('click', () => { data.cards[0].title += ' ve sonucu günlüğe yaz'; setState('full'); ui.announce('Dosyanın dışarıdaki sürümü yüklendi.'); });
    setState('full');
  } catch {
    renderState('error', start, () => {});
  }
}
start();
