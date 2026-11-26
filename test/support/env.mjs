import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../../core/fsx.mjs';
import { checkedPath } from '../../core/paths.mjs';
import { initDataDir, stateDir } from '../../core/roots.mjs';

export { fixedClock } from '../../core/clock.mjs';

// Fresh temporary folders; callers pass them explicitly, process.env is never changed.
export const tempHome = () => mkdtempSync(join(tmpdir(), 'cairn-home-'));
export const tempData = () => mkdtempSync(join(tmpdir(), 'cairn-data-'));

// Resolved so symlinked temporary roots (macOS /var) compare exactly; removed when the test ends.
export function tempDir(t, prefix = 'cairn-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Clones one real initDataDir output per (language, preset) in this process so repeated fixture setup skips redundant
// directory and file fsyncs. Tests covering initDataDir itself still call initDataDir directly.
// initDataDir only seeds static config and ignore rules, so the template has no clock-dependent data or IDs.
const initTemplates = new Map();

export function seedDataDir(path, { language = 'en', preset = 'default', home, env = {}, register = true } = {}) {
  if (![true, false, 'if-unset'].includes(register)) throw new TypeError('Unsupported seedDataDir register mode.');
  if (register !== false && !home) throw new TypeError('seedDataDir registration requires an explicit home.');
  const key = `${language}:${preset}`;
  let template = initTemplates.get(key);
  if (!template) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'cairn-init-tpl-')));
    const data = join(base, 'data');
    const tplHome = join(base, 'home');
    mkdirSync(data, { recursive: true });
    mkdirSync(tplHome, { recursive: true });
    initDataDir(data, { language, preset, home: tplHome, env: {}, register: false });
    process.once('exit', () => {
      try { rmSync(base, { recursive: true, force: true }); } catch {}
    });
    template = data;
    initTemplates.set(key, template);
  }
  mkdirSync(path, { recursive: true });
  cpSync(template, path, { recursive: true });
  if (register !== false) {
    const state = stateDir({ env, home });
    if (register === 'if-unset' && existsSync(join(state, 'state.json'))) return;
    mkdirSync(state, { recursive: true, mode: 0o700 });
    writeFileAtomic(checkedPath(realpathSync(state), 'state.json'), JSON.stringify({ data: realpathSync(path) }),
      undefined, { durable: false });
  }
}
