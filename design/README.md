# Design

`DESIGN.md` (repository root) is the single source for colour, type, spacing, radii, motion and copy. `npm run
design:build` turns it into `src/styles/tokens.css`; `npm run design:lint` checks both and every prototype.

## Prototypes: frozen reference (2026-11-04)

`design/prototypes/` holds one framework-free HTML/CSS/JS page per screen, with invented sample data and the
production CSP in a `<meta>` tag. Stage T closed with them **frozen**: they show how each screen looks, moves and
behaves; they are not code to copy. Stage B and C components are written in Astro against `DESIGN.md` and the
matching prototype. Change a prototype only to fix a defect `design:check` finds, or when the owner changes a screen
on purpose (then record the decision in the screen's README).

Open them with `npm run design:serve` → `http://127.0.0.1:4391/prototypes/`.

| Screen | Prototype | Built in | Notes |
|---|---|---|---|
| Home | `home/` | B (read), C (quick note, pin) | Lead project chosen with a star; stored in the data folder in B |
| Board | `board/` | B (read), C (drag, keyboard move, add) | Columns are keyed by `key` (`.cairn/config.json`) |
| Card | `card/` | B (read), C (edit, move, trash) | |
| Notes, Note | `notes/`, `note/` | B (read), C (edit with preview, pin, trash) | 409 conflict and locked messages shown |
| Projects, Project | `projects/`, `project/` | B (read), C (add, edit, archive, trash) | Deleting a project trashes only the project file |
| Journal, Journal day | `journal/`, `journal-day/` | B (read), C (add entry) | Data assumption in the READMEs: project from a `[[project-id]]` link |
| Research, Research item | `research/`, `research-item/` | B (read), C (edit, trash) | |
| Search | `search/` | B | Read-only: no locked or 409 state |
| Trash | `trash/` | C | Restore only; nothing is deleted for good |
| Settings | `settings/` | C | Light/dark lives only in the top bar |
| Setup | `setup/` | C | Folder validation instead of locked/409 states |
| 404, 500 | `not-found/`, `error/` | B | No path or stack trace |
| Graph | `graph/` + local panel | **v1.1** | Reference for the Obsidian-like graph; spec §3.2 |
| Tools | `tools/` | **v1.1 plugin** | Outside v1 (spec §1) |

Read-only screens (Search, Graph, Setup, 404, 500) have no locked or 409 conflict state on purpose: they never write.

**v1 keeps one theme family (Bento, light and dark).** Paper and Graphite stay in `design/themes/` and the prototypes
for v1.1; the B/C code reads only the Bento tokens until then.

## Known limits

- Prototype data is static JSON; session-only behaviour (pins, quick notes, lead project) lives in browser storage.
- The graph uses a small hand-written force layout; B replaces it with `d3-force` (spec §3.2).
- Diagrams, images and charts in notes are not in the prototypes yet (plan R, v1.1).
- `design:check` runs locally only: CI has no browser step. Firefox and WebKit were not run.

## Checking the prototypes

Run `npm run design:check` with system Chrome installed. The command starts a loopback server on an ephemeral
port, checks every prototype and its state options, then closes the browser and server. It checks console errors,
CSP, overflow, pinned-rail overlap, axe accessibility, reduced motion and 15 keyboard Tab stops. Normal loads use
375, 1280 and 2000 px widths in light and dark Bento; Paper and Graphite also run at 1280 px in both modes.
Each case reloads with reduced motion before checking entry and hover animations. State options run at 1280 px
in light Bento, including with reduced motion. Console and CSP findings are frozen before axe runs, because axe
inserts styles of its own. The full matrix is about 333 cases and takes 5–6 minutes.

- `npm run design:check -- --only board --quick` checks one screen at 1280 px in light Bento, including its states.
- `--only index` and `--only _styleguide` select the prototype directory and style guide.
- The default browser is Playwright's downloaded Chromium, started as its headless shell, so a check never
  launches (or crashes) your installed Chrome. `--browser chrome` and `--browser brave` use the system browsers; `CAIRN_BROWSER_PATH` overrides the executable for any browser.
- `--browser chromium`, `--browser webkit` and `--browser firefox` use Playwright's downloaded browsers. If missing,
  install the selected browser beforehand with `npx playwright-core install chromium` (or `webkit` / `firefox`).
- `--workers 4` sets the number of parallel contexts (default 4; range 1–16).

The stdout table shows passing/failing cases per page and check. `design/check-report.json` contains case results,
warning counts and up to five messages per check per page, with viewport, theme, mode and state. Serious and critical
axe findings fail; moderate and minor findings are warnings. Exit codes: 0 passed, 1 acceptance/runtime failure,
2 invalid arguments or browser unavailable. Browser launch is limited to 15 seconds, each case to 60 seconds and the
whole run to the larger of 4 minutes and 4 seconds per case. CI needs an installed browser and permission to launch
it and bind loopback. Pure unit tests run with `npm test` without launching a browser or opening a socket.
