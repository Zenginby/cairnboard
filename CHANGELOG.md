# Changelog

## [Unreleased]

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
