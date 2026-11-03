# 01 – CSSOM writes under CSP

Tests which JS style mutations work under `style-src 'self'` (no `'unsafe-inline'`): `style.setProperty` on a custom property, `style.transform`, `style.cssText`, `setAttribute('style')`, `insertRule`, constructable stylesheets, and `Element.animate`. Applied is measured with `getComputedStyle`; violations come from `securitypolicyviolation`.

Open: `node design/experiments/serve.mjs`, then http://127.0.0.1:4390/01-cssom-csp/ and press "Run all".
Expected violations are the point of this test; they are not bugs.

| Method | Chrome (Chromium 2026-11-03, Claude browser pane) | Brave | Safari | Firefox |
|---|---|---|---|---|
| setProperty('--x') | ok | — | — | — |
| style.transform | ok | — | — | — |
| style.cssText | ok | — | — | — |
| setAttribute('style') | **blocked** (style-src-attr) | — | — | — |
| insertRule | ok | — | — | — |
| adoptedStyleSheets | ok | — | — | — |
| el.animate | ok | — | — | — |

Chrome result (2026-11-03): only `setAttribute('style', …)` is blocked. Writing through the CSSOM (`style.*`,
`setProperty`, `cssText`, `insertRule`, constructable stylesheets) and the Web Animations API is not inline style
for CSP purposes. Policy proposal for Cairnboard: pass dynamic values only with `style.setProperty('--x', …)` and
single-property writes; the other allowed APIs stay unused by convention, not because CSP forbids them.
