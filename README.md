# Cairnboard

## English

Cairnboard is a local project board, notes and journal for developers who work with coding agents
(Claude Code, Codex, Gemini CLI, Cursor). It keeps many projects in one folder of plain Markdown files that
you can also open in Obsidian, and gives your agent a command-line tool so it can pick up a card, report
progress and log what it did. Cairnboard never starts agents itself; your agent runs in its own terminal and
uses the board as shared state.

**Status:** under development. The board and wiki CLI are available; the graphical interface is planned.

### Web interface

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

The cookie-protected read API serves `/api/home`, `/api/board`, `/api/cards/:id` and `/api/notes/:id` via GET (HEAD is also supported).

**Agent board.** Keep agent work in one project and name it in `.cairn/config.json` as
`"agents": { "project": "<project-id>" }`. Its cards then leave the main board and Home and appear on `/agents` (the
robot button beside search); Home shows how many sit in each column. A column with `"hidden": true` (for example
`{ "key": "archive", "label": "Archive", "role": "done", "hidden": true }`) is left off both boards: move reviewed
agent cards there and open them from the board's Archive link. The CLI and the API still list every column and card.

### CLI

Requires Node.js ≥ 22.23.4. From a fresh clone:

```sh
git clone <repo>
cd cairnboard
npm ci
npm run build:cli
node dist/cairn.mjs schema --json
```

Replace `<repo>` with this repository's clone URL. Optionally run `npm link` to expose `cairn` on
PATH; otherwise use `node dist/cairn.mjs` from the clone. Keep the clone and both files in `dist/` in
place, and rebuild after updating the source.

Initialize a data folder (quote paths containing spaces):

```sh
node dist/cairn.mjs init "./cairn-data" --language en --actor owner
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
node dist/cairn.mjs project add --title acme --actor owner --data "./cairn-data" --json
node dist/cairn.mjs project list --data "./cairn-data" --json
node dist/cairn.mjs note add --title zorblax --project @projects/acme --actor owner --data "./cairn-data" --json
node dist/cairn.mjs note list --project @projects/acme --data "./cairn-data" --json
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
node dist/cairn.mjs card add --title zorblax --project @projects/acme --body-file card.md --actor owner --data "./cairn-data" --json
node dist/cairn.mjs card list --unassigned --column-role todo --compact --json --data "./cairn-data"
node dist/cairn.mjs card claim @cards/zorblax --actor agent --data "./cairn-data" --json
node dist/cairn.mjs card check @cards/zorblax 1 --actor agent --data "./cairn-data" --json
node dist/cairn.mjs card check @cards/zorblax 2 --actor agent --data "./cairn-data" --json
node dist/cairn.mjs card done @cards/zorblax --if-revision <revision> --actor agent --data "./cairn-data" --json
node dist/cairn.mjs journal add --label acme --title zorblax --item "Completed both checks" --actor agent --data "./cairn-data" --json
```

Claim moves the card to the first `doing` role column and leases it for 120 minutes by default.
Use `card claim <ref> --renew` for long work, or `card release <ref>` to release it (with actor and data
options). A conflicting owner returns exit 4. Completing unchecked acceptance items warns but does
not block completion. `--body-file` reads a file relative to the current directory; stdin is read only
with `--body -`, so a bodyless add never waits for an open input pipe.

Install agent instructions from a terminal after building:

```sh
node dist/cairn.mjs agent install --dry-run --json
node dist/cairn.mjs agent install --target claude
node dist/cairn.mjs agent check --json
node dist/cairn.mjs agent print
```

`agent install` shows its destinations and changes, then requires typing `yes` in a TTY. Without
`--target` it writes `~/.claude/skills/cairnboard/SKILL.md` and `~/.agents/skills/cairnboard/SKILL.md`.
`--target claude` selects only the first; `--target agents` selects the second (Codex, Gemini CLI,
Cursor and Antigravity desktop). `--target antigravity-cli` selects
`~/.gemini/antigravity-cli/skills/`, writing `cairnboard/SKILL.md` there. Repeat `--target` to select several.
The generated skill contains the quoted full CLI path. Reinstall after moving the clone or updating it;
`agent check` reports installed versions and path validity. `agent print` prints a fragment you can
copy into a project's `AGENTS.md`; it does not edit that file.
Generated skills must fit within 24 KB of UTF-8 text. If a long clone path makes them exceed that
limit, installation and dry-run fail before changing any skill files; move the clone to a shorter path and rebuild.

After optional `npm link`, run this from a separate project's Git repository, replacing `<project-id>`
with the ID returned by `project add` and setting `CAIRN_DATA` to the data folder if needed:

```sh
cairn link <project-id> --actor owner --gitignore
```

Without `npm link`, invoke the clone's `dist/cairn.mjs` using its quoted full path. `link` requires TTY
confirmation and writes a `.cairn` project pointer in the Git root; `--gitignore` adds `.cairn` to
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
node dist/cairn.mjs card add --title acme --actor owner --dry-run --data "./cairn-data" --json
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

### Wiki

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
`init "./new-wiki" --preset tr-wiki --language tr --actor owner` with the CLI invocation above.

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
`--superseded-by <ref>` for validity and replacement metadata.

Once the summary and directly affected pages are saved, read the research record's latest revision
with `research show <research-id>` and mark it processed. Replace the placeholders with that record's
ID (or path selector) and revision; the summary update changes the revision returned by ingest.

```sh
node dist/cairn.mjs research update <research-id> --processed --if-revision <revision> --actor agent --data "./cairn-data" --json
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

### Settings

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

License: MIT.

## Türkçe

Cairnboard, kodlama ajanlarıyla (Claude Code, Codex, Gemini CLI, Cursor) çalışan geliştiriciler için yerel bir
proje panosu, not ve günlük uygulamasıdır. Birden çok projeyi, Obsidian'da da açılabilen düz Markdown
dosyalarından oluşan tek bir klasörde tutar; ajanınıza bir komut satırı aracı verir, ajan bir kartı alır,
ilerlemesini yazar ve yaptığını günlüğe kaydeder. Cairnboard ajan başlatmaz; ajanınız kendi terminalinde
çalışır ve panoyu ortak durum olarak kullanır.

**Durum:** geliştirme aşamasında. Pano ve wiki komut satırı aracı kullanılabilir; grafik arayüz planlanıyor.

### Web arayüzü

`npm start` web arayüzünü derler, sunucuyu başlatır ve tarayıcıyı açar. Sunucu 4321–4340 aralığındaki
ilk boş portu kullanır ve yalnızca geri döngüde (`127.0.0.1` ve `::1`) dinler. Çalışan arayüzü yeniden açmak için
`cairn open` kullanın.

Arayüz `http://<26 harf>.cairnboard.localhost:4321/` gibi size özel bir adreste açılır. Harfler anahtarınızdan
türetilir: bu makinede hep aynıdır, başkası tahmin edemez; `*.localhost` her zaman kendi makinenizi gösterir. Başka
adresler (`127.0.0.1`, `localhost`) reddedilir. Tarayıcılar çerezi bir adın bütün portlarında paylaştığı için sabit
bir ad, aynı makinedeki başka bir hesabın başka porttaki bir sayfayla çerezi toplamasına izin verirdi.

Okumalar dahil her sayfa oturum çerezi ister. `npm start` ve `cairn open` tarayıcıyı 60 saniye geçerli, tek
kullanımlık bir bağlantıyla açar; çerez sonra 30 gün geçerlidir ve sunucu yeniden başlasa da kalır. Çerezi
olmayan tarayıcı `cairn open` çalıştırmanızı isteyen bir sayfa görür. Anahtar veri klasöründe değil, kullanıcının
durum klasöründe tutulur.

Oturum çereziyle korunan okuma API’si `/api/home`, `/api/board`, `/api/cards/:id` ve `/api/notes/:id` yollarında yalnız GET sunar (HEAD de desteklenir).

**Ajan panosu.** Ajan işlerini bir projede toplayın ve `.cairn/config.json` dosyasına
`"agents": { "project": "<proje-kimliği>" }` olarak yazın. Bu projenin kartları ana panodan ve Ana sayfadan çıkar,
`/agents` sayfasında (aramanın yanındaki robot düğmesi) görünür; Ana sayfa her sütunda kaç iş olduğunu gösterir.
`"hidden": true` taşıyan sütun (örneğin `{ "key": "archive", "label": "Arşiv", "role": "done", "hidden": true }`) iki
panoda da görünmez: incelenen ajan kartlarını oraya taşıyın, panonun Arşiv bağlantısından açın. CLI ve API bütün
sütunları ve kartları listelemeyi sürdürür.

### CLI

Node.js ≥ 22.23.4 gerekir. Yeni klonda:

```sh
git clone <repo>
cd cairnboard
npm ci
npm run build:cli
node dist/cairn.mjs schema --json
```

`<repo>` yerine bu deponun klon URL'sini yazın. İsteğe bağlı `npm link`, `cairn` komutunu PATH'e ekler;
aksi halde klon içinden `node dist/cairn.mjs` kullanın. Klonu ve `dist/` içindeki iki dosyayı yerinde tutun;
kaynak güncellendiğinde yeniden derleyin.

Veri klasörünü başlatın (boşluklu yolları tırnaklayın):

```sh
node dist/cairn.mjs init "./cairn-data" --language tr --actor owner
```

Var olan Markdown/Obsidian kasasında elle şema yazmadan klasör eşlemelerini önizleyin:

```sh
cairn init --detect "./vault" --dry-run --json --actor owner
cairn init --detect "./vault" --language tr --yes --actor owner
```

Tespit, güven ve gerekçe içeren tablo gösterir (`--json` yapılandırılmış veri döndürür).
`--dry-run` yoksa config farkını inceleyip terminalde onaylayın; etkileşimsiz yazma için `--yes` kullanın.
`--if-revision` mevcut config'i korur. `--detect`, `--preset`, konumsal yol veya `--set-default` ile
birlikte kullanılamaz. Yalnız `.cairn` üst verisini değiştirir; varsayılan kasa kaydetmez.
Sonraki komutlarda `--data "./vault"` kullanın. Kasanın Markdown dosyalarına dokunulmaz.
Gizli klasörler, sembolik bağlar ve şablonlar atlanır; tarama adları ve Markdown dosyalarının sınırlı
başlangıcını okur, yalnız ön bilgiyi ayrıştırır. Belirsiz eşlemeler uyarı üretir; kalan Markdown not sayılır.
Kasa kökü not yolu olamadığı için varsayılan not klasörleri korunur; önizleme yeni notların yazılacağı yeri gösterir.
Başlatılmış kasalarda tespit yalnız eksik şema girdilerini ekler; mevcut kökler ve eşlemeler korunur.
Çakışan kökler uyarıyla atlanır. Görülen tür yazımları büyük/küçük harfleriyle birebir değer eşlemesine eklenir.

Veri keşif sırası: `--data` > `CAIRN_DATA` > `init` ile platformun `state.json` dosyasına kaydedilen yol
> `~/Cairn`. Başlatma klasörü kaydeder; kabuğun ortam değişkenlerini değiştirmez. Aşağıdaki örnekler
`--data` kullanır. Okumalarda aktör gerekmez; yazmalarda `--actor` ya da `CAIRN_ACTOR` zorunludur
(`agent install` hariç). Olaylarda `cli:owner`, kartın sahip alanında `owner` tutulur.

`cairn help` (veya `cairn --help`, `cairn -h`) komutları listeler; `cairn help card add`
ya da `cairn card add --help` seçenekleri gösterir. Yardım başlatmadan önce çalışır ve `--json` destekler.
`--project` kimlik, mevcut `@path` seçicisi veya büyük/küçük harf duyarsız tam başlık ya da takma ad kabul eder.
Belirsiz adlarda eşleşen kimlikler listelenir; birini seçmek için kimlik kullanın.

Proje ve not oluşturup listeleyin:

```sh
node dist/cairn.mjs project add --title acme --actor owner --data "./cairn-data" --json
node dist/cairn.mjs project list --data "./cairn-data" --json
node dist/cairn.mjs note add --title zorblax --project @projects/acme --actor owner --data "./cairn-data" --json
node dist/cairn.mjs note list --project @projects/acme --data "./cairn-data" --json
```

Şu gövdeyi çalışma klasöründe `card.md` olarak kaydedin:

```markdown
Implement the acme task.

## Acceptance
- [ ] First check
- [ ] Second check
```

Kartı ekleyip ajan akışını izleyin. Yol seçicileri yeni bir veri klasörünü varsayar; oluşturma sonucunda
dönen kimlikler de kullanılabilir. `card done` öncesinde `<revision>` yerine son `card check` yanıtındaki
revision değerini yazın.

```sh
node dist/cairn.mjs card add --title zorblax --project @projects/acme --body-file card.md --actor owner --data "./cairn-data" --json
node dist/cairn.mjs card list --unassigned --column-role todo --compact --json --data "./cairn-data"
node dist/cairn.mjs card claim @cards/zorblax --actor agent --data "./cairn-data" --json
node dist/cairn.mjs card check @cards/zorblax 1 --actor agent --data "./cairn-data" --json
node dist/cairn.mjs card check @cards/zorblax 2 --actor agent --data "./cairn-data" --json
node dist/cairn.mjs card done @cards/zorblax --if-revision <revision> --actor agent --data "./cairn-data" --json
node dist/cairn.mjs journal add --label acme --title zorblax --item "Completed both checks" --actor agent --data "./cairn-data" --json
```

`claim` kartı ilk `doing` rollü sütuna taşır; varsayılan süre 120 dakikadır. Uzun işlerde
`card claim <ref> --renew`, bırakmak için `card release <ref>` kullanın (aktör ve veri seçenekleriyle).
Başka sahip varsa çıkış 4 döner. İşaretlenmemiş kabul maddeleriyle bitirme uyarı verir, engellenmez.
`--body-file` çalışma klasörüne göre dosya okur; stdin yalnız `--body -` ile okunur. Gövdesiz ekleme,
açık bir giriş borusunu beklemez.

Derledikten sonra terminalde ajan talimatlarını kurun:

```sh
node dist/cairn.mjs agent install --dry-run --json
node dist/cairn.mjs agent install --target claude
node dist/cairn.mjs agent check --json
node dist/cairn.mjs agent print
```

`agent install` hedefleri ve değişiklikleri gösterir, ardından TTY'de `yes` yazılmasını ister.
`--target` verilmezse `~/.claude/skills/cairnboard/SKILL.md` ve
`~/.agents/skills/cairnboard/SKILL.md` dosyalarına yazar. `--target claude` yalnız ilkini,
`--target agents` ikincisini seçer (Codex, Gemini CLI, Cursor ve Antigravity masaüstü).
`--target antigravity-cli`, `~/.gemini/antigravity-cli/skills/` altında `cairnboard/SKILL.md` yazar.
Birden çok hedef için `--target` tekrarlanabilir. Üretilen skill, CLI'nin tırnaklanmış tam yolunu içerir.
Klon taşınınca veya güncellenince yeniden kurun; `agent check` kurulu sürümleri ve yol geçerliliğini
bildirir. `agent print`, projenin `AGENTS.md` dosyasına kopyalayabileceğiniz bir parça basar;
dosyayı kendisi değiştirmez.
Üretilen skill UTF-8 olarak en fazla 24 KB olabilir. Uzun klon yolu sınırı aştırırsa kurulum ve
önizleme hiçbir skill dosyasını değiştirmeden hata verir; klonu daha kısa bir yola taşıyıp yeniden derleyin.

İsteğe bağlı `npm link` sonrasında ayrı bir projenin Git deposunda aşağıdakini çalıştırın.
`<project-id>` yerine `project add` sonucundaki kimliği yazın; gerekirse `CAIRN_DATA` değişkenini
veri klasörüne ayarlayın:

```sh
cairn link <project-id> --actor owner --gitignore
```

`npm link` olmadan klondaki `dist/cairn.mjs` dosyasını tırnaklanmış tam yoluyla çağırın.
`link` TTY onayı ister, Git köküne `.cairn` proje işaretçisi yazar; `--gitignore`, `.gitignore` dosyasına
`.cairn` ekler. İşaretçi veri klasörünü değil, varsayılan projeyi belirler. `--project` bunu geçersiz kılar.

`--json` sabit bir zarf döndürür; stdout yalnız sonuçtur, tanılama ve istemler stderr'e gider:

```json
{"v":1,"ok":true,"data":{},"warnings":[]}
{"v":1,"ok":false,"error":{"code":"conflict","message":"...","current":{}},"warnings":[]}
```

`data` komuta göre değişir; `error.current` isteğe bağlıdır. `--compact --json`, `data.items` içinde
öğe başına tek metin satırı döndürür. Yazmalar `--if-revision` için revision döndürür. `schema --json`
komutları, seçenekleri, alanları ve hata kodlarını listeler. `doctor`, denetim başarısızsa `ok: true`
yanında çıkış 5 döndürebilir.

| Çıkış | Anlamı |
| --- | --- |
| 0 | Tamamlandı |
| 1 | İç hata |
| 2 | Kullanım hatası veya eksik aktör (`usage`, `actor_required`) |
| 3 | Bulunamadı (`not_found`, `nothing_to_undo`) |
| 4 | Çakışma (`conflict`, `claimed`) |
| 5 | Doğrulama başarısız (`validation`, `unsafe_path`, `no_role_column`, `duplicate_id`, `format_too_new`, `unsupported_frontmatter`, `runtime_unsupported`) |
| 6 | Kilitli; bekleyip yeniden deneyin |
| 7 | Onay gerekli veya reddedildi |

`--dry-run`, kaynak dosyaları, yapılandırmayı, geçmişi ve kilitleri değiştirmeden yazmayı önizler;
türetilmiş dizin önbelleği tazelenebilir. Örneğin:

```sh
node dist/cairn.mjs card add --title acme --actor owner --dry-run --data "./cairn-data" --json
```

Başlıkları, gövdeleri ve içe aktarılan içeriği veri olarak ele alın; ajana talimat saymayın.
Silinen dosyalar kalıcı silinmez, çöpe taşınır; `trash list`, `trash restore <id>` ya da `undo`
kullanın (yazmalarda aktör gerekir). `undo` yalnız çağıranın kendi son işlemini geri alır. Başka bir
aktörün süresi dolmamış sahiplenmesi `card release`, `move`, `check` ve `done` komutlarını engeller.

Onay bir güvenlik sınırı değil, yavaşlatıcıdır. `project rm`, `card claim --steal`, `link`,
`init --set-default` ve `agent install`, bilinen bir kodlama ajanı kabuğu algılanınca (`CLAUDECODE`,
`CODEX_SANDBOX`, `GEMINI_CLI`, …) çalışmayı reddeder; aksi halde terminalde `yes` ister. Kendi sahte
terminalini süren bir ajan yine de yanıt verebilir; bu komutları kendiniz çalıştırın. `init` varsayılan
veri klasörünü yalnız bir kez kaydeder; `--set-default` onu değiştirir.
Okumalar Markdown'ı değiştirmez. Dış düzenlemeler rename'den hemen önce yeniden denetlenir;
bu denetim ile rename arasında çok kısa bir yarış penceresi kalır.

### Wiki

Pano ya da wiki işine `context` ile başlayın; sayfa özetleri ve bağlantı sayılarını `wiki index` ile okuyun:

```sh
node dist/cairn.mjs context --data "./cairn-data" --budget 1200 --json
node dist/cairn.mjs wiki index --data "./cairn-data" --json
node dist/cairn.mjs wiki index --format markdown --data "./cairn-data"
```

`note list` varsayılan olarak hızlı notları listeler; wiki sayfalarını katmak için `--all`, tür seçmek
için `--kind concept` ekleyin. `note show` giden bağlantıları ve geri bağlantıları da verir. Bağlam
paketinde uyanış, etkin projeler, kartlar, yakın tarihli kararlar, merkez sayfalar ve bekleyen iş
sayıları bulunur; `--project <ref>` kapsamı daraltır.

Mevcut Türkçe Obsidian kasasını başlatmadan ve dosyalarını değiştirmeden okuyabilirsiniz:

```sh
node dist/cairn.mjs context --data "./existing-vault" --preset tr-wiki --json
node dist/cairn.mjs wiki lint --data "./existing-vault" --preset tr-wiki --json
```

`tr-wiki`, Türkçe klasörleri ve `tur`, `etiketler`, `guncelleme` gibi alanları kanonik JSON anahtarlarına
eşler. Ham kaynakları ve yardımcı dosyaları wiki sayfalarına katmaz. Geçici okuma kipinde türetilen
dizin işletim sisteminin durum klasöründe durur; kasada `.cairn` oluşmaz. Yazma için başlatılmış veri
klasörü gerekir. Yeni bir Türkçe wiki oluşturmak için yukarıdaki CLI çağrısıyla
`init "./new-wiki" --preset tr-wiki --language tr --actor owner` çalıştırın.

Önce yakala, sonra derle. Başlatılmış veri klasöründe UTF-8 `.md` ya da `.txt` kaynağını içe aktarın:

```sh
node dist/cairn.mjs ingest --title 'acme source' --file source.md --url https://example.com/source --actor agent --data "./cairn-data" --json
node dist/cairn.mjs ingest --title 'acme source' --body - --actor agent --data "./cairn-data" --dry-run --json
node dist/cairn.mjs search 'acme' --type raw --data "./cairn-data" --json
```

`--body -` stdin okur; kaynak metnini bir pipe ya da ajanın stdin arayüzüyle verin. Girdi en fazla
5 MB olabilir; ikili ya da geçersiz UTF-8 girdi reddedilir. `--url` yalnız kaynak adresini kaydeder,
içerik indirmez. Ingest, kaynak/tarih künyesinin arkasına özgün girdi baytlarını saklar ve aynı işlemde
işlenmemiş araştırma kaydı oluşturur. Aynı girdi baytları yeniden verilirse yeni dosya açmadan
`duplicate: true` döner. Dönen araştırma kaydına kısa özet yazın, yalnız doğrudan etkilenen sayfaları
güncelleyin; ayrıntılı sentezi ihtiyaç doğana bırakın. Ham kaynakları değiştirmeyin; düzeltmeleri ve
tarihli güncellemeleri wiki sayfasına yazın. İddiaları kaynağa dayandırın, çelişkileri `> [!WARNING]`
ile koruyun; değişen bilgide önceki değeri tarihli üstü çizili metinle ya da `valid_from` / `valid_until`
ve `superseded_by` alanlarıyla saklayın.

`note add` ve `note update`, birlikte kullanılamayan `--pin` ve `--unpin` seçeneklerini destekler.
Not ve araştırma ekleme/güncelleme komutları geçerlilik ve yerine geçen kayıt için
`--valid-from YYYY-MM-DD`, `--valid-until YYYY-MM-DD` ve `--superseded-by <ref>` kabul eder.

Özet ve doğrudan etkilenen sayfalar kaydedilince `research show <research-id>` ile araştırmanın güncel
revision değerini okuyup işlenmiş olarak işaretleyin. Yer tutucular yerine kaydın kimliğini (ya da yol
seçicisini) ve revision değerini yazın; özet güncellemesi ingest sonucundaki revision değerini değiştirir.

```sh
node dist/cairn.mjs research update <research-id> --processed --if-revision <revision> --actor agent --data "./cairn-data" --json
```

Eksik kalan kaynakları işlenmemiş bırakın. Bu adım tamamlanan kaynağı lint'in `unprocessed_source`
bulgularından ve bağlam paketinin bekleyen sayısından çıkarır; ayrıntılı sentez yine sonraya kalabilir.

Sayfayı kaydetmeden önce tam taslağını stdin üzerinden, veri klasörüne göre hedef yoluyla denetleyin:

```sh
node dist/cairn.mjs wiki check - --path wiki/concepts/acme.md --data "./cairn-data" --json
node dist/cairn.mjs wiki lint --verify --evidence --code --data "./cairn-data" --json
```

`wiki check` taslağı kaydetmez; hata varsa çıkış 5 döner. `required`, `sources`, `links`, `filename`
kuralları `config.rules` ciddiyetlerini kullanır; zorunlu alanlar, kaynaklar ve bağlantılar varsayılan
olarak uyarıdır. `wiki lint` dosyaları onarmadan raporlar; `--strict` hata ya da uyarıda çıkış 5 döndürür.
`--verify` ham kaynak özetlerini yeniden hesaplar, `--evidence` alıntı ve sayıları yerel ham metinle
karşılaştırır, `--code` bağlanmış projede referans verilen kodun değişmesini denetler. Kanıt denetimi
bir iddianın doğru olduğunu kanıtlamaz. Bulguları inceleyip düzeltmeleri onayladıktan sonra ajana
uygulatın. Günlükte sıradan `--item` yerine `--decision`, `--discovery`, `--pitfall`, `--lesson` ile
karar, keşif, tuzak ve ders kaydedebilirsiniz.

`mentions`, bir notun adını (başlık, dosya adı ya da takma ad; Türkçe büyük/küçük harf katlamasıyla)
geçirip ona bağlantı vermeyen sayfaları listeler; kod, var olan wiki bağlantıları ve nota zaten bağlantı
veren sayfalar atlanır. Kesme işaretinden sonraki ek anma sayılır (`Acme'de`), bitişik ek sayılmaz.
`--link <yol>:<satır>` o satırdaki tek anmayı onayınızdan sonra wiki bağlantısına çevirir; `undo` geri alır.

```sh
node dist/cairn.mjs mentions @notes/acme --data "./cairn-data" --json
node dist/cairn.mjs mentions @notes/acme --link notes/board.md:12 --actor owner --data "./cairn-data"
```

İsteğe bağlı Claude Code Write/Edit kancasını kendiniz bir terminalden kurabilirsiniz:

```sh
node dist/cairn.mjs agent install --target claude --hooks --dry-run --json
node dist/cairn.mjs agent install --target claude --hooks
node dist/cairn.mjs agent check --json
node dist/cairn.mjs doctor --data "./cairn-data" --json
```

Kurulum ayar farkını gösterir, onay ister, başka kancaları korur ve mevcut ayarları atomik olarak
değiştirmeden önce yedekler. `CLAUDE_CONFIG_DIR` varsa `~/.claude` yerine onu kullanır. Kanca normal
veri keşfini (`CAIRN_DATA` ya da kayıtlı varsayılan) kullanır; başlatılmamış kasa için çağrıda açıkça
`--data` ve `--preset` gerekir. Önerilen sayfa metnini ayarlı kurallarla denetler; hataları engeller,
uyarıları ajanın bağlamına verir. Veri bulunamazsa, düzenleme belirsizse ya da beklenmedik girdi
gelirse izin verir; bu yüzden taslak denetimini de kullanın. Kapsam Claude Code Write/Edit'tir;
kabukla yazma ve diğer ajanlar kapsam dışındadır. Ayrıntı: [Claude Code kanca protokolü](https://code.claude.com/docs/en/hooks).

### Ayarlar

Sahip web arayüzündeki `/settings` sayfasından ya da `cairn config` komutuyla dört isteğe bağlı özelliği açıp
kapatabilir. `.cairn/config.json` içinde yazılmayan özellik varsayılan olarak açık sayılır:

- **Değişiklik izi (`change-trail` / `changeTrail`)**: dış Markdown düzenlemelerini (kim, ne zaman, hangi dosya)
  kaydeder. Kapatılınca uzlaştırma durur; yeniden açılınca sahte dosya olayları yerine `.cairn/shadow` yeniden taban
  alır ve tek bir `external.gap` olayı yazılır. Kendi yazmaları ve `undo` geçmişi etkilenmez.
- **Ne değişti (`change-content` / `changeContent`)**: `changes --diff` ile farkları gösterebilmek için `.cairn/shadow`
  içinde önceki içerik kopyalarını saklar. Kapatılınca yalnız revizyonlar tutulur (`content_not_kept`).
  `change-trail` kapalıyken etkisizdir.
- **Canlı güncelleme (`live-updates` / `liveUpdates`)**: dosyalar değişince açık web sayfalarını `/api/events`
  üzerinden yeniler. Kapalıyken `/api/events` 404 döner ve sayfalar elle yenilenir; sunucu izleyicisi dizini ve
  açıksa değişiklik izini güncellemeyi sürdürür.
- **Bağlantısız anmalar (`mentions`)**: bağlantısız not anmalarını bulur ve bağlar. Kapalıyken `mentions`
  `feature_disabled` hatası verir, `help` komutu `(disabled)` gösterir ve `agent install` ajanın skill belgesinden
  çıkarır. Önceki bağlantılara dokunulmaz.

Ayarları herhangi bir terminalden okuyabilir, kendi etkileşimli terminalinizden ya da `/settings` sayfasından
değiştirebilir ve iz revizyonlarını koruyarak saklanan içerik kopyalarını temizleyebilirsiniz:

```sh
node dist/cairn.mjs config --data "./cairn-data" --json
node dist/cairn.mjs config get change-trail --data "./cairn-data"
node dist/cairn.mjs config set change-content off --data "./cairn-data"
node dist/cairn.mjs config clear-shadow --data "./cairn-data"
```

`config set <özellik> on|off` ve `config clear-shadow` yalnız sahibin kendi etkileşimli terminalinde çalışır (`--yes`
yoktur): TTY olmayan akışlarda veya bilinen bir kodlama ajanı kabuğunda `owner_only` hatası verir. Onay için
özellik adını (`clear-shadow` için `clear`) yazmanız istenir; `--actor` verilmezse `owner` (`cli:owner`) kullanılır.
`cairn context`, ajanı etkileyen kapalı özellikleri `settings` bölümünde açıkça listeler.

Ayarlar yalnız sahip içindir, ancak CLI sahipliği kriptografik bir sınır değildir: `--actor` serbest yazıdır, kendi
sahte terminalini süren bir araç yanıt verebilir ve `.cairn/config.json` diskte doğrudan düzenlenebilir. Amaç sessiz
değişiklik olmamasıdır: yazmalar terminal onayı ya da korumalı `/settings` POST isteği gerektirir, değişiklikler
`config.change` (temizleme `shadow.clear`) yazar, `features` alanındaki elle düzenlemeler `config.external`
(`owner:external`) olarak kaydedilir ve kapalı özellikler `context` çıktısında görünür.

Lisans: MIT.
