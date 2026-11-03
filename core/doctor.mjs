import { DatabaseSync } from 'node:sqlite';
import * as fs from './fsx.mjs';
import { openContext } from './context.mjs';
import { defaultConfig } from './config.mjs';
import { checkedPath, readChecked } from './paths.mjs';
import { refresh, rows } from './index.mjs';

const detail = (error) => `${error.code ?? 'internal'}: ${error.message}`;

function inventory(root) {
  const links = [], files = [];
  function walk(prefix = '') {
    const path = prefix ? checkedPath(root, prefix) : root;
    for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) links.push(rel);
      else if (entry.isDirectory()) walk(rel);
      else files.push(rel);
    }
  }
  walk();
  return { links, files };
}

function locks(ctx, files) {
  let failed = false;
  const descriptions = files.filter((path) => path.startsWith('.cairn/locks/')).map((path) => {
    const stat = fs.lstatSync(checkedPath(ctx.root, path));
    let owner;
    try { owner = JSON.parse(readChecked(ctx.root, path, 'utf8')); } catch {}
    const valid = owner && typeof owner.host === 'string' && Number.isInteger(owner.pid)
      && owner.pid > 0 && owner.pid <= 2 ** 31 - 1 && typeof owner.instance === 'string'
      && typeof owner.ts === 'string' && Number.isFinite(Date.parse(owner.ts));
    const age = ctx.clock.now().getTime() - (valid ? Date.parse(owner.ts) : stat.mtimeMs);
    let stale = age > (valid ? 7 : 2) * 60 * 1000 || path.includes('.stale-');
    if (valid && owner.host === ctx.host) {
      try { process.kill(owner.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') stale = true; else if (error.code !== 'EPERM') throw error; }
    }
    failed ||= stale;
    return `${path}: ${owner?.host ?? 'unknown'} pid=${owner?.pid ?? 'unknown'} since=${owner?.ts ?? stat.mtimeMs} (${stale ? 'old or stale' : 'active'})`;
  });
  return { ok: !failed, hint: descriptions.join('; ') || 'No locks.' };
}

export function checkData(options = {}) {
  const checks = [];
  const check = (name, fn) => {
    try { checks.push({ name, ...fn() }); }
    catch (error) { checks.push({ name, ok: false, hint: detail(error) }); }
  };
  let ctx;
  try { ctx = openContext({ ...options, mode: 'inspect' }); }
  catch (error) { return [{ name: 'config', ok: false, hint: detail(error) }]; }
  check('writable', () => {
    fs.accessSync(ctx.root, fs.constants.W_OK);
    const ok = process.platform === 'win32' || !!(fs.statSync(ctx.root).mode & 0o222);
    return { ok, hint: ok ? 'Data directory is writable.' : 'Make the data directory writable.' };
  });
  checks.push({ name: 'config', ok: true, hint: 'Configuration is valid.' },
    { name: 'formatVersion', ok: ctx.config.formatVersion === defaultConfig().formatVersion,
      hint: `Format ${ctx.config.formatVersion}; supported ${defaultConfig().formatVersion}.` });
  let files = [];
  check('symlinks', () => {
    const found = inventory(ctx.root);
    files = found.files;
    return { ok: !found.links.length, hint: found.links.join('; ') || 'No symlinks.' };
  });
  check('locks', () => locks(ctx, files));
  check('pending', () => {
    const pending = files.filter((path) => path.startsWith('.cairn/pending/') && path.endsWith('.json'));
    return { ok: !pending.length, hint: pending.join('; ') || 'No pending intents.' };
  });
  let existed = false;
  check('index_check', () => {
    existed = fs.lstatSync(checkedPath(ctx.root, '.cairn/index.db'), { throwIfNoEntry: false }) !== undefined;
    if (!existed) return { ok: true, hint: 'Index cache is absent; it can be built.' };
    let db;
    try {
      // openIndex repairs corruption; record the original state before asking refresh to use it.
      db = new DatabaseSync(checkedPath(ctx.root, '.cairn/index.db'), { readOnly: true, timeout: 0 });
      const results = db.prepare('PRAGMA quick_check').all().map((row) => row.quick_check);
      return { ok: results.every((value) => value === 'ok'), hint: results.join('; ') };
    } finally { db?.close(); }
  });
  check('index_fresh', () => {
    const changed = refresh(ctx, { verify: true });
    const ok = !ctx.warnings.includes('index_unavailable') && (!existed || changed.added + changed.updated + changed.removed === 0);
    return { ok, hint: ctx.warnings.includes('index_unavailable') ? 'Index cache is unavailable.'
      : `Verified index: ${changed.added} added, ${changed.updated} updated, ${changed.removed} removed.` };
  });
  let items = [];
  check('duplicate_id', () => {
    items = rows(ctx);
    const ids = new Map();
    for (const item of items) if (item.id !== null) {
      if (!ids.has(item.id)) ids.set(item.id, []);
      ids.get(item.id).push(item.path);
    }
    const duplicates = [...ids].filter(([, paths]) => paths.length > 1).map(([id, paths]) => `${id}: ${paths.join(', ')}`);
    return { ok: !duplicates.length, hint: duplicates.join('; ') || 'No duplicate ids.' };
  });
  check('unknown_column', () => {
    const unknown = items.filter((item) => item.type === 'card' && !ctx.config.columns.some(({ key }) => key === item.data.column));
    return { ok: !unknown.length, hint: unknown.map((item) => `${item.path}: ${JSON.stringify(item.data.column) ?? 'missing column'}`).join('; ') || 'All card columns are known.' };
  });
  return checks;
}
