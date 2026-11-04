import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGraph, filterGraph, graphOptions, localGraph, matchesGraph } from '../design/prototypes/_shared/graph-data.js';
import { createForceLayout, createGraph } from '../design/prototypes/_shared/graph-layout.js';

const read = (file) => JSON.parse(readFileSync(new URL(`../design/prototypes/${file}`, import.meta.url)));
const sample = read('_shared/sample.json');
const workspace = read('_shared/workspace.json');
const fixture = read('graph/data.json');
const merge = (key) => [...new Map([...sample[key], ...workspace[key]].map((record) => [record.id, { ...sample[key].find((item) => item.id === record.id), ...record }])).values()];
const data = { ...sample, ...workspace, notes: merge('notes'), cards: merge('cards') };
const graph = buildGraph(data, fixture);
const options = (query = '') => graphOptions(new URLSearchParams(query));

test('graph fixture aggregates parallel links and counts only incoming backlinks before filtering', () => {
  assert.equal(graph.edges.find((edge) => edge.source === 'note-1' && edge.target === 'note-3').count, 3);
  const backlinks = fixture.links.filter(([, target]) => target === 'note-3').length;
  assert.equal(graph.nodes.find((node) => node.id === 'note-3').degree, backlinks);
  const plain = filterGraph(graph, options());
  const tagged = filterGraph(graph, options('tags=1'));
  plain.nodes.forEach((node) => assert.equal(tagged.nodes.find((other) => other.id === node.id).degree, node.degree));
  assert(tagged.nodes.some((node) => node.type === 'tag'));
  assert.equal(graph.nodes.filter((node) => node.type === 'journal').length, 1);
  assert(graph.nodes.some((node) => node.ghost && !node.ambiguous && node.title === node.target_name));
  assert(graph.nodes.some((node) => node.ambiguous && node.ghost));
  assert(graph.nodes.some((node) => node.ignored && node.type === 'raw'));
  assert(graph.edges.every((edge) => graph.nodes.some((node) => node.id === edge.source) && graph.nodes.some((node) => node.id === edge.target)));
});

test('graph query composes filters, hides journals/cards/tags by default and keeps search as highlighting', () => {
  const plain = filterGraph(graph, options());
  assert(!plain.nodes.some((node) => ['journal', 'card', 'tag'].includes(node.type)));
  const query = 'type=note&kind=concept&project=mutfak-defteri&tag=tarif&orphans=0&ghosts=0&journals=0&q=Çorba';
  // A title match never removes nonmatching nodes.
  assert.deepEqual(filterGraph(graph, options('q=Çorba')), plain);
  const result = filterGraph(graph, options(query));
  assert.deepEqual(result.nodes.map((node) => node.id), ['note-1']);
  assert(result.nodes.every((node) => node.type === 'note' && node.kind === 'concept' && node.project === 'mutfak-defteri' && node.tags.includes('tarif') && !node.ghost));
  assert(filterGraph(graph, options('journals=1&cards=1')).nodes.some((node) => node.type === 'card'));
  assert(filterGraph(graph, options('journals=1')).nodes.some((node) => node.type === 'journal'));
  assert(!filterGraph(graph, options('orphans=0')).nodes.some((node) => node.id === 'graph-14'));
  assert(!filterGraph(graph, options('ghosts=0')).nodes.some((node) => node.ghost));
  assert(matchesGraph({ title: 'İlk görüşme', tags: ['yazım'] }, 'ilk'));
  assert(matchesGraph({ title: '', tags: ['yazım'] }, '#yazım'));
});

test('graph limit retains the highest backlink counts, caps tags too, and keeps only present endpoints', () => {
  for (const query of ['limit=3', 'limit=3&tags=1']) {
    const result = filterGraph(graph, options(query));
    assert.equal(result.nodes.length, 3);
    assert.equal(result.truncated, true);
    const highest = [...filterGraph(graph, options(query.replace('limit=3', 'limit=3000'))).nodes].sort((a, b) => b.degree - a.degree).slice(0, 3).map((node) => node.degree);
    assert.deepEqual(result.nodes.map((node) => node.degree), highest);
    assert(result.edges.every((edge) => result.nodes.some((node) => node.id === edge.source) && result.nodes.some((node) => node.id === edge.target)));
  }
  for (const limit of ['0', '-1', 'NaN', '1.5', 'Infinity']) assert.equal(options(`limit=${limit}`).limit, 3000);
  assert.equal(options('limit=9000').limit, 3000);
});

test('local graph uses breadth-first depth, includes the page, and shares exact global node records', () => {
  const first = localGraph(graph, 'note-1');
  const second = localGraph(graph, 'note-1', 2);
  assert(first.nodes.some((node) => node.id === 'note-1'));
  assert(!first.nodes.some((node) => node.id === 'research-11'));
  assert(second.nodes.some((node) => node.id === 'research-11'));
  assert(first.nodes.every((node) => second.nodes.includes(node)));
  assert(second.nodes.length > first.nodes.length);
  for (const id of ['note-1', 'mutfak-defteri', 'research-1']) assert(localGraph(graph, id).nodes.length > 1);
});

test('force layout cools to a stop, separates coincident nodes, and preserves session pins through filtering', () => {
  const visible = filterGraph(graph, options());
  const previous = new Map(visible.nodes.map((node) => [node.id, { x: 0, y: 0 }]));
  previous.set('note-1', { x: 100, y: -40, fx: 100, fy: -40 });
  const layout = createForceLayout(visible, previous, 40);
  for (let step = 0; step < 301; step++) layout.step();
  assert(layout.settled);
  assert(layout.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)));
  assert.equal(layout.nodes.find((node) => node.id === 'note-1').x, 100);
  assert.equal(layout.nodes.find((node) => node.id === 'note-1').y, -40);
  const positions = layout.nodes.map((node) => [node.x, node.y]);
  layout.step(); assert.deepEqual(layout.nodes.map((node) => [node.x, node.y]), positions);
  assert(layout.nodes.some((node) => node.id !== 'note-1' && node.x !== 0));
  const restored = createForceLayout(visible, new Map(layout.nodes.map((node) => [node.id, node])), 40);
  restored.step(); assert.equal(restored.nodes.find((node) => node.id === 'note-1').fx, 100);
});

// A canvas event harness verifies camera/pointer maths without a browser or a network listener.
function canvasHarness(t, reduced = true) {
  const saved = new Map();
  const set = (key, value) => { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  const cleanup = [];
  t.after(() => { cleanup.forEach((dispose) => dispose()); saved.forEach((descriptor, key) => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }); });
  const root = new EventTarget(); root.dataset = {};
  const media = new EventTarget(); media.matches = reduced;
  const frames = new Map(); let nextFrame = 0;
  set('document', { documentElement: root }); set('matchMedia', (query) => query.includes('reduced-motion') ? media : new EventTarget());
  set('requestAnimationFrame', (callback) => { frames.set(++nextFrame, callback); return nextFrame; }); set('cancelAnimationFrame', (id) => frames.delete(id));
  set('ResizeObserver', class { observe() {} disconnect() {} }); set('devicePixelRatio', 1);
  const tokens = { '--space-xl': '40px', '--space-md': '16px', '--space-sm': '8px', '--space-xs': '4px', '--space-6': '6px', '--space-2xs': '2px', '--space-hairline': '1px' };
  set('getComputedStyle', () => ({ getPropertyValue: (key) => tokens[key] || (key.startsWith('--graph-') ? root.dataset.mode === 'dark' ? 'dark-node' : 'light-node' : 'text') }));
  const canvas = new EventTarget(); canvas.clientWidth = 600; canvas.clientHeight = 400;
  const capture = new Set();
  canvas.setPointerCapture = (id) => capture.add(id); canvas.hasPointerCapture = (id) => capture.has(id); canvas.releasePointerCapture = (id) => capture.delete(id);
  canvas.classList = { add() {}, remove() {}, toggle() {} };
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0 });
  const context = { arcs: [], labels: [], strokes: [], draws: 0, setTransform() {}, clearRect() { this.arcs = []; this.labels = []; this.strokes = []; this.draws++; }, beginPath() {}, arc(x, y, r) { this.arcs.push({ x, y, r, alpha: this.globalAlpha, colour: this.fillStyle }); }, rect() {}, fill() {}, stroke() { this.strokes.push(this.lineWidth); }, setLineDash() {}, moveTo() {}, lineTo() {}, fillText(label) { this.labels.push(label); } };
  canvas.getContext = () => context;
  const dispatch = (type, x, y, id = 1, extra = {}) => { const event = new Event(type, { cancelable: true }); Object.assign(event, { pointerId: id, clientX: x, clientY: y, button: 0, ...extra }); canvas.dispatchEvent(event); };
  const flush = () => { for (let count = 0; frames.size && count < 100; count++) { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback()); } };
  return { canvas, context, dispatch, root, media, frames, flush, cleanup };
}
const tiny = { nodes: [{ id: 'a', title: 'Bir', type: 'note', tags: [], degree: 1, ref: '../note/?id=a' }, { id: 'b', title: 'İki', type: 'note', tags: [], degree: 2, ref: '../note/?id=b' }], edges: [{ source: 'a', target: 'b', count: 3 }] };

test('canvas reduced motion paints once; wheel zoom anchors the pointer; pan is retained between draws', (t) => {
  const h = canvasHarness(t); const opened = [];
  const view = createGraph(h.canvas, { onOpen: (node) => opened.push(node.id) });
  h.cleanup.push(() => view.destroy()); view.setGraph(tiny);
  assert.equal(h.context.draws, 1); assert.equal(h.frames.size, 0);
  const before = h.context.arcs[0];
  h.dispatch('wheel', before.x, before.y, 1, { deltaY: -100, deltaMode: 0 });
  assert(Math.abs(h.context.arcs[0].x - before.x) < 1e-9);
  assert(Math.abs(h.context.arcs[0].y - before.y) < 1e-9);
  h.dispatch('pointerdown', 10, 10); h.dispatch('pointermove', 40, 60); h.dispatch('pointerup', 40, 60);
  assert(Math.abs(h.context.arcs[0].x - before.x - 30) < 1e-9);
  assert(Math.abs(h.context.arcs[0].y - before.y - 50) < 1e-9);
  view.setSearch('Bir'); assert(Math.abs(h.context.arcs[0].x - before.x - 30) < 1e-9);
  assert.deepEqual(opened, []);
});

test('canvas drag pins a node across filter rebuilds, click opens, pinch scales, and theme recolours', (t) => {
  const h = canvasHarness(t); const opened = [];
  const view = createGraph(h.canvas, { onOpen: (node) => opened.push(node.id) }); h.cleanup.push(() => view.destroy());
  view.setGraph(tiny);
  const point = h.context.arcs[0];
  h.dispatch('pointerdown', point.x, point.y); h.dispatch('pointermove', point.x + 40, point.y + 20); h.dispatch('pointerup', point.x + 40, point.y + 20);
  assert.deepEqual(opened, []);
  const moved = h.context.arcs[0];
  assert(Math.abs(moved.x - point.x - 40) < 1e-9);
  h.dispatch('pointerdown', moved.x, moved.y); h.dispatch('pointerup', moved.x, moved.y); assert.deepEqual(opened, ['a']);
  h.dispatch('pointerleave', 0, 0);
  const other = h.context.arcs[1];
  h.dispatch('pointerdown', other.x, other.y); h.dispatch('pointermove', other.x - 20, other.y - 10); h.dispatch('pointerup', other.x - 20, other.y - 10);
  h.dispatch('pointerleave', 0, 0); view.setGraph(tiny);
  // Both world positions are pinned; hiding and restoring nodes must preserve their camera geometry.
  const restored = h.context.arcs[0];
  view.setGraph({ nodes: [tiny.nodes[0]], edges: [] }); view.setGraph(tiny);
  assert.deepEqual(h.context.arcs[0], restored);
  const separation = Math.abs(h.context.arcs[0].x - h.context.arcs[1].x);
  h.dispatch('pointerdown', 100, 100, 1); h.dispatch('pointerdown', 300, 100, 2);
  h.dispatch('pointermove', 400, 100, 2); h.dispatch('pointerup', 400, 100, 2); h.dispatch('pointerup', 100, 100, 1);
  assert(Math.abs(h.context.arcs[0].x - h.context.arcs[1].x) > separation);
  h.root.dataset.mode = 'dark'; h.root.dispatchEvent(new Event('themechange'));
  assert.equal(h.context.arcs[0].colour, 'dark-node');
  assert(h.context.strokes.some((width) => width > 1));
});

test('canvas animation terminates and the explicit less-motion setting finishes pending work synchronously', (t) => {
  const h = canvasHarness(t, false); const view = createGraph(h.canvas); h.cleanup.push(() => view.destroy());
  view.setGraph(tiny); h.flush(); assert.equal(h.frames.size, 0);
  view.setGraph(tiny); h.root.dataset.motion = 'less'; h.root.dispatchEvent(new Event('motionchange'));
  assert.equal(h.frames.size, 0);
});

test('canvas hover labels the node and neighbours, fades others, and search leaves geometry unchanged', (t) => {
  const h = canvasHarness(t); const view = createGraph(h.canvas); h.cleanup.push(() => view.destroy());
  view.setGraph({ nodes: [...tiny.nodes, { id: 'c', title: 'Üç', type: 'note', tags: [], degree: 0 }], edges: tiny.edges });
  const before = h.context.arcs.map(({ x, y }) => [x, y]);
  const point = h.context.arcs[0]; h.dispatch('pointermove', point.x, point.y);
  assert(h.context.labels.includes('Bir')); assert(h.context.labels.includes('İki')); assert(!h.context.labels.includes('Üç'));
  assert(h.context.arcs.some((arc) => arc.alpha === 0.15));
  h.dispatch('pointerleave', 0, 0); view.setSearch('Üç');
  assert.deepEqual(h.context.arcs.map(({ x, y }) => [x, y]), before);
  assert.equal(h.context.arcs[0].alpha, 0.15); assert.equal(h.context.arcs[2].alpha, 1);
});
