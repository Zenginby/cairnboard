# Tools (Araçlar)

Which AI agents, skills, plugins and MCP servers are installed for working with Cairnboard, on which machine, and whether they are used. Preview: `http://127.0.0.1:4391/prototypes/tools/`.

**Not part of v1.** This is the screen of an optional plugin that ships after v1. The prototype only fixes how it looks and behaves; nothing here exists in `core/` or `cli/` yet, and `cairn tools scan` is a planned command.

- **Data source (when built):** `cairn agent check` for each agent's Cairnboard skill (`güncel`, `eski sürüm`, `kurulu değil`); the skill folders `~/.claude/skills` and `~/.agents/skills` for skills; agent and MCP configuration files for plugins and servers; and the agents' own session logs, counted locally for "son kullanım" and "kez". The scan runs on each machine and everything stays there: nothing is uploaded and no log text is stored, only a last-used time and a count per tool.
- **Summary row:** a count per kind (Ajan, Skill, Eklenti, MCP sunucusu), then one tile per machine with its tool count, its last scan time and a status word (`okundu` or `kısmen okunabildi`).
- **Table:** name with a kind chip and a one-line description, the machines it is installed on, usage ("son kullanım 3 gün önce · 42 kez" or "hiç kullanılmadı") and, for agents only, the skill status per machine. A skill that is `eski sürüm` or `kurulu değil` shows its fix, `cairn agent install --target <ad>`, as code with a Kopyala button. If the clipboard is not available the command is selected instead.
- **Filters and order:** search (name and description), kind, machine, "Yalnız kullanılmayanlar", and sort by name or by last use (never-used tools go last). "Süzgeçleri temizle" appears while a filter is on; the count line is a live region.
- **States:** dolu, boş (no scan yet: names `cairn tools scan` and marks it planlanan), yükleniyor, hata, kısmen okundu (one machine's scan failed: a warning note with Taramayı yeniden dene, that machine's chips read "eski kayıt" and its skill status reads "okunamadı") and uzun metin. A filter with no match has its own row.
- **Layout:** columns from 56rem up. Below it every row is a stacked card with labelled parts; at 375px nothing scrolls sideways. Tiles go from six across to four, then two.
- **Motion:** none beyond the shared controls (colour on hover, the tab pill sliding to "Araçlar"); the shared reduced-motion rules apply.
- **Known limits:** the data is fixed sample data; the scan, the clipboard result of the install command and the retry only change this page. The machine list is two machines; more would wrap to further tiles.
