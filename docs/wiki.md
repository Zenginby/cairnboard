# Wiki

[← README](../README.md)

Start board or wiki work with `context`; inspect page summaries and link counts with `wiki index`:

```sh
node dist/cairn.mjs context --data "./cairn-data" --budget 1200 --json
node dist/cairn.mjs wiki index --data "./cairn-data" --json
node dist/cairn.mjs wiki index --format markdown --data "./cairn-data"
node dist/cairn.mjs changes --since 0 --actor owner:external --diff --limit 20 --data "./cairn-data" --json
```

`changes` lists recorded writes; filter with `--since <seq|ISO>`, `--target <id|path>` or `--actor <name>`.
`--diff` shows at most 200 lines and 16 KiB per event. The default limit is 20 events, with a maximum of 200.
External edits are recorded after five quiet seconds while the server watches, or before CLI writes,
`changes` and `context`. Ordinary read commands and `--dry-run` do not reconcile. A first scan silently
establishes the baseline. A read-only or locked metadata directory yields `reconcile_skipped` so reads can continue.

`context --actor <name>` includes `owner_changes` since that actor's last context cursor; without an actor it
shows the last 24 hours. After an exit 4 revision conflict, run `changes --target <ref> --diff`, re-read the note,
then retry with its current revision. The conflict names the last recorded actor and time.

`note list` lists quick notes by default; add `--all` to include wiki pages or `--kind concept` to
select a kind. `note show` includes outgoing links and backlinks. Context includes the wake-up,
active projects, cards, recent decisions, hubs and pending counts; `--project <ref>` narrows it.

Read an existing Turkish Obsidian vault without initializing it or changing its files:

```sh
node dist/cairn.mjs context --data "./existing-vault" --preset tr-wiki --json
node dist/cairn.mjs wiki lint --data "./existing-vault" --preset tr-wiki --json
```

`tr-wiki` maps Turkish folders and fields such as `tur`, `etiketler` and `guncelleme` to canonical
JSON keys. It excludes raw material and support files from wiki pages. In this transient read mode
the derived index lives in the platform's state directory; no `.cairn` folder appears in the vault.
Writes require an initialized data folder. To create a new Turkish wiki, use
`init "./new-wiki" --preset tr-wiki --language tr --actor owner` with the CLI invocation from [CLI](cli.md).

Capture first, compile later. In an initialized data folder, ingest a UTF-8 `.md` or `.txt` source:

```sh
node dist/cairn.mjs ingest --title 'acme source' --file source.md --url https://example.com/source --actor agent --data "./cairn-data" --json
node dist/cairn.mjs ingest --title 'acme source' --body - --actor agent --data "./cairn-data" --dry-run --json
node dist/cairn.mjs search 'acme' --type raw --data "./cairn-data" --json
```

`--body -` reads stdin: provide the source text through a pipe or your agent's stdin API. Input is
limited to 5 MB; binary or invalid UTF-8 input is rejected. `--url` records a citation and never
downloads content. Ingest saves the original input bytes behind source/date metadata and creates an
unprocessed research record in one transaction. Identical input bytes return `duplicate: true`
without new files. Write a short summary in the returned research record, update only directly
affected pages, and defer deeper synthesis until needed. Keep raw sources unchanged; put corrections
and dated updates in wiki pages. Cite sources for claims, preserve contradictions with `> [!WARNING]`,
and retain former values using dated strike-through or `valid_from` / `valid_until` and `superseded_by`.

`note add` and `note update` accept `--pin` or `--unpin` (mutually exclusive). Both note and
research add/update accept `--valid-from YYYY-MM-DD`, `--valid-until YYYY-MM-DD` and
`--superseded-by <ref>` for validity and replacement metadata. `research add` and `research update` also
accept `--category '<text>'`, an optional free one-line type of at most 100 characters (an empty value on
update removes it; the tr-wiki layout stores it as `kategori`).

Once the summary and directly affected pages are saved, read the research record's latest revision
with `research show <research-id>` and mark it processed. Replace the placeholders with that record's
ID (or path selector) and revision; the summary update changes the revision returned by ingest.

```sh
node dist/cairn.mjs research update <research-id> --processed --if-revision <revision> \
  --actor agent --data "./cairn-data" --json
```

Incomplete sources stay unprocessed. This step removes a completed source from lint's
`unprocessed_source` findings and the context pack's pending count; deeper synthesis can still wait.

Before saving a page, check its complete draft on stdin with a data-relative target path:

```sh
node dist/cairn.mjs wiki check - --path wiki/concepts/acme.md --data "./cairn-data" --json
node dist/cairn.mjs wiki lint --verify --evidence --code --data "./cairn-data" --json
```

`wiki check` does not save the draft; errors return exit 5. The `required`, `sources`, `links` and
`filename` checks use `config.rules` severities; required fields, sources and links warn by default.
`wiki lint` reports without repairing files; `--strict` returns exit 5 for errors or warnings.
`--verify` rehashes raw sources, `--evidence` compares quotes/numbers with local raw text, and `--code`
checks referenced code for drift after a project has been linked. Evidence checks do not establish
truth. Review findings and approve repairs before asking an agent to fix them. Journal entries can
use `--decision`, `--discovery`, `--pitfall` and `--lesson` instead of an ordinary `--item`.

`mentions` lists pages that name a note (title, file name or alias, with Turkish case folding) but do
not link to it; code, existing wiki links and pages that already link to it are skipped. A suffix after an
apostrophe still counts (`Acme'de`), a joined suffix does not. `--link <path>:<line>` turns the single
mention on that line into a wiki link after your confirmation; `undo` reverts it.

```sh
node dist/cairn.mjs mentions @notes/acme --data "./cairn-data" --json
node dist/cairn.mjs mentions @notes/acme --link notes/board.md:12 --actor owner --data "./cairn-data"
```

To add the optional Claude Code Write/Edit hook, run these yourself from a terminal:

```sh
node dist/cairn.mjs agent install --target claude --hooks --dry-run --json
node dist/cairn.mjs agent install --target claude --hooks
node dist/cairn.mjs agent check --json
node dist/cairn.mjs doctor --data "./cairn-data" --json
```

Installation previews the settings change, asks for confirmation, preserves other hooks and backs up
existing settings before replacing them atomically. `CLAUDE_CONFIG_DIR` overrides `~/.claude`.
The hook uses normal data discovery (`CAIRN_DATA` or the registered default); an uninitialized vault
needs an explicit invocation with `--data` and `--preset`. It checks proposed page text against the
configured rules, blocks errors and passes warnings as context. Missing data, ambiguous edits and
unexpected input fail open, so explicit draft checks remain useful. It covers Claude Code Write/Edit;
shell writes and other agents are outside its scope. See the [Claude Code hook protocol](https://code.claude.com/docs/en/hooks).
