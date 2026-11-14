// Telemetry reads the environment during module initialization, before build() runs.
process.env.ASTRO_TELEMETRY_DISABLED = '1';
// --out <dir> builds somewhere other than dist/app, so tests and checks never replace a running server's files.
const at = process.argv.indexOf('--out');
const outDir = at > 0 ? process.argv[at + 1] : undefined;
if (at > 0 && !outDir) throw new Error('--out needs a folder.');
const { build } = await import('astro');
await build(outDir ? { outDir } : {});
