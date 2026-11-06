import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { delimiter, join, posix, win32 } from 'node:path';

export const CHECKS = ['console', 'csp', 'overflow', 'overlap', 'axe', 'reduced-motion', 'keyboard'];
export const FAMILIES = ['bento', 'paper', 'graphite'];
const BROWSERS = ['chrome', 'brave', 'chromium', 'webkit', 'firefox'];

export function parseArgs(args) {
  const options = { browser: 'chromium', quick: false, only: null, workers: 4, help: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--quick') options.quick = true;
    else if (flag === '--help') options.help = true;
    else if (['--browser', '--only', '--workers'].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
      options[flag.slice(2)] = flag === '--workers' ? Number(value) : value;
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!BROWSERS.includes(options.browser)) throw new Error(`--browser must be one of: ${BROWSERS.join(', ')}.`);
  if (!Number.isInteger(options.workers) || options.workers < 1 || options.workers > 16) throw new Error('--workers must be an integer from 1 to 16.');
  return options;
}

export function discoverPages(root, only = null) {
  const dir = join(root, 'design/prototypes');
  const screens = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !['_shared', '_styleguide'].includes(entry.name))
    .filter((entry) => {
      try { return statSync(join(dir, entry.name, 'index.html')).isFile(); } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    })
    .map((entry) => ({ name: entry.name, path: `/prototypes/${encodeURIComponent(entry.name)}/` }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const pages = [{ name: 'index', path: '/prototypes/index.html' }, { name: '_styleguide', path: '/prototypes/_styleguide/' }, ...screens];
  if (only === null) return pages;
  const selected = pages.filter((page) => page.name === only);
  if (!selected.length) throw new Error(`Unknown screen: ${only}. Available: ${pages.map((page) => page.name).join(', ')}`);
  return selected;
}

export function buildMatrix({ quick = false } = {}) {
  if (quick) return [{ width: 1280, family: 'bento', mode: 'light' }];
  return FAMILIES.flatMap((family) => (family === 'bento' ? [375, 1280, 2000] : [1280])
    .flatMap((width) => ['light', 'dark'].map((mode) => ({ width, family, mode }))));
}

export function resolveBrowser(name, {
  platform = process.platform, env = process.env, downloadedPath,
  isExecutable = (file) => {
    try {
      accessSync(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
      return statSync(file).isFile();
    } catch { return false; }
  },
} = {}) {
  const engine = ['chrome', 'brave'].includes(name) ? 'chromium' : name;
  if (env.CAIRN_BROWSER_PATH) {
    if (!isExecutable(env.CAIRN_BROWSER_PATH)) throw new Error('CAIRN_BROWSER_PATH is not an executable file.');
    return { engine, executablePath: env.CAIRN_BROWSER_PATH };
  }
  if (!['chrome', 'brave'].includes(name)) {
    if (!downloadedPath || !isExecutable(downloadedPath)) throw new Error(`Missing ${name} browser. Run: npx playwright-core install ${name}`);
    // Without a path Playwright starts its headless shell, a bare binary with no app bundle: a crash or a
    // killed run cannot raise the system's "quit unexpectedly" dialog the way an installed Chrome does.
    if (name === 'chromium') return { engine, executablePath: undefined };
    return { engine, executablePath: downloadedPath };
  }
  let candidates = [];
  if (platform === 'darwin') {
    candidates = [name === 'chrome' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'];
  } else if (platform === 'win32') {
    const relative = name === 'chrome' ? ['Google', 'Chrome', 'Application', 'chrome.exe'] : ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'];
    candidates = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean).map((base) => win32.join(base, ...relative));
  } else if (platform === 'linux') {
    candidates = (env.PATH || '').split(platform === process.platform ? delimiter : ':').filter(Boolean)
      .map((base) => posix.join(base, name === 'chrome' ? 'google-chrome' : 'brave-browser'));
  }
  const executablePath = candidates.find(isExecutable);
  if (!executablePath) throw new Error(`Cannot find ${name}. Install it or set CAIRN_BROWSER_PATH to its executable.`);
  return { engine, executablePath };
}

// Counts retain every finding; only the first five messages per check per page are stored.
export function aggregateResults(results) {
  const pages = new Map();
  const cases = results.map(({ checks, ...entry }) => {
    if (!pages.has(entry.page)) pages.set(entry.page, { page: entry.page, checks: {} });
    const summary = pages.get(entry.page).checks;
    const statuses = {};
    for (const [check, findings] of Object.entries(checks)) {
      const totals = summary[check] ||= { pass: 0, fail: 0, warnings: 0, messages: [] };
      const errors = findings.filter((finding) => finding.level !== 'warning');
      const warnings = findings.length - errors.length;
      totals[errors.length ? 'fail' : 'pass']++;
      totals.warnings += warnings;
      // Failures take precedence over warnings in the limited detail budget.
      for (const finding of [...errors, ...findings.filter((item) => item.level === 'warning')]) {
        totals.messages.push({ ...entry, check, level: finding.level || 'error', message: finding.message.replace(/\s+/g, ' ').slice(0, 240) });
      }
      totals.messages.sort((a, b) => Number(a.level === 'warning') - Number(b.level === 'warning'));
      totals.messages = totals.messages.slice(0, 5);
      statuses[check] = { status: errors.length ? 'fail' : 'pass', failures: errors.length, warnings };
    }
    return { ...entry, checks: statuses };
  });
  return { summary: [...pages.values()].sort((a, b) => a.page.localeCompare(b.page, 'en')), cases };
}

export function exitCode(report) {
  return report.error || report.summary.some((page) => Object.values(page.checks).some((check) => check.fail > 0)) ? 1 : 0;
}
