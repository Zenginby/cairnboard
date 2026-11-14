// Tools screen filters: search across name, description, project and kind, one kind at a time, "no description" and
// "unused". Rows stay in the HTML, so the page works without script; this hides rows and updates counts.

import { normalizeSearch } from './search-text.js';

/**
 * @param {Array<{ name?: string, description?: string, project?: string, kind?: string,
 *   described?: boolean, used?: boolean | null }>} items
 * @param {{ query?: string, kind?: string, undescribed?: boolean, unused?: boolean, locale?: string }} [selection]
 * @param {string[]} [kindKeys]
 */
export function filterTools(items, selection = {}, kindKeys = []) {
  const locale = selection.locale || 'tr';
  const query = normalizeSearch(selection.query, locale);
  const kindCounts = Object.fromEntries(kindKeys.map((key) => [key, 0]));
  const flagCounts = { undescribed: 0, unused: 0 };
  const visible = [];
  let allCount = 0;
  for (const item of items) {
    const haystack = normalizeSearch(
      [item.name, item.description, item.project, item.kind].filter(Boolean).join(' '),
      locale,
    );
    if (query && !haystack.includes(query)) continue;
    const kind = item.kind || '';
    // Count each flag as if only the other filters were active so the badge shows how many rows it would keep.
    if (!selection.kind || kind === selection.kind) {
      if (!item.described && (!selection.unused || item.used === false)) flagCounts.undescribed += 1;
      if (item.used === false && (!selection.undescribed || !item.described)) flagCounts.unused += 1;
    }
    if (selection.undescribed && item.described) continue;
    if (selection.unused && item.used !== false) continue;
    allCount += 1;
    if (kind) kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
    if (selection.kind && kind !== selection.kind) continue;
    visible.push(item);
  }
  return { visible, total: visible.length, allCount, kindCounts, flagCounts };
}

function initToolsFilter() {
  const state = { query: '', kind: '', undescribed: false, unused: false };

  const apply = () => {
    const page = document.querySelector('[data-tools-page]');
    const list = page?.querySelector('[data-tools-list]');
    if (!page || !list) return;
    const kindButtons = [...page.querySelectorAll('[data-filter-kind]')];
    if (state.kind && !kindButtons.some((btn) => btn.dataset.filterKind === state.kind)) state.kind = '';
    const rows = [...list.querySelectorAll('[data-tool-row]')];
    const items = rows.map((el) => ({
      el,
      name: el.dataset.name || '',
      description: el.dataset.description || '',
      project: el.dataset.project || '',
      kind: el.dataset.kind || '',
      described: el.dataset.described === '1',
      used: el.dataset.used === '' || el.dataset.used === undefined ? null : el.dataset.used === '1',
    }));
    const kindKeys = kindButtons.map((btn) => btn.dataset.filterKind || '').filter(Boolean);
    const result = filterTools(items, { ...state, locale: page.dataset.locale || 'tr' }, kindKeys);
    const visible = new Set(result.visible.map((item) => item.el));
    for (const row of rows) row.classList.toggle('hidden', !visible.has(row));
    for (const btn of kindButtons) {
      const key = btn.dataset.filterKind || '';
      btn.setAttribute('aria-pressed', String(key === state.kind));
      const badge = btn.querySelector('[data-kind-count]');
      if (badge) badge.textContent = String(key ? (result.kindCounts[key] ?? 0) : result.allCount);
    }
    for (const btn of page.querySelectorAll('[data-filter-flag]')) {
      const key = btn.dataset.filterFlag;
      btn.setAttribute('aria-pressed', String(Boolean(state[key])));
      const badge = btn.querySelector('[data-flag-count]');
      if (badge && key) badge.textContent = String(result.flagCounts[key] ?? 0);
    }
    // A kind group with no visible row hides its heading too.
    for (const group of list.querySelectorAll('[data-tool-group]')) {
      group.classList.toggle('hidden', !group.querySelector('[data-tool-row]:not(.hidden)'));
    }
    page.querySelector('[data-tools-empty-filtered]')?.classList.toggle('hidden', result.total > 0);
    const summary = page.querySelector('[data-tools-summary]');
    if (summary) {
      const template = result.total === 1 && summary.dataset.templateSingle
        ? summary.dataset.templateSingle : summary.dataset.template || '{n}';
      summary.textContent = template.replace('{n}', String(result.total));
    }
  };

  document.addEventListener('input', (event) => {
    if (!(event.target instanceof HTMLInputElement) || !event.target.matches('[data-tools-search]')) return;
    state.query = event.target.value;
    apply();
  });
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const kind = event.target.closest('[data-filter-kind]');
    const flag = event.target.closest('[data-filter-flag]');
    if (kind?.closest('[data-tools-page]')) {
      const next = kind.dataset.filterKind || '';
      state.kind = next && state.kind === next ? '' : next;
      apply();
    } else if (flag?.closest('[data-tools-page]')) {
      const key = flag.dataset.filterFlag;
      if (key === 'undescribed' || key === 'unused') state[key] = !state[key];
      apply();
    }
  });
  document.addEventListener('live:updated', apply);
}

if (typeof document !== 'undefined') initToolsFilter();
