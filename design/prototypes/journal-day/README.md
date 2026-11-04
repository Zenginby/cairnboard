# Journal day

Preview: `http://127.0.0.1:4391/prototypes/journal-day/`.

The day document is titled “3 Kasım 2026, Salı” by default. Each section has a heading (`title · label`), project metadata derived from its links and a bullet list of typed items; the TOC follows those headings. Previous and next links open adjacent day documents. The final “Bugüne iş ekle” form names the fixture date it will write to.

Reproduces the original tool's day document, sidebar and document pagination.

Page-specific keyboard behavior: Tab reaches TOC links, previous and next day links, the textarea and submit button. TOC links focus their entry heading. Native form submission adds the entry and restores textarea focus.

Page-specific limits: The date query selects the displayed day. Days without detailed fixtures show an empty message. The final form always adds to the fixture’s “today”, even when viewing another day; its destination is stated in the UI. Entries stay in this page’s memory.

## Frame and motion

Uses the new shared document frame, the approved shell/CSP, skip link, theme controls, state switcher and pinned rail. The sidebar collapses below 50rem; the TOC hides below 72rem. With the pinned rail open at 90rem and above, any TOC moves below the title, above the body, so it cannot collide with the rail. See [the frame contract](../note/README.md#shared-frame) for data loading, source actions, breakpoints, scroll spy and keyboard details.

Previous/next cards lift by the card-lift token with the original shadow transition and box-press feedback. Day content swaps instantly. Sidebar collapse and controls reuse the shared frame. Both OS reduced motion and `data-motion="less"` remove spatial movement and blur while retaining short fades. The approved global shortcuts remain available; editing shortcuts cannot bypass locks or conflicts.

## Verification and limits

`npm test`: 685 passed, 1 skipped. `npm run design:lint`: zero errors and warnings. The temporary Node DOM simulation passed 108 rendering/state/interaction checks across all eight screens. Module and static checks are recorded in the [shared verification notes](../note/README.md#verification-and-limits). Native browser layout, console/CSP, all six palettes, the required viewport widths and real reduced-motion behavior remain coordinator checks because isolated Chrome exited before connecting in this sandbox.

Data comes from the shared sample/workspace fixtures and this page’s `data.json`. Edits stay in this page’s memory; navigating reloads fixtures. State selection restores the fixtures. Source actions show generated Markdown in a dialog; no source editor or filesystem writes are integrated. The shared palette differences in the approved Home README remain unchanged.

## Veri modeli varsayımı

The core (`core/journal.mjs`) stores one file per day with sections `## <title> · <label>`, each holding bullet items typed `decision`, `discovery`, `pitfall` or `lesson` (or untyped). It stores **no per-entry time and no author**, and **no project field**, so this screen shows neither time nor author. The fixtures use that shape: `{ id, date, title, label?, items: [{ type?, text }] }` (helpers in `_shared/journal.js`).

Assumption for stage C to confirm: a section's project is the first `[[project-id]]` wiki link in its heading or items. The project chip and the project filter derive from it; a section with no such link has no chip and shows only under "Tümü". The "Proje" choice in the add form appends such a link (`[[project-id|Name]]`) to the item text. Counts on the calendar and on the project page count sections ("iş"), not items.
