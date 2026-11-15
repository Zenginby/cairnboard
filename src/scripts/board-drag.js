// Delegation keeps pointer and keyboard moves working when live updates replace the board.
import { pauseLive, resumeLive } from './live-pause.js';

const BOARD = '[data-board-draggable]';
const CARD = '[data-card-id]';
const CONTROL = '.card-quick, input, select, textarea, button, [contenteditable], [role="button"]';
let pointer = null, busy = false, suppressClick = false;
const announcement = document.createElement('p');
announcement.className = 'sr-only';
announcement.setAttribute('aria-live', 'polite');
announcement.setAttribute('aria-atomic', 'true');
document.body.append(announcement);

const cardsIn = (column, except) => [...column.querySelectorAll(CARD)]
  .filter((card) => card !== except && !card.hidden);
const token = (element, name) => getComputedStyle(element).getPropertyValue(name).trim();
const milliseconds = (value) => parseFloat(value) * (value.endsWith('ms') ? 1 : 1000);
const lessMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
  || Boolean(document.querySelector('[data-motion="less"]'));
const pause = () => pauseLive('board-drag');
const resume = () => resumeLive('board-drag');
const announce = (text) => { announcement.textContent = text; };

function refreshCounts(board, origin, target, delta) {
  if (delta && origin !== target) {
    for (const [column, change] of [[origin, -delta], [target, delta]]) {
      column.dataset.columnTotal = String(Number(column.dataset.columnTotal) + change);
    }
  }
  const filtering = !document.querySelector('[data-board-clear]')?.hidden;
  for (const column of board.querySelectorAll('[data-board-column]')) {
    const count = cardsIn(column).length;
    column.querySelector('[data-column-count]').textContent = String(filtering ? count : column.dataset.columnTotal);
    column.querySelector('[data-column-list]').hidden = count === 0;
    column.querySelector('[data-column-empty]').hidden = count > 0;
  }
}

async function move(card, target, before = null, keyboard = false) {
  const board = card.closest(BOARD);
  const origin = card.closest('[data-board-column]');
  const parent = card.parentElement, next = card.nextSibling, oldColumn = card.dataset.cardColumn;
  const oldBox = card.getBoundingClientRect();
  const list = target.querySelector('[data-column-list]');
  const column = target.dataset.moveColumn;
  // A merged lane posts to its first column. References from its other columns would be refused by the server.
  const visible = cardsIn(target, card);
  const index = before ? visible.indexOf(before) : visible.length;
  const following = visible.slice(index).find((item) => item.dataset.cardColumn === column);
  const previous = visible.slice(0, index).reverse().find((item) => item.dataset.cardColumn === column);
  const body = new URLSearchParams({ csrf: board.dataset.csrf || '', column });
  if (following) body.set('before', following.dataset.cardId);
  else if (previous) body.set('after', previous.dataset.cardId);
  busy = true;
  pause();
  list.insertBefore(card, before);
  card.dataset.cardColumn = column;
  refreshCounts(board, origin, target, 1);
  const link = card.querySelector('a.board-card');
  if (keyboard) {
    link.focus({ preventScroll: true });
    link.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  } else if (!lessMotion()) {
    const box = card.getBoundingClientRect();
    card.animate([{ transform: `translate(${oldBox.left - box.left}px, ${oldBox.top - box.top}px)` },
      { transform: 'translate(0, 0)' }], {
      duration: milliseconds(token(board, '--motion-duration-fast')), easing: token(board, '--motion-ease-settle'),
    });
  }
  try {
    const response = await fetch(`/cards/${encodeURIComponent(card.dataset.cardId)}/move`, {
      method: 'POST', credentials: 'same-origin', referrerPolicy: 'same-origin', redirect: 'manual', body,
    });
    if (response.type !== 'opaqueredirect' && response.status !== 303) {
      // 409 also covers revision/file conflicts; only the claimed refusal should mention an agent.
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      const claimed = response.status === 409 && page.querySelector('h1')?.textContent === board.dataset.claimedTitle;
      throw new Error(claimed ? board.dataset.moveClaimed : board.dataset.moveFailed);
    }
    announce(board.dataset.moveAnnouncement.replace('{title}', () => card.querySelector('h3').textContent)
      .replace('{column}', () => target.querySelector('h2').textContent));
    card.classList.add('board-card-moved');
    setTimeout(() => card.classList.remove('board-card-moved'),
      milliseconds(token(board, '--motion-duration-highlight')));
  } catch (error) {
    parent.insertBefore(card, next);
    card.dataset.cardColumn = oldColumn;
    refreshCounts(board, origin, target, -1);
    if (keyboard) link.focus({ preventScroll: true });
    announce(error.message === board.dataset.moveClaimed ? error.message : board.dataset.moveFailed);
  } finally {
    busy = false;
    resume();
  }
}

function locate(state) {
  const { board, card, x, y, marker } = state;
  const box = board.getBoundingClientRect();
  const column = [...board.querySelectorAll('[data-board-column]')].find((element) => {
    const bounds = element.getBoundingClientRect();
    return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom
      && x >= box.left && x <= box.right;
  });
  state.target?.classList.remove('board-drop-target');
  state.target = column;
  if (!column) { marker.remove(); return; }
  column.classList.add('board-drop-target');
  state.before = cardsIn(column, card).find((item) => {
    const bounds = item.getBoundingClientRect();
    return y < bounds.top + bounds.height / 2;
  }) ?? null;
  const list = column.querySelector('[data-column-list]');
  list.hidden = false;
  list.insertBefore(marker, state.before);
}

function start(state) {
  if (pointer !== state || state.active) return;
  state.active = true;
  suppressClick = true;
  state.card.setPointerCapture(state.id);
  state.card.classList.add('board-drag-source');
  state.board.classList.add('board-dragging');
  const box = state.card.getBoundingClientRect();
  // Measured from where the card was grabbed, so the copy sits under the pointer as it was picked up.
  state.offsetX = state.startX - box.left;
  state.offsetY = state.startY - box.top;
  state.ghost = state.card.querySelector('.board-card').cloneNode(true);
  state.ghost.removeAttribute('href');
  state.ghost.removeAttribute('aria-describedby');
  state.ghost.classList.add('board-drag-ghost');
  state.ghost.setAttribute('aria-hidden', 'true');
  state.ghost.style.width = `${box.width}px`;
  document.body.append(state.ghost);
  state.marker = document.createElement('li');
  state.marker.className = 'board-drop-marker';
  state.marker.setAttribute('aria-hidden', 'true');
  const edge = parseFloat(token(state.board, '--space-xl'));
  const speed = parseFloat(token(state.board, '--space-md'));
  let lastTime;
  const frame = (time) => {
    if (pointer !== state) return;
    state.ghost.style.transform = `translate(${state.x - state.offsetX}px, ${state.y - state.offsetY}px)`;
    const bounds = state.board.getBoundingClientRect();
    const direction = state.x < bounds.left + edge ? -1 : state.x > bounds.right - edge ? 1 : 0;
    if (state.y >= bounds.top && state.y <= bounds.bottom) {
      state.board.scrollLeft += direction * speed * Math.min((time - (lastTime ?? time)) / 16, 2);
    }
    lastTime = time;
    locate(state);
    state.frame = requestAnimationFrame(frame);
  };
  state.frame = requestAnimationFrame(frame);
}

function finish(cancel = false) {
  const state = pointer;
  if (!state) return;
  pointer = null;
  clearTimeout(state.timer);
  cancelAnimationFrame(state.frame);
  if (state.card.hasPointerCapture(state.id)) state.card.releasePointerCapture(state.id);
  state.ghost?.remove();
  state.marker?.remove();
  state.card.classList.remove('board-drag-source');
  state.board.classList.remove('board-dragging');
  state.target?.classList.remove('board-drop-target');
  refreshCounts(state.board, state.card.closest('[data-board-column]'), state.target, 0);
  if (state.active && !cancel && state.target) void move(state.card, state.target, state.before);
  else resume();
  // The synthetic click follows pointerup; later clicks must still navigate normally.
  if (!cancel) setTimeout(() => { suppressClick = false; }, 0);
}

document.addEventListener('pointerdown', (event) => {
  if (!pointer) suppressClick = false;
  if (busy || pointer || !event.isPrimary || event.button !== 0 || !(event.target instanceof Element)) return;
  if (event.target.closest(CONTROL)) return;
  const card = event.target.closest(CARD), board = card?.closest(BOARD);
  if (!board || !board.dataset.csrf || card.hidden) return;
  pause();
  const state = { card, board, id: event.pointerId, type: event.pointerType,
    x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY };
  pointer = state;
  if (state.type === 'touch') state.timer = setTimeout(() => start(state),
    milliseconds(token(board, '--motion-duration-slow')));
});
document.addEventListener('pointermove', (event) => {
  const state = pointer;
  if (!state || state.id !== event.pointerId) return;
  state.x = event.clientX;
  state.y = event.clientY;
  if (!state.active && Math.hypot(state.x - state.startX, state.y - state.startY)
    > parseFloat(token(state.board, '--space-xs'))) {
    if (state.type === 'touch') { finish(true); return; }
    start(state);
  }
  if (state.active) event.preventDefault();
}, { passive: false });
// Keep native scrolling until the long press activates; then prevent the touch scroll gesture from taking over.
document.addEventListener('touchmove', (event) => {
  if (pointer?.active && pointer.type === 'touch') event.preventDefault();
}, { passive: false });
document.addEventListener('pointerup', (event) => { if (pointer?.id === event.pointerId) finish(); });
document.addEventListener('pointercancel', (event) => { if (pointer?.id === event.pointerId) finish(true); });
document.addEventListener('lostpointercapture', (event) => { if (pointer?.id === event.pointerId) finish(true); });
window.addEventListener('blur', () => finish(true));
document.addEventListener('contextmenu', (event) => {
  if (pointer?.type === 'touch') event.preventDefault();
});
document.addEventListener('dragstart', (event) => {
  if (event.target instanceof Element && event.target.closest(BOARD)) event.preventDefault();
});
document.addEventListener('click', (event) => {
  if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && pointer) { event.preventDefault(); finish(true); return; }
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !event.key.startsWith('Arrow')) return;
  const link = event.target instanceof Element ? event.target.closest('a.board-card') : null;
  const card = link?.closest(CARD), board = card?.closest(BOARD);
  if (!board || !board.dataset.csrf || card.hidden) return;
  event.preventDefault();
  if (busy || pointer) return;
  const column = card.closest('[data-board-column]');
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    const columns = [...board.querySelectorAll('[data-board-column]')];
    const target = columns[columns.indexOf(column) + (event.key === 'ArrowLeft' ? -1 : 1)];
    if (target) void move(card, target, null, true);
  } else {
    const cards = cardsIn(column), index = cards.indexOf(card);
    if (event.key === 'ArrowUp' && index > 0) void move(card, column, cards[index - 1], true);
    if (event.key === 'ArrowDown' && index < cards.length - 1) void move(card, column, cards[index + 2] ?? null, true);
  }
});
