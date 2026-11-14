# Settings

[← README](../README.md)

Owners can toggle four optional features from `/settings` in the web interface or with `cairn config`. All four
default to on when omitted from `.cairn/config.json`:

- **Change trail (`change-trail` / `changeTrail`)**: records external Markdown edits (who, when, which file). Turning
  it off stops reconciliation; turning it back on rebases `.cairn/shadow` and records one `external.gap` event instead
  of synthetic file changes. Own writes and `undo` history are unaffected.
- **What changed (`change-content` / `changeContent`)**: keeps prior content copies in `.cairn/shadow` so
  `changes --diff` can show diffs. Turning it off keeps revisions only (`content_not_kept`). Inactive while
  `change-trail` is off.
- **Live updates (`live-updates` / `liveUpdates`)**: reloads open web pages via `/api/events` when files change. When
  off, `/api/events` returns 404 and pages reload manually; the server watcher still refreshes the index and change
  trail.
- **Unlinked mentions (`mentions`)**: finds and links unlinked note mentions. When off, `mentions` fails with
  `feature_disabled`, `help` labels it `(disabled)` and `agent install` omits it from the agent skill. Previous links
  stay intact.

Inspect settings from any terminal, or change them and clear stored shadow content copies (leaving trail revisions
intact) from your own interactive terminal or `/settings`:

```sh
node dist/cairn.mjs config --data "./cairn-data" --json
node dist/cairn.mjs config get change-trail --data "./cairn-data"
node dist/cairn.mjs config set change-content off --data "./cairn-data"
node dist/cairn.mjs config clear-shadow --data "./cairn-data"
```

`config set <feature> on|off` and `config clear-shadow` run only in the owner's own interactive terminal (never with
`--yes`): non-TTY streams or known coding-agent shells fail with `owner_only`. Confirmation asks you to type the
feature name (`clear` for `clear-shadow`); `--actor` defaults to `owner` (`cli:owner`). `cairn context` lists disabled
agent-facing features in a `settings` section.

Settings are owner-only, though CLI ownership is not a cryptographic boundary: `--actor` is free text, a tool driving
its own pseudo-terminal could respond, and `.cairn/config.json` can be edited on disk. The goal is no silent changes:
writes require terminal confirmation or a protected `/settings` POST, toggles log `config.change` (clearing logs
`shadow.clear`), manual `features` edits log `config.external` (`owner:external`), and disabled features appear in
`context`.
