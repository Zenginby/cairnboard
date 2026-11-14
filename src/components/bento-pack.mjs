// Home bento packing: which boxes render decides where CSS auto-placement leaves holes in the six-column grid, so
// the page computes each box's span here and widens a box into the hole on its right. Pure and DOM-free.

export const COLUMNS = 6;

// Simulates CSS grid sparse auto-placement (row by row, the cursor never moves back) and returns each item's cells.
export function place(items, columns = COLUMNS) {
  const taken = [];
  const free = (row, col, span, rows) => {
    if (col + span > columns) return false;
    for (let r = row; r < row + rows; r += 1) {
      for (let c = col; c < col + span; c += 1) if (taken[r]?.[c]) return false;
    }
    return true;
  };
  let row = 0, col = 0;
  return items.map(({ span, rows = 1 }) => {
    const width = Math.min(span, columns);
    while (!free(row, col, width, rows)) {
      col += 1;
      if (col + width > columns) { row += 1; col = 0; }
    }
    for (let r = row; r < row + rows; r += 1) {
      taken[r] ??= [];
      for (let c = col; c < col + width; c += 1) taken[r][c] = true;
    }
    const at = { row, col, span: width, rows };
    col += width;
    return at;
  });
}

// Widens one-row boxes into the empty cells that follow them in the same row, until no box can grow.
// Returns the spans in item order.
export function pack(items, columns = COLUMNS) {
  const spans = items.map(({ span }) => Math.min(span, columns));
  for (let round = 0; round < items.length * columns; round += 1) {
    const cells = place(items.map((item, i) => ({ ...item, span: spans[i] })), columns);
    const taken = [];
    for (const { row, col, span, rows } of cells) {
      for (let r = row; r < row + rows; r += 1) {
        taken[r] ??= [];
        for (let c = col; c < col + span; c += 1) taken[r][c] = true;
      }
    }
    let grown = false;
    for (let i = cells.length - 1; i >= 0 && !grown; i -= 1) {
      const { row, col, span, rows } = cells[i];
      if (rows !== 1) continue;
      let end = col + span;
      while (end < columns && !taken[row][end]) end += 1;
      if (end > col + span) {
        spans[i] = end - col;
        grown = true;
      }
    }
    if (!grown) break;
  }
  return spans;
}

// The Home boxes in page order, with the span each needs before packing. Keep in step with src/pages/index.astro
// and the render conditions of the box components.
export function homeSlots({ calendar, projects, agents, research, pinned, recent }) {
  const slots = [{ id: 'hero', span: 4 }];
  if (calendar) slots.push({ id: 'calendar', span: 2 });
  projects.forEach((project, i) => slots.push({ id: `project-${i}`, span: project.featured ? 4 : 2 }));
  if (!projects.length) slots.push({ id: 'projects-empty', span: COLUMNS });
  slots.push({ id: 'ongoing', span: 4, rows: 2 }, { id: 'distribution', span: 2, rows: 2 });
  slots.push({ id: 'latest-day', span: 3 });
  if (agents) slots.push({ id: 'agents', span: 2 });
  if (research) slots.push({ id: 'research', span: 2 });
  if (pinned) slots.push({ id: 'pinned', span: 2 });
  if (recent) slots.push({ id: 'recent', span: 2 });
  return slots;
}

// id -> class name ("span-3") for the boxes whose span differs from their default; the classes apply on wide screens.
export function homeSpans(present) {
  const slots = homeSlots(present);
  const spans = pack(slots);
  const changed = slots.flatMap((slot, i) => (spans[i] === slot.span ? [] : [[slot.id, `span-${spans[i]}`]]));
  return Object.fromEntries(changed);
}
