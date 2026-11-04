import { lessMotion } from './components.js';
import { graphDescription, matchesGraph } from './graph-data.js';

// A bounded, deterministic force simulation for the small prototype fixture.
// B replaces this O(n²) repulsion and cooling loop with d3-force, retaining the view contract.
export function createForceLayout(graph, previous, unit) {
  const nodes = graph.nodes.map((node, index) => {
    const old = previous.get(node.id);
    const angle = index / Math.max(graph.nodes.length, 1) * Math.PI * 2;
    const distance = unit * (3 + index % 5 * 0.75);
    return { ...node, x: old?.x ?? Math.cos(angle) * distance, y: old?.y ?? Math.sin(angle) * distance, fx: old?.fx, fy: old?.fy, vx: 0, vy: 0 };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = graph.edges.map((edge) => ({ ...edge, source: byId.get(edge.source), target: byId.get(edge.target) }));
  let iterations = 0;
  let settled = false;
  function step() {
    if (settled) return true;
    const alpha = Math.max(0.05, 1 - iterations / 300);
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const dx = nodes[b].x - nodes[a].x || 0.01;
        const dy = nodes[b].y - nodes[a].y || 0.01;
        const distance = Math.max(Math.hypot(dx, dy), 1);
        const force = unit * unit * 1.625 / (distance * distance) * alpha;
        nodes[a].vx -= dx / distance * force; nodes[a].vy -= dy / distance * force;
        nodes[b].vx += dx / distance * force; nodes[b].vy += dy / distance * force;
      }
    }
    edges.forEach(({ source, target }) => {
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(Math.hypot(dx, dy), 1);
      const force = (distance - unit * 1.75) * 0.04 * alpha;
      source.vx += dx / distance * force; source.vy += dy / distance * force;
      target.vx -= dx / distance * force; target.vy -= dy / distance * force;
    });
    let speed = 0;
    nodes.forEach((node) => {
      node.vx = (node.vx - node.x * 0.012 * alpha) * 0.6;
      node.vy = (node.vy - node.y * 0.012 * alpha) * 0.6;
      if (node.fx !== undefined) { node.x = node.fx; node.y = node.fy; node.vx = 0; node.vy = 0; }
      else { node.x += node.vx; node.y += node.vy; }
      speed = Math.max(speed, Math.hypot(node.vx, node.vy));
    });
    iterations++;
    settled = iterations >= 300 || (iterations > 30 && speed < unit * 0.0005);
    return settled;
  }
  return { nodes, edges, step, restart() { iterations = 0; settled = false; }, get settled() { return settled; } };
}

export function createGraph(canvas, { tooltip, onOpen = (node) => { if (node.ref) location.assign(node.ref); }, announce = () => {} } = {}) {
  const context = canvas.getContext('2d');
  const memory = new Map();
  const pointers = new Map();
  const root = document.documentElement;
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  let view = { scale: 1, x: 0, y: 0 };
  let frame;
  let query = '';
  let focusId = '';
  let hovered = null;
  let gesture = null;
  let width = 0;
  let height = 0;
  const token = (name) => getComputedStyle(canvas).getPropertyValue(name).trim();
  const size = (name) => parseFloat(token(`--space-${name}`));
  let layout = createForceLayout({ nodes: [], edges: [] }, new Map(), size('xl'));
  const screen = (node) => ({ x: node.x * view.scale + view.x, y: node.y * view.scale + view.y });
  const world = (point) => ({ x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale });
  const radius = (node) => node.type === 'tag' ? size('xs') : size('6') + Math.log1p(node.degree) * size('2xs');
  const pointFor = (event) => { const box = canvas.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; };
  const nodeAt = (point) => [...layout.nodes].reverse().find((node) => { const at = screen(node); return Math.hypot(at.x - point.x, at.y - point.y) <= radius(node) + size('6'); });
  function fit() {
    const nodes = layout.nodes;
    width = canvas.clientWidth; height = canvas.clientHeight;
    if (!width || !height) return;
    const pad = size('xl') + size('sm');
    const xs = nodes.map((node) => node.x); const ys = nodes.map((node) => node.y);
    const minX = nodes.length ? Math.min(...xs) : 0; const maxX = nodes.length ? Math.max(...xs) : 0;
    const minY = nodes.length ? Math.min(...ys) : 0; const maxY = nodes.length ? Math.max(...ys) : 0;
    const scale = Math.max(0.1, Math.min((width - pad * 2) / Math.max(maxX - minX, 1), (height - pad * 2) / Math.max(maxY - minY, 1), 1.6));
    const focus = nodes.find((node) => node.id === focusId);
    view = { scale, x: width / 2 - (focus?.x ?? (minX + maxX) / 2) * scale, y: height / 2 - (focus?.y ?? (minY + maxY) / 2) * scale };
  }
  function draw() {
    const w = canvas.clientWidth; const h = canvas.clientHeight;
    if (!w || !h) return;
    const ratio = devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) { canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio); }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, w, h);
    const active = hovered || layout.nodes.find((node) => node.id === focusId);
    const neighbours = new Set();
    layout.edges.forEach(({ source, target }) => { if (source === active) neighbours.add(target); if (target === active) neighbours.add(source); });
    const bright = (node) => matchesGraph(node, query) && (!active || node === active || neighbours.has(node));
    const palette = new Map();
    const colour = (name) => { if (!palette.has(name)) palette.set(name, token(name)); return palette.get(name); };
    layout.edges.forEach(({ source, target, count }) => {
      const from = screen(source); const to = screen(target);
      const strong = source === active || target === active;
      context.globalAlpha = bright(source) && bright(target) ? 1 : 0.15;
      context.strokeStyle = colour(strong ? '--color-focus' : '--color-line-strong');
      context.lineWidth = size('hairline') * (1 + Math.log2(count));
      context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke();
    });
    context.font = `${token('--font-caption-weight')} ${token('--font-caption-size')} ${token('--font-caption-family')}`;
    context.textAlign = 'center'; context.textBaseline = 'top';
    layout.nodes.forEach((node) => {
      const at = screen(node); const r = radius(node);
      const key = node.ambiguous ? 'ambiguous' : node.ghost ? 'ghost' : node.type === 'note' && node.kind && node.kind !== 'note' ? `note-${node.kind}` : node.type;
      context.globalAlpha = bright(node) ? node.ghost ? 0.55 : 1 : 0.15;
      context.fillStyle = colour(`--graph-${key}`);
      context.strokeStyle = colour(`--graph-${key}`);
      context.lineWidth = size('2xs');
      context.beginPath();
      if (node.ignored) context.rect(at.x - r, at.y - r, r * 2, r * 2);
      else context.arc(at.x, at.y, r, 0, Math.PI * 2);
      if (node.ghost || node.ignored || node.type === 'tag') {
        context.setLineDash(node.ghost ? [size('xs'), size('2xs')] : []); context.stroke(); context.setLineDash([]);
      } else context.fill();
      if (node === active) {
        context.strokeStyle = colour('--color-focus'); context.beginPath(); context.arc(at.x, at.y, r + size('xs'), 0, Math.PI * 2); context.stroke();
      }
      if (node === active || neighbours.has(node) || node.type === 'tag' || (query && matchesGraph(node, query))) {
        context.fillStyle = colour('--color-text-2');
        context.fillText(node.title.length > 32 ? `${node.title.slice(0, 31)}…` : node.title, at.x, at.y + r + size('xs'));
      }
    });
    context.globalAlpha = 1;
    if (tooltip) { tooltip.hidden = !active; tooltip.textContent = active ? graphDescription(active) : ''; }
  }
  function stop() { cancelAnimationFrame(frame); frame = null; }
  function settle() {
    stop();
    if (lessMotion()) { while (!layout.step()) { /* Compute before drawing in reduced motion. */ } draw(); return; }
    const tick = () => {
      for (let index = 0; index < 6 && !layout.settled; index++) layout.step();
      draw();
      if (!layout.settled) frame = requestAnimationFrame(tick);
      else frame = null;
    };
    if (!layout.settled) tick(); else draw();
  }
  function setGraph(graph, { focus = '', search = query } = {}) {
    stop();
    layout.nodes.forEach((node) => memory.set(node.id, node));
    layout = createForceLayout(graph, memory, size('xl'));
    focusId = focus; query = search; hovered = null;
    if (lessMotion()) while (!layout.step()) { /* Settle before the first paint. */ }
    else for (let index = 0; index < 80 && !layout.settled; index++) layout.step();
    fit(); settle();
  }
  function zoom(factor, point) {
    const anchor = world(point);
    view.scale = Math.max(0.1, Math.min(5, view.scale * factor));
    view.x = point.x - anchor.x * view.scale; view.y = point.y - anchor.y * view.scale;
    draw();
  }
  const bindings = [];
  const listen = (target, name, action, options) => { target.addEventListener(name, action, options); bindings.push(() => target.removeEventListener(name, action, options)); };
  listen(canvas, 'wheel', (event) => {
    event.preventDefault(); stop();
    const delta = event.deltaY * (event.deltaMode === 1 ? size('md') : event.deltaMode === 2 ? canvas.clientHeight : 1);
    zoom(Math.exp(-delta * 0.001), pointFor(event));
  }, { passive: false });
  listen(canvas, 'pointerdown', (event) => {
    if (event.button !== 0) return;
    stop();
    const point = pointFor(event);
    canvas.setPointerCapture(event.pointerId); pointers.set(event.pointerId, point);
    if (pointers.size === 1) gesture = { start: point, last: point, node: nodeAt(point), moved: false };
    else { gesture.node = null; gesture.moved = true; }
    canvas.classList.add('is-dragging');
  });
  listen(canvas, 'pointermove', (event) => {
    const point = pointFor(event);
    if (!pointers.has(event.pointerId)) { hovered = nodeAt(point); canvas.classList.toggle('is-pointing', Boolean(hovered?.ref || hovered?.type === 'tag')); draw(); return; }
    if (pointers.size === 2) {
      const before = [...pointers.values()];
      pointers.set(event.pointerId, point);
      const after = [...pointers.values()];
      const midpoint = (pair) => ({ x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 });
      const distance = (pair) => Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
      const from = midpoint(before); const to = midpoint(after);
      view.x += to.x - from.x; view.y += to.y - from.y;
      zoom(distance(after) / Math.max(distance(before), 1), to);
      return;
    }
    pointers.set(event.pointerId, point);
    if (!gesture) return;
    if (Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) > size('xs')) gesture.moved = true;
    if (gesture.moved) {
      if (gesture.node) {
        const at = world(point);
        Object.assign(gesture.node, { x: at.x, y: at.y, fx: at.x, fy: at.y, vx: 0, vy: 0 });
        hovered = gesture.node;
      } else { view.x += point.x - gesture.last.x; view.y += point.y - gesture.last.y; }
    }
    gesture.last = point; draw();
  });
  function release(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (pointers.size) { const point = [...pointers.values()][0]; gesture = { start: point, last: point, moved: true, node: null }; return; }
    if (event.type === 'pointerup' && gesture && !gesture.moved && gesture.node && nodeAt(pointFor(event)) === gesture.node) onOpen(gesture.node);
    const pinned = gesture?.moved && gesture.node;
    gesture = null; canvas.classList.remove('is-dragging');
    if (pinned) { announce(`${pinned.title}: bu oturumda sabitlendi.`); layout.restart(); settle(); }
  }
  listen(canvas, 'pointerup', release); listen(canvas, 'pointercancel', release); listen(canvas, 'lostpointercapture', release);
  listen(canvas, 'pointerleave', () => { if (!pointers.size) { hovered = null; canvas.classList.remove('is-pointing'); draw(); } });
  listen(root, 'themechange', draw);
  listen(matchMedia('(prefers-color-scheme: dark)'), 'change', draw);
  const motion = () => { if (lessMotion()) settle(); };
  listen(root, 'motionchange', motion); listen(media, 'change', motion);
  const observer = new ResizeObserver(() => { if (canvas.clientWidth && (canvas.clientWidth !== width || canvas.clientHeight !== height)) { fit(); draw(); } });
  observer.observe(canvas);
  return {
    setGraph,
    setSearch(value) { query = value; draw(); },
    fit() { fit(); draw(); },
    zoom(factor) { stop(); zoom(factor, { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }); },
    destroy() { stop(); observer.disconnect(); bindings.forEach((remove) => remove()); },
  };
}
