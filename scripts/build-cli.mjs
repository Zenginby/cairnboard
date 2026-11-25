import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const text = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
await build({
  absWorkingDir: root, entryPoints: ['cli/main.mjs'], outfile: 'dist/cairn-main.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node22.23',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  define: {
    __CAIRN_VERSION__: JSON.stringify(JSON.parse(text('package.json')).version),
    __CAIRN_SKILL__: JSON.stringify(text('agents/skill-template.md')),
    __CAIRN_AGENTS__: JSON.stringify(text('agents/agents-md-template.md')),
  },
  footer: { js: `process.exitCode = await main(process.argv.slice(2), {
  entrypoint: process.argv[1],
  stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
  env: process.env, cwd: process.cwd(), isTTY: process.stdin.isTTY === true && process.stderr.isTTY === true,
});` },
});
// npm's Windows shims pass the target path, so each name needs its own entry point.
for (const name of ['cairn', 'cairnboard']) {
  const entry = new URL(`../dist/${name}.mjs`, import.meta.url);
  writeFileSync(entry, `#!/usr/bin/env node
import * as module from 'node:module';

module.enableCompileCache?.();
await import('./cairn-main.mjs');
`);
  chmodSync(entry, 0o755);
}
