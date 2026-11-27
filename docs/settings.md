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

## Language

`language` (`en` or `tr`) is the interface language of the data folder; the interface falls back to English. It is
not interface-only: journal section labels, the Turkish writing rules and the wiki sort order follow it. Board column
names are your data and are never translated.

- **Web**: choose English or Türkçe under Language on `/settings` and save. The running server switches in the same
  process, so the next page (the error pages included) is already in the new language; no restart.
- **CLI**: `config get language` prints the code and `config set language tr|en` changes it, under the same
  owner-only rule as the features (type `language` to confirm). `config --json` includes `language`.
- After a CLI change or a hand edit, the running interface keeps its previous language until you restart the server
  or save the language on `/settings`.

## Board

In Board on `/settings`, save a column name, hide or show a column, or move it one place up or down. Each action
saves separately. Names must be non-empty and at most 40 characters. Names must be distinct even if they differ
only in case or in the Turkish dotted and dotless i. Each role's first column must stay visible. Column keys and
roles stay the same.

Hidden columns and their cards appear in the archive. Showing the last hidden column removes the archive from the
board. Column order decides the destinations for new, claimed, finished, and restored cards. Lanes keep their role
order, and changing the order leaves existing cards in their columns.

Set Claim lease to a whole number from 5 to 1440 minutes. The new value applies to future claims and renewals.
If settings changed elsewhere while the page was open, reopen Settings and repeat the action on the latest values.

The same settings are available from the terminal:

- `cairn config get columns` lists the keys, names, roles, and hidden status in order.
- `cairn config set column.<key>.label "New name"` renames one column.
- `cairn config set column.<key>.hidden on|off` hides or shows one column.
- `cairn config set columns-order <key1>,<key2>,...` sets the order. Include every column key exactly once.
- `cairn config get lease-minutes` reads the lease, and `cairn config set lease-minutes <minutes>` changes it.

## Commands

Inspect settings from any terminal, or change them and clear stored shadow content copies (leaving trail revisions
intact) from your own interactive terminal or `/settings`:

```sh
node dist/cairn.mjs config --data "./cairn-data" --json
node dist/cairn.mjs config get change-trail --data "./cairn-data"
node dist/cairn.mjs config set change-content off --data "./cairn-data"
node dist/cairn.mjs config get language --data "./cairn-data"
node dist/cairn.mjs config set language tr --data "./cairn-data"
node dist/cairn.mjs config clear-shadow --data "./cairn-data"
```

Writes with `config set` and `config clear-shadow` require the owner's interactive terminal and a typed confirmation.
Non-TTY streams or known coding-agent shells fail with `owner_only`. Type the setting name (for example,
`language` or `lease-minutes`) for `config set` and `clear` for `config clear-shadow`. `--actor` defaults to
`owner` (`cli:owner`). `cairn context` lists disabled agent-facing features in a `settings` section.

Settings are owner-only, though CLI ownership is not a cryptographic boundary: `--actor` is free text, a tool driving
its own pseudo-terminal could respond, and `.cairn/config.json` can be edited on disk.

## Settings events

- Changes to language and Board settings from the web or CLI, and changes to Home project visibility from the web,
  log `config.change`. Its `fields` array contains only the changed field names. Feature toggles also log
  `config.change`, using `feature`, `before`, and `after`. The former `config.language` and `config.home` event
  names are retired.
- Detected hand edits to `features`, `language`, `home.hiddenProjects`, `leaseMinutes`, and column names, visibility,
  or order log `config.external` with actor `owner:external`. Feature changes use `changed` and `after`, while
  other tracked settings use `fields`. The column field names are `columns.label`, `columns.hidden`, and
  `columns.order`. Adding or removing a column by hand affects the recorded column order. If the revision changed
  and the previous field digests are unavailable, `unknown: true` marks the listed fields as possibly changed.
- Clearing the shadow store logs `shadow.clear`.
