import { lessMotion } from '../_shared/components.js';
import { $, el, loadData, setupUI, renderState } from '../_shared/app-ui.js';
import { hrefFor, searchKinds } from '../_shared/search-results.js';

// Graph: a force layout of notes (and, on request, tags) runs a few hundred steps on load or when the visible set
// changes, then stops. With reduced motion or "Hareket: az" the steps run at once and the result is drawn once.
const STEPS = 300;
const STEPS_PER_FRAME = 6;
let data;
let fixtures;
let page;
let ui;
let state = 'full';
let nodes = [];
let edges = [];
let frame = 0;
let hovered = null;
let focused = -1;
let view = { scale: 1, x: 0, y: 0 };
const selected = new Set();
const canvas = $('#graph-canvas');
const context = canvas.getContext('2d');
const tooltip = $('#graph-tooltip');
const copy = {
  empty: ['Grafikte gösterilecek not yok', 'Bir not yazıp başka bir nota [[bağlantı]] ver; bağlantı burada görünsün.', 'İlk notu ekle'],
  loading: ['Bağlantılar okunuyor', 'Notlardaki bağlantılar ve etiketler toplanıyor.'],
  error: ['Bağlantılar okunamadı', 'Bağlantı dizini açılamadı. Yeniden dene; sorun sürerse cairn index komutunu çalıştır.'],
};
const options = () => ({ query: $('#graph-search').value.trim().toLocaleLowerCase('tr'), orphans: $('#graph-orphans').checked, tags: $('#graph-labels').checked });
const projectFor = (id) => data.projects.find((project) => project.id === id);
const titleFor = (note, index) => state === 'long' ? `${note.title} — ${index % 2 ? data.longText.english : data.longText.title}` : note.title;

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function allNotes() {
  return [...data.notes, ...page.notes].filter((note) => note.title).map((note, index) => ({ ...note, title: titleFor(note, index), tags: note.tags || page.tags[note.id] || [] }));
}
function linkCount(id) {
  return page.links.filter(([from, to]) => from === id || to === id).length;
}
// The visible graph for the current filters. Positions of nodes that stay visible are kept.
function rebuild() {
  const { orphans, tags } = options();
  const previous = new Map(nodes.map((node) => [node.id, node]));
  const notes = allNotes().filter((note) => selected.has(note.projectId) && (orphans || linkCount(note.id) > 0));
  const ids = new Set(notes.map((note) => note.id));
  const next = notes.map((note) => ({ id: note.id, type: 'note', note, label: note.title, project: projectFor(note.projectId) }));
  const nextEdges = page.links.filter(([from, to]) => ids.has(from) && ids.has(to)).map(([from, to]) => [from, to]);
  if (tags) {
    const tagNames = [...new Set(notes.flatMap((note) => note.tags))].sort((a, b) => a.localeCompare(b, 'tr'));
    tagNames.forEach((tag) => next.push({ id: `tag:${tag}`, type: 'tag', label: `#${tag}` }));
    notes.forEach((note) => note.tags.forEach((tag) => nextEdges.push([note.id, `tag:${tag}`])));
  }
  const count = next.length || 1;
  next.forEach((node, index) => {
    const old = previous.get(node.id);
    const angle = index / count * Math.PI * 2;
    const radius = 120 + (index % 5) * 30;
    Object.assign(node, old ? { x: old.x, y: old.y } : { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }, { vx: 0, vy: 0 });
  });
  const index = new Map(next.map((node, at) => [node.id, at]));
  edges = nextEdges.map(([from, to]) => [index.get(from), index.get(to)]);
  next.forEach((node) => { node.degree = edges.filter(([a, b]) => next[a] === node || next[b] === node).length; });
  nodes = next;
  hovered = null;
  focused = Math.min(focused, nodes.length - 1);
}
function step(alpha) {
  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      const dx = nodes[b].x - nodes[a].x;
      const dy = nodes[b].y - nodes[a].y;
      const distance = Math.max(Math.hypot(dx, dy), 1);
      const force = 2600 / (distance * distance) * alpha;
      nodes[a].vx -= dx / distance * force; nodes[a].vy -= dy / distance * force;
      nodes[b].vx += dx / distance * force; nodes[b].vy += dy / distance * force;
    }
  }
  edges.forEach(([a, b]) => {
    const dx = nodes[b].x - nodes[a].x;
    const dy = nodes[b].y - nodes[a].y;
    const distance = Math.max(Math.hypot(dx, dy), 1);
    const force = (distance - 70) * 0.04 * alpha;
    nodes[a].vx += dx / distance * force; nodes[a].vy += dy / distance * force;
    nodes[b].vx -= dx / distance * force; nodes[b].vy -= dy / distance * force;
  });
  nodes.forEach((node) => {
    node.vx = (node.vx - node.x * 0.012 * alpha) * 0.6;
    node.vy = (node.vy - node.y * 0.012 * alpha) * 0.6;
    node.x += node.vx;
    node.y += node.vy;
  });
}
function fit() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!nodes.length || !width) { view = { scale: 1, x: width / 2, y: height / 2 }; return; }
  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);
  const pad = 48;
  const spanX = Math.max(Math.max(...xs) - Math.min(...xs), 1);
  const spanY = Math.max(Math.max(...ys) - Math.min(...ys), 1);
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY, 1.6);
  view = { scale, x: width / 2 - (Math.min(...xs) + spanX / 2) * scale, y: height / 2 - (Math.min(...ys) + spanY / 2) * scale };
}
const screen = (node) => ({ x: node.x * view.scale + view.x, y: node.y * view.scale + view.y });
const radius = (node) => node.type === 'tag' ? 4 : 5 + Math.sqrt(node.degree) * 2.2;
function matches(node, query) {
  if (!query) return true;
  const text = `${node.label} ${(node.note?.tags || []).join(' ')}`.toLocaleLowerCase('tr');
  return text.includes(query.replace(/^#/, ''));
}
function draw() {
  const ratio = devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  fit();
  const { query } = options();
  const lit = nodes.map((node) => matches(node, query));
  const active = hovered ?? (focused >= 0 ? nodes[focused] : null);
  const neighbours = new Set();
  if (active) edges.forEach(([a, b]) => { if (nodes[a] === active) neighbours.add(b); if (nodes[b] === active) neighbours.add(a); });
  const line = token('--color-line-strong');
  context.lineWidth = 1;
  edges.forEach(([a, b]) => {
    const from = screen(nodes[a]);
    const to = screen(nodes[b]);
    const strong = active && (nodes[a] === active || nodes[b] === active);
    context.globalAlpha = query && !(lit[a] && lit[b]) ? 0.25 : 1;
    context.strokeStyle = strong ? token('--color-focus') : line;
    context.lineWidth = strong ? 1.6 : 1;
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
  });
  const caption = `${token('--font-caption-weight')} ${token('--font-caption-size')} ${token('--font-caption-family')}`;
  context.font = caption;
  context.textAlign = 'center';
  context.textBaseline = 'top';
  nodes.forEach((node, index) => {
    const point = screen(node);
    const size = radius(node);
    const dim = (query && !lit[index]) || (active && node !== active && !neighbours.has(index));
    context.globalAlpha = dim ? 0.25 : 1;
    context.beginPath();
    context.arc(point.x, point.y, size, 0, Math.PI * 2);
    if (node.type === 'tag') {
      context.fillStyle = token('--color-surface');
      context.fill();
      context.strokeStyle = token('--color-text-3');
      context.lineWidth = 1.5;
      context.stroke();
    } else {
      context.fillStyle = token(`--color-tone-${node.project?.tone || 7}`);
      context.fill();
    }
    if (node === active) {
      context.strokeStyle = token('--color-focus');
      context.lineWidth = 2;
      context.beginPath();
      context.arc(point.x, point.y, size + 3, 0, Math.PI * 2);
      context.stroke();
    }
    const labelled = node === active || node.type === 'tag' || (query && lit[index]);
    if (labelled && !(node === hovered)) {
      context.fillStyle = token(node.type === 'tag' ? '--color-text-3' : '--color-text-2');
      context.fillText(node.label.length > 32 ? `${node.label.slice(0, 31)}…` : node.label, point.x, point.y + size + 4);
    }
  });
  context.globalAlpha = 1;
}
function settle(steps = STEPS) {
  cancelAnimationFrame(frame);
  if (lessMotion()) {
    for (let index = 0; index < steps; index++) step(1 - index / steps * 0.9);
    draw();
    return;
  }
  let done = 0;
  const tick = () => {
    for (let index = 0; index < STEPS_PER_FRAME && done < steps; index++, done++) step(1 - done / steps * 0.9);
    draw();
    if (done < steps) frame = requestAnimationFrame(tick);
  };
  tick();
}
function finishNow() {
  cancelAnimationFrame(frame);
  for (let index = 0; index < 60; index++) step(0.1);
  draw();
}
function describe(node) {
  if (node.type === 'tag') return `${node.label} etiketi · ${node.degree} not`;
  return [node.label, node.project?.name, searchKinds[node.note.kind], `${node.degree} bağlantı`].filter(Boolean).join(' · ');
}
function showTooltip(node) {
  tooltip.hidden = !node;
  if (!node) return;
  const point = screen(node);
  tooltip.textContent = describe(node);
  tooltip.style.setProperty('--tip-x', `${point.x}px`);
  tooltip.style.setProperty('--tip-y', `${point.y - radius(node) - 6}px`);
}
function nodeAt(event) {
  const box = canvas.getBoundingClientRect();
  const x = event.clientX - box.left;
  const y = event.clientY - box.top;
  let best = null;
  let bestDistance = Infinity;
  nodes.forEach((node) => {
    const point = screen(node);
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance <= radius(node) + 6 && distance < bestDistance) { best = node; bestDistance = distance; }
  });
  return best;
}
function openNode(node) {
  if (!node) return;
  if (node.type === 'tag') {
    $('#graph-search').value = node.label;
    refresh(false);
    ui.announce(`${node.label} etiketli notlar vurgulandı.`);
    return;
  }
  location.assign(hrefFor({ id: node.id, kind: node.note.kind }));
}
function renderList() {
  const list = $('#graph-list');
  const notes = nodes.filter((node) => node.type === 'note');
  const { query } = options();
  list.replaceChildren(...notes.map((node) => {
    const item = el('li', 'graph-list-item');
    item.classList.toggle('is-dim', Boolean(query) && !matches(node, query));
    const head = el('div', 'graph-list-head');
    const link = el('a', 'graph-list-title', node.label);
    link.href = hrefFor({ id: node.id, kind: node.note.kind });
    const meta = el('span', 'graph-list-meta');
    const dot = el('span', 'graph-dot');
    dot.setAttribute('aria-hidden', 'true');
    dot.style.setProperty('--dot', `var(--color-tone-${node.project?.tone || 7})`);
    meta.append(dot, `${node.project?.name || 'Projesiz'} · ${searchKinds[node.note.kind]}`);
    head.append(link, meta);
    item.append(head);
    const linked = edges.filter(([a, b]) => nodes[a] === node || nodes[b] === node).map(([a, b]) => nodes[a] === node ? nodes[b] : nodes[a]);
    const noteLinks = linked.filter((other) => other.type === 'note');
    const tagLinks = linked.filter((other) => other.type === 'tag');
    if (noteLinks.length) {
      const sub = el('ul', 'graph-links');
      sub.setAttribute('aria-label', `${node.label}: ${noteLinks.length} bağlantı`);
      noteLinks.forEach((other) => {
        const row = el('li');
        const anchor = el('a', '', other.label);
        anchor.href = hrefFor({ id: other.id, kind: other.note.kind });
        row.append(anchor);
        sub.append(row);
      });
      item.append(sub);
    } else item.append(el('p', 'type-label muted', 'Bağlantısı yok (yetim not).'));
    if (tagLinks.length) item.append(el('p', 'type-label muted', `Etiketler: ${tagLinks.map((tag) => tag.label).join(', ')}`));
    return item;
  }));
  if (!notes.length) list.append(el('li', 'muted', 'Süzgeçlere uyan not yok. Bir proje seç ya da yetim notları göster.'));
}
function summary() {
  const notes = nodes.filter((node) => node.type === 'note');
  const links = edges.filter(([a, b]) => nodes[a].type === 'note' && nodes[b].type === 'note').length;
  const orphans = notes.filter((node) => node.degree === 0 || !edges.some(([a, b]) => (nodes[a] === node && nodes[b].type === 'note') || (nodes[b] === node && nodes[a].type === 'note'))).length;
  $('#graph-summary').textContent = `${notes.length} not · ${links} bağlantı · ${orphans} yetim`;
  canvas.setAttribute('aria-label', `Bağlantı grafiği: ${notes.length} not, ${links} bağlantı. Ayrıntılar Liste görünümünde.`);
  const { query } = options();
  $('#graph-filter-count').textContent = query ? `${nodes.filter((node) => matches(node, query)).length} not vurgulandı` : '';
}
function refresh(relayout = true) {
  if (relayout) {
    rebuild();
    settle(nodes.length && relayout === 'first' ? STEPS : 160);
  } else draw();
  renderList();
  summary();
  showTooltip(null);
}
function buildProjects() {
  const box = $('#graph-projects');
  const used = new Set(allNotes().map((note) => note.projectId));
  box.replaceChildren(...data.projects.filter((project) => used.has(project.id)).map((project) => {
    const label = el('label', 'graph-switch type-label');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = selected.has(project.id);
    input.addEventListener('change', () => {
      if (input.checked) selected.add(project.id); else selected.delete(project.id);
      refresh();
    });
    const dot = el('span', 'graph-dot');
    dot.setAttribute('aria-hidden', 'true');
    dot.style.setProperty('--dot', `var(--color-tone-${project.tone})`);
    label.append(input, dot, el('span', 'graph-project-name', state === 'long' ? data.longText.projectName : project.name));
    return label;
  }));
}
function setState(value) {
  state = value;
  cancelAnimationFrame(frame);
  if (value === 'empty') { data.notes = []; page.notes = []; page.links = []; }
  $('#prototype-state').value = value;
  renderState(value, () => setState('full'), (event) => ui.create('note', event?.detail === 0), copy);
  if (['empty', 'loading', 'error'].includes(value)) return;
  selected.clear();
  data.projects.forEach((project) => selected.add(project.id));
  nodes = [];
  buildProjects();
  refresh('first');
}
canvas.addEventListener('pointermove', (event) => {
  const node = nodeAt(event);
  if (node === hovered) return;
  hovered = node;
  canvas.classList.toggle('is-pointing', Boolean(node));
  draw();
  showTooltip(node);
});
canvas.addEventListener('pointerleave', () => { hovered = null; canvas.classList.remove('is-pointing'); draw(); showTooltip(focused >= 0 && document.activeElement === canvas ? nodes[focused] : null); });
canvas.addEventListener('click', (event) => openNode(nodeAt(event)));
canvas.addEventListener('keydown', (event) => {
  if (!nodes.length) return;
  const order = nodes.map((node, index) => index).sort((a, b) => nodes[a].x - nodes[b].x || nodes[a].y - nodes[b].y);
  const at = order.indexOf(focused);
  const moves = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: order.length - 1 };
  if (event.key in moves) {
    event.preventDefault();
    focused = order[(moves[event.key] + order.length) % order.length];
    draw();
    showTooltip(nodes[focused]);
    ui.announce(describe(nodes[focused]));
  } else if (event.key === 'Enter' && focused >= 0) {
    event.preventDefault();
    openNode(nodes[focused]);
  } else if (event.key === 'Escape') {
    focused = -1;
    draw();
    showTooltip(null);
  }
});
canvas.addEventListener('blur', () => { if (!hovered) showTooltip(null); });
$('#graph-search').addEventListener('input', () => refresh(false));
$('#graph-orphans').addEventListener('change', () => refresh());
$('#graph-labels').addEventListener('change', () => refresh());
document.querySelectorAll('.view-tabs [role="tab"]').forEach((tab) => tab.addEventListener('click', () => requestAnimationFrame(draw)));
new ResizeObserver(() => { if (nodes.length) draw(); }).observe(canvas);
document.documentElement.addEventListener('themechange', () => { if (nodes.length) draw(); });
document.documentElement.addEventListener('motionchange', () => { if (lessMotion()) finishNow(); });
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => { if (lessMotion()) finishNow(); });
async function start() {
  try {
    const [loaded, response] = await Promise.all([loadData('../_shared/workspace.json'), fetch('data.json')]);
    if (!response.ok) throw new Error('Graph data unavailable');
    data = loaded;
    page = await response.json();
    fixtures = structuredClone({ data, page });
    ui = setupUI(data, () => { if (state === 'empty') setState('full'); else refresh(); }, (instant) => ui.create('card', instant));
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
