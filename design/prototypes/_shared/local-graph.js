import { el, button } from './app-ui.js';
import { buildGraph, filterGraph, graphOptions, localGraph, graphDescription } from './graph-data.js';
import { createGraph } from './graph-layout.js';

// Mounted only on document pages that opt in; refreshing a document reuses the canvas and fixed positions.
export function createLocalGraph() {
  const panel = el('details', 'local-graph');
  panel.id = 'local-graph';
  const summary = el('summary', 'type-label', 'Yerel grafik');
  const content = el('div', 'local-graph-content');
  const depth = el('select'); depth.id = 'local-graph-depth';
  [[1, '1 adım'], [2, '2 adım']].forEach(([value, title]) => { const option = el('option', '', title); option.value = value; depth.append(option); });
  const label = el('label', 'field type-label', 'Komşuluk derinliği'); label.append(depth);
  const canvas = el('canvas', 'graph-canvas'); canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Yerel bağlantı grafiği. Bağlantılar aşağıdaki listede.');
  const tooltip = el('p', 'graph-tooltip'); tooltip.hidden = true;
  const links = el('ul', 'local-graph-links'); links.setAttribute('aria-label', 'Yerel grafik bağlantıları');
  const open = el('a', 'local-graph-open', 'Grafikte aç');
  const tools = el('div', 'graph-tools');
  let graph;
  tools.append(button('Grafiği sığdır', () => graph.fit()));
  content.append(label, canvas, tooltip, tools, links, open); panel.append(summary, content);
  document.querySelector('.doc-aside').append(panel);
  graph = createGraph(canvas, { tooltip });
  const wide = matchMedia('(min-width: 72rem)');
  panel.open = wide.matches;
  wide.addEventListener('change', () => { panel.open = wide.matches; });
  panel.addEventListener('toggle', () => { if (panel.open) graph.fit(); });
  let data;
  let fixture;
  let id;
  function render() {
    if (!data) return;
    const source = filterGraph(buildGraph(data, fixture), graphOptions(new URLSearchParams()));
    const visible = localGraph(source, id, Number(depth.value));
    graph.setGraph(visible, { focus: id });
    links.replaceChildren(...visible.nodes.map((node) => {
      const row = el('li');
      const anchor = el(node.ref ? 'a' : 'span', '', node.title);
      if (node.ref) anchor.href = node.ref;
      if (node.id === id) anchor.setAttribute('aria-current', 'page');
      row.append(anchor); row.title = graphDescription(node);
      if (node.ghost || node.ignored) row.append(el('span', 'muted', ` · ${node.ambiguous ? 'Belirsiz hedef' : node.ghost ? 'Çözülmemiş hedef' : 'ignore altında'}`));
      return row;
    }));
    open.href = `../graph/?focus=${encodeURIComponent(id)}`;
  }
  depth.addEventListener('change', render);
  return { update(nextData, nextFixture, nextId) { data = nextData; fixture = nextFixture; id = nextId; render(); } };
}
