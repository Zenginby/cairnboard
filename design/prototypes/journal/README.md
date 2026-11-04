# Journal month

Preview: `http://127.0.0.1:4391/prototypes/journal/`.

The calendar reproduces month arrows, project pills, seven weekday columns, day cells with entry counts and the expandable day preview. The fictional workspace’s current day is outlined. “Bugüne iş ekle” (job title, item type, item text, project) writes a new section to the fixture’s current date, opens that month and shows it. Sidebar groups list months and the days that have entries. Each day preview lists its sections with typed items (Karar, Keşif, Tuzak, Ders).

Reproduces the original tool's month calendar and document sidebar.

Page-specific keyboard behavior: Tab reaches month arrows, project pills, days with entries and the day-preview link. Enter or Space activates them. The calendar uses a native table with weekday headers rather than an incomplete ARIA grid.

Page-specific limits: The deterministic “today” is 3 November 2026, matching the shared fixture. Only that day has detailed entries; earlier indexed days can open an empty day document. New entries and project filters are local to this page. Calendar geometry and entry counts require served-browser verification.

## Frame and motion

Uses the new shared document frame, the approved shell/CSP, skip link, theme controls, state switcher and pinned rail. The sidebar collapses below 50rem; the TOC hides below 72rem. With the pinned rail open at 90rem and above, any TOC moves below the title, above the body, so it cannot collide with the rail. See [the frame contract](../note/README.md#shared-frame) for data loading, source actions, breakpoints, scroll spy and keyboard details.

Selecting a recorded day expands the preview with grid rows, opacity and the allowed small blur. Close timing is shorter. Calendar buttons use transform-only hover and press feedback; keyboard-opened previews are immediate. Both OS reduced motion and `data-motion="less"` remove spatial movement and blur while retaining short fades. The approved global shortcuts remain available; editing shortcuts cannot bypass locks or conflicts.

## Verification and limits

`npm test`: 685 passed, 1 skipped. `npm run design:lint`: zero errors and warnings. The temporary Node DOM simulation passed 108 rendering/state/interaction checks across all eight screens. Module and static checks are recorded in the [shared verification notes](../note/README.md#verification-and-limits). Native browser layout, console/CSP, all six palettes, the required viewport widths and real reduced-motion behavior remain coordinator checks because isolated Chrome exited before connecting in this sandbox.

Data comes from the shared sample/workspace fixtures and this page’s `data.json`. Edits stay in this page’s memory; navigating reloads fixtures. State selection restores the fixtures. Source actions show generated Markdown in a dialog; no source editor or filesystem writes are integrated. The shared palette differences in the approved Home README remain unchanged.

## Veri modeli varsayımı

The core (`core/journal.mjs`) stores one file per day with sections `## <title> · <label>`, each holding bullet items typed `decision`, `discovery`, `pitfall` or `lesson` (or untyped). It stores **no per-entry time and no author**, and **no project field**, so this screen shows neither time nor author. The fixtures use that shape: `{ id, date, title, label?, items: [{ type?, text }] }` (helpers in `_shared/journal.js`).

Assumption for stage C to confirm: a section's project is the first `[[project-id]]` wiki link in its heading or items. The project chip and the project filter derive from it; a section with no such link has no chip and shows only under "Tümü". The "Proje" choice in the add form appends such a link (`[[project-id|Name]]`) to the item text. Counts on the calendar and on the project page count sections ("iş"), not items.
