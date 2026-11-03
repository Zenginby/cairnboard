# 08 – `<dialog>` open/close animation

`@starting-style` + `transition-behavior: allow-discrete` (`display`, `overlay`), opacity + `scale(0.96)`; 240 ms open, 180 ms close. The page logs `transitionrun/start/end/cancel` and fills a table showing whether the close actually animated (an unanimated close shows `none` for transitionstart on opacity/display). With reduced motion the transition is disabled, so no events is expected.

Open: `node design/experiments/serve.mjs`, then http://127.0.0.1:4390/08-dialog-close/

| Observation | Chrome | Brave | Safari | Firefox |
|---|---|---|---|---|
| Open animates | — | — | — | — |
| Close animates (visible) | — | — | — | — |
| transitionstart/end on close | — | — | — | — |
| display / overlay transitioned | — | — | — | — |
| Backdrop fades | — | — | — | — |

Chrome result (2026-11-03, Chromium in the Claude browser pane): opening animates opacity and transform for 240 ms
(start and end events). Closing starts transitions on display, overlay, opacity and transform, so `allow-discrete`
is honoured, but no `transitionend` was logged after the dialog closed. Whether the close is visibly animated still
needs a look on screen (the pane may have been in the background); repeat in Safari and Firefox.
