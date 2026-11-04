# Note

Preview: `http://127.0.0.1:4391/prototypes/note/`.

A rendered Markdown note has metadata, a wiki link and a “Bağlantılar” backlinks grid. “Düzenle” opens a Markdown textarea and live preview side by side, stacked on narrow screens. Save and cancel return focus to the edit action. Pinning gives a toast. Delete confirms a move to trash and offers a persistent undo action.

Reproduces the original tool's document sidebar, page title, source block and reference cards.

Page-specific keyboard behavior: Tab reaches actions and editor controls. Enter and Space activate buttons. The editor keeps normal textarea keys. TOC links focus their heading; Escape closes dialogs.

Page-specific limits: The safe Markdown subset supports headings, paragraphs, bold, inline code, fenced code, flat ordered and unordered lists, tables, ordinary links and wiki links. Raw HTML stays text. Nested Markdown, syntax highlighting and a general Markdown parser are outside this prototype. Pinning does not synchronize the shared pinned rail. Backlinks are fictional fixed examples.

## Shared frame

All pages import the new `_shared/doc-frame.css` and `_shared/doc-frame.js`; existing shared files, approved screens, tokens and themes are unchanged. The frame reuses the approved `loadData`, `setupUI`, `renderState`, shell, theme and pinned-rail modules. Data merges the shared sample, this page’s small `data.json` and `workspace.json` by record ID. The header markup, CSP, skip link, persistent polite announcement region and prototype controls follow the approved screens. All UI data is fictional and rendered with DOM nodes.

The document surface is plain, with a grey sidebar, current-page pill, small-cap group headings, 46rem prose cap and the 46.4px page-title token (responsive clamp). The sidebar becomes a “Sayfa menüsü” button below 50rem; Escape collapses it and returns focus. The TOC is hidden below 72rem. At 90rem and above, while the shared pinned rail is open, the TOC moves to the top of the content column below the title. Closing the rail restores the right TOC. This intentionally adapts the original two-sidebars layout to the approved extra pinned rail without overlapping it. The source’s enclosing framework widths/breakpoints are represented conservatively with token arithmetic and these explicit breakpoints.

“Markdown'ı kopyala” copies the generated Markdown; if clipboard access fails, a read-only textarea provides a manual copy fallback. “Ham” and “Kaynakta aç” show the local fixture’s Markdown in a dialog: these prototypes have no source-editor integration. The TOC updates its current heading on scroll. Pages swap immediately and no long-content view-transition name is assigned.

## Motion and keyboard

Sidebar groups use the approved grid-row collapse and small-blur fade, with a shorter close. Dialogs, buttons, menus and the header use approved shared motion. Reference links lift by the card-lift token; project section boxes and day-pagination links keep their original lift/press feedback. Calendar previews use the same collapse exception. Colors switch immediately; only transform/opacity, the approved collapse/blur exception and approved shared material/theme behavior animate. Keyboard-opened controls appear immediately. Both OS reduced motion and `data-motion="less"` remove movement and collapse blur, retaining short opacity feedback.

The approved global keys remain: `N` quick note, `C` card, `/`, `⌘K` or `Ctrl+K` search, and `?` help. Inputs retain normal typing. Document locks and conflicts cannot be bypassed by the quick-create character shortcuts. Dialogs use native focus containment and Escape. Buttons and fields retain visible focus rings.

## Verification and limits

Run `npm run design:serve`, then open the preview path above. The switcher exposes full, empty, loading, error and long-text states; editable screens also expose a claim by claude and 409 conflict. The conflict view blocks writes, shows a local/external comparison and applies the simulated external version with “Yeniden yükle”. State selection restores the fixtures. Edits are intentionally per-page memory; no Markdown files, APIs or cross-page data are written.

`npm test`: 685 passed, 1 skipped. `npm run design:lint`: zero errors and warnings. A temporary Node DOM simulation exercised all eight renderers, state visibility and core edits, filtering, progress, moves, comments, trash/undo and journal forms, plus retry recovery, stable anchors, keyboard menus and safe Markdown rendering. Eight module graphs and nine stylesheets bundled successfully; 637 file, shell, CSP, asset, fixture and token checks passed, and both forbidden-pattern scans were clean. The DOM simulation does not establish browser layout, native accessibility behavior or CSP enforcement. Isolated Chrome exited before connecting in this sandbox; served-browser console/CSP, scroll-spy geometry, screenshots, 375/1280/1440/2000px layout, all six palettes and real reduced-motion behavior remain coordinator checks. Shared palette differences documented by the approved Home README are inherited unchanged.
