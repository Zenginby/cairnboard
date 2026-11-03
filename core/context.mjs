import { createHash, randomBytes } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import * as fs from './fsx.mjs';
import { CairnError } from './errors.mjs';
import { systemClock } from './clock.mjs';
import { checkedPath, realRoot } from './paths.mjs';
import { findDataDir, stateDir } from './roots.mjs';
import { defaultConfig, loadConfig, migrate, needsMigration } from './config.mjs';
import { PRESETS } from './presets.mjs';
import { resolveSchema } from './schema.mjs';
import { recover } from './store.mjs';
import { dropPath, indexPath } from './index.mjs';

export function openContext({ mode, dataDir, preset, env = process.env, home = homedir(),
  platform = process.platform, cwd = process.cwd(), clock = systemClock, actor = null }) {
  if (!['read', 'dry-run', 'write', 'inspect'].includes(mode)) throw new CairnError('internal', 'Invalid context mode.');
  const found = findDataDir({ flag: dataDir && resolve(cwd, dataDir), env: { ...env, ...(env.CAIRN_DATA ? { CAIRN_DATA: resolve(cwd, env.CAIRN_DATA) } : {}) }, home, platform });
  let root;
  try {
    root = realRoot(found.path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new CairnError('validation', 'Initialization is required.');
  }
  const metadata = fs.lstatSync(checkedPath(root, '.cairn'), { throwIfNoEntry: false });
  const ephemeral = !metadata;
  let config;
  if (ephemeral) {
    if (!['read', 'inspect'].includes(mode) || !Object.hasOwn(PRESETS, preset ?? '')) {
      throw new CairnError('validation', 'Initialization is required.');
    }
    config = { ...defaultConfig(), schema: structuredClone(PRESETS[preset]) };
  } else {
    if (!metadata.isDirectory()) throw new CairnError('validation', 'Invalid data directory.');
    config = loadConfig(root);
  }
  const ctx = { root, config, schema: resolveSchema(config), clock, actor, mode, ephemeral, warnings: [],
    stateDir: stateDir({ platform, env, home }),
    host: hostname(), pid: process.pid, instance: randomBytes(8).toString('hex'),
    indexPath: ephemeral ? join(stateDir({ platform, env, home }), 'cache',
      createHash('sha256').update(root).digest('hex').slice(0, 16), 'index.db') : join(root, '.cairn/index.db') };
  if (['before-rename', 'after-rename', 'after-event', 'after-check'].includes(env.CAIRN_TEST_CRASH)) {
    ctx.faults = (point) => { if (point === env.CAIRN_TEST_CRASH) process.kill(process.pid, 'SIGKILL'); };
  }
  if (!ephemeral && mode === 'write') {
    // Step 9 of a write: keep the index current. Index failures only add a warning, never fail the write.
    // One refresh covers every target of the transaction.
    ctx.afterCommit = ({ items: [first] }) => (first.revision === null ? dropPath : indexPath)(ctx, first.path);
    if (needsMigration(config)) {
      migrate(root, { clock, migrations: { 0: (old) => ({ ...old, formatVersion: 1 }) } });
      ctx.config = loadConfig(root);
      ctx.schema = resolveSchema(ctx.config);
    }
    recover(ctx);
  } else if (!ephemeral && mode !== 'inspect') {
    if (needsMigration(config)) ctx.warnings.push('migration_pending');
    try {
      if (fs.readdirSync(checkedPath(root, '.cairn/pending')).some((name) => name.endsWith('.json'))) {
        ctx.warnings.push('pending_recovery');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return ctx;
}
