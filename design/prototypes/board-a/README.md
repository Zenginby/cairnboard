# Board A

The board now follows the supplied reference's compact inset columns, full-width collapse headers, colored priority subheads, label-led card text and bottom project chips. Columns have a 15rem minimum and share remaining width, scroll horizontally when necessary, and stack below 50rem; the previous fixed-height scrollers and mobile tab picker are removed.

- Preview: `npm run design:serve`, then `http://127.0.0.1:4391/prototypes/board-a/`. A `project` query parameter selects the initial project filter.
- Shell: identical local shell files and header structure to Home A. Search shrinks before it can cover a tab; navigation takes a separate row if icon-sized controls still cannot fit. The exact supplied sun/moon markup toggles mode. The adjacent menu contains all three theme families, system/light/dark appearance and **Hareket: az**. Shared code owns the circular palette reveal.
- Interactions: project/priority filter pills combine. Each column has a collapse button and a quiet **Kart ekle** control with an inline form. Cards retain agent/person initials, acceptance progress and comment metadata. **Taşı…** is quiet in the top-right, shown on hover or focus and always on touch or a claimed card. The dotted handle preserves native touch scrolling elsewhere.
- Ordering: priority groups determine visual order. Dragging and the move menu reorder within the card's existing priority group and move across configured columns without silently changing priority. Menus explicitly name that group. Counts, announcements and position fractions count cards, not priority headings. Moving into a collapsed column opens it. Filters preserve the backing order.
- Keyboard: `N` quick note, `C` the active column's inline form, `/`, `⌘K` or `Ctrl+K` search, `?` help. `M` on a focused card opens **Taşı…**; arrow keys, Home and End navigate enabled actions. Escape cancels/closes; Tab closes the move menu. Enter on a card opens its details. Every move returns card focus and updates one persistent polite status region.
- Motion: visible-card FLIP and an opacity highlight confirm moves; the source remains at 40% opacity and a 2px insertion line marks the destination. Chevron transforms remain; prohibited height/filter transitions are omitted. Reduced motion removes settling, keeps short fades and disables the shared reveal. The pointer ghost follows direct manipulation without a transition. Content visibility, delegated pointer handling and observed visible-card targeting retain the 300-card fixture.
- States/data: full, empty, loading, error, claimed, conflict, long-text and 300-card states remain. A claimed card names the agent and disables moving with an explanation. Fixtures are fictional, per-page memory only. No Markdown is written; Home archive totals and this smaller board fixture remain independent.

## Token gaps and substitutions

The complete shared-shell and palette gap inventory is in [Home A's README](../home-a/README.md#token-gaps-and-substitutions). The rows below cover board/page-title values not already represented by mapped tokens. They report numeric values and purposes, not source excerpts.

| Reference value | Purpose and location | Current token-based substitution |
|---|---|---|
| 78% opaque surface mixture | Header material on the board's document frame | The shared `--color-material` palette value; no separate document-header opacity token exists |
| 72rem content cap; 15rem column minimum | Page frame and horizontal board | 1152px inner cap and 240px minimum through spacing arithmetic |
| 12px | Column gap | `--space-md` (16px) |
| 28px–40px | Page-title top padding | Responsive `--space-lg` to `--space-xl` (24px–40px) |
| 32px–46.4px, 4.4vw interpolation | Page heading | Display size minimum (32px), display size plus medium space maximum (48px); responsive interpolation retained |
| 700 weight; 1.06 line height; -0.03em tracking | Page heading | Display weight (650), display line height (1.15), display tracking (-0.02em) |
| 13.6px | Column header vertical padding | `--space-md` (16px) |
| 12px inherited small-text size | Column counts and priority headings | `--font-label-size` (13px); the reference does not include its framework's definition |
| 14px icon; 1.5-unit stroke | Collapse chevron | `--space-md` (16px), half-`--space-xs` stroke (2px at the matching viewBox scale) |
| 5.6px vertical and 13.6px horizontal margins | Priority subheads | `--space-xs` vertical (4px), `--space-sm` inner horizontal (8px), plus list padding |
| 12px and 13.6px | Card vertical/horizontal padding | `--space-md` (16px) |
| 14px inherited small-text size | Card body | `--font-code-size` (14px), with the body family; the reference's framework definition is not included |
| 1.45 line height | Card body | `--font-code-line-height` (1.6) |
| 2px lift | Card hover | `--motion-distance-micro` (4px) |
| 6.4px | Card footer top margin | `--space-sm` (8px) |
| 12px inherited extra-small text | Footer/project chip text | `--font-label-size` (13px) |
| 8.8px | Project-chip horizontal padding | `--space-sm` (8px) |
| 9999px pill radius | Project chip | `--radius-full` (999px), with the same fully rounded result at these sizes |
| Default `ease` shadow interpolation | Card elevation | Instant shadow change; only transform/opacity animate |
| Grid row 0fr–1fr and blur 2px–0 | Collapse expansion | Immediate layout change, without animated height/filter; the chevron retains its token transform transition |

Retained structural geometry: column flow breakpoint 50rem, compact title breakpoint 40rem, chevron viewBox 16 and its path coordinates. Eight-pixel list gaps/padding, sixteen-pixel board margins and twenty-/twelve-pixel column/card radii already map to existing tokens. The added filters, inline forms, move control, metadata and prototype switcher use the nearest existing pill/inset/card primitives; the reference has no corresponding interaction markup to match exactly.

## Intentional limits and validation

Exact equality is blocked by the documented frozen-token substitutions, system font availability and the prohibition on animated layout/filter/shadow properties. The board uses one card list per column with presentation-only priority heading items so a move can preserve the focused DOM node; it reproduces the visible grouping without copying the reference's multiple-list implementation. Prototype-added controls and touch targets necessarily occupy some extra space. No dependency, font file, shared file, theme, token generator, script or test was changed.

Direct served-page visual comparison and real-device drag performance remain coordinator checks. The reference itself was read only and was not copied into an output artifact. Changes remain uncommitted.

Validation completed: `npm test` passed 682 tests with one skipped; `npm run design:lint` passed without warnings. The combined isolated browser harness passed 653 assertions at seven widths from 375px through 1600px, including 1280px, all six palettes, collapse controls, move/focus/announcement behavior, priority reordering that survives filtering, the 300-card count and a synthetic pointer drop. Syntax/bundle, CSP/source-pattern, shell-parity and changed-folder checks passed. This does not certify screenshot equality, production HTTP/CSP loading or hardware drag performance.
