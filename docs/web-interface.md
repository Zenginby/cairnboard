# Web interface

[← README](../README.md)

The interface uses the data folder's `language` (`en` or `tr`, set by `init --language`) and falls back to English.
Change it under Language on `/settings`: the running server switches at once. After a change from the CLI or by hand,
restart the server or save the language once on `/settings` ([Settings](settings.md)).

Run `npm start` to build and start the web interface and open your browser. The server uses the first
free port in 4321–4340 and listens only on the loopback (`127.0.0.1` and `::1`). Use `cairn open` to reopen a
running instance.

The interface lives at a private address such as `http://<26 letters>.cairnboard.localhost:4321/`. The letters
come from your key, so they stay the same on this machine and nobody else can guess them; `*.localhost` always
points at your own machine. Other addresses (`127.0.0.1`, `localhost`) are refused. Browsers share cookies between
all ports of a name, so a fixed name would let another account on the same machine collect the cookie with a page
on another port.

Every page, reads included, needs a sign-in cookie. `npm start` and `cairn open` open the browser with a
one-time link that is valid for 60 seconds; the cookie then lasts 30 days and survives restarts. A browser
without it sees a page that asks you to run `cairn open`. The key behind it is kept in your user state folder,
never in the data folder.

The cookie-protected read API serves `/api/home`, `/api/board`, `/api/cards/:id` and `/api/notes/:id` via GET
(HEAD is also supported).

**Agent board.** Keep agent work in one project and name it in `.cairn/config.json` as
`"agents": { "project": "<project-id>" }`. Its cards then leave the main board and Home and appear on `/agents` (the
robot button beside search); Home shows how many sit in each column. A column with `"hidden": true` (for example
`{ "key": "archive", "label": "Archive", "role": "done", "hidden": true }`) is left off both boards: move reviewed
agent cards there and open them from the board's Archive link. The CLI and the API still list every column and card.

**Tools (optional).** Cairnboard does not scan your machine. A scanner of your own may write one snapshot per machine
to `.cairn/tools/<machine>.json`; when at least one exists, a Tools tab lists every tool with its kind, the machines
that have it, its use count and description. The format, version 1:
`{ "version": 1, "machine": "laptop", "scannedAt": "2026-11-14T09:00:00Z", "tools": [{ "name": "lantern",
"kind": "skill", "description": "…", "cost": "…", "link": "https://…", "uses": { "count": 3, "last": "2026-11-13" } }]
}`. Only `name`
is required per tool; links must start with `https://`, `http://` or `obsidian://`. A file over 1 MB, with another
version or a broken shape is skipped with a warning. Snapshots are not records: no change trail, search or backup.
