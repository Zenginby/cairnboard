# 05 – Pointer drag and drop, 300 cards

Three-column board (Todo / Doing / Done) with 300 cards total; a second layout puts 290 of them in Doing. Pointer-event drag (`setPointerCapture`, 4 px threshold for touch/pen, edge auto-scroll), source card at `opacity: .4`, 2 px drop line, FLIP settle (240 ms, `cubic-bezier(0.15, 1, 0.3, 1)`, visible cards only) followed by a 700 ms glow (an opacity animation on a pseudo-element). Second mode: `startViewTransition` with `view-transition-name: match-element` on every card (the page says so when unsupported). Each card has a “Taşı…” menu; `M` opens it for the focused card. One `role="status"` region announces moves; focus returns to the card. The page logs the last 20 settle times and `longtask` entries over 50 ms.

Note: the ghost and drop line are positioned through the CSSOM (`el.style.translate`, `el.style.width`), which this page relies on being allowed under the CSP; see experiment 01. Any violation shows in the log.

Open: `npm run design:serve`, then http://127.0.0.1:4391/experiments/05-dnd/

| Observation | Chrome | Brave | Safari | Firefox |
|---|---|---|---|---|
| Drag works (mouse) | — | — | — | — |
| Drag works (touch) | — | — | — | — |
| Settle time FLIP, balanced (avg/max ms) | — | — | — | — |
| Settle time FLIP, 290 in Doing | — | — | — | — |
| Settle time VT match-element, balanced | — | — | — | — |
| Settle time VT match-element, 290 in Doing | — | — | — | — |
| Long tasks > 50 ms | — | — | — | — |
| CSP violations | — | — | — | — |
| Keyboard move + focus return + announcement | — | — | — | — |
