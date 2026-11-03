# 03 – Persistent frame, fetch router, four transition variants

Two short pages (header, sidebar, content) share a fetch + `DOMParser` router that replaces `main`'s contents and calls `history.pushState`. Variant selector (stored in `localStorage`):

- (a) default root cross-fade via `startViewTransition`
- (b) (a) + `::view-transition-group(root) { mix-blend-mode: normal; isolation: auto }`
- (c) no View Transitions; 120 ms opacity enter class
- (d) directional slide: `main` named, `translate` on old/new, `overflow: clip` on the container (animates `translate`/`opacity` only)

The tab pill has its own `view-transition-name` (`pill`). The header and sidebar are deliberately unnamed (part of root) so any dimming in (a) shows up. Use back/forward to check direction in (d). Watch for chrome dimming/flashing, blend artefacts, slide clipping.

Open: `node design/experiments/serve.mjs`, then http://127.0.0.1:4390/03-broken-frame/

| Observation | Chrome | Brave | Safari | Firefox |
|---|---|---|---|---|
| (a) chrome stays solid | — | — | — | — |
| (b) chrome stays solid | — | — | — | — |
| (c) enter looks right | — | — | — | — |
| (d) slide + clip + direction | — | — | — | — |
| Pill slides | — | — | — | — |
