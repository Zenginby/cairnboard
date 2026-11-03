# Changelog

## [Unreleased]

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
