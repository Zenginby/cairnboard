import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit, firefox } from 'playwright-core';
import { createDesignServer } from './design-serve.mjs';
import { parseArgs, discoverPages, buildMatrix, resolveBrowser, aggregateResults, exitCode } from './lib/design-check/config.mjs';
import { checkCase } from './lib/design-check/case.mjs';
import { printTable } from './lib/design-check/report.mjs';

export { checkCase };

const root = fileURLToPath(new URL('../', import.meta.url));
const engines = { chromium, webkit, firefox };
const reportPath = new URL('../design/check-report.json', import.meta.url);
const usage = 'Usage: npm run design:check -- [--browser chrome|brave|chromium|webkit|firefox] [--only <screen>] [--quick] [--workers 4]';

async function main() {
  let browser;
  let server;
  let deadline;
  let report = { summary: [], cases: [] };
  let code = 1;
  let help = false;
  try {
    let options;
    let pages;
    let target;
    try {
      options = parseArgs(process.argv.slice(2));
      if (options.help) { help = true; console.log(usage); return; }
      pages = discoverPages(root, options.only);
      const engine = ['chrome', 'brave'].includes(options.browser) ? 'chromium' : options.browser;
      target = resolveBrowser(options.browser, { downloadedPath: engines[engine].executablePath() });
      browser = await engines[target.engine].launch({ executablePath: target.executablePath, headless: true, timeout: 15000 });
    } catch (error) {
      code = 2;
      throw new Error(`Cannot start design check: ${error.message}\n${usage}`);
    }
    server = createDesignServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    const axeSource = await readFile(fileURLToPath(import.meta.resolve('axe-core/axe.min.js')), 'utf8');
    const queue = pages.flatMap((page) => buildMatrix(options).map((variant) => ({ page: page.name, path: page.path, ...variant })));
    const results = [];
    let expired = false;
    // Bound the entire run as well as individual cases, including on a broken page/browser.
    // About 2.5 s per case on four workers; the full matrix is ~180 cases (measured 3.5 min on Chrome).
    deadline = setTimeout(() => { expired = true; browser.close().catch(() => {}); }, Math.max(240000, queue.length * 4000));
    await Promise.all(Array.from({ length: options.workers }, async () => {
      while (queue.length && !expired) {
        const entry = queue.shift();
        const discoverStates = entry.state === undefined && entry.width === 1280 && entry.family === 'bento' && entry.mode === 'light';
        try {
          const { result, states } = await checkCase(browser, baseURL, entry, axeSource, discoverStates);
          results.push(result);
          for (const state of states) queue.push({ ...entry, state });
        } catch (error) {
          results.push({ ...entry, checks: { runner: [{ message: error.message }] } });
        }
      }
    }));
    report = aggregateResults(results);
    if (expired) throw new Error(`Design check exceeded 210 seconds; ${queue.length} case(s) not started. Narrow with --only or --quick.`);
    code = exitCode(report);
  } catch (error) {
    report.error = error.message;
    console.error(error.message);
  } finally {
    clearTimeout(deadline);
    if (browser) await browser.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (!help) {
      printTable(report);
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      console.log('Report: design/check-report.json');
      process.exitCode = code;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
