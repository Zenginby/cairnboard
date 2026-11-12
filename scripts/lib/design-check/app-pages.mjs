import * as index from '../../../core/index.mjs';

export const MISSING_PATH = '/no-such-page';

// Pages are picked from the data itself, never by hard-coded id: the first card and first note in id order.
export function selectAppPages(ctx, only = null) {
  const first = (type) => index.rows(ctx, type).filter((row) => row.id).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  const card = first('card');
  const note = first('note');
  const project = first('project');
  if (!card || !note) throw new Error('The data folder needs at least one card and one note with an id.');
  // A word that is certain to match: the first word of the first note's title.
  const word = String(note.title ?? '').trim().split(/\s+/u)[0];
  if (!word) throw new Error('The first note needs a title to search for.');
  const pages = [
    { name: 'home', path: '/' },
    { name: 'board', path: '/board' },
    { name: 'card', path: `/cards/${encodeURIComponent(card.id)}` },
    { name: 'note', path: `/notes/${encodeURIComponent(note.id)}` },
    // `noscript`: the page is also loaded with JavaScript off and must still list results (plain GET form).
    { name: 'search', path: `/search?q=${encodeURIComponent(word)}`, noscript: true },
    { name: 'search-empty', path: '/search?q=zzzzqqq' },
    // `interaction`: not a layout case; scripts/lib/design-check/search-dialog.mjs drives the ⌘K dialog.
    { name: 'search-dialog', path: '/', interaction: 'search-dialog' },
    { name: 'not-found', path: MISSING_PATH, status: 404 },
    { name: 'signed-out', path: '/', status: 401, auth: false },
    { name: 'settings', path: '/settings' },
    { name: 'cards-new', path: '/cards/new' },
    { name: 'card-edit', path: `/cards/${encodeURIComponent(card.id)}/edit` },
    { name: 'agents', path: '/agents' },
    { name: 'projects', path: '/projects' },
    ...(project ? [{ name: 'project', path: `/projects/${encodeURIComponent(project.id)}` }] : []),
  ];
  if (only === null) return pages;
  const selected = pages.filter((page) => page.name === only);
  if (!selected.length) throw new Error(`Unknown page: ${only}. Available: ${pages.map((page) => page.name).join(', ')}`);
  return selected;
}

export function buildAppMatrix({ quick = false } = {}) {
  const widths = quick ? [1280] : [375, 1280];
  return widths.flatMap((width) => (quick ? ['light'] : ['light', 'dark']).map((mode) => ({ width, family: 'app', mode })));
}
