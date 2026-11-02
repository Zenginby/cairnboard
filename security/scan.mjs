import { matchTerms } from './denylist.mjs';
import { RULES } from './rules.mjs';

// Test fixtures need fake e-mail addresses, IPs, paths and tokens. A line carrying this marker skips the
// generic pattern rules only; the private denylist still applies to it.
export const FIXTURE_MARKER = 'cairn-scan:allow-fixture';

export function scanText(text, { file, terms = [], allowIdentities = [], patterns = true }) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  const remaining = lines.map((line) => {
    for (const identity of allowIdentities) {
      if (identity) line = line.split(identity).join(' ');
    }
    return line;
  });
  // A term may be wrapped over several lines, with blank lines in between: each term is matched against a window of
  // the next non-blank lines that is as long as the longest term, and reported on the line where it starts.
  const span = Math.max(1, ...terms.map((term) => term.split(' ').length));
  const filled = remaining.flatMap((line, index) => line.trim() ? [index] : []);
  const window = (at) => matchTerms(filled.slice(at, at + span).map((index) => remaining[index]).join(' '), terms);
  const starts = new Map(filled.map((index, at) => {
    const later = new Set(window(at + 1));
    return [index, window(at).filter((term) => !later.has(term))];
  }));
  for (const [index, line] of lines.entries()) {
    const fixture = line.includes(FIXTURE_MARKER);
    for (const [rule, matches] of Object.entries(RULES)) {
      if (fixture || !patterns) break;
      if (matches(line, file)) findings.push({ file, line: index + 1, rule });
    }
    const termMatches = new Set([...matchTerms(remaining[index], terms), ...(starts.get(index) ?? [])]);
    for (const termIndex of termMatches) {
      // Only the index is reported: the term itself must never reach logs.
      findings.push({ file, line: index + 1, rule: `denylist:${termIndex}` });
    }
  }
  return findings;
}

export function formatFindings(findings) {
  return findings.map(({ file, line, rule }) => `${file}:${line} ${rule}`).join('\n');
}
