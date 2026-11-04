import { hrefFor } from './search-results.js';

export const graphTypes = { note: 'Not', wiki: 'Wiki', project: 'Proje', research: 'Araştırma', journal: 'Günlük', card: 'Kart', raw: 'Ham kaynak', tag: 'Etiket' };
export const graphKinds = { note: 'Not', concept: 'Kavram', reference: 'Kaynak', index: 'Dizin' };
export const matchesGraph = (node, query) => `${node.title} ${(node.tags || []).join(' ')}`.toLocaleLowerCase('tr').includes(query.trim().replace(/^#/, '').toLocaleLowerCase('tr'));
export const graphStatus = (node) => node.ambiguous ? 'Belirsiz hedef' : node.ghost ? 'Çözülmemiş hedef' : node.ignored ? 'ignore altında' : graphKinds[node.kind] || graphTypes[node.type];
export const graphDescription = (node) => `${node.title} · ${graphStatus(node)} · ${node.degree} geri bağlantı`;

// Input links are directed occurrences; drawing edges are undirected, aggregated pairs.
export function buildGraph(data, fixture) {
  const records = [...new Map([...fixture.notes, ...data.notes].filter((note) => note.title).map((note) => [note.id, note])).values()];
  const nodes = records.map((note) => ({ id: note.id, ref: hrefFor(note), title: note.title, type: note.kind === 'research' ? 'research' : note.kind === 'wiki' ? 'wiki' : 'note', kind: fixture.kinds[note.id] || (note.kind === 'note' ? 'note' : ''), project: note.projectId || '', tags: note.tags || fixture.tags[note.id] || [], degree: 0 }));
  data.projects.forEach((project) => nodes.push({ id: project.id, ref: `../project/?project=${encodeURIComponent(project.id)}`, title: project.name, type: 'project', project: project.id, tags: [], degree: 0 }));
  data.cards.forEach((card) => nodes.push({ id: card.id, ref: hrefFor({ ...card, kind: 'card' }), title: card.title, type: 'card', project: card.projectId, tags: [], degree: 0 }));
  // One node per daily file, even when the file contains several journal sections.
  [...new Set(data.journal.map((entry) => entry.date))].forEach((date) => nodes.push({ id: `journal:${date}`, ref: hrefFor({ kind: 'journal', day: date }), title: `${date} günlüğü`, type: 'journal', project: '', tags: [], degree: 0 }));
  nodes.push(...fixture.nodes.map((node) => ({ tags: [], degree: 0, ...node })));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const pairs = new Map();
  fixture.links.forEach(([source, target]) => {
    if (!byId.has(source) || !byId.has(target)) return;
    byId.get(target).degree++;
    const key = JSON.stringify([source, target].sort());
    if (pairs.has(key)) pairs.get(key).count++;
    else pairs.set(key, { source, target, count: 1 });
  });
  return { nodes, edges: [...pairs.values()], truncated: false };
}

export function graphOptions(params) {
  const requestedLimit = Number(params.get('limit'));
  return {
    type: params.get('type') || '', kind: params.get('kind') || '', project: params.get('project') || '', tag: params.get('tag') || '',
    orphans: params.get('orphans') !== '0', ghosts: params.get('ghosts') !== '0', journals: params.get('journals') === '1', cards: params.get('cards') === '1',
    tags: params.get('tags') === '1', q: params.get('q') || '', focus: params.get('focus') || '',
    limit: Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 3000) : 3000,
  };
}
export function filterGraph(graph, options) {
  const connected = new Set(graph.edges.flatMap((edge) => [edge.source, edge.target]));
  let nodes = graph.nodes.filter((node) => (!options.type || node.type === options.type) && (!options.kind || node.kind === options.kind)
    && (!options.project || node.project === options.project) && (!options.tag || node.tags.includes(options.tag))
    && (options.orphans || connected.has(node.id)) && (options.ghosts || !node.ghost)
    && (options.journals || node.type !== 'journal') && (options.cards || node.type !== 'card'));
  let edges = [...graph.edges];
  if (options.tags) {
    const tags = [...new Set(nodes.flatMap((node) => node.tags))].sort((a, b) => a.localeCompare(b, 'tr'));
    const entities = nodes;
    nodes = [...nodes, ...tags.map((tag) => ({ id: `tag:${tag}`, title: `#${tag}`, type: 'tag', tags: [tag], degree: 0 }))];
    entities.forEach((node) => node.tags.forEach((tag) => edges.push({ source: node.id, target: `tag:${tag}`, count: 1 })));
  }
  const total = nodes.length;
  const truncated = graph.truncated || total > options.limit;
  if (total > options.limit) nodes = [...nodes].sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id)).slice(0, options.limit);
  const ids = new Set(nodes.map((node) => node.id));
  edges = edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  return { nodes, edges, truncated, total };
}
export function localGraph(graph, id, depth = 1) {
  const ids = new Set([id]);
  for (let step = 0; step < depth; step++) {
    const next = new Set(ids);
    graph.edges.forEach(({ source, target }) => { if (ids.has(source)) next.add(target); if (ids.has(target)) next.add(source); });
    next.forEach((nodeId) => ids.add(nodeId));
  }
  return { nodes: graph.nodes.filter((node) => ids.has(node.id)), edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)), truncated: false };
}
