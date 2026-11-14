// The owner's board can show one lane per column role (to do, doing, done) instead of every configured column.
// Data stay as they are: a lane made of several columns keeps their cards in column order, tags each card with its
// column's label, and adds new cards to its first column. A role with a single column keeps that column unchanged.
// Lanes always read to do, doing, done, whatever order the columns are configured in.
const RANK = { todo: 0, doing: 1, done: 2 };
const rank = (role) => RANK[role] ?? 3;

/**
 * @template {{ key: string, label: string, role?: string, total: number, cards: Array<object> }} Column
 * @param {Column[]} columns
 * @param {Record<string, string>} labels lane names by role, used when a role has several columns
 */
export function laneColumns(columns, labels) {
  const order = [];
  const byRole = new Map();
  for (const column of columns) {
    const role = column.role || 'todo';
    if (!byRole.has(role)) {
      byRole.set(role, []);
      order.push(role);
    }
    byRole.get(role).push(column);
  }
  return order.sort((a, b) => rank(a) - rank(b)).map((role) => {
    const group = byRole.get(role);
    if (group.length === 1) return group[0];
    return {
      key: role,
      label: labels[role] ?? group[0].label,
      role,
      addKey: group[0].key,
      total: group.reduce((sum, column) => sum + column.total, 0),
      cards: group.flatMap((column) => column.cards.map((card) => ({ ...card, columnLabel: column.label }))),
    };
  });
}
