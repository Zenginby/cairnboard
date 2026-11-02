import { listCards, effectiveColumn } from './card.mjs';
import { oneLine } from './text.mjs';

// `|`, `[` and `]` would end the alias or the link early, so they become spaces.
const label = (title) => oneLine(title.replace(/[[\]|]+/gu, ' ')).replace(/ {2,}/gu, ' ').trim();

export function exportBoard(ctx) {
  const cards = listCards(ctx, { includeDone: true });
  const sections = ctx.config.columns.map((column) => {
    const lines = cards.filter((card) => effectiveColumn(ctx.config, card).key === column.key).map((card) => {
      // Use the classified source path, including manual filenames and custom schema roots.
      const path = card.path.replace(/\.md$/iu, '');
      return `- [${column.role === 'done' ? 'x' : ' '}] [[${path}|${label(card.title)}]]`
        + (card.data.priority ? ` #${card.data.priority}` : '');
    });
    return [`## ${oneLine(column.label)}`, ...(column.role === 'done' ? ['**Complete**'] : []),
      ...(lines.length ? [lines.join('\n')] : [])].join('\n\n');
  });
  return ['---\nkanban-plugin: board\n---', ...sections].join('\n\n') + '\n';
}
