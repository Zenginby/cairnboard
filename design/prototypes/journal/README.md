# Journal month

Preview: `http://127.0.0.1:4391/prototypes/journal/`.

The calendar reproduces month arrows, project pills, seven weekday columns, day cells with entry counts and the expandable day preview. The fictional workspace’s current day is outlined. “Bugüne ekle” writes to the fixture’s current date, opens that month and shows the new entry. Sidebar groups list months and indexed days.

Reproduces the original tool's month calendar and document sidebar.

Page-specific keyboard behavior: Tab reaches month arrows, project pills, days with entries and the day-preview link. Enter or Space activates them. The calendar uses a native table with weekday headers rather than an incomplete ARIA grid.

Page-specific limits: The deterministic “today” is 3 November 2026, matching the shared fixture. Only that day has detailed entries; earlier indexed days can open an empty day document. New entries and project filters are local to this page. Calendar geometry and entry counts require served-browser verification.

## Frame and motion

Uses the new shared document frame, the approved shell/CSP, skip link, theme controls, state switcher and pinned rail. The sidebar collapses below 50rem; the TOC hides below 72rem. With the pinned rail open at 90rem and above, any TOC moves below the title, above the body, so it cannot collide with the rail. See [the frame contract](../note/README.md#shared-frame) for data loading, source actions, breakpoints, scroll spy and keyboard details.

Selecting a recorded day expands the preview with grid rows, opacity and the allowed small blur. Close timing is shorter. Calendar buttons use transform-only hover and press feedback; keyboard-opened previews are immediate. Both OS reduced motion and `data-motion="less"` remove spatial movement and blur while retaining short fades. The approved global shortcuts remain available; editing shortcuts cannot bypass locks or conflicts.

## Verification and limits

`npm test`: 685 passed, 1 skipped. `npm run design:lint`: zero errors and warnings. The temporary Node DOM simulation passed 108 rendering/state/interaction checks across all eight screens. Module and static checks are recorded in the [shared verification notes](../note/README.md#verification-and-limits). Native browser layout, console/CSP, all six palettes, the required viewport widths and real reduced-motion behavior remain coordinator checks because isolated Chrome exited before connecting in this sandbox.

Data comes from the shared sample/workspace fixtures and this page’s `data.json`. Edits stay in this page’s memory; navigating reloads fixtures. State selection restores the fixtures. Source actions show generated Markdown in a dialog; no source editor or filesystem writes are integrated. The shared palette differences in the approved Home README remain unchanged.
