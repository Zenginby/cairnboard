# Card

Preview: `http://127.0.0.1:4391/prototypes/card/`.

A card document shows status, priority, project and person or agent badges, a dated acceptance checklist with native progress, Markdown body and comments. “Taşı…” offers every other board column. Editing changes the title, priority and Markdown body. Comments append locally. Delete confirms a move to trash with undo.

Reproduces the original tool's badges, progress timeline and document frame.

An unknown `?id=` shows the shared 404 card instead of the first card. Priority follows the core: `urgent`, `important`, `low`, or no priority (shown as “Diğer”).

Page-specific keyboard behavior: The move menu supports arrow keys, Home and End, Enter, Escape and Tab. Native Space toggles acceptance checkboxes. Tab reaches the comment textarea and submit button. Focus returns to the moved card action or the comment input after a write.

Page-specific limits: Checklist checkboxes and progress are interactive product adaptations of the original progress timeline. The default comments are a fictional thread. Moves, comments and edits are local to this page; they do not mutate the board prototype.

## Frame and motion

Uses the new shared document frame, the approved shell/CSP, skip link, theme controls, state switcher and pinned rail. The sidebar collapses below 50rem; the TOC hides below 72rem. With the pinned rail open at 90rem and above, any TOC moves below the title, above the body, so it cannot collide with the rail. See [the frame contract](../note/README.md#shared-frame) for data loading, source actions, breakpoints, scroll spy and keyboard details.

The move menu uses the shared opacity/transform enter and shorter close. Checklist and status updates are immediate. The sidebar uses the approved collapse exception; dialogs and buttons use shared feedback. Both OS reduced motion and `data-motion="less"` remove spatial movement and blur while retaining short fades. The approved global shortcuts remain available; editing shortcuts cannot bypass locks or conflicts.

## Verification and limits

`npm test`: 685 passed, 1 skipped. `npm run design:lint`: zero errors and warnings. The temporary Node DOM simulation passed 108 rendering/state/interaction checks across all eight screens. Module and static checks are recorded in the [shared verification notes](../note/README.md#verification-and-limits). Native browser layout, console/CSP, all six palettes, the required viewport widths and real reduced-motion behavior remain coordinator checks because isolated Chrome exited before connecting in this sandbox.

Data comes from the shared sample/workspace fixtures and this page’s `data.json`. Edits stay in this page’s memory; navigating reloads fixtures. State selection restores the fixtures. Source actions show generated Markdown in a dialog; no source editor or filesystem writes are integrated. The shared palette differences in the approved Home README remain unchanged.
