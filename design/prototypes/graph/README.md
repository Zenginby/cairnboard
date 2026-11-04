# Graph (Bağlantı grafiği)

Notes as nodes and their links as edges, drawn on a `<canvas>`, with the same graph available as an accessible list. Preview: `http://127.0.0.1:4391/prototypes/graph/`.

- **Reproduces:** the original had no graph view, so this page is new. It uses the page-title row from the board and an inset filter panel in the original's sidebar-panel style. Node colours are the project tones. Edges use `line-strong`, and the hovered or focused node and its edges use `focus`.
- **Layout:** a simple force layout with repulsion, link springs and centring. It runs 300 steps on load (6 per frame, so it settles in under a second) and then stops. When the filters change, 160 steps run from the current positions. No loop keeps running. With reduced motion or "Hareket: az" all steps run at once and the result is drawn once, with no settling animation. Colours and fonts come from computed tokens and are redrawn on theme change.
- **Filters:** Notlarda vurgula (search; matching nodes stay bright and get labels, the rest dim), Projeler (checkboxes with tone dots), Yetim notları göster, and Etiketleri göster (adds tag nodes such as `#plan` linked to their notes; clicking a tag highlights its notes).
- **Interaction:** hover shows a label (title, project, kind, link count). Click opens the note's page. The canvas can take focus: arrow keys move through the nodes from left to right, Home and End go to the ends, Enter opens and Escape clears. Each step is announced.
- **List view:** the Grafik and Liste tabs use the shared tab pattern. The list shows every visible note with its project, its kind, links to its linked notes and its tags. Search matches stay full strength and the other notes dim.
- **States:** dolu, boş, yükleniyor, hata and uzun metin.
- **Known limits:** no pan, zoom or node dragging. The view fits all nodes. Data comes from `../_shared/workspace.json` plus `data.json` (extra notes, tags and links).
