import { matchTerms } from './denylist.mjs';
import { RULES } from './rules.mjs';

// Test fixtures need fake e-mail addresses, IPs, paths and tokens. A line carrying this marker skips the
// generic pattern rules only; the private denylist still applies to it.
export const FIXTURE_MARKER = 'cairn-scan:allow-fixture';

export function scanText(text, { file, terms = [], allowIdentities = [] }) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  const remaining = lines.map((line) => {
    for (const identity of allowIdentities) {
      if (identity) line = line.split(identity).join(' ');
    }
    return line;
  });
  const lineMatches = remaining.map((line) => matchTerms(line, terms));
  for (const [index, line] of lines.entries()) {
    const fixture = line.includes(FIXTURE_MARKER);
    for (const [rule, matches] of Object.entries(RULES)) {
      if (fixture) break;
      if (matches(line, file)) findings.push({ file, line: index + 1, rule });
    }
    const termMatches = new Set(lineMatches[index]);
    if (index + 1 < lines.length) {
      for (const termIndex of matchTerms(`${remaining[index]} ${remaining[index + 1]}`, terms)) {
        if (!lineMatches[index + 1].includes(termIndex)) termMatches.add(termIndex);
      }
    }
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
