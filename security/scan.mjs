import { matchTerms } from './denylist.mjs';
import { RULES } from './rules.mjs';

// Test fixtures need fake e-mail addresses, IPs, paths and tokens. A line carrying this marker skips the
// generic pattern rules only; the private denylist still applies to it.
export const FIXTURE_MARKER = 'cairn-scan:allow-fixture';

export function scanText(text, { file, terms = [], allowIdentities = [] }) {
  const findings = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const fixture = line.includes(FIXTURE_MARKER);
    for (const [rule, matches] of Object.entries(RULES)) {
      if (fixture) break;
      if (matches(line, file)) findings.push({ file, line: index + 1, rule });
    }
    let remaining = line;
    for (const identity of allowIdentities) {
      if (identity) remaining = remaining.split(identity).join(' ');
    }
    for (const termIndex of matchTerms(remaining, terms)) {
      // Only the index is reported: the term itself must never reach logs.
      findings.push({ file, line: index + 1, rule: `denylist:${termIndex}` });
    }
  }
  return findings;
}

export function formatFindings(findings) {
  return findings.map(({ file, line, rule }) => `${file}:${line} ${rule}`).join('\n');
}
