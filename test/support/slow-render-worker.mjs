// Test worker: loads slower than the pool's page limit, then behaves like the real one.
const until = Date.now() + 600;
while (Date.now() < until) { /* Simulates a slow module load on a busy machine. */ }
await import('../../server/render-worker.mjs');
