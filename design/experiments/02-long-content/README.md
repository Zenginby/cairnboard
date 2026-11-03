# 02 – View Transitions on long content

Switches one document between a 300-card board and a ~20,000 px note with `document.startViewTransition`, with and without `view-transition-name` on `main` (checkbox toggles a class). Watch for jank, snapshot size limits, blank frames, scroll position after the swap. Standalone `board.html` / `note.html` show each view alone (for height measurement). Unsupported browsers: the page says so and switches instantly.

Open: `node design/experiments/serve.mjs`, then http://127.0.0.1:4390/02-long-content/

| Observation | Chrome | Brave | Safari | Firefox |
|---|---|---|---|---|
| startViewTransition supported | — | — | — | — |
| Smooth, unnamed `main` | — | — | — | — |
| Smooth, named `main` | — | — | — | — |
| Note height (px) | — | — | — | — |
| Scroll position after switch | — | — | — | — |
