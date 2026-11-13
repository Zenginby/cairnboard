/**
 * Filters board cards by project and priority and computes per-column counts.
 * @param {Array<{ column: string, project?: string | null, priority?: string | null }>} cards
 * @param {{ project?: string, priority?: string }} [selection]
 * @param {string[]} [columnKeys]
 */
export function filterBoardCards(cards, selection = {}, columnKeys = []) {
  const project = selection.project || '';
  const priority = selection.priority || '';
  const counts = Object.fromEntries(columnKeys.map((key) => [key, 0]));
  const visible = [];
  for (const card of cards) {
    if (project && (card.project || '') !== project) continue;
    if (priority && (card.priority || '') !== priority) continue;
    visible.push(card);
    counts[card.column] = (counts[card.column] ?? 0) + 1;
  }
  return { visible, total: visible.length, counts };
}

function formatSummary(template, cardsCount, columnsCount) {
  return template.replace('{n}', String(cardsCount)).replace('{m}', String(columnsCount));
}

function initBoardFilter() {
  const state = { project: '', priority: '' };

  const apply = () => {
    const toolbar = document.querySelector('[data-board-toolbar]');
    const board = document.querySelector('.board');
    if (!toolbar || !board) return;

    const projectPills = [...toolbar.querySelectorAll('[data-filter-project]')];
    const priorityPills = [...toolbar.querySelectorAll('[data-filter-priority]')];
    if (state.project && !projectPills.some((pill) => pill.dataset.filterProject === state.project)) {
      state.project = '';
    }
    if (state.priority && !priorityPills.some((pill) => pill.dataset.filterPriority === state.priority)) {
      state.priority = '';
    }

    for (const pill of projectPills) {
      pill.setAttribute('aria-pressed', String((pill.dataset.filterProject || '') === state.project));
    }
    for (const pill of priorityPills) {
      pill.setAttribute('aria-pressed', String((pill.dataset.filterPriority || '') === state.priority));
    }

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
        });
      }
    }

    const active = Boolean(state.project || state.priority);
    const result = filterBoardCards(cards, state, columnKeys);
    const visibleSet = new Set(result.visible);

    for (const card of cards) {
      card.element.hidden = !visibleSet.has(card);
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

    const summaryEl = toolbar.querySelector('[data-board-summary]');
    if (summaryEl) {
      const template = summaryEl.dataset.template || '{n} kart · {m} sütun';
      const total = active ? result.total : Number(summaryEl.dataset.totalCards ?? result.total);
      const columnCount = Number(summaryEl.dataset.columnCount ?? columns.length);
      summaryEl.textContent = formatSummary(template, total, columnCount);
    }
  };

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const pill = event.target.closest('[data-filter-project], [data-filter-priority]');
    if (!pill || !pill.closest('[data-board-toolbar]')) return;
    if (Object.hasOwn(pill.dataset, 'filterProject')) {
      state.project = pill.dataset.filterProject || '';
    } else {
      const next = pill.dataset.filterPriority || '';
      state.priority = state.priority === next ? '' : next;
    }
    apply();
  });

  document.addEventListener('live:updated', apply);
}

if (typeof document !== 'undefined') initBoardFilter();
