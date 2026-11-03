import { listCards, effectiveColumn } from './card.mjs';
import { oneLine } from './text.mjs';
import { validatePriority } from './entity.mjs';

// `|`, `[` and `]` would end the alias or the link early, so they become spaces.
const label = (title) => oneLine(title.replace(/[[\]|]+/gu, ' ')).replace(/ {2,}/gu, ' ').trim();
const validPriority = (value) => { try { validatePriority(value); return true; } catch { return false; } };

// Marks a generated board so a hand-written board.md is never overwritten.
export const EXPORT_MARKER = 'cairnboard: export';

export function exportBoard(ctx) {
  const cards = listCards(ctx, { includeDone: true });
  const sections = ctx.config.columns.map((column) => {
    const lines = cards.filter((card) => effectiveColumn(ctx.config, card).key === column.key).map((card) => {
      // Use the classified source path, including manual filenames and custom schema roots.
      const path = oneLine(card.path.replace(/\.md$/iu, ''));
      if (/[[\]|]/u.test(path)) return `- [${column.role === 'done' ? 'x' : ' '}] ${label(card.title)} (${label(path)})`;
      return `- [${column.role === 'done' ? 'x' : ' '}] [[${path}|${label(card.title)}]]`
        + (validPriority(card.data.priority) ? ` #${card.data.priority}` : '');
    });
    return [`## ${oneLine(column.label)}`, ...(column.role === 'done' ? ['**Complete**'] : []),
      ...(lines.length ? [lines.join('\n')] : [])].join('\n\n');
  });
  return [`---\nkanban-plugin: board\n${EXPORT_MARKER}\n---`, ...sections].join('\n\n') + '\n';
}
