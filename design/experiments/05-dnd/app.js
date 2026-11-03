import { log } from '../_shared/log.js';

const COLS = ['Todo', 'Doing', 'Done'];
const LAYOUTS = { balanced: [90, 120, 90], single: [5, 290, 5] };
const EASE = 'cubic-bezier(0.15, 1, 0.3, 1)';
const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const board = document.getElementById('board');
const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');
const dropLine = document.getElementById('drop-line');
const layoutSel = document.getElementById('layout');
const modeSel = document.getElementById('mode');
const supportEl = document.getElementById('support');
const vtSupported = typeof document.startViewTransition === 'function'
  && typeof CSS !== 'undefined' && CSS.supports('view-transition-name', 'match-element');
let lists = [];
let mode = 'flip';
const settles = [];

// ---------- build ----------
function buildBoard() {
  closeMenu();
  board.replaceChildren();
  lists = [];
  let n = 0;
  LAYOUTS[layoutSel.value].forEach((count, ci) => {
    const sec = document.createElement('section');
    sec.className = 'col';
    const h = document.createElement('h2');
    h.id = `h-${ci}`;
    sec.setAttribute('aria-labelledby', h.id);
    const ul = document.createElement('ul');
    ul.className = 'list';
    ul.dataset.col = COLS[ci];
    ul.setAttribute('role', 'list');
    for (let i = 0; i < count; i++) ul.append(makeCard(++n));
    sec.append(h, ul);
    board.append(sec);
    lists.push(ul);
  });
  updateHeadings();
  log(`built layout ${layoutSel.value}: ${n} cards`);
}

function makeCard(n) {
  const li = document.createElement('li');
  li.className = 'card';
  li.tabIndex = 0;
  li.dataset.title = `Kart ${n}`;
  const t = document.createElement('span');
  t.textContent = `Kart ${n}`;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mv';
  b.textContent = 'Taşı…';
  b.setAttribute('aria-haspopup', 'menu');
  b.setAttribute('aria-label', `Kart ${n} taşı`);
  li.append(t, b);
  return li;
}

function updateHeadings() {
  lists.forEach((ul, i) => { document.getElementById(`h-${i}`).textContent = `${ul.dataset.col} (${ul.children.length})`; });
}

// ---------- mode ----------
function setMode(m) {
  mode = m;
  const useVt = m === 'vt';
  document.documentElement.classList.toggle('vt-mode', useVt && vtSupported);
  supportEl.textContent = useVt && !vtSupported ? 'startViewTransition + match-element NOT supported here: moves are instant' : '';
  if (useVt && !vtSupported) log('view-transition-name: match-element / startViewTransition not supported');
  log(`mode = ${m}`);
}

// ---------- status / stats ----------
function announce(text) {
  statusEl.textContent = '';
  requestAnimationFrame(() => { statusEl.textContent = text; });
  log(text);
}

function recordSettle(ms) {
  settles.push(ms);
  if (settles.length > 20) settles.shift();
  const avg = settles.reduce((a, b) => a + b, 0) / settles.length;
  statsEl.textContent = `last ${settles.length} settles: avg ${avg.toFixed(0)} ms, max ${Math.max(...settles).toFixed(0)} ms, latest ${ms.toFixed(0)} ms`;
}

try {
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (e.duration > 50) log(`longtask ${e.duration.toFixed(0)} ms`);
  }).observe({ type: 'longtask', buffered: true });
} catch { log('PerformanceObserver longtask not supported'); }

// ---------- commit a move ----------
function visibleCards() {
  const vh = innerHeight;
  const out = [];
  for (const ul of lists) {
    const lr = ul.getBoundingClientRect();
    for (const c of ul.children) {
      const r = c.getBoundingClientRect();
      if (r.bottom > Math.max(lr.top, 0) && r.top < Math.min(lr.bottom, vh) && r.right > 0 && r.left < innerWidth) out.push([c, r]);
    }
  }
  return out;
}
const inView = (r, ul) => {
  const lr = ul.getBoundingClientRect();
  return r.bottom > Math.max(lr.top, 0) && r.top < Math.min(lr.bottom, innerHeight);
};

async function commitMove(card, list, ref, ghostRect) {
  const from = card.parentElement.dataset.col;
  const to = list.dataset.col;
  if (ref === card) ref = card.nextElementSibling;
  const t0 = performance.now();
  const move = () => { list.insertBefore(card, ref); updateHeadings(); card.focus({ preventScroll: false }); };
  let settle = Promise.resolve();

  if (mode === 'vt' && vtSupported) {
    const vt = document.startViewTransition(move);
    settle = vt.finished.catch(() => {});
  } else if (reduce() || mode !== 'flip') {
    move();
  } else {
    const first = visibleCards();
    if (ghostRect) first.push([card, ghostRect]);
    move();
    const anims = [];
    const seen = new Set();
    for (const [el, r] of first.reverse()) {
      if (seen.has(el)) continue;
      seen.add(el);
      const l = el.getBoundingClientRect();
      if (!inView(l, el.parentElement)) continue;
      const dx = r.left - l.left, dy = r.top - l.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      anims.push(el.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], { duration: 240, easing: EASE }).finished);
    }
    settle = Promise.all(anims).catch(() => {});
  }

  const idx = [...list.children].indexOf(card) + 1;
  announce(from === to
    ? `'${card.dataset.title}' kartı '${to}' sütununda yeniden sıralandı, ${idx}/${list.children.length}.`
    : `'${card.dataset.title}' kartı '${from}' sütunundan '${to}' sütununa taşındı, ${idx}/${list.children.length}.`);
  await settle;
  const ms = performance.now() - t0;
  recordSettle(ms);
  if (!reduce()) {
    card.classList.remove('glow');
    void card.offsetWidth;
    card.classList.add('glow');
    card.addEventListener('animationend', () => card.classList.remove('glow'), { once: true });
  }
}

// ---------- pointer drag ----------
let drag = null;
const THRESH = { touch: 4, pen: 4, mouse: 2 };

board.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || drag) return;
  const card = e.target.closest('.card');
  if (!card || e.target.closest('button')) return;
  drag = { card, id: e.pointerId, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, started: false, type: e.pointerType, ghost: null, list: null, ref: null, raf: 0 };
  card.setPointerCapture(e.pointerId);
});

board.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  drag.x = e.clientX; drag.y = e.clientY;
  if (!drag.started) {
    if (Math.hypot(drag.x - drag.sx, drag.y - drag.sy) < (THRESH[drag.type] ?? 4)) return;
    startDrag();
  }
  moveGhost();
});

function startDrag() {
  const r = drag.card.getBoundingClientRect();
  drag.offX = drag.sx - r.left;
  drag.offY = drag.sy - r.top;
  const g = drag.card.cloneNode(true);
  g.classList.add('ghost');
  g.classList.remove('dragging');
  g.tabIndex = -1;
  g.style.width = `${r.width}px`;
  document.body.append(g);
  drag.ghost = g;
  drag.card.classList.add('dragging');
  drag.started = true;
  log(`drag start (${drag.type})`);
  drag.raf = requestAnimationFrame(frame);
}

function moveGhost() {
  drag.ghost.style.translate = `${drag.x - drag.offX}px ${drag.y - drag.offY}px`;
}

function frame() {
  if (!drag?.started) return;
  const under = document.elementsFromPoint(drag.x, drag.y).find((el) => el.classList?.contains('list')) ?? null;
  // auto-scroll near edges of the hovered list and of the window
  const EDGE = 56, MAX = 18;
  const speed = (d) => Math.ceil(MAX * Math.min(1, (EDGE - d) / EDGE));
  if (under) {
    const lr = under.getBoundingClientRect();
    if (drag.y - lr.top < EDGE) under.scrollTop -= speed(Math.max(0, drag.y - lr.top));
    else if (lr.bottom - drag.y < EDGE) under.scrollTop += speed(Math.max(0, lr.bottom - drag.y));
  }
  if (drag.y < EDGE) scrollBy(0, -speed(Math.max(0, drag.y)));
  else if (innerHeight - drag.y < EDGE) scrollBy(0, speed(Math.max(0, innerHeight - drag.y)));
  updateTarget(under);
  drag.raf = requestAnimationFrame(frame);
}

function updateTarget(list) {
  drag.list = list;
  if (!list) { dropLine.classList.remove('on'); drag.ref = null; return; }
  const lr = list.getBoundingClientRect();
  let ref = null, ry = 0;
  for (const c of list.children) {
    if (c === drag.card) continue;
    const r = c.getBoundingClientRect();
    if (drag.y < r.top + r.height / 2) { ref = c; ry = r.top - 3; break; }
    ry = r.bottom + 1;
  }
  if (!ref && !list.children.length) ry = lr.top + 8;
  drag.ref = ref;
  dropLine.classList.add('on');
  dropLine.style.width = `${lr.width - 16}px`;
  dropLine.style.translate = `${lr.left + 8}px ${Math.min(Math.max(ry, lr.top), lr.bottom - 2)}px`;
}

function endDrag(commit) {
  if (!drag) return;
  const d = drag;
  drag = null;
  cancelAnimationFrame(d.raf);
  try { d.card.releasePointerCapture(d.id); } catch { /* already released */ }
  dropLine.classList.remove('on');
  if (!d.started) return;
  const ghostRect = d.ghost.getBoundingClientRect();
  d.ghost.remove();
  d.card.classList.remove('dragging');
  if (commit && d.list) commitMove(d.card, d.list, d.ref, ghostRect);
  else log('drag cancelled');
}

board.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.id) endDrag(true); });
board.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.id) endDrag(false); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && drag) endDrag(false); });

// ---------- move menu ----------
let menu = null, menuCard = null;

function closeMenu(restore = false) {
  if (!menu) return;
  menu.remove();
  menu = null;
  if (restore && menuCard) menuCard.focus();
  menuCard = null;
}

function openMenu(card) {
  closeMenu();
  menuCard = card;
  menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', `${card.dataset.title}: taşı`);
  for (const ul of lists) {
    const h = document.createElement('h3');
    h.textContent = ul.dataset.col;
    h.setAttribute('role', 'presentation');
    menu.append(h);
    for (const [label, top] of [['en üste', true], ['en alta', false]]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.tabIndex = -1;
      b.setAttribute('role', 'menuitem');
      b.textContent = `${ul.dataset.col}, ${label}`;
      b.addEventListener('click', () => {
        const target = card;
        closeMenu();
        commitMove(target, ul, top ? ul.firstElementChild : null, null);
      });
      menu.append(b);
    }
  }
  document.body.append(menu);
  const br = (card.querySelector('.mv') ?? card).getBoundingClientRect();
  const mr = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(br.left, innerWidth - mr.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(br.bottom + 4, innerHeight - mr.height - 4))}px`;
  menu.querySelector('button').focus();
}

board.addEventListener('click', (e) => {
  const b = e.target.closest('.mv');
  if (b) openMenu(b.closest('.card'));
});

board.addEventListener('keydown', (e) => {
  if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const card = e.target.closest?.('.card');
    if (card) { e.preventDefault(); openMenu(card); }
  }
});

document.addEventListener('keydown', (e) => {
  if (!menu) return;
  const items = [...menu.querySelectorAll('button')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
  else if (e.key === 'End') { e.preventDefault(); items.at(-1).focus(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
  else if (e.key === 'Tab') closeMenu(true);
});
document.addEventListener('pointerdown', (e) => { if (menu && !menu.contains(e.target) && !e.target.closest('.mv')) closeMenu(); });

layoutSel.addEventListener('change', buildBoard);
modeSel.addEventListener('change', () => setMode(modeSel.value));
buildBoard();
setMode('flip');
