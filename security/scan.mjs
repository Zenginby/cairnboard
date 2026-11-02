import { matchTerms } from './denylist.mjs';
import { RULES } from './rules.mjs';

// Test fixtures need fake e-mail addresses, IPs, paths and tokens. A line carrying this marker skips the
// generic pattern rules only, and only when the caller passes `fixtures` for a file under test/ (`file` is just a
// label); the private denylist still applies to it.
export const FIXTURE_MARKER = 'cairn-scan:allow-fixture';

export function scanText(text, { file, terms = [], allowIdentities = [], patterns = true, fixtures = false }) {
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
    const fixture = fixtures && line.includes(FIXTURE_MARKER);
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

const side = (path, prefix) => (path.startsWith(`${prefix}/`) ? path.slice(2) : path.startsWith(`"${prefix}/`) ? path.slice(3) : '');

// Flags the lines of `git log -p` output that are hunk lines of a file under test/, the only lines where the marker
// applies. Hunks are consumed by their line counts, so commit headers and messages are never flagged.
export function fixtureLines(patch) {
  let state = 'text';
  let minus = '';
  let fixtures = false;
  let left = [0, 0];
  return patch.split(/\r?\n/).map((line) => {
    if (left[0] > 0 || left[1] > 0) {
      const mark = line[0] ?? ' ';
      if (mark === ' ' || mark === '-') left[0]--;
      if (mark === ' ' || mark === '+') left[1]--;
      if (' -+\\'.includes(mark)) return fixtures;
      left = [0, 0];
    }
    if (line.startsWith('diff --git ')) {
      [state, minus, fixtures] = ['header', '', false];
      return false;
    }
    if (state === 'header') {
      // `+++ b/<path>` survives spaces in names; a deletion has `+++ /dev/null` and its path on `--- a/<path>`.
      if (line.startsWith('--- ')) minus = side(line.slice(4), 'a');
      else if (line.startsWith('+++ ')) fixtures = (line === '+++ /dev/null' ? minus : side(line.slice(4), 'b')).startsWith('test/');
      else if (!line) state = 'text';
    }
    const hunk = state !== 'text' && /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      [state, left] = ['file', [Number(hunk[1] ?? 1), Number(hunk[2] ?? 1)]];
    } else if (state === 'file' && !line.startsWith('\\')) {
      state = 'text';
    }
    return false;
  });
}

// Scans text whose lines differ in whether the marker applies (`flags`, one per line). Pattern rules run per run of
// equally flagged lines; the denylist runs over the whole text so a term wrapped across two runs is still found.
export function scanLines(text, flags, options) {
  const lines = text.split(/\r?\n/);
  const findings = [];
  for (let start = 0, end = 1; end <= lines.length; end++) {
    if (end < lines.length && flags[end] === flags[start]) continue;
    const run = scanText(lines.slice(start, end).join('\n'), { ...options, terms: [], fixtures: flags[start] });
    findings.push(...run.map((finding) => ({ ...finding, line: finding.line + start })));
    start = end;
  }
  findings.push(...scanText(text, { ...options, patterns: false }));
  // Stable sort keeps the per-line order of scanText: pattern rules first, then denylist terms.
  return findings.sort((a, b) => a.line - b.line);
}

export function formatFindings(findings) {
  return findings.map(({ file, line, rule }) => `${file}:${line} ${rule}`).join('\n');
}
