import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openContext } from '../core/context.mjs';
import { initDataDir } from '../core/roots.mjs';
import { reconcileExternal } from '../core/changes.mjs';
import { refresh } from '../core/index.mjs';

const count = Number(process.argv[2] ?? 3000);
if (!Number.isSafeInteger(count) || count < 1 || process.argv.length > 3) {
  throw new Error('Usage: bench-reconcile.mjs [positive note count]');
}
const scratch = mkdtempSync(join(tmpdir(), 'cairn-reconcile-'));
try {
  const dir = join(scratch, 'data'), home = join(scratch, 'home');
  mkdirSync(home);
  initDataDir(dir, { home, env: {} });
  mkdirSync(join(dir, 'notes'), { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(join(dir, 'notes', `n${i}.md`), `# Note ${i}\n\n${'text '.repeat(200)}\n`);
  }
  const ctx = openContext({ mode: 'write', dataDir: dir, home, env: {}, actor: 'agent:bench' });
  const measure = (label, expected) => {
    const start = performance.now();
    const result = reconcileExternal(ctx);
    const ms = performance.now() - start;
    if (result.recorded !== expected || ctx.warnings.length) throw new Error('Unexpected reconciliation result.');
    console.log(`${label}: ${ms.toFixed(2)} ms (baseline=${result.baseline}, recorded=${result.recorded})`);
  };
  console.log(`${count} notes; timings include index refresh`);
  measure('baseline', 0);
  const start = performance.now();
  refresh(ctx);
  console.log(`warm index refresh reference: ${(performance.now() - start).toFixed(2)} ms`);
  measure('noop', 0);
  const edits = Math.min(5, count);
  for (let i = 0; i < edits; i++) writeFileSync(join(dir, 'notes', `n${i}.md`), 'changed\n');
  measure(`${edits} changes`, edits);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
