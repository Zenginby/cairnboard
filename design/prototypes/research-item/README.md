# Research document

Preview: `http://127.0.0.1:4391/prototypes/research-item/`.

A research document can be viewed, edited and deleted. A research document includes project metadata, a source/method block, summary, findings, a small experiment, next steps and a reference-link grid. The right TOC follows document headings. The source is a fictional local observation record.

Reproduces the original tool's source block, reference cards and document-page typography.

Edit and delete (like the note screen): “Araştırmayı düzenle” opens the Markdown textarea with a live preview and “Araştırmayı kaydet” / “İptal”. “Araştırmayı sil” asks for confirmation, moves the document to the trash and offers “Geri al” in the toast. In the kilitli state the buttons are disabled with “claude üzerinde çalışıyor. Kilit kalkana kadar düzenlenemez.”. In the 409 çakışma state saving is refused with the conflict banner and toast; “Yeniden yükle” applies the outside version. Edits stay in this page’s memory.

An unknown `?id=` shows the shared 404 card instead of the first document.

Page-specific keyboard behavior: Tab reaches title actions, the edit and delete buttons, TOC links, the wiki link and reference cards. TOC links focus headings. Escape closes the raw-source or search dialog.

Page-specific limits: The twelve fixture IDs use their own title and introduction with a shared fictional findings template. No external research was conducted or cited. The state switcher includes kilitli and 409 çakışma.

## Frame and motion

Uses the new shared document frame, the approved shell/CSP, skip link, theme controls, state switcher and pinned rail. The sidebar collapses below 50rem; the TOC hides below 72rem. With the pinned rail open at 90rem and above, any TOC moves below the title, above the body, so it cannot collide with the rail. See [the frame contract](../note/README.md#shared-frame) for data loading, source actions, breakpoints, scroll spy and keyboard details.

Reference cards use the original card-lift feedback with transform only. Sidebar collapse and raw-source dialogs reuse the shared motion; document content stays still. Both OS reduced motion and `data-motion="less"` remove spatial movement and blur while retaining short fades. The approved global shortcuts remain available; editing shortcuts cannot bypass locks or conflicts.

## Verification and limits

`npm test`: 685 passed, 1 skipped. `npm run design:lint`: zero errors and warnings. The temporary Node DOM simulation passed 108 rendering/state/interaction checks across all eight screens. Module and static checks are recorded in the [shared verification notes](../note/README.md#verification-and-limits). Native browser layout, console/CSP, all six palettes, the required viewport widths and real reduced-motion behavior remain coordinator checks because isolated Chrome exited before connecting in this sandbox.

Data comes from the shared sample/workspace fixtures and this page’s `data.json`. Edits stay in this page’s memory; navigating reloads fixtures. State selection restores the fixtures. Source actions show generated Markdown in a dialog; no filesystem writes are integrated. The shared palette differences in the approved Home README remain unchanged.
