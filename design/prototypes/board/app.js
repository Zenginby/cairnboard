import { lessMotion, tokenTime } from '../_shared/components.js';
import { $, el, button, priorities, projectChip, lockMessage, field, loadData, setupUI, renderState } from '../_shared/app-ui.js';

let data;
let fixtures;
let ui;
let state = 'full';
let projectFilter = new URLSearchParams(location.search).get('project') || 'all';
let priorityFilter = 'all';
let activeColumn = 'todo';
let cards = [];
let drag = null;
let draggedAt = 0;
let menuCard = null;
let lastMoved = null;
const mobile = matchMedia('(max-width: 50rem)');
const collapsed = new Set();
const cardsIn = (list) => [...list.children].filter((node) => node.classList.contains('kanban-card'));
const nextCard = (card) => cardsIn(card.parentElement)[cardsIn(card.parentElement).indexOf(card) + 1] || null;
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
  const siblings = cardsIn(current).filter((item) => recordFor(item).priority === record.priority);
  const position = siblings.indexOf(card);
  add('Bir sıra yukarı', current, siblings[position - 1] || card);
  add('Bir sıra aşağı', current, siblings[position + 2] || null);
  menu.children[0].disabled = position === 0;
  menu.children[1].disabled = position === siblings.length - 1;
  lists().forEach((list) => {
    add(`${list.dataset.label}, ${priorities[record.priority]} en üste`, list, cardsIn(list).find((item) => recordFor(item).priority === record.priority) || null);
    add(`${list.dataset.label}, ${priorities[record.priority]} en alta`, list, null);
  });
  card.querySelector('[data-move]').setAttribute('aria-expanded', 'true');
  menu.classList.toggle('is-instant', instant);
  menu.classList.add('is-open');
  menu.inert = false;
  const rect = card.querySelector('[data-move]').getBoundingClientRect();
  const gutter = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-md'));
  menu.style.setProperty('--menu-left', `${Math.max(gutter, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - gutter))}px`);
  menu.style.setProperty('--menu-top', `${Math.max(gutter, Math.min(rect.bottom, innerHeight - menu.offsetHeight - gutter))}px`);
  menu.querySelector('button:not(:disabled)').focus();
}
menu.addEventListener('keydown', (event) => {
  const items = [...menu.querySelectorAll('button:not(:disabled)')];
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
function selectColumn(id) {
  activeColumn = id;
  collapsed.delete(id);
  const column = document.getElementById(`column-${id}`);
  if (!column) return;
  const opening = column.dataset.open !== 'true';
  if (opening) column.classList.add('is-instant');
  column.dataset.open = 'true';
  column.querySelector('.column-toggle').setAttribute('aria-expanded', 'true');
  const content = column.querySelector('.column-content');
  content.inert = false;
  content.setAttribute('aria-hidden', 'false');
  if (opening) {
    void column.offsetHeight;
    requestAnimationFrame(() => column.classList.remove('is-instant'));
  }
}
function arrangeGroups(list) {
  list.querySelectorAll(':scope > .priority-heading-item').forEach((node) => node.remove());
  const items = cardsIn(list);
  Object.entries(priorities).forEach(([priority, label]) => {
    const group = items.filter((card) => recordFor(card).priority === priority);
    if (!group.length) return;
    const heading = el('li', 'priority-heading-item');
    heading.setAttribute('role', 'presentation');
    heading.append(el('h3', `priority-heading priority-${priority}`, label));
    list.append(heading, ...group);
  });
}
function updateCounts() {
  data.columns.forEach((column) => {
    const count = cards.filter((record) => record.column === column.id && passes(record)).length;
    $(`#count-${column.id}`).textContent = count;
    $(`#empty-${column.id}`).hidden = count > 0;
  });
  $('#board-summary').textContent = `${cards.filter(passes).length} kart · ${data.columns.length} sütun`;
}
function fillCardCopy(copy, record, title) {
  const line = el('p');
  const lead = record.column === 'review' ? 'Senden: ' : record.column === 'doing' ? 'Şimdi: ' : record.column === 'done' ? 'Sonuç: ' : 'Sonra: ';
  // The title is the card's one link; its hit area is stretched over the whole card in CSS, so a click anywhere
  // that is not a control opens the card page.
  const open = el('a', 'card-link', title);
  open.href = `../card/?id=${encodeURIComponent(record.id)}`;
  open.draggable = false;
  line.append(el('b', '', lead), open);
  copy.replaceChildren(line);
  if (record.column === 'doing') {
    const next = el('p');
    next.append(el('b', '', 'Sonra: '), document.createTextNode('Kabul ölçütlerini birlikte denetle.'));
    copy.append(next);
  }
}
function makeCard(record, index) {
  const card = el('li', 'kanban-card');
  card.classList.toggle('is-done', data.columns.find((column) => column.id === record.column).role === 'done');
  card.id = record.id;
  card.dataset.id = record.id;
  card.tabIndex = 0;
  const top = el('div', 'card-top');
  const chip = projectChip(projectFor(record));
  chip.classList.add('card-project-chip');
  top.append(chip);
  const copy = el('div', 'card-copy');
  fillCardCopy(copy, record, titleFor(record, index));
  const meta = el('div', 'card-metadata');
  const person = data.people.find((item) => item.id === record.assigneeId);
  const owner = el('span', `card-owner${person ? '' : ' is-agent'}`, person?.initials || record.assigneeId || 'Atanmamış');
  owner.setAttribute('aria-label', person?.name || `${record.assigneeId || 'Atanmamış'} · ajan`);
  const progress = `${record.criteria.filter((criterion) => criterion.done).length}/${record.criteria.length}`;
  const criteria = el('span', 'counter', progress);
  criteria.setAttribute('aria-label', `Kabul ölçütleri: ${progress}`);
  const handle = el('span', 'drag-handle', '⠿');
  handle.title = 'Sürüklemek için tutun. Taşımak için Taşı… düğmesini de kullanabilirsiniz.';
  handle.setAttribute('aria-hidden', 'true');
  meta.append(owner, criteria, el('span', 'counter', `${record.comments} yorum`), handle);
  const move = button('Taşı…', (event) => openMenu(card, event.detail === 0), 'move-trigger');
  move.dataset.move = '';
  move.setAttribute('aria-haspopup', 'menu');
  move.setAttribute('aria-expanded', 'false');
  move.setAttribute('aria-controls', menu.id);
  move.setAttribute('aria-label', `${record.title}: taşı`);
  move.disabled = isLocked(record);
  card.append(top, move, copy, meta);
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
  data.columns.forEach((column) => {
    const section = el('section', 'kanban-column');
    section.id = `column-${column.id}`;
    section.dataset.column = column.id;
    section.dataset.open = String(!collapsed.has(column.id));
    section.setAttribute('role', 'region');
    section.setAttribute('aria-labelledby', `heading-${column.id}`);
    const header = el('div', 'column-header');
    const heading = button('', () => {
      const open = section.dataset.open !== 'true';
      section.dataset.open = String(open);
      heading.setAttribute('aria-expanded', String(open));
      if (!open && content.contains(document.activeElement)) heading.focus({ preventScroll: true });
      content.inert = !open;
      content.setAttribute('aria-hidden', String(!open));
      if (open) collapsed.delete(column.id); else collapsed.add(column.id);
    }, 'column-toggle');
    heading.id = `heading-${column.id}`;
    heading.setAttribute('aria-expanded', section.dataset.open);
    heading.setAttribute('aria-controls', `content-${column.id}`);
    const count = el('span', 'counter column-count');
    count.id = `count-${column.id}`;
    const chevron = el('span', 'column-chevron');
    chevron.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', 'm4 6 4 4 4-4');
    svg.append(path);
    chevron.append(svg);
    heading.append(el('span', '', column.label), count, chevron);
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
    const add = button('Kart ekle', (event) => inlineAdd(column, form, event.detail === 0), 'button column-add');
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
      arrangeGroups(list);
      title.control.value = '';
      form.hidden = true;
      updateCounts();
      document.getElementById(record.id).focus();
      ui.announce(`'${value}' kartı '${column.label}' sütununa eklendi.`);
    });
    header.append(heading, add, form);
    const list = el('ul', 'kanban-list');
    list.dataset.column = column.id;
    list.dataset.label = column.label;
    list.setAttribute('aria-label', `${column.label} kartları`);
    cards.filter((record) => record.column === column.id && passes(record)).forEach((record, index) => list.append(makeCard(record, index)));
    const empty = el('p', 'muted type-label column-empty', 'Burada henüz kart yok. Kart ekle ile başlayın veya buraya bir kart taşıyın.');
    empty.id = `empty-${column.id}`;
    arrangeGroups(list);
    const content = el('div', 'column-content');
    content.id = `content-${column.id}`;
    content.inert = collapsed.has(column.id);
    content.setAttribute('aria-hidden', String(content.inert));
    const inner = el('div', 'column-content-inner');
    inner.append(list, empty);
    content.append(inner);
    section.append(header, content);
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
function insertionReference(card, list, ref) {
  if (ref === card) ref = nextCard(card);
  const priority = recordFor(card).priority;
  if (!ref || recordFor(ref).priority === priority) return ref;
  const siblings = cardsIn(list);
  const position = siblings.indexOf(ref);
  return siblings.find((item, index) => index >= position && item !== card && recordFor(item).priority === priority) || null;
}
function commitMove(card, list, ref = null, ghostRect = null) {
  const record = recordFor(card);
  if (isLocked(record)) return;
  ref = insertionReference(card, list, ref);
  const before = visibleRects();
  if (ghostRect) before.set(card, ghostRect);
  const source = card.parentElement;
  const from = source.dataset.label;
  card.getAnimations().forEach((animation) => animation.cancel());
  list.insertBefore(card, ref);
  record.column = list.dataset.column;
  card.classList.toggle('is-done', data.columns.find((column) => column.id === record.column).role === 'done');
  fillCardCopy(card.querySelector('.card-copy'), record, titleFor(record));
  arrangeGroups(source);
  if (source !== list) arrangeGroups(list);
  // Keep the backing order in sync so a subsequent filter never undoes a move.
  const group = cardsIn(list).filter((item) => recordFor(item).priority === record.priority);
  const following = group[group.indexOf(card) + 1];
  const next = following ? recordFor(following) : null;
  const index = cards.indexOf(record);
  cards.splice(index, 1);
  if (next) cards.splice(cards.indexOf(next), 0, record);
  else {
    const last = cards.findLastIndex((item) => item.column === record.column && item.priority === record.priority);
    cards.splice(last + 1, 0, record);
  }
  selectColumn(record.column);
  updateCounts();
  card.focus({ preventScroll: true });
  card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  const position = cardsIn(list).indexOf(card) + 1;
  ui.announce(`'${record.title}' kartı '${from}' sütunundan '${list.dataset.label}' sütununa taşındı, ${position}/${cardsIn(list).length}.`);
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
$('#board').addEventListener('focusin', (event) => { const column = event.target.closest('.kanban-column'); if (column) activeColumn = column.dataset.column; });
$('#board').addEventListener('keydown', (event) => {
  if (event.target.closest('input, textarea, select') || event.ctrlKey || event.metaKey || event.altKey) return;
  const card = event.target.closest('.kanban-card');
  if (card && event.target === card && event.key === 'Enter') { event.preventDefault(); card.querySelector('.card-link').click(); }
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
    drag.ghost.style.setProperty('--ghost-width', `${rect.width}px`);
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
    drag.ghost.style.setProperty('--ghost-transform', 'none');
    drag.ghost.style.setProperty('--ghost-left', `${x - drag.offsetX}px`);
    drag.ghost.style.setProperty('--ghost-top', `${y - drag.offsetY}px`);
  } else {
    drag.ghost.style.setProperty('--ghost-left', '0px');
    drag.ghost.style.setProperty('--ghost-top', '0px');
    drag.ghost.style.setProperty('--ghost-transform', `translate(${x - drag.offsetX}px, ${y - drag.offsetY}px)`);
  }
  const target = document.elementFromPoint(x, y);
  const list = target?.closest('.kanban-list') || target?.closest('.kanban-column')?.querySelector('.kanban-list');
  const board = $('#board');
  const edge = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-xl'));
  const speed = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-md'));
  if (y < edge) scrollBy(0, -speed);
  else if (y > innerHeight - edge) scrollBy(0, speed);
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
    if (column.dataset.open !== 'true') selectColumn(column.dataset.column);
    // Hit testing and the observer avoid measuring all 300 cards on every frame.
    const candidates = [...visible].filter((card) => card.parentElement === list && card !== drag.card)
      .map((card) => [card, card.getBoundingClientRect()]).sort((a, b) => a[1].top - b[1].top);
    let ref = candidates.find(([, rect]) => y < rect.top + rect.height / 2)?.[0]
      || (candidates.length ? nextCard(candidates.at(-1)[0]) : null);
    if (ref === drag.card) ref = nextCard(ref);
    ref = insertionReference(drag.card, list, ref);
    drag.ref = ref;
    const listRect = list.getBoundingClientRect();
    const lineY = ref ? ref.getBoundingClientRect().top : cardsIn(list).at(-1)?.getBoundingClientRect().bottom || listRect.top;
    marker.style.setProperty('--marker-width', `${listRect.width}px`);
    marker.style.setProperty('--marker-transform', `translate(${listRect.left}px, ${Math.max(rect.top, 0, Math.min(lineY, rect.bottom, innerHeight))}px)`);
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
  draggedAt = performance.now();
  const rect = current.ghost.getBoundingClientRect();
  current.ghost.remove();
  current.card.classList.remove('is-dragging');
  if (commit && current.list) commitMove(current.card, current.list, current.ref, rect);
  else { current.card.focus(); ui.announce('Taşıma iptal edildi.'); }
}
$('#board').addEventListener('pointerup', (event) => { if (drag?.id === event.pointerId) endDrag(true); });
// Mouse presses are captured by the card for dragging, so the click lands on the card rather than the link: forward it.
$('#board').addEventListener('click', (event) => {
  const card = event.target.closest('.kanban-card');
  if (!card) return;
  if (performance.now() - draggedAt < 400) { event.preventDefault(); return; }
  if (event.target.closest('a, button, .drag-handle')) return;
  const open = card.querySelector('.card-link');
  if (event.metaKey || event.ctrlKey) window.open(open.href, '_blank', 'noopener');
  else open.click();
}, true);
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
