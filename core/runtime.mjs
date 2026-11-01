import { CairnError } from './errors.mjs';

export async function checkRuntime({ nodeVersion = process.versions.node, sqlite = () => import('node:sqlite') } = {}) {
  const unsupported = () => new CairnError('runtime_unsupported', `Cairnboard needs Node 22.16 or newer with SQLite FTS5 (found ${nodeVersion}).`);
  const [major, minor] = nodeVersion.split('.').map(Number);
  if (!(major > 22 || (major === 22 && minor >= 16))) throw unsupported();

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
