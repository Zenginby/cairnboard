import { parseWikiLink } from './wiki-links.js';

// Journal data model, mirroring core/journal.mjs: a day file holds sections `## <title> · <label>`, each a list of
// bullet items typed decision / discovery / pitfall / lesson (or untyped). The core stores no per-entry time or author.
//   section: { id, date, title, label?, items: [{ type?, text }] }
// The core has no project field either. Assumption (confirm in stage C): a section belongs to the project named by the
// first `[[project-id]]` wiki link in its heading or items.
export const journalTypes = { decision: 'Karar', discovery: 'Keşif', pitfall: 'Tuzak', lesson: 'Ders' };
// Same target rule as core/links.mjs linkTarget: `[[target|Label]]` and `[[target#Heading]]` name `target`.
export function linkTargets(text) {
  return Array.from(String(text).matchAll(/\[\[([^[\]\n]+)\]\]/gu), (match) => parseWikiLink(match[1]).target).filter(Boolean);
}
export function sectionProjectId(section, projects) {
  const ids = new Set(projects.map((project) => project.id));
  return linkTargets([section.title, section.label || '', ...section.items.map((item) => item.text)].join('\n')).find((target) => ids.has(target)) || '';
}
export const sectionHeading = (section) => section.label ? `${section.title} · ${section.label}` : section.title;
export const itemMarkdown = (item) => `- ${item.type ? `**${journalTypes[item.type]}:** ` : ''}${item.text}`;
export const sectionMarkdown = (section) => `## ${sectionHeading(section)}\n\n${section.items.map(itemMarkdown).join('\n')}`;
export const sectionText = (section) => section.items.map((item) => item.text.replace(/\[\[([^[\]|#\n]+)(?:#[^[\]|\n]*)?(?:\|([^[\]\n]+))?\]\]/gu, (all, target, label) => label || target)).join(' ');
