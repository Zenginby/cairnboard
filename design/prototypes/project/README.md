# Project cover

Preview: `http://127.0.0.1:4391/prototypes/project/`.

The project switcher precedes the sidebar sections. The cover reproduces the tinted hero, grouped open jobs (Acil, Önemli, Diğer), completed count and section grid for Notlar, Kartlar, Günlük and Araştırmalar. Edit updates the name and description. Archive toggles the project state; delete has a confirm dialog and undo.

Reproduces the original tool's project cover and project switcher in the sidebar.

Page-specific keyboard behavior: Tab reaches the project switcher, title pills, project actions, card links and section boxes. Enter or Space activates dialog actions; Escape closes dialogs.

Page-specific limits: Section counts use the available workspace records, not the separate dashboard archive totals. Low-priority open cards are counted separately and remain accessible on the board. The cover’s overview boxes do not generate document TOC entries. Archive and trash are local reversible simulations.

## Frame and motion

Uses the new shared document frame, the approved shell/CSP, skip link, theme controls, state switcher and pinned rail. The sidebar collapses below 50rem; the TOC hides below 72rem. With the pinned rail open at 90rem and above, any TOC moves below the title, above the body, so it cannot collide with the rail. See [the frame contract](../note/README.md#shared-frame) for data loading, source actions, breakpoints, scroll spy and keyboard details.

Section boxes lift by the card-lift token on hover and use the box-press token on press. Colors switch immediately. The hero stays still; sidebar groups and dialogs use the approved shared motion. Both OS reduced motion and `data-motion="less"` remove spatial movement and blur while retaining short fades. The approved global shortcuts remain available; editing shortcuts cannot bypass locks or conflicts.

## Verification and limits

`npm test`: 685 passed, 1 skipped. `npm run design:lint`: zero errors and warnings. The temporary Node DOM simulation passed 108 rendering/state/interaction checks across all eight screens. Module and static checks are recorded in the [shared verification notes](../note/README.md#verification-and-limits). Native browser layout, console/CSP, all six palettes, the required viewport widths and real reduced-motion behavior remain coordinator checks because isolated Chrome exited before connecting in this sandbox.

Data comes from the shared sample/workspace fixtures and this page’s `data.json`. Edits stay in this page’s memory; navigating reloads fixtures. State selection restores the fixtures. Source actions show generated Markdown in a dialog; no source editor or filesystem writes are integrated. The shared palette differences in the approved Home README remain unchanged.
