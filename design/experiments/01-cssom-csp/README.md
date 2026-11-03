# 01 – CSSOM writes under CSP

Tests which JS style mutations work under `style-src 'self'` (no `'unsafe-inline'`): `style.setProperty` on a custom property, `style.transform`, `style.cssText`, `setAttribute('style')`, `insertRule`, constructable stylesheets, and `Element.animate`. Applied is measured with `getComputedStyle`; violations come from `securitypolicyviolation`.

Open: `node design/experiments/serve.mjs`, then http://127.0.0.1:4390/01-cssom-csp/ and press "Run all".
Expected violations are the point of this test; they are not bugs.

| Method | Chrome | Brave | Safari | Firefox |
|---|---|---|---|---|
| setProperty('--x') | — | — | — | — |
| style.transform | — | — | — | — |
| style.cssText | — | — | — | — |
| setAttribute('style') | — | — | — | — |
| insertRule | — | — | — | — |
| adoptedStyleSheets | — | — | — | — |
| el.animate | — | — | — | — |
