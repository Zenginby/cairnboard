import { CairnError } from './errors.mjs';
import { openIndex, unavailable, withIndex } from './index.mjs';
import { CHECKS, loadView } from './lint-checks.mjs';
import { LINT_CODES } from './rules.mjs';

export { CHECKS };
const ORDER = { error: 0, warn: 1, info: 2 };
const STALE_DAYS = 180;

// The raw digests computed on the way are cached so the next run only re-reads files that changed. Losing them costs
// time, never correctness, so a busy cache is ignored.
function saveDigests(ctx, digests) {
  if (!digests.size) return;
  let index;
  try {
    index = openIndex(ctx);
    const insert = index.db.prepare('INSERT OR REPLACE INTO raw_digests VALUES (?, ?, ?, ?, ?, ?)');
    index.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of digests.values()) insert.run(row.path, row.mtime_ms, row.ctime_ms, row.size, row.ino, row.sha256);
      index.db.exec('COMMIT');
    } catch (error) {
      index.db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    // Only a busy or unusable cache is ignored (it costs time, never correctness); anything else is a bug.
    if (!unavailable(error)) throw error;
  } finally {
    index?.close();
  }
}

/**
 * Wiki spec §9 checks over the index (never a file scan): `{ findings }` ordered by severity, path, line.
 * `config.lint[code]` overrides each severity (`off` skips the check); `only` limits the codes. The evidence and code
 * flags select the checks that read raw or code files (wiki spec §13, §14).
 */
export function lint(ctx, { only, verify = false, evidence = false, code = false } = {}) {
  if (only !== undefined && only.some((item) => !LINT_CODES.includes(item))) throw new CairnError('validation', 'Unknown lint code.');
  const settings = ctx.config?.lint ?? {};
  const view = withIndex(ctx, (db) => loadView(ctx, db));
  const opts = { view, verify, evidence, code, now: ctx.clock.now().getTime(),
    staleDays: Number.isSafeInteger(settings.staleDays) ? settings.staleDays : STALE_DAYS };
  const flags = { verify, evidence, code };
  const findings = [];
  for (const check of CHECKS) {
    if (only && !only.includes(check.code)) continue;
    if (check.flag && !flags[check.flag]) continue;
    const severity = settings[check.code] ?? check.defaultFor?.(ctx) ?? check.defaultSeverity;
    if (severity === 'off') continue;
    for (const item of check.run(ctx, opts)) findings.push({ ...item, severity });
  }
  saveDigests(ctx, view.newDigests);
  findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    || (a.line ?? 0) - (b.line ?? 0));
  return { findings: findings.map(({ code: name, severity, ...rest }) => ({ code: name, severity, ...rest })) };
}
