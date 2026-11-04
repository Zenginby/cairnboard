# Research index

Preview: `http://127.0.0.1:4391/prototypes/research/`.

The research index follows the original’s text field, project select, counted type pills, result count and rows containing a title link, type badge, date, project badge and excerpt. All three filters intersect. The sidebar groups the research fixtures by project.

Reproduces the original tool's research list and document sidebar.

Page-specific keyboard behavior: Tab reaches filters, pills and result links. Native select keys choose the project; Enter and Space activate the type pills. Result counts use a polite status region.

Page-specific limits: The twelve research fixtures receive deterministic fictional types: İnceleme, Deney and Kaynak. This is a read-only index, so its switcher offers full, empty, loading, error and long-text states.

## Frame and motion

Uses the new shared document frame, the approved shell/CSP, skip link, theme controls, state switcher and pinned rail. The sidebar collapses below 50rem; the TOC hides below 72rem. With the pinned rail open at 90rem and above, any TOC moves below the title, above the body, so it cannot collide with the rail. See [the frame contract](../note/README.md#shared-frame) for data loading, source actions, breakpoints, scroll spy and keyboard details.

Filter results update immediately. Type-pill press feedback and sidebar collapse use the approved shared motion, with no animated list reflow. Both OS reduced motion and `data-motion="less"` remove spatial movement and blur while retaining short fades. The approved global shortcuts remain available; editing shortcuts cannot bypass locks or conflicts.

## Verification and limits

`npm test`: 685 passed, 1 skipped. `npm run design:lint`: zero errors and warnings. The temporary Node DOM simulation passed 108 rendering/state/interaction checks across all eight screens. Module and static checks are recorded in the [shared verification notes](../note/README.md#verification-and-limits). Native browser layout, console/CSP, all six palettes, the required viewport widths and real reduced-motion behavior remain coordinator checks because isolated Chrome exited before connecting in this sandbox.

Data comes from the shared sample/workspace fixtures and this page’s `data.json`. Edits stay in this page’s memory; navigating reloads fixtures. State selection restores the fixtures. Source actions show generated Markdown in a dialog; no source editor or filesystem writes are integrated. The shared palette differences in the approved Home README remain unchanged.
