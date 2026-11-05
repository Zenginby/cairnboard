// Telemetry reads the environment during module initialization, before build() runs.
process.env.ASTRO_TELEMETRY_DISABLED = '1';
const { build } = await import('astro');
await build({});
