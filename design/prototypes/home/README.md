# Home A

The six-track dashboard follows the supplied reference's box structure, order and proportions, with Cairnboard's workspace, journal, project and note content. The grid is centered at `--space-content-max` (1080px), becomes two tracks at 64rem and one at 40rem.

Owner change (2026-11-03): on screens 90rem (1440px) and wider, pinned notes live in a rail on the right of every page (`_shared/pinned-rail.js`, styles in `_shared/components.css`, data in `_shared/pinned.json`), under the top bar. It can be hidden; a pin tab at the right edge brings it back and the choice is remembered. While the rail is open the home page hides its own "Sabitlenenler" box; below 90rem there is no rail and the box shows as in the reference.

- Preview: `npm run design:serve`, then `http://127.0.0.1:4391/prototypes/home/`.
- Precision: the former type, spacing, radius, material, shadow and timing approximations are replaced by the dedicated tokens and exact token arithmetic. Hero type reaches 72px/700, project titles 24px/700, statistics 28px/700 and panel titles 19px/650. Fractional values, calendar geometry and the seven-unit ring stroke retain the reference's values. Inter comes from the existing shared base import; no font files, declarations or links were added here.
- Shell: identical local shell files to Board A, with 56px/68px upper rows, a 48px navigation row, 240px full search, exact indicator shadow and a 20px/180% material filter. Search contracts before it could cover tabs. The provided family/mode controls, sun/moon button and circular theme reveal remain unchanged.
- Motion: linked boxes lift 3px and scale to 1.012; press feedback uses 0.98 over 120ms. Shadows transition with the approved default easing. The 2.4-second dot pulse uses a transform-only overlay equivalent to the original 4px–7px halo, with an opaque foreground dot. First-load stagger, ring masks and journal-row entry are retained. The tab indicator interpolates its bounds with transforms. Reduced motion removes spatial movement and the pulse, retaining short fades, including under forced hover/press states.
- Interaction: project selection persists in guarded localStorage. Journal input, previews, all prototype states and keyboard shortcuts remain: `N` quick note, `C` card, `/`, `⌘K` or `Ctrl+K` search, `?` help, `M` on an ongoing card to move it. Native Tab/Space operate checkboxes; Escape closes overlays. Character shortcuts leave text input alone.
- Product adaptations: quick-add/search dialogs, card move actions, state controls and 32px/44px hit targets remain as required. Fixtures are fictional, edits stay in per-page memory, and Home archive totals remain independent of Board's smaller fixture. Natural heights depend on the fictional text; the reference itself remains read-only and untracked.

## Remaining differences

No local size, type, spacing, material or timing substitutions remain. The protected shared palettes still contain two literal color differences; they are used as supplied rather than overridden in the prototype.

| Difference | Why it remains |
|---|---|
| Neutral pills use `--color-pill-bg`; the current Bento values are opaque rather than the reference's RGB 120/120/135 at 12% or 22% opacity | Palette files are protected and remain authoritative across all six palettes |
| The Bento-light completed accent uses `--color-done` (RGB 26/115/64), rather than RGB 30/127/69 | The protected approved palette retains this value |
| Hover text/fill colors switch immediately | Color/background interpolation remains outside the allowed animation exceptions; shadow, collapse and material behavior now match |

Cairnboard's extra controls use the supplied shared components and larger touch targets. These product adaptations are retained intentionally; the obsolete substitution inventory has been removed. Direct served-page screenshot comparison and physical-device touch/drag smoothness remain coordinator checks.

## Verification

`npm test`: 684 passed, one skipped. `npm run design:lint`: no errors or warnings. Isolated browser previews passed 1178 checks across both screens at 375/640/800/1024/1280/1440/1600px plus simulated OS-reduced-motion cases. Checks loaded both supplied Inter subsets and covered computed reference values, pulse geometry, indicator morphing, non-overlapping navigation, all six palettes/states, selection, journal input, keyboard controls, collapse, filter-stable priority ordering, focus return and a synthetic pointer drop. The temporary harness embeds existing local assets and mocks fixture reads; production HTTP/CSP loading, screenshot equality and hardware performance are not certified by it. Source/CSP patterns, token references, module syntax/bundling, shell parity and owned-folder-only changes were also checked. Changes remain uncommitted.
