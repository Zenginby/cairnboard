import { $, el, loadData, setupUI, renderState } from '../_shared/app-ui.js';
import { buildGraph, filterGraph, graphOptions, graphDescription, matchesGraph } from '../_shared/graph-data.js';
import { createGraph } from '../_shared/graph-layout.js';

let data;
let fixture;
let ui;
let state = 'full';
let visible;
const controls = { type: 'type', kind: 'kind', project: 'project', tag: 'tag', orphans: 'orphans', ghosts: 'ghosts', journals: 'journals', cards: 'cards', tags: 'labels', q: 'search' };
const copy = {
  empty: ['Grafikte gösterilecek varlık yok', 'Bir not yazıp başka bir nota [[bağlantı]] ver; bağlantı burada görünsün.', 'İlk notu ekle'],
  loading: ['Bağlantılar okunuyor', 'Sayfalardaki bağlantılar ve etiketler toplanıyor.'],
  error: ['Bağlantılar okunamadı', 'Bağlantı dizini açılamadı. Yeniden dene; sorun sürerse cairn index komutunu çalıştır.'],
};
const options = () => graphOptions(new URLSearchParams(location.search));
const graph = createGraph($('#graph-canvas'), {
  tooltip: $('#graph-tooltip'),
  announce: (message) => ui.announce(message),
  onOpen(node) {
    if (node.type === 'tag') { $('#graph-search').value = node.title; saveFilters(false); }
    else if (node.ref) location.assign(node.ref);
    else ui.announce(graphDescription(node));
  },
});
function restoreControls() {
  const values = options();
  Object.entries(controls).forEach(([key, id]) => {
    const input = $(`#graph-${id}`);
    if (input.type === 'checkbox') input.checked = values[key];
    else {
      // Preserve unknown query values as visible filters rather than silently displaying “Tümü”.
      if (input.tagName === 'SELECT' && values[key] && ![...input.options].some((item) => item.value === values[key])) {
        const option = el('option', '', values[key]); option.value = values[key]; input.append(option);
      }
      input.value = values[key];
    }
  });
}
function saveFilters(relayout = true) {
  const url = new URL(location.href);
  const defaults = graphOptions(new URLSearchParams());
  Object.entries(controls).forEach(([key, id]) => {
    const input = $(`#graph-${id}`);
    const value = input.type === 'checkbox' ? input.checked : input.value;
    if (value === defaults[key]) url.searchParams.delete(key);
    else url.searchParams.set(key, typeof value === 'boolean' ? value ? '1' : '0' : value);
  });
  if (url.href !== location.href) history.pushState(null, '', url);
  refresh(relayout);
}
function renderList() {
  const query = options().q;
  const list = $('#graph-list');
  list.replaceChildren(...visible.nodes.map((node) => {
    const item = el('li', 'graph-list-item');
    item.classList.toggle('is-dim', !matchesGraph(node, query));
    const title = el(node.ref ? 'a' : 'span', 'graph-list-title', node.title);
    if (node.ref) title.href = node.ref;
    const project = data.projects.find((record) => record.id === node.project);
    item.append(title, el('p', 'graph-list-meta', [graphDescription(node), project?.name].filter(Boolean).join(' · ')));
    const links = visible.edges.filter((edge) => edge.source === node.id || edge.target === node.id);
    if (links.length) {
      const sub = el('ul', 'graph-links');
      links.forEach((edge) => {
        const other = visible.nodes.find((record) => record.id === (edge.source === node.id ? edge.target : edge.source));
        const row = el('li');
        const link = el(other.ref ? 'a' : 'span', '', `${other.title} · ${edge.count} bağlantı`);
        if (other.ref) link.href = other.ref;
        row.append(link); sub.append(row);
      });
      item.append(sub);
    } else item.append(el('p', 'type-label muted', 'Bu görünümde bağlantısı yok.'));
    return item;
  }));
  if (!visible.nodes.length) list.append(el('li', 'muted', 'Süzgeçlere uyan varlık yok. Tür, proje veya etiket süzgecini genişlet.'));
}
function refresh(relayout = true) {
  if (!data || ['empty', 'loading', 'error'].includes(state)) return;
  const values = options();
  if (relayout) {
    const all = buildGraph(data, fixture);
    if (state === 'long') all.nodes.forEach((node) => { node.title += ` — ${data.longText.title}`; });
    visible = filterGraph(all, values);
    graph.setGraph(visible, { focus: values.focus, search: values.q });
  } else graph.setSearch(values.q);
  renderList();
  $('#graph-summary').textContent = `${visible.nodes.length} düğüm · ${visible.edges.length} bağlantı`;
  $('#graph-canvas').setAttribute('aria-label', `Bağlantı grafiği: ${visible.nodes.length} düğüm, ${visible.edges.length} bağlantı. Ayrıntılar Liste görünümünde.`);
  $('#graph-filter-count').textContent = values.q ? `${visible.nodes.filter((node) => matchesGraph(node, values.q)).length} düğüm vurgulandı` : '';
  $('#graph-limit').hidden = !visible.truncated;
  $('#graph-limit').textContent = `Süzgeci daralt · ${visible.total} düğümün en çok geri bağlantı alan ${visible.nodes.length} tanesi gösteriliyor.`;
}
function setState(value) {
  state = value;
  $('#prototype-state').value = value;
  renderState(value, () => setState('full'), (event) => ui.create('note', event?.detail === 0), copy);
  if (['empty', 'loading', 'error'].includes(value)) graph.setGraph({ nodes: [], edges: [] });
  else refresh();
}
Object.entries(controls).forEach(([key, id]) => $(`#graph-${id}`).addEventListener(key === 'q' ? 'input' : 'change', () => saveFilters(key !== 'q')));
addEventListener('popstate', () => { restoreControls(); refresh(); });
$('#graph-zoom-in').addEventListener('click', () => graph.zoom(1.25));
$('#graph-zoom-out').addEventListener('click', () => graph.zoom(0.8));
$('#graph-fit').addEventListener('click', () => graph.fit());
async function start() {
  try {
    const [loaded, response] = await Promise.all([loadData('../_shared/workspace.json'), fetch('data.json')]);
    if (!response.ok) throw new Error('Graph data unavailable');
    data = loaded; fixture = await response.json();
    ui = setupUI(data, () => state === 'empty' ? setState('full') : refresh(), (instant) => ui.create('card', instant));
    data.projects.forEach((project) => { const option = el('option', '', project.name); option.value = project.id; $('#graph-project').append(option); });
    [...new Set(buildGraph(data, fixture).nodes.flatMap((node) => node.tags))].sort((a, b) => a.localeCompare(b, 'tr')).forEach((tag) => {
      const option = el('option', '', `#${tag}`); option.value = tag; $('#graph-tag').append(option);
    });
    restoreControls();
    $('#prototype-state').addEventListener('change', (event) => setState(event.target.value));
    setState('full');
  } catch {
    renderState('error', start, null, copy);
  }
}
start();
