# 09 – Type-to-search

Pressing a letter while focus is not in a text field opens a search box and puts that letter in it. Two strategies: focus on `keydown` and let the browser insert, or `preventDefault` and insert manually. The log shows `keydown`, `beforeinput`, `input`, `compositionstart/update/end`, and a verdict on whether the first character was lost. Shortcut keys `n c m g / ?` never open the search. Test `ğ ü ş ı ö ç İ`, dead keys (`^`, `¨`, `´` + vowel) and, if possible, an IME.

Open: `npm run design:serve`, then http://127.0.0.1:4391/experiments/09-type-to-search/

| Observation (strategy: focus) | Chrome | Brave | Safari | Firefox |
|---|---|---|---|---|
| `a` first char kept | — | — | — | — |
| `ğ ü ş ı ö ç İ` first char kept | — | — | — | — |
| Dead key `^` / `¨` + vowel | — | — | — | — |
| IME composition start/end seen | — | — | — | — |
| Shortcut keys do not open | — | — | — | — |

| Observation (strategy: manual) | Chrome | Brave | Safari | Firefox |
|---|---|---|---|---|
| `ğ ü ş ı ö ç İ` first char kept | — | — | — | — |
| Dead key behaviour | — | — | — | — |
