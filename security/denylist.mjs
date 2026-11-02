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
  const norm = normalize(line);
  const text = ` ${norm} `;
  return terms.flatMap((term, index) => {
    if (text.includes(` ${term} `)) return [index];
    const letters = term.replace(/\s+/g, '');
    if (letters.length >= 5 && (norm.includes(term) || norm.split(' ').some((token) => token.includes(letters)))) {
      return [index];
    }
    return [];
  });
}
