# Search (Ara)

Full search over notes, cards, wiki pages, research and journal entries. Preview: `http://127.0.0.1:4391/prototypes/search/` (`?q=` and `?tur=` preset the query and the type).

- **Reproduces:** the original's search dialog in Bento form: a large pill field, then result rows with the title, a kind badge, the project (tone dot), the date or column, and a snippet with every matched word in `<mark>`. The type filter pills with counts (Tümü, Notlar, Kartlar, Wiki, Araştırmalar, Günlük) use the board's filter-pill look.
- **Shared rows:** `_shared/search-results.js` builds the records, ranking (title hits first, every word must match, Turkish case folding), snippets and highlighting. `_shared/shell.css` holds the row styles. The top bar's search dialog (⌘K) on every page now uses the same rows, limited to 8, with a "Tüm sonuçları arama sayfasında aç" link to this page.
- **States:** with an empty field the page shows recent searches. A query with no results gets its own empty state, with actions to search all types, show the type that does have hits, or clear the field. The prototype states are dolu, boş, yükleniyor, hata and uzun metin. Uzun metin lengthens titles, snippets and project names.
- **Keyboard:** the field is a combobox. Arrow keys move the active result while focus stays in the field. Ctrl+Home and Ctrl+End go to the first and last result, Enter opens the active result and Escape clears the field. On this page, `/`, `⌘K` and the top bar's search button focus the big field instead of opening the dialog.
- **Motion:** a new result list fades in over `duration-quick`. Nothing moves while you type within the same results. Hovering or making a row active changes only its background, with no animation.
- **Known limits:** results open the detail pages (`../note/`, `../card/`, `../research-item/`, `../journal-day/`), which another prototype provides. Matching is substring only: no stemming and no typo tolerance.

## Sahip kararı 2026-11-09

The web app's search dialog takes four additions from the Homebrew documentation site's search. They are built
directly in Astro (`src/layouts/AppShell.astro`, `src/scripts/search-dialog.js`); this frozen prototype is unchanged.

1. **Groups by type:** results sit under **Kartlar** and **Notlar** headings; an empty group is hidden, and a group
   with more hits ends with "Tüm kartlar (N)" to `/search?q=…&type=…`.
2. **Recent searches in the dialog:** with an empty field the dialog lists recent searches (star keeps one at the
   top, × removes it). Stored in `localStorage` (`cairn.recent-searches.v1`); without storage the list is hidden.
3. **Keyboard hints in the footer:** `↵ seç · ↑↓ gez · esc kapat`, next to "Tüm sonuçları aç".
4. **Filled active row:** the active row is filled with the accent colour and shows `↵` on its right.
