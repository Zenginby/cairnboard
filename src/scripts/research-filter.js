import { normalizeSearch } from './search-text.js';

/**
 * Resolves the display type label for a research item: trimmed `category` if present, otherwise translated `kind`.
 * @param {{ category?: string | null, kind?: string | null, content?: { category?: string | null },
 *   meta?: { kind?: string | null } }} item
 * @param {{ kindLabels?: Record<string, string>, untypedLabel?: string }} [options]
 */
export function researchTypeLabel(item, { kindLabels = {}, untypedLabel = '' } = {}) {
  const category = item?.category ?? item?.content?.category;
  if (typeof category === 'string' && category.trim()) return category.trim();
  const kind = item?.kind ?? item?.meta?.kind;
  if (typeof kind === 'string' && Object.hasOwn(kindLabels, kind) && kindLabels[kind]) return kindLabels[kind];
  if (typeof kind === 'string' && kind.trim()) return kind.trim();
  return untypedLabel;
}

/**
 * Derives sorted type groups `{ value, label, count }` from research items without hardcoding categories.
 * @param {Array<object>} items
 * @param {{ kindLabels?: Record<string, string>, untypedLabel?: string, locale?: string }} [options]
 */
export function deriveResearchTypes(items, { kindLabels = {}, untypedLabel = '', locale = 'tr' } = {}) {
  const counts = new Map();
  for (const item of items) {
    const label = researchTypeLabel(item, { kindLabels, untypedLabel });
    if (!label) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
  return [...counts.entries()]
    .map(([label, count]) => ({ value: label, label, count }))
    .sort((a, b) => collator.compare(a.label, b.label));
}

/**
 * Filters research items by title query, project id, and derived type label, returning matching items and facet counts.
 * @param {Array<{ title?: string, project?: string | null, type?: string }>} items
 * @param {{ query?: string, project?: string, type?: string, locale?: string }} [selection]
 * @param {string[]} [typeKeys]
 */
export function filterResearchItems(items, selection = {}, typeKeys = []) {
  const locale = selection.locale || 'tr';
  const query = normalizeSearch(selection.query, locale);
  const project = selection.project || '';
  const type = selection.type || '';
  const typeCounts = Object.fromEntries(typeKeys.map((key) => [key, 0]));
  const visible = [];
  let allCount = 0;

  for (const item of items) {
    if (project && (item.project || '') !== project) continue;
    if (query && !normalizeSearch(item.title || '', locale).includes(query)) continue;
    allCount += 1;
    const itemType = item.type || '';
    if (itemType) typeCounts[itemType] = (typeCounts[itemType] ?? 0) + 1;
    if (type && itemType !== type) continue;
    visible.push(item);
  }

  return { visible, total: visible.length, allCount, typeCounts };
}

function formatSummary(singular, plural, count) {
  if (count === 1 && singular) return singular;
  return plural.replace('{n}', String(count));
}

function initResearchFilter() {
  const state = { query: '', project: '', type: '' };

  const apply = () => {
    const page = document.querySelector('[data-research-page]');
    if (!page) return;
    const toolbar = page.querySelector('[data-research-toolbar]');
    const list = page.querySelector('[data-research-list]');
    if (!toolbar || !list) return;

    const searchInput = toolbar.querySelector('[data-research-search]');
    const projectSelect = toolbar.querySelector('[data-research-project]');
    const typeButtons = [...toolbar.querySelectorAll('[data-filter-type]')];
    const locale = page.dataset.locale || 'tr';

    if (searchInput instanceof HTMLInputElement && searchInput.value !== state.query) {
      searchInput.value = state.query;
    }
    if (projectSelect instanceof HTMLSelectElement) {
      const validProject = [...projectSelect.options].some((option) => option.value === state.project);
      if (!validProject) state.project = '';
      if (projectSelect.value !== state.project) projectSelect.value = state.project;
    }
    if (state.type && !typeButtons.some((btn) => btn.dataset.filterType === state.type)) {
      state.type = '';
    }

    const typeKeys = typeButtons.map((btn) => btn.dataset.filterType || '').filter(Boolean);
    const rows = [...list.querySelectorAll('[data-research-row]')];
    const items = rows.map((el) => ({
      el,
      title: el.dataset.title || '',
      project: el.dataset.project || '',
      type: el.dataset.type || '',
    }));

    const result = filterResearchItems(items, { ...state, locale }, typeKeys);
    const visibleSet = new Set(result.visible.map((item) => item.el));
    for (const row of rows) {
      row.classList.toggle('hidden', !visibleSet.has(row));
    }

    for (const btn of typeButtons) {
      const key = btn.dataset.filterType || '';
      btn.setAttribute('aria-pressed', String(key === state.type));
      const badge = btn.querySelector('[data-type-count]');
      if (badge) {
        const nextCount = key ? (result.typeCounts[key] ?? 0) : result.allCount;
        badge.textContent = String(nextCount);
      }
    }

    const emptyFiltered = page.querySelector('[data-research-empty-filtered]');
    if (emptyFiltered) {
      emptyFiltered.classList.toggle('hidden', result.total > 0);
    }

    const summary = page.querySelector('[data-research-summary]');
    if (summary) {
      const plural = summary.dataset.template || '{n}';
      const singular = summary.dataset.templateSingle || '';
      summary.textContent = formatSummary(singular, plural, result.total);
    }
  };

  document.addEventListener('input', (event) => {
    if (!(event.target instanceof HTMLInputElement)) return;
    if (!event.target.matches('[data-research-search]')) return;
    state.query = event.target.value;
    apply();
  });

  document.addEventListener('change', (event) => {
    if (!(event.target instanceof HTMLSelectElement)) return;
    if (!event.target.matches('[data-research-project]')) return;
    state.project = event.target.value;
    apply();
  });

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const btn = event.target.closest('[data-filter-type]');
    if (!btn || !btn.closest('[data-research-toolbar]')) return;
    const next = btn.dataset.filterType || '';
    state.type = next && state.type === next ? '' : next;
    apply();
  });

  document.addEventListener('live:updated', apply);
}

if (typeof document !== 'undefined') initResearchFilter();
