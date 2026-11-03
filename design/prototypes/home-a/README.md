# Home A

A journal-first bento dashboard gives today's work the largest surface, then groups open cards beside pinned notes and recent quick notes. The projects strip links to the matching filtered Board A; the grid becomes one column on phones.

- Preview: `npm run design:serve`, then `http://127.0.0.1:4391/prototypes/home-a/`.
- Motion: approved shared press, hover, dialog and notification transitions only; no entrance stagger. Keyboard-opened dialogs are instant; system reduced motion and **Hareket: az** retain short fades without movement.
- Keyboard: `N` quick note, `C` new card, `/` search, `?` shortcuts, `M` on a focused card to move it, `Escape` close. Inputs keep normal typing behavior.
- Prototype controls: full, empty, loading, failed, agent-claimed, 409 conflict and long text. Switching fixtures resets in-memory edits; adding the first card leaves the empty fixture with just that new card. Long text alternates Turkish and English content and uses a 40-character project name.
- Limits: fictional, per-page memory only; no Markdown writes, server, cross-page persistence or real conflict detection. Seed journal entries are presented as today's illustrative entries. Project chips retain the approved truncation and full-name tooltip.
- Proposed shared change: a configurable move helper with insertion position, full Turkish announcements and card focus would remove the local Home move handling. No new design token was needed; layout dimensions derive from existing spacing tokens.
- Verification: repository tests and design lint pass; source/CSP pattern and module syntax checks pass. Browser rendering and real-device touch checks remain for the coordinator; the sandboxed headless browser did not establish a debugging session.
