import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readDesignSources } from './lib/design-tokens.mjs';
import { lintPrototypes } from './lib/prototype-lint.mjs';

// Prototype styles and pages first: they need no DESIGN.md and must report even when the documents cannot be read.
const violations = lintPrototypes(process.cwd());
for (const { file, line, rule, detail } of violations) console.error(`${file}:${line} ${rule}: ${detail}`);
if (violations.length) console.error(`${violations.length} prototype violation(s).`);
try {
  const cli = fileURLToPath(import.meta.resolve('@google/design.md'));
  let failed = false;
  for (const { file } of await readDesignSources(process.cwd())) {
    const result = spawnSync(process.execPath, [cli, 'lint', file], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.stderr) process.stderr.write(result.stderr);
    const report = JSON.parse(result.stdout);
    console.log(`${file}:\n${JSON.stringify(report, null, 2)}`);
    if (result.status !== 0 || report.summary.errors > 0 || report.summary.warnings > 0) failed = true;
  }
  const check = spawnSync(process.execPath, [fileURLToPath(new URL('./design-build.mjs', import.meta.url)), '--check'], { stdio: 'inherit' });
  if (check.error) throw check.error;
  process.exitCode = failed || check.status !== 0 || violations.length ? 1 : 0;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
