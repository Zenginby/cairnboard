import { CairnError } from './errors.mjs';

export const MIN_NODE = [22, 23, 4];

/** True when a Node version string is at least `min` ([major, minor, patch]), compared numerically. */
export function nodeAtLeast(version, min = MIN_NODE) {
  const parts = version.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < min.length; i += 1) {
    if ((parts[i] ?? 0) !== min[i]) return (parts[i] ?? 0) > min[i];
  }
  return true;
}

export async function checkRuntime({ nodeVersion = process.versions.node, sqlite = () => import('node:sqlite') } = {}) {
  const unsupported = () => new CairnError('runtime_unsupported', `Cairnboard needs Node ${MIN_NODE.join('.')} or newer with SQLite FTS5 (found ${nodeVersion}).`);
  if (!nodeAtLeast(nodeVersion)) throw unsupported();

  try {
    const { DatabaseSync } = await sqlite();
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE t USING fts5(x)');
    } finally {
      db.close();
    }
  } catch {
    throw unsupported();
  }
}
