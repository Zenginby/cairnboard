# Security

Cairnboard runs only on your own machine and listens on the loopback (127.0.0.1 and ::1) at a private address,
`<label>.cairnboard.localhost`. Please report vulnerabilities through GitHub's private vulnerability reporting for
this repository, not in public issues.

## Known limitations

- **Prior note content remains in private metadata.** Editing or deleting a note does not erase its previous bytes:
  `.cairn/shadow/` keeps the last known content, up to 256 KiB per file and 64 MiB total, and external-change history
  retains the latest 200 records. The 50-record undo history for application writes is separate. Deleted secrets can
  therefore remain in these copies until they are replaced or pruned. Private history, shadow copies and agent cursors
  are git-ignored through `.cairn/.gitignore`; keep `.cairn/` excluded from other sharing and backups as appropriate.
  `.cairn/` is never included in application exports.
- **Programs running as you** (browser extensions, editor plugins, coding agents) can read your notes directly; the
  sign-in only protects against web pages and other accounts on the same machine.
- **Port takeover by another account after shutdown.** The private address stays the same between runs. If another
  account on the same machine binds Cairnboard's port after the server stops, and you then reload an old Cairnboard
  tab, your browser sends that account the private address and your session cookie. Mitigation on shared machines:
  close Cairnboard tabs when you stop the server. A per-run address would close this, at the cost of bookmarks and
  browser-stored preferences; it may become an option later.
