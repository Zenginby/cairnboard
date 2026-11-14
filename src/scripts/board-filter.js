import { normalizeSearch } from './search-text.js';

const PRIORITIES = ['urgent', 'important', 'low'];

/**
 * Filters board cards by search text, project and priority and computes per-column and per-priority counts.
 * Priority counts follow the search and project choice but not the priority choice, so each pill shows what it
 * would leave; the '' key is the total for "All".
 * @param {Array<{ column: string, project?: string | null, priority?: string | null, text?: string }>} cards
 * @param {{ project?: string, priority?: string, query?: string, locale?: string }} [selection]
 * @param {string[]} [columnKeys]
 */
export function filterBoardCards(cards, selection = {}, columnKeys = []) {
  const locale = selection.locale || 'tr';
  const project = selection.project || '';
  const priority = selection.priority || '';
  const query = normalizeSearch(selection.query, locale);
  const counts = Object.fromEntries(columnKeys.map((key) => [key, 0]));
  const priorityCounts = Object.fromEntries(['', ...PRIORITIES].map((key) => [key, 0]));
  const visible = [];
  for (const card of cards) {
    if (project && (card.project || '') !== project) continue;
    if (query && !normalizeSearch(card.text || '', locale).includes(query)) continue;
    priorityCounts[''] += 1;
    if (card.priority) priorityCounts[card.priority] = (priorityCounts[card.priority] ?? 0) + 1;
    if (priority && (card.priority || '') !== priority) continue;
    visible.push(card);
    counts[card.column] = (counts[card.column] ?? 0) + 1;
  }
  return { visible, total: visible.length, counts, priorityCounts };
}

function formatSummary(template, cardsCount, columnsCount) {
  return template.replace('{n}', String(cardsCount)).replace('{m}', String(columnsCount));
}

// What a search matches: the title, the status values (not their labels) and the project's name.
function cardText(element, projectNames) {
  const parts = [element.querySelector('h3')?.textContent ?? ''];
  for (const value of element.querySelectorAll('.status-line dd')) parts.push(value.textContent ?? '');
  parts.push(projectNames.get(element.dataset.cardProject || '') ?? '');
  // Tags are not shown on the card, but a search for one (say "bekliyor") still finds it.
  parts.push(element.dataset.cardTags ?? '');
  return parts.join(' ');
}

function initBoardFilter() {
  const state = { project: '', priority: '', query: '' };

  const apply = () => {
    const toolbar = document.querySelector('[data-board-toolbar]');
    const board = document.querySelector('.board');
    if (!toolbar || !board) return;

    const search = toolbar.querySelector('[data-board-search]');
    const select = toolbar.querySelector('[data-board-project]');
    const priorityPills = [...toolbar.querySelectorAll('[data-filter-priority]')];
    const options = select instanceof HTMLSelectElement ? [...select.options] : [];
    if (state.project && !options.some((option) => option.value === state.project)) state.project = '';
    if (state.priority && !priorityPills.some((pill) => pill.dataset.filterPriority === state.priority)) {
      state.priority = '';
    }
    // A live update re-renders the toolbar; put the owner's choices back.
    if (search instanceof HTMLInputElement && search.value !== state.query) search.value = state.query;
    if (select instanceof HTMLSelectElement && select.value !== state.project) select.value = state.project;
    const projectNames = new Map(options.filter((option) => option.value)
      .map((option) => [option.value, option.textContent ?? '']));

    const columns = [...board.querySelectorAll('[data-board-column]')];
    const columnKeys = columns.map((column) => column.dataset.columnKey || '');
    const cards = [];
    for (const column of columns) {
      const key = column.dataset.columnKey || '';
      for (const element of column.querySelectorAll('[data-board-card]')) {
        cards.push({
          element,
          column: key,
          project: element.dataset.cardProject || '',
          priority: element.dataset.cardPriority || '',
          text: cardText(element, projectNames),
        });
      }
    }

    const active = Boolean(state.project || state.priority || normalizeSearch(state.query));
    const locale = document.documentElement.lang || 'tr';
    const result = filterBoardCards(cards, { ...state, locale }, columnKeys);
    const visibleSet = new Set(result.visible);

    for (const card of cards) {
      card.element.hidden = !visibleSet.has(card);
    }

    for (const pill of priorityPills) {
      const value = pill.dataset.filterPriority || '';
      pill.setAttribute('aria-pressed', String(value === state.priority));
      const count = pill.querySelector('[data-priority-count]');
      if (count) count.textContent = String(result.priorityCounts[value] ?? 0);
    }

    for (const column of columns) {
      const key = column.dataset.columnKey || '';
      const visibleCount = result.counts[key] ?? 0;
      const countEl = column.querySelector('[data-column-count]');
      const recentEl = column.querySelector('[data-column-recent]');
      const listEl = column.querySelector('[data-column-list]');
      const emptyEl = column.querySelector('[data-column-empty]');
      if (countEl) {
        countEl.textContent = String(active ? visibleCount : (column.dataset.columnTotal ?? visibleCount));
      }
      if (recentEl) recentEl.hidden = active;
      if (listEl) listEl.hidden = visibleCount === 0;
      if (emptyEl) emptyEl.hidden = visibleCount > 0;
    }

    const clear = toolbar.querySelector('[data-board-clear]');
    if (clear) clear.hidden = !active;

    const summaryEl = toolbar.querySelector('[data-board-summary]');
    if (summaryEl) {
      const template = summaryEl.dataset.template || '{n} kart · {m} sütun';
      const total = active ? result.total : Number(summaryEl.dataset.totalCards ?? result.total);
      const columnCount = Number(summaryEl.dataset.columnCount ?? columns.length);
      summaryEl.textContent = formatSummary(template, total, columnCount);
    }
  };

  document.addEventListener('input', (event) => {
    if (!(event.target instanceof HTMLInputElement) || !event.target.matches('[data-board-search]')) return;
    state.query = event.target.value;
    apply();
  });

  document.addEventListener('change', (event) => {
    if (!(event.target instanceof HTMLSelectElement) || !event.target.matches('[data-board-project]')) return;
    state.project = event.target.value;
    apply();
  });

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('[data-board-clear]')) {
      Object.assign(state, { project: '', priority: '', query: '' });
      apply();
      document.querySelector('[data-board-search]')?.focus();
      return;
    }
    const pill = event.target.closest('[data-filter-priority]');
    if (!pill || !pill.closest('[data-board-toolbar]')) return;
    const next = pill.dataset.filterPriority || '';
    state.priority = next && state.priority === next ? '' : next;
    apply();
  });

  // Escape in a filled search box empties it; the next Escape leaves the box.
  document.addEventListener('keydown', (event) => {
    const field = event.target;
    if (event.key !== 'Escape' || !(field instanceof HTMLInputElement) || !field.matches('[data-board-search]')) return;
    if (field.value) {
      event.preventDefault();
      state.query = '';
      apply();
    } else {
      field.blur();
    }
  });

  document.addEventListener('live:updated', apply);
}

if (typeof document !== 'undefined') initBoardFilter();
