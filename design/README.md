## Checking the prototypes

Run `npm run design:check` with system Chrome installed. The command starts a loopback server on an ephemeral
port, checks every prototype and its state options, then closes the browser and server. It checks console errors,
CSP, overflow, pinned-rail overlap, axe accessibility, reduced motion and 15 keyboard Tab stops. Normal loads use
375, 1280 and 2000 px widths in light and dark Bento; Paper and Graphite also run at 1280 px in both modes.
Each case reloads with reduced motion before checking entry and hover animations. State options run at 1280 px
in light Bento, including with reduced motion.

- `npm run design:check -- --only board --quick` checks one screen at 1280 px in light Bento, including its states.
- `--only index` and `--only _styleguide` select the prototype directory and style guide.
- `--browser brave` uses system Brave; `CAIRN_BROWSER_PATH` overrides the executable for any browser.
- `--browser chromium`, `--browser webkit` and `--browser firefox` use Playwright's downloaded browsers. If missing,
  install the selected browser beforehand with `npx playwright-core install chromium` (or `webkit` / `firefox`).
- `--workers 4` sets the number of parallel contexts (default 4; range 1–16).

The stdout table shows passing/failing cases per page and check. `design/check-report.json` contains case results,
warning counts and up to five messages per check per page, with viewport, theme, mode and state. Serious and critical
axe findings fail; moderate and minor findings are warnings. Exit codes: 0 passed, 1 acceptance/runtime failure,
2 invalid arguments or browser unavailable. Browser launch is limited to 15 seconds, each case to 20 seconds and
the browser checks to 210 seconds. CI needs an installed browser and permission to launch it and bind loopback.
Pure unit tests run with `npm test` without launching a browser or opening a socket.
