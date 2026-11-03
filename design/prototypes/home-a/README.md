# Home A

The dashboard now follows the supplied reference's six-track composition and component anatomy rather than the previous approximation. The order is workspace hero, journal calendar, selected projects, ongoing work beside the board summary and pinned notes, recent notes, research, and today's numbered entries with the journal input.

- Preview: `npm run design:serve`, then `http://127.0.0.1:4391/prototypes/home-a/`.
- Structure: hero and ongoing work span four tracks; calendar, projects, summary and pinned notes span two; recent notes, research and today's entries span three. Ongoing work occupies two grid rows. At 64rem the grid becomes two tracks; at 40rem it becomes one. The project chooser expands inside the hero footer. Project selection persists through guarded localStorage reads and writes.
- Shell: the header has an upper row and a separate scrolling navigation row; from 80rem the navigation sits in the center of the upper row. The selected indicator is inside its link. Search collapses before it can collide with a tab; if even icon-sized controls cannot fit, navigation returns to its own row. The supplied sun/moon control and shared palette reveal are used unchanged, with family, mode and reduced-motion choices in the adjacent menu. Local coarse-pointer sizing provides the required larger targets.
- Keyboard: `N` adds a quick note, `C` a card, `/`, `⌘K` or `Ctrl+K` search, `?` opens help. `M` on an ongoing card opens its move dialog. Project checkboxes use native Tab and Space; Escape closes the chooser and appearance menu. Character shortcuts do not consume input typing.
- Motion: first-load boxes use token-limited stagger, rings reveal through rotating masks, new journal rows fade/translate, and linked boxes/rows use the reference's spring behavior within the permitted properties. The dot's pulse uses an opacity/transform overlay. The tab indicator moves with transforms, including optional session-scoped continuity across page loads. Reduced motion removes spatial movement and the pulse. The shared theme reveal is the explicitly supplied exception to the transform/opacity rule; no reveal implementation is duplicated locally.
- States/data: all prototype states remain available. Fixtures are fictional and edits are per-page memory only. Home's archive summaries produce 177 cards, while Board retains its independent smaller fixture; navigation does not synchronize live data. The fixed example day is 3 November 2026, with eight entries, nineteen journal days across two months, and twelve research documents.

## Token gaps and substitutions

The supplied reference was read in full and was not copied into a tracked artifact. The tables below report scalar values and purposes only; they contain no reference source excerpts. Exact equality is not possible with the frozen token set, unavailable font files and the restrictions on animated properties. Repeated values are consolidated; the rows cover reference values affecting these two reconstructed views. Unrelated document, sidebar, clipboard, pagination and project-detail features are outside this prototype's scope.

Values already represented directly by the mapped color, radius, shadow or motion tokens retain those tokens. Layout ratios, CSS reset values, percentages and SVG coordinates are structural geometry; the retained geometry is listed separately. Spacing arithmetic derives structural sizes from existing tokens without adding tokens.

| Reference value | Purpose and location | Current token-based substitution |
|---|---|---|
| 25% focus-color mixture | Text selection throughout both screens | `--color-focus-bg` and `--color-text` |
| 2px outline and 2px offset | Keyboard focus | Existing shared focus styling is retained as supplied; no local focus-width token was introduced |
| 1px hairlines | Panel dividers and inset boundaries | One quarter of `--space-xs`; no dedicated stroke-width token exists |
| 20px blur; 180% saturation | Header material | `--space-lg` blur (24px); saturation omitted because no saturation token exists |
| 56px, 68px | Header upper-row heights, regular and wide | `--space-xl + --space-md` (56px); `--space-xl + --space-lg` (64px) |
| 48px | Navigation row height | Two `--space-lg` units; coarse pointers use 56px to fit 44px targets |
| 240px | Full search width | Six `--space-xl` units |
| 9.6px | Logo/name gap | `--space-sm` (8px) |
| 17px | Logo caption and hero body | `--font-body-size` (16px) |
| 15px | Tab labels, hero date/pills, project descriptions/focus, panel subtitles and feature text | `--font-body-size` (16px) |
| 500 weight | Tab labels, date and hero controls | `--font-label-weight` (550) |
| 2px | Gap between navigation pills | `--space-xs` (4px) |
| 14.4px | Navigation label horizontal padding | `--space-md` (16px) |
| 6px | Logo outer radius | Half of `--radius-sm` |
| 0px 1px 3px with 12% opacity | Selected navigation indicator shadow | `--shadow-box`; no dedicated indicator shadow exists |
| RGB 120,120,135 at 12% and 22% opacity | Light/dark neutral pill fills | `--color-pill-bg` from the selected palette |
| RGB 30,127,69 | Light completed/pulse accent | `--color-done`; the approved palette has a different green |
| RGB 72,80,106 and RGB 232,235,243; dark RGB 185,193,218 and RGB 37,42,56 | An auxiliary project tone's text/fill | Corresponding `--color-tone-7-text` and `--color-tone-7-bg`; current tokens use a different tone |
| RGB 138,58,122 and RGB 248,231,243; dark RGB 240,166,220 and RGB 58,27,51 | Another auxiliary tone's text/fill | `--color-tone-5-text` and `--color-tone-5-bg` |
| RGB 163,52,63 and RGB 252,232,234; dark RGB 255,158,168 and RGB 61,26,30 | Another auxiliary tone's text/fill | `--color-tone-6-text` and `--color-tone-6-bg` |
| RGB 16,16,30 at 35% opacity | Modal backdrop | Existing shared modal material; no separate scrim token was added |
| 3px lift, 1.012 hover scale | Whole linked boxes | `--motion-distance-micro` (4px) lift; scale expansion omitted because no expansion token exists |
| 0.98 press scale; 120ms press duration | Whole linked boxes | `--motion-scale-press` (0.97), `--motion-duration-quick` (150ms) |
| 19px, 1.25 line height, -0.015em tracking | Panel headings | `--font-title-size` (20px), title line height (1.3), title tracking (-0.01em) |
| 28px gap; 28px–44px padding | Hero layout | `--space-lg` gap (24px), responsive padding bounded by `--space-lg` and `--space-xl` (24px–40px) |
| 6px | Hero title top margin | `--space-sm` (8px) |
| 44px–72px title bounds | Hero title | Existing typography arithmetic retains 44px minimum and uses twice display size (64px) maximum |
| 700 weight; line height 1; -0.045em tracking | Hero title | Display weight (650), display line height (1.15), twice display tracking (-0.04em) |
| 10px gaps; 12px leading inset | Hero pills/footer | `--space-sm` gap (8px); pill padding uses `--space-md` (16px) |
| 12px chooser padding; 6.4px label gap/padding; 5.6px and 12.8px action padding | Expanded project chooser | `--space-md` panel padding (16px), `--space-sm` label spacing (8px), `--space-xs` and `--space-md` action padding (4px and 16px) |
| 2.4s pulse period; 7px maximum ring spread | Last-record dot | Four very-slow durations (2s); overlay grows to an 8px spread using transform, with a static 4px base halo |
| 5px gap and radius | Calendar cells | `--space-xs` gap (4px), half-small radius (6px) |
| 14px top margin; 1.5px inset outline | Calendar | `--space-md` margin (16px), half-`--space-xs` outline (2px) |
| 18px gap | Project box vertical rhythm | `--space-md` (16px) |
| 24px title; 700 weight; 1.1 line height; -0.025em tracking | Project name | Title size (20px), display weight (650), display line height (1.15), display tracking (-0.02em) |
| 7-unit stroke | Project progress ring | `--space-sm` stroke (8px at the matching viewBox scale) |
| 28px; 1.1 line height | Project completion statistic | Display size (32px), display line height (1.15) |
| 14px | Project focus divider padding and summary-row vertical padding | `--space-md` (16px) |
| 15.5px; 1.5 line height | Ongoing rows and numbered lists | Body size (16px); rows use code line height (1.6) |
| 6px badge dot/gap; 2px and 10px badge padding | Ongoing project badges | 8px dot, 4px following gap, shared 4px/8px chip padding |
| 1px badge top offset | Ongoing badges | Zero offset; no optical-offset token exists |
| 10px distribution height; 18px top and 14px bottom margin | Board distribution box | `--space-sm` height (8px), `--space-md` margins (16px) |
| 110px legend minimum; 6px row gap; 14px column gap | Board legend | Three `--space-xl` units (120px), `--space-sm` and `--space-md` gaps (8px and 16px) |
| 3px legend-dot radius | Board legend | One quarter of `--radius-sm` |
| 10px row padding; 8px number radius | Numbered research/journal lists | `--space-sm` padding (8px), `--radius-sm` radius (12px) |
| 15.5px date text | Research list dates | `--font-code-size` (14px) |
| 2px row-copy gap | Ongoing rows | Half of `--space-xs` |

Retained structural geometry without dedicated layout/illustration tokens: 74rem content cap (1184px from spacing arithmetic); 80rem header breakpoint; 64rem and 40rem grid breakpoints; six tracks with 4/2/3-track spans; 4vw hero-padding and 7vw title interpolation; 46ch hero text measure; 16rem mobile calendar cap; 96px gradient cap from four large spaces; 64px ring from large plus extra-large space; ring viewBox 64, center 32, radius 26 and path length 100; quarter-turn arc origin and half-turn reveal masks; logo's 90-degree quadrants, 25%/50%/75% stops and 44% mask tiles. The logo's mapped neutral quadrant intentionally remains neutral.

## Intentional limits and validation

Only transform/opacity animate locally: background/shadow interpolation, the original shadow-spread pulse and full-page transition machinery are not reproduced. Linked shadows and fills switch instantly; a transform/opacity pulse and masked ring reveal provide the permitted motion. Indicator width changes immediately while its position slides. Shared theme-button/reveal behavior is owned by the provided files, including their explicitly requested exceptions. No shared, theme, token, script or test source was modified. No font files or dependencies were added.

The current token approximations are explicitly **not a verified pixel-identical result**. The missing typography, material, indicator-shadow and optical-spacing tokens would need approval in a separate shared-design change to close the gaps. Fictional content length also changes natural box heights. Direct served-page visual comparison and physical-device touch/drag review remain coordinator checks.

Validation completed: `npm test` passed 682 tests with one skipped; `npm run design:lint` passed without warnings. Syntax/bundle, CSP/source-pattern, shell-parity and changed-folder checks passed. Isolated fixture-backed browser checks passed 653 assertions across both pages at 375, 640, 800, 1024, 1280, 1440 and 1600px, including all six palettes, tab/search separation, state switches, project selection, journal input, shortcuts, priority ordering, filter-stable moves and a synthetic pointer drop. The temporary browser harness bundles local assets and mocks fixture reads; it does not prove production HTTP/CSP loading, screenshot equality or physical touch smoothness.
