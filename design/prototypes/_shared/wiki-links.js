// Wiki links resolved the way core/links.mjs and the core index do: `[[target|Label]]` shows Label and resolves
// `target`; `[[target#Heading]]` resolves `target`. Resolution is by file name (no `/`) or path (with `/`), case-folded,
// never by display title. Fixture files: notes/<id>.md, research/<id>.md, cards/<id>.md; a project is addressed by its
// id (projects/<id>/index.md would otherwise all be named "index").
export function parseWikiLink(inner) {
  const [expr, ...label] = inner.split('|');
  const [target, ...heading] = expr.split('#');
  const name = target.trim().replace(/\.md$/iu, '').normalize('NFC');
  return { target: name, heading: heading.length ? heading.join('#').trim() : null, label: label.length ? label.join('|').trim() : null };
}
const key = (value) => value.replace(/\\/g, '/').normalize('NFC').toLowerCase();
function files(data) {
  const notes = (data.notes || []).filter((record) => !record.trashed).map((record) => ({ path: `${record.kind === 'research' ? 'research' : 'notes'}/${record.id}`, name: record.id, href: `../${record.kind === 'research' ? 'research-item' : 'note'}/?id=${encodeURIComponent(record.id)}` }));
  const cards = (data.cards || []).filter((record) => !record.trashed).map((record) => ({ path: `cards/${record.id}`, name: record.id, href: `../card/?id=${encodeURIComponent(record.id)}` }));
  const projects = (data.projects || []).map((record) => ({ path: `projects/${record.id}`, name: record.id, href: `../project/?project=${encodeURIComponent(record.id)}` }));
  return [...notes, ...cards, ...projects];
}
// → { label, href, status: 'resolved' | 'ambiguous' | 'unresolved' }; href is null unless resolved.
export function resolveWikiLink(inner, data) {
  const { target, label } = parseWikiLink(inner);
  const wanted = key(target);
  const hits = target ? files(data).filter((file) => key(wanted.includes('/') ? file.path : file.name) === wanted) : [];
  return { label: label || inner.split('#')[0].trim() || inner, href: hits.length === 1 ? hits[0].href : null, status: hits.length === 1 ? 'resolved' : hits.length ? 'ambiguous' : 'unresolved' };
}
