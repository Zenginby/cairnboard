# Cairnboard

## English

Cairnboard is a local project board, notes and journal for developers who work with coding agents
(Claude Code, Codex, Gemini CLI, Cursor). It keeps many projects in one folder of plain Markdown files that
you can also open in Obsidian, and gives your agent a command-line tool so it can pick up a card, report
progress and log what it did. Cairnboard never starts agents itself; your agent runs in its own terminal and
uses the board as shared state.

**Status:** under development. The milestone A CLI is available; the graphical interface is planned.

### CLI

Requires Node.js ≥ 22.16. From a fresh clone:

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

Data discovery order is `--data` > `CAIRN_DATA` > the path registered by `init` in the platform's
`state.json` > `~/Cairn`. Initialization registers the folder; it does not change your shell's environment.
The examples below use `--data` explicitly. Reads need no actor; writes require `--actor` or
`CAIRN_ACTOR` (except `agent install`). Events record `cli:owner`, while card ownership stores `owner`.

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

License: MIT.

## Türkçe

Cairnboard, kodlama ajanlarıyla (Claude Code, Codex, Gemini CLI, Cursor) çalışan geliştiriciler için yerel bir
proje panosu, not ve günlük uygulamasıdır. Birden çok projeyi, Obsidian'da da açılabilen düz Markdown
dosyalarından oluşan tek bir klasörde tutar; ajanınıza bir komut satırı aracı verir, ajan bir kartı alır,
ilerlemesini yazar ve yaptığını günlüğe kaydeder. Cairnboard ajan başlatmaz; ajanınız kendi terminalinde
çalışır ve panoyu ortak durum olarak kullanır.

**Durum:** geliştirme aşamasında. A aşamasının CLI aracı kullanılabilir; grafik arayüz planlanıyor.

### CLI

Node.js ≥ 22.16 gerekir. Yeni klonda:

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

Veri keşif sırası: `--data` > `CAIRN_DATA` > `init` ile platformun `state.json` dosyasına kaydedilen yol
> `~/Cairn`. Başlatma klasörü kaydeder; kabuğun ortam değişkenlerini değiştirmez. Aşağıdaki örnekler
`--data` kullanır. Okumalarda aktör gerekmez; yazmalarda `--actor` ya da `CAIRN_ACTOR` zorunludur
(`agent install` hariç). Olaylarda `cli:owner`, kartın sahip alanında `owner` tutulur.

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

Lisans: MIT.
