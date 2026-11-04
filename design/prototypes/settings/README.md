# Settings (Ayarlar)

Workspace settings in Bento boxes on the canvas. Preview: `http://127.0.0.1:4391/prototypes/settings/`.

- **Reproduces:** the home page's box style (28px radius, soft shadow, 19px box titles) and the top bar's segmented pill (grey track, white indicator with the indicator shadow). The original had no settings page.
- **Görünüm:** three theme cards. Each card holds a live miniature drawn with that family's own tokens: the element carries `data-theme` and the resolved `data-mode`, so the miniatures follow light and dark. Next to the cards are Görünüm (Sistem, Açık, Koyu), a "Hareket: az" switch and Dil (Türkçe, English). The cards and segments call `setTheme` and `setMode` from `_shared/theme.js` with the clicked control as origin, so the circular theme reveal grows from it. The switch is a `data-motion-toggle`, which theme.js applies through `setLessMotion`. The top bar menu and this page stay in step through `themechange`.
- **Veri klasörü:** a read-only path field and the note "Değiştirmek için `cairn init`".
- **Sahiplenme süresi:** minutes from 5 to 240, with an inline error.
- **Pano sütunları:** rename (unique and non-empty), role select (Yapılacak, Sürüyor, Bitti), reorder with up and down buttons, add, and remove. Remove asks for confirmation in a danger dialog that also picks where the column's cards go. A warning appears if no "Yapılacak" or no "Bitti" column is left. Reorder and remove use a FLIP slide (`duration-fast`, `ease-settle`). Added rows rise in. Removed rows fade out.
- **Ajanlar:** detected agent skills, read only, with Güncel or Eski sürüm shown as a word and a colour.
- **Saving:** every change shows "Kaydediliyor…" and then "Kaydedildi · config.yml" in a live status pill.
- **States:** dolu, boş (no config.yml yet: create the defaults), yükleniyor, hata, kilitli (column editing disabled with a lock message), 409 çakışma (config.yml changed outside: Yeniden yükle applies the outside version) and uzun metin (long data path).
- **Keyboard:** native radios (arrow keys inside each group), checkbox switch, inputs and buttons. Focus follows a moved column's button and goes to the neighbouring row after a removal.
- **Known limits:** Dil is saved, but the prototype stays in Turkish. Nothing is written to disk.
