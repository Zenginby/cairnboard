# Contributing

## Development setup

Requires Node.js ≥ 22.23.4.

```sh
git clone https://github.com/Zenginby/cairnboard.git
cd cairnboard
npm run hooks:install
npm ci
npm run build:cli
node dist/cairn.mjs init ~/Cairn --language en --actor owner
npm start
```

`npm start` builds and starts the web interface. Run `node dist/cairn.mjs` for CLI help or `npm link` to add
`cairn` and `cairnboard` to your PATH.

Run `npm run test:pack` to build, pack and install the npm package in temporary directories and check that it starts.
For a tarball alone, use `npm pack --ignore-scripts=false` to enable `prepack` for that command.

## Checks and conventions

- Code, file, data-key and command names are English; user-facing text lives in `src/i18n/`.
- Run `npm run check:types` to check JavaScript types in `core/` without emitting files.
- Run `npm run check:style` to check changed lines against the Git base (override with `-- --base <ref>`).
- Tests: `npm test` (Node built-in test runner, no dependencies).
- Prototype acceptance: `npm run design:check` (requires a browser; see [Checking the prototypes](design/README.md#checking-the-prototypes)).
- README screenshots: `npm run screenshots` rewrites `docs/images/` from fictional data (dates change, so run it only
  when the UI changed). It needs Playwright's Chromium: `npx playwright-core install chromium`, or `CAIRN_BROWSER_PATH`.
- Never put personal data (names, e-mail addresses, home paths, machine names) into files, commit messages,
  branch names or pull request descriptions. Use `example.com` and invented names in tests.
- Releases follow the checklist in [docs/releasing.md](docs/releasing.md).

## B1.5 live-update acceptance

Run `npm run test:live` alone on a machine with native file watching, loopback access and Chrome.
It sets `CAIRN_LIVE_STRICT=1`, runs the SSE and browser tests sequentially, and requires a CLI claim
and the resulting Board update within two seconds. A skipped integration test is not acceptance.
The normal suite asserts the same event and card movement with a 15-second budget under parallel load.
Browser failures include every HTTP response with status 400 or above and its URL; console errors are not filtered.

The watcher debounces for 150 ms with a maximum scheduled wait of one second. These timers cannot
preempt a busy event loop or synchronous index refresh. Chokidar's `atomic` coalesces an unlink/add
pair for an atomic save into a change; notifications describe the resulting state, not every intermediate
write. Scheduling and filesystem/index work can delay delivery under load. OS watcher exhaustion or
lost native notifications can still miss a live update; focus reconciliation and the five-minute refresh
recover the final state, but do not guarantee two-second delivery in that fallback mode.

Hidden tabs close their SSE stream and reconnect when visible. With HTTP/1.1, six or more visible
windows on the same origin can still exhaust the browser's connection pool and delay page fetches.
