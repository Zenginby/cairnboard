import { readPins, pinNote, unpinNote } from './pins.js';
// Pinned notes rail: on wide screens (DESIGN.md, Layout) every page shows the pinned notes in a column on the right,
// under the top bar. It can be hidden; a small tab at the edge brings it back. The choice is remembered.
const root = document.documentElement;
const kindNames = { note: 'Not', wiki: 'Wiki', research: 'Araştırma' };
const storageName = 'prototype-pinned-rail';
const pinIcon = 'M10 2 14 6l-2.5 1-2 2 .5 3-1 1-3-3-3.5 3.5M6 7 4 6l1-1 3 .5 2-2Z';
const wide = matchMedia('(min-width: 90rem)');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('d', path);
  svg.append(line);
  return svg;
}
function readOpen() {
  try { return localStorage.getItem(storageName) !== 'closed'; } catch { return true; }
}
function saveOpen(open) {
  try { localStorage.setItem(storageName, open ? 'open' : 'closed'); } catch { /* Still works for this visit. */ }
}
// Unpinning is remembered for the session, so the rail matches on every page.
function setOpen(open, { focus = false } = {}) {
  root.dataset.pinnedRail = open ? 'open' : 'closed';
  saveOpen(open);
  document.querySelector('.pinned-rail')?.toggleAttribute('inert', !open);
  document.querySelector('.pinned-rail-tab')?.toggleAttribute('inert', open);
  if (focus) (open ? document.querySelector('.pinned-rail-close') : document.querySelector('.pinned-rail-tab'))?.focus();
}

function noteDialog() {
  let dialog = document.querySelector('.pinned-dialog');
  if (dialog) return dialog;
  dialog = el('dialog', 'modal pinned-dialog');
  dialog.setAttribute('aria-labelledby', 'pinned-dialog-title');
  const body = el('div', 'stack');
  const title = el('h2', 'pinned-dialog-title');
  title.id = 'pinned-dialog-title';
  const close = el('button', 'button', 'Kapat');
  close.type = 'button';
  close.addEventListener('click', () => dialog.close());
  body.append(el('p', 'pinned-dialog-meta'), title, el('p', 'pinned-dialog-body'), close);
  dialog.append(body);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  document.body.append(dialog);
  return dialog;
}
function openNote(note, project) {
  const dialog = noteDialog();
  dialog.querySelector('.pinned-dialog-meta').textContent = [kindNames[note.kind], project?.name, note.updated].filter(Boolean).join(' · ');
  dialog.querySelector('.pinned-dialog-title').textContent = note.title;
  dialog.querySelector('.pinned-dialog-body').textContent = note.body;
  if (!dialog.open) dialog.showModal();
}

function item(note, projects, unpin) {
  const project = projects[note.projectId] || note.project;
  const li = el('li', 'pinned-rail-item');
  li.dataset.id = note.id;
  const open = el('button', 'pinned-rail-link');
  open.type = 'button';
  const meta = el('span', 'pinned-rail-meta');
  if (project) {
    const dot = el('span', 'pinned-rail-dot');
    dot.setAttribute('aria-hidden', 'true');
    dot.style.setProperty('--pinned-dot', `var(--color-tone-${project.tone})`);
    meta.append(dot, document.createTextNode(project.name));
  }
  meta.append(el('span', 'pinned-rail-kind', kindNames[note.kind]));
  open.append(meta, el('span', 'pinned-rail-title', note.title), el('span', 'pinned-rail-excerpt', note.body));
  open.addEventListener('click', () => openNote(note, project));
  const remove = el('button', 'pinned-rail-unpin');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Sabitlemeyi kaldır: ${note.title}`);
  remove.title = 'Sabitlemeyi kaldır';
  remove.append(icon(`${pinIcon}M2.5 2.5l11 11`));
  remove.addEventListener('click', () => unpin(note, li));
  li.append(open, remove);
  return li;
}

async function start() {
  if (document.querySelector('.pinned-rail')) return;
  const rail = el('aside', 'pinned-rail');
  rail.setAttribute('aria-labelledby', 'pinned-rail-title');
  const header = el('div', 'pinned-rail-header');
  const title = el('h2', 'pinned-rail-heading', 'Sabitlenenler');
  title.id = 'pinned-rail-title';
  const count = el('span', 'pinned-rail-count');
  const close = el('button', 'pinned-rail-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Sabitlenenleri gizle');
  close.append(icon('m6 4 4 4-4 4'));
  close.addEventListener('click', () => setOpen(false, { focus: true }));
  header.append(title, count, close);
  const list = el('ul', 'pinned-rail-list');
  rail.append(header, list, el('p', 'pinned-rail-hint', 'Bir notu sabitlemek için notu açıp “Sabitle”ye bas.'));

  const tab = el('button', 'pinned-rail-tab');
  tab.type = 'button';
  tab.setAttribute('aria-label', 'Sabitlenenleri göster');
  tab.append(icon(pinIcon));
  const tabCount = el('span', 'pinned-rail-tab-count');
  tab.append(tabCount);
  tab.addEventListener('click', () => setOpen(true, { focus: true }));
  document.body.append(rail, tab);
  setOpen(readOpen());

  try {
    const response = await fetch(new URL('./pinned.json', import.meta.url));
    if (!response.ok) throw new Error('pinned notes unavailable');
    const { projects, pinned } = await response.json();
    const empty = el('p', 'pinned-rail-empty', 'Henüz sabitlenen bir not yok.');
    const status = el('div', 'pinned-rail-status');
    status.setAttribute('role', 'status');
    rail.insertBefore(status, rail.querySelector('.pinned-rail-hint'));
    const sync = () => {
      const shown = list.children.length;
      count.textContent = String(shown);
      tabCount.textContent = String(shown);
      empty.hidden = shown > 0;
      list.hidden = shown === 0;
    };
    // Removing a note closes its row; a short "Geri al" brings it back in its old place.
    const unpin = (note, li) => {
      unpinNote(note.id, 'rail');
      const next = li.nextElementSibling;
      const focusTarget = next?.querySelector('.pinned-rail-link') || li.previousElementSibling?.querySelector('.pinned-rail-link') || close;
      const finish = () => { li.remove(); sync(); };
      li.classList.add('is-leaving');
      const reduced = root.dataset.motion === 'less' || matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduced) finish(); else li.addEventListener('transitionend', (event) => { if (event.target === li && event.propertyName === 'grid-template-rows') finish(); });
      if (!reduced) setTimeout(() => { if (li.isConnected && li.classList.contains('is-leaving')) finish(); }, 600);
      focusTarget.focus();
      const undo = el('button', 'pinned-rail-undo', 'Geri al');
      undo.type = 'button';
      undo.addEventListener('click', () => {
        pinNote(note, 'rail');
        const back = item(note, projects, unpin);
        const order = current(); const anchor = order.slice(order.findIndex((other) => other.id === note.id) + 1).map((other) => list.querySelector(`[data-id="${other.id}"]`)).find(Boolean);
        list.insertBefore(back, anchor || null);
        status.replaceChildren(); sync();
        back.querySelector('.pinned-rail-link').focus();
      });
      status.replaceChildren(el('span', '', `“${note.title}” sabitlenenlerden çıkarıldı.`), undo);
    };
    // Notes pinned in this session come first, then the fixture's pinned notes that were not unpinned.
    const current = () => {
      const { added, removed } = readPins();
      return [...added, ...pinned.filter((note) => !removed.includes(note.id) && !added.some((other) => other.id === note.id))];
    };
    const render = () => { list.replaceChildren(...current().map((note) => item(note, projects, unpin))); sync(); };
    list.after(empty);
    render();
    // Pinning on the page redraws the rail; the rail's own remove/undo animate in place instead.
    document.addEventListener('pinchange', (event) => { if (event.detail?.source !== 'rail') { status.replaceChildren(); render(); } });
  } catch {
    list.replaceWith(el('p', 'pinned-rail-empty', 'Sabitlenen notlar yüklenemedi.'));
  }
  // Keyboard: Escape on the rail hides it only on wide screens, where it is visible.
  rail.addEventListener('keydown', (event) => { if (event.key === 'Escape' && wide.matches) setOpen(false, { focus: true }); });
}
start();
