# Notes

Preview: `http://127.0.0.1:4391/prototypes/notes/`.

The notes index reproduces the research-list component: title links, kind chips, dates, project chips and excerpts, with Turkish text search, a project select and kind counts. Sidebar groups show pinned notes, recent notes and notes by project. “Not ekle” uses the approved quick-note dialog and inserts the result into this page’s list.

Reproduces the original tool's list with filters and the document sidebar.

Page-specific keyboard behavior: Tab reaches filters, type pills, links and “Not ekle”. Enter and Space activate buttons; native select keys choose a project.

Page-specific limits: The list contains the four non-research workspace fixtures. New notes exist in this page’s memory; navigating to another prototype reloads its fixtures.

## Frame and motion

Uses the new shared document frame, the approved shell/CSP, skip link, theme controls, state switcher and pinned rail. The sidebar collapses below 50rem; the TOC hides below 72rem. With the pinned rail open at 90rem and above, any TOC moves below the title, above the body, so it cannot collide with the rail. See [the frame contract](../note/README.md#shared-frame) for data loading, source actions, breakpoints, scroll spy and keyboard details.

The list changes immediately when filtered. Button presses, dialogs and sidebar collapse reuse the approved shared motion; no decorative row stagger is added. Both OS reduced motion and `data-motion="less"` remove spatial movement and blur while retaining short fades. The approved global shortcuts remain available; editing shortcuts cannot bypass locks or conflicts.

## Verification and limits

`npm test`: 685 passed, 1 skipped. `npm run design:lint`: zero errors and warnings. The temporary Node DOM simulation passed 108 rendering/state/interaction checks across all eight screens. Module and static checks are recorded in the [shared verification notes](../note/README.md#verification-and-limits). Native browser layout, console/CSP, all six palettes, the required viewport widths and real reduced-motion behavior remain coordinator checks because isolated Chrome exited before connecting in this sandbox.

Data comes from the shared sample/workspace fixtures and this page’s `data.json`. Edits stay in this page’s memory; navigating reloads fixtures. State selection restores the fixtures. Source actions show generated Markdown in a dialog; no source editor or filesystem writes are integrated. The shared palette differences in the approved Home README remain unchanged.
