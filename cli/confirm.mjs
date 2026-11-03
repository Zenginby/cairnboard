import { createInterface } from 'node:readline';
import { CairnError } from '../core/errors.mjs';
import { oneLine, stripHidden } from '../core/text.mjs';

// Variables set by coding agents' shells. A terminal alone is no proof of a human: agents can drive a
// pseudo-terminal, so dangerous commands refuse outright inside a known agent. This is a speed bump, not a boundary.
const AGENT_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'GEMINI_CLI', 'CURSOR_AGENT'];

export async function confirm(io, message) {
  const agent = AGENT_MARKERS.find((name) => io.env?.[name]);
  if (agent) throw new CairnError('confirmation_required', 'A coding agent cannot confirm this; run it yourself in a terminal.');
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
