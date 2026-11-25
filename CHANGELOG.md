# Changelog

## [Unreleased]

- Update Astro to 7.4.12 and the Node adapter to 11.1.13 to address the image endpoint path traversal advisory.
- Security scan: Dependabot's sign-off address and GitHub compare links in commit messages are no longer reported.

## [0.3.0] - 2026-11-16

- Cam scene: more detail (pines, a larger cairn, rocks, a lake with the sun or moon reflected) and slow background
  motion: clouds and mist drift, stars and lake glints take turns. Settings > Appearance gains "Background motion"
  (follow system, on, off), kept per browser; it stands still with reduced motion.
- Board: with the pinned rail open, the board stays centred on the screen while it fits, instead of on the space
  left of the rail.
- Release process: `docs/releasing.md` checklist and `npm run release:verify` version consistency check.
- Fix pinned-note excerpt stalls on `[` runs, `N` opening a duplicate form on `/notes/new`, `$&` in `{title}`
  replacements, and overlapping live-update pauses across the board and pinned rail.
- Notes: edit a note from its page (`/notes/<ref>/edit`, `POST /notes/<ref>`), script-free, with stale-revision and
  write-rule refusals returning the form with the text kept.
- Notes: a note link opens the note in a dialog (pin, edit, delete, open page); delete moves the note to the data
  folder's trash (`POST /notes/<ref>/delete`, with a confirm step). The notes page gains a title search, side-by-side
  topic columns and pin/delete buttons on each row.
- Quick note: the dialog closes after a save and a short toast links to the new note; the title field is a rounded
  field; an "Add link" picker writes `[[name|title]]` links, and the note page explains its "Linked from" list.
- Pinned rail: each note shows when it was added.
- Note dialog: pin, edit, delete, open page and close are icons at the top right; the note page no longer lists
  "Linked from" for now, the "Add link" picker is gone and the note field is labelled as plain text. On the notes
  page the row buttons sit where the chevron is, on slightly taller rows.
- Notes keep each typed line on its own line when read; a blank line still starts a new paragraph.
- Note dialog: only Close sits in the header; pin and larger, labelled Edit (blue) and Delete (red) buttons sit
  right under it, and "Open page" is gone. A note's "Updated" date moves to the bottom right. Deleting asks in a
  themed dialog in the middle of the screen instead of the browser's box.

## [0.2.0] - 2026-11-15

- Notes list page at `/notes`: pinned notes first, one section per topic (the folder under the notes root), project
  filter chips; the top bar gains a Notes entry.
- Quick notes: `POST /notes`, `/notes/new` and a global `N` shortcut dialog let the owner save a note from any page.
- Floating quick-note button, quick-note pin option, note-page `Pin` / `Unpin` action (`POST /notes/<ref>/pin`), and a
  wide-screen pinned-notes rail (`pinnedNotes`) across shell pages with row unpin + Undo and live updates.
- Settings: a Language card on `/settings` and `cairn config get|set language tr|en` change the data folder's
  language (owner-only, logged as `config.language`). A web save switches the running server at once, without a
  restart; `cairn config --json` includes `language`.
- The interface now falls back to English instead of Turkish when no language is set.
- The 404 and 500 pages are rendered per request instead of at build time, so they follow the interface language.

## [0.1.0] - 2026-11-15

First public release.

- The web interface follows the data folder's language (English or Turkish) instead of always Turkish.
- README: shorter English README with screenshots, a Turkish README.tr.md, and the full reference moved to `docs/`
  (`docs/tr/` in Turkish). `npm run screenshots` regenerates the images from fictional data.
- Owner board: drag cards between columns or reorder them; Alt + arrow keys offer the same moves.
- Board: a search box (focus it with `/`) matches card titles, status lines and project names; the project pills
  become one project choice, priority pills show their counts, and a clear button resets every filter.
- Board cards end with one row: project, priority and how long ago the card changed (full date on hover). A dot in
  each column heading and beside that time shows the column's role: amber for to do, blue for doing, green for done.
- Board cards and "Add card" open in a dialog instead of a new page; the edit form now has the Now, Next and Needs
  lines (they were missing, so the form looked empty) above the Markdown details. The card page keeps a compact
  move select as the keyboard and no-script path. The archive pill lifts with its card.
- Card dialog: a card opens readable, Edit switches to the form and Save returns to it; Go to project sits beside
  Close. Long Now/Next/Needs lines wrap. Form fields follow the theme. The project cover keeps its two buttons
  together at the end.
- Faster pages: the search index ran SQLite `quick_check` on every open (about 0.2 s on a few MB, several times per
  request); it now runs once per index file per process, and `cairn doctor` still checks on demand.
- Board archive: done cards carry an Archive button that moves them to the configured hidden done column, the
  toolbar links to `/board?archive` with its count, and archived cards there have a Restore button back to Done.
  The board search also matches card tags. With one column per role the board drops the "every column" link.
- Board shows one lane per column role by default, always in the order to do, doing, done, and lanes stop widening
  on large screens; a card in a merged lane carries its column as a chip and new cards go to the lane's first
  column. A toolbar link switches to every column, remembered in a cookie. Data and the agent board are unchanged.
- Optional Tools screen: reads per-machine snapshots from `.cairn/tools/` (written by a scanner outside Cairnboard),
  with kind, no-description and unused filters; the tab appears only when a snapshot exists.
- Fix research filters never hiding rows: the app had no `.hidden` rule.
- Cam is the default theme: frosted glass boxes over a dithered pixel horizon, with an opaque fallback when backdrop
  blur is missing or the reader asks for reduced transparency or more contrast. Every theme gains `glass-*` tokens;
  a test composites glass text pairs over every scene color, since the design.md lint reads alpha as opaque.
- Settings: a per-browser glass choice (follow system, on, off) for the Cam theme.
- Home boxes widen into the holes the six-column grid would leave, whichever boxes render.
- On phones each Board filter group is one row that scrolls sideways instead of wrapping into many rows.

- Open Settings in a centred dialog with a solid gear icon, feature switches and a shared no-script page.

- Fix the theme reveal circle finishing in under a millisecond in built pages (the minified duration token was
  read as milliseconds); project boxes lift on hover.
- Project cover and card page show a card's Next and Needs lines beside Now; the card page lists all three
  under the heading.
- Agent board: an optional `agents.project` setting moves that project's cards from the main board and Home to
  `/agents`; Home counts them per column. Columns may carry `hidden: true` (an archive) and are then left off both
  boards, with an Archive view on `/agents`. The CLI and the read API are unchanged.
- Settings and the agent board open from round icon buttons beside search; Settings is no longer a tab.
- Edit and move cards, tick acceptance items and add comments from the web card page.
- Add cards from the web board with validated fields and a session-bound, form-specific CSRF token.
- Move the shared checks of web writes (rate, content type, body size, CSRF, repeated fields) into one route table
  (`server/writes.mjs`); CSRF tokens are bound to a form name. Settings behave as before.
- Search: ⌘K dialog on every page and a /search page (cards and notes).
- Fix the edit hook reading a different file for a POSIX name that contains a backslash; such files are allowed
  unchecked with a warning.
- Add optional `features` settings (`changeTrail`, `changeContent`, `liveUpdates`, `mentions`) with single-entry
  reconcile gaps (`external.gap`), revision-only diff mode (`content_not_kept`), manual drift events
  (`config.external`), `clearShadow` (`shadow.clear`) and `feature_disabled` gates.
- Add `cairn config` (`get`, interactive owner-only `set` and `clear-shadow`), report disabled `mentions` in `help`
  and omit it from installed agent skills via template markers.
- Add the web `/settings` page and the first POST write path (`/settings/feature`, `/settings/clear-shadow`) with
  `Origin`, `Sec-Fetch-Site`, session-bound CSRF, body-size and rate checks; disable `/api/events` and the live
  script when `liveUpdates` is off.
- Report disabled agent-facing features in session `context`, forbid `.cairn/config.json` edits in the agent skill
  and document settings in English and Turkish.
- Fix change-trail review findings: track rebuilt undo revisions, run orphan pruning on full scans only, match
  filesystem case sensitivity with O(1) shadow lookups and size/mtime stamps, scope 8.3 short-name checks to
  Windows, validate event revisions, record file/folder swaps, block post-preflight `board.md` export overwrites and
  report disk failures as `reconcile_failed`.

- Record external Markdown edits with prior content, five-second watcher coalescing and one reconcile before CLI writes.
- Add `changes` with bounded line diffs, owner changes in session context, actor cursors and revision-conflict
  attribution.
- Git-ignore private shadow copies and agent cursors, preserving user ignore rules when upgrading existing data folders.
- Add `init --detect` with bounded read-only vault scanning, explained schema previews and confirmed config writes.
- Home shows a panel only when it has data; a folder with no content keeps the getting-started guidance.
- Fix the login launcher redirect so browsers reach the signed-in home page.
- Add `cairn help` and resolve `--project` by title or alias, including Turkish case folding.
- Treat Markdown in every eligible folder as notes and expose path-derived `n-<hash>` keys for notes without IDs.
- Normalize valid note IDs for lookup; notes with external IDs use note keys and keep their frontmatter.
- Keep note keys stable across updates; never overwrite an existing ID on other entity types.
- Reuse a healthy server watcher's successful index refresh across requests, checking cache generations and
  falling back to request scans when watching fails. Share ignored directories between the watcher and index.

- Add shared home/board CLI views, a cookie-protected GET read API and sanitized Markdown rendering. Markdown
  renders in a worker thread with a 5 s limit per page (`render_timeout`), so a slow page never stalls the server.
- Serve `/_astro/` without a cookie only when the raw path matches the parsed one; missing assets never reach pages.
- Add the local-only web server skeleton, CSP-safe Astro pages, startup state and `cairn open`.
- Require a sign-in cookie for every page: one-time 60 s login link from `npm start` / `cairn open`, HttpOnly
  SameSite=Strict cookie, key in the user state folder.
- Serve only a private site name (`<label>.cairnboard.localhost`, label derived from the key) on both loopbacks;
  every other Host gets 421 without a redirect. Login tokens never appear on a command line or in warnings.
- Skip ports whose IPv6 loopback is taken, so `localhost:<port>` cannot reach another app.

- Reject text mutations of invalid UTF-8 files without changing their bytes; preserve byte mutations.
- Skip and report unreadable pages and raw sources on indexed and fallback reads.
- Add mutually exclusive `--pin` / `--unpin` note options and expose research validity and
  replacement fields (`--valid-from`, `--valid-until`, `--superseded-by`) in the CLI and schema.
- Cache wiki summaries while indexing; rebuild older index schemas and avoid warm listing body reads.

- Fix review findings: wiki classification, text matching, bounded reads, indexing, mentions and repeatable source/code options.
- Add `mentions`: pages that name a note without linking to it (Turkish folding, word boundaries,
  code and existing links skipped), and `--link path:line` to convert one mention with confirmation and undo.
  The skill lists mentions after saving a note. 5,000 pages: ~30 ms of its own on top of the shared index freshness check.
- Reject generated skills larger than 24 KB before installation, including long or Unicode clone paths.
  Document and exercise marking summarized sources as processed so completed work leaves pending counts.
- Add wiki indexing, lint, draft checks, session context, source ingestion and raw-source search,
  with evidence, code drift and validity checks and transient reads of existing Turkish wikis.
- Add the optional Claude Code Write/Edit hook with settings previews, backups and fail-open handling.
  Honor explicit data/preset options and preserve separate backups for installs in the same second.
- Extend agent skills and the AGENTS.md fragment with the wiki workflow; document it in English and
  Turkish. Run every fenced skill example with fixtures and dry-run, preserve sources and enforce 24 KB.
- Repository skeleton and leak gate.
- Build the packaged CLI before tests on Linux, macOS and Windows; nightly runs use
  200 stress rounds and report CLI benchmark results without failing the job.
- Add bilingual CLI setup, agent workflow, confirmation and safety documentation.
- Add `npm run bench:cli`: 1,000 generated cards, 20 runs per command, one list warm-up,
  with process startup included. macOS, Node 24: median list 225.31 ms, claim 451.58 ms.
  Both exceed the respective < 150 ms and < 200 ms targets; reported as warnings only.
