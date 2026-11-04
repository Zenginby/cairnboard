# Settings (Ayarlar)

Workspace settings in Bento boxes on the canvas. Preview: `http://127.0.0.1:4391/prototypes/settings/`.

- **Reproduces:** the home page's box style (28px radius, soft shadow, 19px box titles) and the top bar's segmented pill (grey track, white indicator with the indicator shadow). The original had no settings page.
- **Görünüm:** three theme cards. Each card holds a live miniature drawn with that family's own tokens: the element carries `data-theme` and the resolved `data-mode`, so the miniatures follow light and dark. Next to the cards are a "Hareket: az" switch and Dil (Türkçe, English). Light and dark are chosen only in the top bar; this page keeps the theme-family choice. The cards call `setTheme` from `_shared/theme.js` with the clicked control as origin, so the circular theme reveal grows from it. The switch is a `data-motion-toggle`, which theme.js applies through `setLessMotion`. The top bar menu and this page stay in step through `themechange`.
- **Veri klasörü:** a read-only path field and the instruction "Değiştirmek için terminalde `cairn init <yeni-klasör> --set-default` komutunu çalıştır" (`cli/commands/write.mjs`, `init`).
- **Sahiplenme süresi:** `leaseMinutes` in `.cairn/config.json` (default 120): any positive whole number, with an inline error (`core/config.mjs`).
- **Pano sütunları:** rename (unique and non-empty), role select (Yapılacak, Sürüyor, Bitti), reorder with up and down buttons, add, and remove. Remove asks for confirmation in a danger dialog that also picks where the column's cards go. A warning appears if no "Yapılacak" or no "Bitti" column is left. Reorder and remove use a FLIP slide (`duration-fast`, `ease-settle`). Added rows rise in. Removed rows fade out.
- **Ajanlar:** detected agent skills, read only, with Güncel or Eski sürüm shown as a word and a colour.
- **Saving:** every change shows "Kaydediliyor…" and then "Kaydedildi · .cairn/config.json" in a live status pill.
- **States:** dolu, boş (no .cairn/config.json yet: create the defaults), yükleniyor, hata, kilitli (column editing disabled with a lock message), 409 çakışma (`.cairn/config.json` changed outside: Yeniden yükle applies the outside version) and uzun metin (long data path).
- **Keyboard:** native radios (arrow keys inside each group), checkbox switch, inputs and buttons. Focus follows a moved column's button and goes to the neighbouring row after a removal.
- **Known limits:** Dil is saved, but the prototype stays in Turkish. Nothing is written to disk.

## Data model

The real configuration is `.cairn/config.json` (`core/config.mjs`): `language`, `leaseMinutes` and `columns`, each column `{ key, label, role }` with `key` matching `^[a-z][a-z0-9-]*$` and `role` one of `todo`, `doing`, `done`. The fixture in `data.json` uses exactly these names. The prototype shares `data.columns` from `_shared/` with the board, which still uses an `id` field; stage C maps it to `key`.
