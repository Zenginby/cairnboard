import { createInterface } from 'node:readline';
import { CairnError } from '../core/errors.mjs';
import { oneLine, stripHidden } from '../core/text.mjs';

export async function confirm(io, message) {
  if (!io.isTTY) throw new CairnError('confirmation_required', 'Confirmation requires a terminal.');
  io.stderr.write(`${oneLine(stripHidden(message).text)} Type yes: `);
  const lines = createInterface({ input: io.stdin, crlfDelay: Infinity, terminal: false });
  try {
    for await (const line of lines) return line.trim() === 'yes';
    return false;
  } finally {
    lines.close();
  }
}
