import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from '../core/fsx.mjs';
import { fixedClock } from '../core/clock.mjs';
import { newId } from '../core/ids.mjs';
import { initDataDir } from '../core/roots.mjs';
import { openContext } from '../core/context.mjs';
import { refresh } from '../core/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'dist/cairn.mjs');
const rounds = 20;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
}

function benchmark() {
  if (!fs.existsSync(cli)) throw new Error('Build the CLI first: npm run build:cli');
  const scratch = fs.mkdtempSync(join(root, '.bench-cli-'));
  try {
    const home = join(scratch, 'home'), data = join(scratch, 'data');
    fs.mkdirSync(home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, CAIRN_DATA: data, CAIRN_TEST_CRASH: '',
      XDG_STATE_HOME: join(home, 'state'), LOCALAPPDATA: join(home, 'local'),
      NODE_COMPILE_CACHE: join(scratch, 'compile-cache'), TMPDIR: scratch, TMP: scratch, TEMP: scratch };
    const clock = fixedClock('2026-11-01T00:00:00Z');
    initDataDir(data, { home, env, clock });
    fs.mkdirSync(join(data, 'cards'));
    const ids = new Set();
    while (ids.size < 1000) ids.add(newId('c'));
    // Seed files in bulk so setup does not measure a thousand durable transactions.
    for (const id of ids) fs.writeFileSync(join(data, 'cards', `${id}.md`),
      `---\nid: ${id}\ntitle: acme ${id}\ncolumn: backlog\nposition: a0\n---\n`);
    const ctx = openContext({ mode: 'read', dataDir: data, home, env, clock });
    const seeded = refresh(ctx);
    if (seeded.added !== 1000 || ctx.warnings.length) throw new Error('Could not index benchmark cards.');

    function run(args) {
      const start = performance.now();
      const result = spawnSync(process.execPath, [cli, ...args, '--data', data, '--json'], {
        cwd: scratch, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      });
      const ms = performance.now() - start;
      if (result.error || result.status !== 0) throw new Error(`CLI failed: ${result.error?.message ?? result.stderr}`);
      const response = JSON.parse(result.stdout);
      if (!response.ok || response.warnings.length) throw new Error('Benchmark CLI returned an error or warning.');
      return { ms, data: response.data };
    }

    run(['card', 'list', '--compact']);
    const reads = [], writes = [];
    for (const id of [...ids].slice(0, rounds)) {
      const read = run(['card', 'list', '--compact']);
      if (read.data.items.length !== 1000) throw new Error('Benchmark list did not return 1000 cards.');
      reads.push(read.ms);
      const write = run(['card', 'claim', id, '--actor', 'bench']);
      if (write.data.id !== id || write.data.meta.assignee !== 'bench') throw new Error('Benchmark claim did not take ownership.');
      writes.push(write.ms);
    }
    process.stdout.write(`1000 cards; ${rounds} runs per command; includes process startup; one list warm-up\n`);
    for (const [command, values, target] of [['card list --compact --json', reads, 150], ['card claim', writes, 200]]) {
      const ms = median(values);
      process.stdout.write(`${command}: median ${ms.toFixed(2)} ms (target < ${target} ms)\n`);
      if (ms >= target) process.stdout.write(`WARN: ${command} exceeded target\n`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

try { benchmark(); }
catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
