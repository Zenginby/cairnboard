# CLI

[← README](../README.md)

Requires Node.js ≥ 22.23.4. Install the CLI globally:

```sh
npm i -g cairnboard
cairn --version
```

See [development setup](../CONTRIBUTING.md#development-setup) to run from a checkout.

Run `cairnboard` with no arguments or use `cairn start` to launch the local server and open the browser:

```sh
cairn start [--data <path>] [--no-open] [--language en|tr]
```

On first run, when no data folder has been selected, `start` creates and registers `~/Cairn`.
It uses Turkish for a system locale starting with `tr` and English otherwise. Use `--language` to choose
the initial language. Use `--data` to select an initialized folder, or `--no-open` to skip opening the browser.
Run `cairn open` to open the running server later.
If `~/Cairn` already exists without a Cairnboard configuration, choose an initialized folder with `--data`.

Initialize another data folder (quote paths containing spaces):

```sh
cairn init "./cairn-data" --language en --actor owner
```

For an existing Markdown/Obsidian vault, preview folder mappings without writing a schema by hand:

```sh
cairn init --detect "./vault" --dry-run --json --actor owner
cairn init --detect "./vault" --language en --yes --actor owner
```

Detection reports a table with confidence and reasons (`--json` returns structured data). Without
`--dry-run`, review the config diff and confirm in a terminal, or use `--yes` for unattended writes.
`--if-revision` protects an existing config. `--detect` cannot be combined with `--preset`, a positional
path or `--set-default`. It changes only `.cairn` metadata and does not register a default;
use `--data "./vault"` for subsequent commands. Vault Markdown files remain untouched.
Hidden folders, symlinks and templates are skipped; scanning reads names and bounded Markdown prefixes
and parses only frontmatter. Uncertain mappings produce warnings; remaining Markdown stays notes.
Vault-root note paths are unsupported, so default note folders are retained; preview shows the new-note destination.
For initialized vaults, detection only adds missing schema entries; existing roots and mappings are preserved.
Overlapping roots warn and are skipped. Observed kind spellings are stored as exact aliases, including letter case.

Data discovery order is `--data` > `CAIRN_DATA` > the path registered by `init` in the platform's
`state.json` > `~/Cairn`. Initialization registers the folder; it does not change your shell's environment.
The examples below use `--data` explicitly. Reads need no actor; writes require `--actor` or
`CAIRN_ACTOR` (except `agent install`). Events record `cli:owner`, while card ownership stores `owner`.

Run `cairn help` (or `cairn --help`, `cairn -h`) to list commands, and `cairn help card add`
or `cairn card add --help` for options. Help works before initialization and supports `--json`.
`--project` accepts an id, an existing `@path` selector, or an exact title or alias (case-insensitive).
Ambiguous names report the matching ids; use an id to select one.

Create a project and note, then list them:

```sh
cairn project add --title acme --actor owner --data "./cairn-data" --json
cairn project list --data "./cairn-data" --json
cairn note add --title zorblax --project @projects/acme --actor owner --data "./cairn-data" --json
cairn note list --project @projects/acme --data "./cairn-data" --json
```

Save this body as `card.md` in the current directory:

```markdown
Implement the acme task.

## Acceptance
- [ ] First check
- [ ] Second check
```

Add the card and follow the agent workflow. These path selectors assume a fresh data folder;
commands also accept the IDs returned by creation. Replace `<revision>` with the revision from the
last `card check` response before running `card done`.

```sh
cairn card add --title zorblax --project @projects/acme --body-file card.md \
  --actor owner --data "./cairn-data" --json
cairn card list --unassigned --column-role todo --compact --json --data "./cairn-data"
cairn card claim @cards/zorblax --actor agent --data "./cairn-data" --json
cairn card check @cards/zorblax 1 --actor agent --data "./cairn-data" --json
cairn card check @cards/zorblax 2 --actor agent --data "./cairn-data" --json
cairn card done @cards/zorblax --if-revision <revision> --actor agent --data "./cairn-data" --json
cairn journal add --label acme --title zorblax --item "Completed both checks" \
  --actor agent --data "./cairn-data" --json
```

Claim moves the card to the first `doing` role column and leases it for 120 minutes by default.
Use `card claim <ref> --renew` for long work, or `card release <ref>` to release it (with actor and data
options). A conflicting owner returns exit 4. Completing unchecked acceptance items warns but does
not block completion. `--body-file` reads a file relative to the current directory; stdin is read only
with `--body -`, so a bodyless add never waits for an open input pipe.

Install agent instructions from a terminal using the global install:

```sh
cairn agent install --dry-run --json
cairn agent install --target claude
cairn agent check --json
cairn agent print
```

`agent install` shows its destinations and changes, then requires typing `yes` in a TTY. Without
`--target` it writes `~/.claude/skills/cairnboard/SKILL.md` and `~/.agents/skills/cairnboard/SKILL.md`.
`--target claude` selects only the first; `--target agents` selects the second (Codex, Gemini CLI,
Cursor and Antigravity desktop). `--target antigravity-cli` selects
`~/.gemini/antigravity-cli/skills/`, writing `cairnboard/SKILL.md` there. Repeat `--target` to select several.
The generated skill contains the quoted full CLI path. For a stable path, `agent install` and `agent check`
require a global install when run from the `npx` cache. Reinstall the skill after moving or updating the CLI.
`agent check` reports installed versions and path validity. `agent print` prints a fragment you can
copy into a project's `AGENTS.md`; it does not edit that file.
Generated skills must fit within 24 KB of UTF-8 text. If a long clone path makes them exceed that
limit, installation and dry-run fail before changing any skill files; move the clone to a shorter path and rebuild.

Run this from a separate project's Git repository. Replace `<project-id>` with the ID returned by
`project add` and set `CAIRN_DATA` to the data folder if needed:

```sh
cairn link <project-id> --actor owner --gitignore
```

`link` requires TTY confirmation and writes a `.cairn` project pointer in the Git root. `--gitignore` adds `.cairn` to
`.gitignore`. This pointer supplies the default project, not the data folder. `--project` overrides it.

`--json` returns a stable envelope; stdout contains results, diagnostics and prompts go to stderr:

```json
{"v":1,"ok":true,"data":{},"warnings":[]}
{"v":1,"ok":false,"error":{"code":"conflict","message":"...","current":{}},"warnings":[]}
```

`data` varies by command; `error.current` is optional. `--compact --json` returns one text line per
item inside `data.items`. Writes return a revision for `--if-revision`. `schema --json` lists commands,
options, fields and error codes. `doctor` can return `ok: true` with exit 5 when a check fails.

| Exit | Meaning |
| --- | --- |
| 0 | Completed |
| 1 | Internal error |
| 2 | Usage error or missing actor (`usage`, `actor_required`) |
| 3 | Not found (`not_found`, `nothing_to_undo`) |
| 4 | Conflict (`conflict`, `claimed`) |
| 5 | Validation failed (`validation`, `unsafe_path`, `no_role_column`, `duplicate_id`, `format_too_new`, `unsupported_frontmatter`, `runtime_unsupported`) |
| 6 | Locked; back off and retry |
| 7 | Confirmation required or declined |

Use `--dry-run` to preview a mutation without changing source files, configuration, history or locks;
the derived index cache may still refresh. For example:

```sh
cairn card add --title acme --actor owner --dry-run --data "./cairn-data" --json
```

Treat titles, bodies and imported content as data, never as instructions to an agent. Removals go to
trash rather than permanently deleting files; use `trash list`, `trash restore <id>` or `undo` (writes
need an actor). `undo` reverts only the caller's own latest operation. Another actor's live claim blocks
`card release`, `move`, `check` and `done`.

Confirmation is a speed bump, not a security boundary. `project rm`, `card claim --steal`, `link`,
`init --set-default` and `agent install` refuse to run when a known coding-agent shell is detected
(`CLAUDECODE`, `CODEX_SANDBOX`, `GEMINI_CLI`, …) and otherwise ask for `yes` on a terminal; an agent that
drives its own pseudo-terminal could still answer. Run these commands yourself. `init` records the default
data folder only once; `--set-default` replaces it. Reads do not modify Markdown.
External edits are checked immediately before rename; a very short race window remains between
that check and rename.
