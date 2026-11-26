import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const initTemplates = new Map();

export function seedDataDir(path, { language = 'en', preset = 'default', home, env = {}, register = true } = {}) {
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
  if (home && register !== false) {
    const state = stateDir({ env, home });
    mkdirSync(state, { recursive: true, mode: 0o700 });
    writeFileSync(join(state, 'state.json'), JSON.stringify({ data: realpathSync(path) }));
  }
}
