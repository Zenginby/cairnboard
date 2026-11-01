import { readFileSync } from 'node:fs';
import { normalize } from './normalize.mjs';

export function loadDenylist(path) {
  const terms = [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    const term = normalize(value);
    if (term.length < 3) throw new Error(`term too short: line ${index + 1}`);
    terms.push(term);
  }
  return { terms };
}

export function matchTerms(line, terms) {
  const text = ` ${normalize(line)} `;
  return terms.flatMap((term, index) => text.includes(` ${term} `) ? [index] : []);
}
