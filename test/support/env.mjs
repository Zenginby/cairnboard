import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export { fixedClock } from '../../core/clock.mjs';

// Fresh temporary folders; callers pass them explicitly, process.env is never changed.
export const tempHome = () => mkdtempSync(join(tmpdir(), 'cairn-home-'));
export const tempData = () => mkdtempSync(join(tmpdir(), 'cairn-data-'));

// Resolved so symlinked temporary roots (macOS /var) compare exactly; removed when the test ends.
export function tempDir(t, prefix = 'cairn-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
