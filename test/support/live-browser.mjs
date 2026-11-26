import { statSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { resolveBrowser } from '../../scripts/lib/design-check/config.mjs';

function executableMissing(path) {
  try { return !statSync(path, { throwIfNoEntry: false }); } catch { return false; }
}

export async function launchLiveChromium() {
  const candidate = process.env.CAIRN_BROWSER_PATH;
  if (candidate && executableMissing(candidate)) {
    return { browser: null, unavailable: `Chromium executable missing: ${candidate}` };
  }
  const executablePath = candidate ? resolveBrowser('chromium').executablePath : undefined;
  const options = {
    executablePath,
    headless: true,
    timeout: 15_000,
    args: ['--no-proxy-server', '--host-resolver-rules=MAP *.cairnboard.localhost 127.0.0.1'],
  };
  for (let attempt = 1; ; attempt += 1) {
    try {
      return { browser: await chromium.launch(options), unavailable: null };
    } catch (error) {
      // With no override, Playwright launches its headless shell, which may be missing separately.
      const message = error.message.replace(/^browserType\.launch: (?:Failed to launch chromium because )?/u, '');
      const missing = /^executable doesn't exist at ([^\r\n]+)/iu.exec(message);
      if (missing && executableMissing(missing[1])) return { browser: null, unavailable: error.message };
      if (attempt === 2) throw error;
    }
  }
}
