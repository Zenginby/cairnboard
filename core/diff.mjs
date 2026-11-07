import { CairnError } from './errors.mjs';

const lines = (text) => text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];

/** @param {string} before @param {string} after
 * @param {{ maxLines?: number, maxBytes?: number }} [options] */
export function lineDiff(before, after, { maxLines = 200, maxBytes = 16384 } = {}) {
  if (![maxLines, maxBytes].every((n) => Number.isSafeInteger(n) && n >= 0)) {
    throw new CairnError('validation', 'Invalid diff limit.');
  }
  if (before === after) return { hunks: '', truncated: false };
  const a = lines(before), b = lines(after);
  let output = '', used = 0, truncated = false;
  const append = (text) => {
    for (const row of lines(text)) {
      if (used >= maxLines) { truncated = true; return false; }
      let cut = '';
      const room = maxBytes - Buffer.byteLength(output);
      let size = 0;
      for (const char of row) {
        size += Buffer.byteLength(char);
        if (size > room) break;
        cut += char;
      }
      output += cut;
      used++;
      if (cut !== row) { truncated = true; return false; }
    }
    return true;
  };
  if (Math.max(a.length, b.length) > 2000) {
    let start = 0, endA = a.length, endB = b.length;
    while (start < endA && start < endB && a[start] === b[start]) start++;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    append(`Changed region: -${endA - start} +${endB - start} lines (input exceeds 2000 lines).\n`);
    return { hunks: output, truncated: true };
  }
  const width = b.length + 1, lcs = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j] ? 1 + lcs[(i + 1) * width + j + 1]
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ type: ' ', text: a[i++], old: 1, next: 1 });
      j++;
    } else if (i < a.length && (j === b.length || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
      ops.push({ type: '-', text: a[i++], old: 1, next: 0 });
    } else ops.push({ type: '+', text: b[j++], old: 0, next: 1 });
  }
  const ranges = [];
  for (let at = 0; at < ops.length; at++) {
    if (ops[at].type === ' ') continue;
    const start = Math.max(0, at - 3), end = Math.min(ops.length, at + 4);
    if (ranges.at(-1)?.end >= start) ranges.at(-1).end = end;
    else ranges.push({ start, end });
  }
  for (const { start, end } of ranges) {
    const prior = ops.slice(0, start), group = ops.slice(start, end);
    const countA = group.reduce((n, op) => n + op.old, 0), countB = group.reduce((n, op) => n + op.next, 0);
    const fromA = prior.reduce((n, op) => n + op.old, 0) + (countA ? 1 : 0);
    const fromB = prior.reduce((n, op) => n + op.next, 0) + (countB ? 1 : 0);
    if (!append(`@@ -${fromA},${countA} +${fromB},${countB} @@\n`)) break;
    for (const op of group) {
      if (!append(op.type + op.text + (op.text.endsWith('\n') ? '' : '\n\\ No newline at end of file\n'))) break;
    }
    if (truncated) break;
  }
  return { hunks: output, truncated };
}
