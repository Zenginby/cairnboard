# Local graph panel

`local-graph.js` and `local-graph.css` implement the graph beside note, project and research-item documents. These three pages opt in with `localGraph: true` in their `startDocument` options and load `graph.css` plus `local-graph.css`. Their `.doc-aside` holds the existing contents navigation followed by the panel. Other document pages do not mount it or fetch graph fixtures.

## Behaviour and layout

“Yerel grafik” is a native disclosure section. It contains the current page and its neighbours at depth **1** by default; “Komşuluk derinliği” switches to **2**. Traversal is breadth first over resolved drawing edges, including visible ghosts/raw sources. It uses the global defaults: journals, cards and tag nodes hidden, ghosts/orphans shown. The centre page stays labelled and highlighted. Each node with a document destination opens that page on click; the link list provides the keyboard path. The “Grafikte aç” link opens `../graph/?focus=<id>` so B can map it to `/graph?focus=<id>`.

The panel reuses the same `createGraph` renderer/simulation, including theme repaint, pointer interactions, session-only pins and reduced motion. “Grafiği sığdır” restores the fitted camera. The disclosure and link list work without a drag gesture. Editing or changing a prototype state refreshes the graph using the current document data.

When the document column has at least 48rem, the contents and graph share a sticky right column. Below that available width, the contents retain their scrolling row above the body and the disclosure sits **after** the body. The section starts collapsed below the existing 72rem viewport breakpoint and can be opened with keyboard or pointer. Container width decides placement, including when the pinned rail reduces the available space. The panel stays inside the normal page grid; it does not reserve or occupy a separate fixed layer over the rail.

## Shared data and motion contract

See the [graph README](../graph/README.md#data-and-drawing) for the spec API `{ nodes: [{ id, ref, title, type, kind, project, degree, ghost? }], edges: [{ source, target, count }], truncated }`, fixture extensions and drawing rules. `doc-frame.js` loads the common graph fixture for opted-in pages and adds its extra notes to the document dataset, so graph links can open them. `graph-data.js` supplies the same node IDs, incoming backlink counts and aggregated edges in both views. Changing depth never recalculates entity sizes from the smaller neighbourhood.

Repulsion, springs and centring explain the settling movement. A dragged node remains fixed while other nodes settle. The simulation stops after cooling/settlement, or computes entirely before painting with OS reduced motion or the “Hareket: az” setting. No background loop runs after settlement. B replaces the O(n²) force loop with d3-force and fixture loading with the index/API; it should retain the shared drawing/camera and accessibility behaviour. Layout coordinates, depth choice and drag pins are not persisted.

## Review checks

Start `npm run design:serve` and visit `/prototypes/note/?id=note-1`, `/prototypes/project/?project=mutfak-defteri` and `/prototypes/research-item/?id=research-1`. At 375, 1280 and 2000 px in light/dark, open the disclosure, compare depths, follow a node and “Grafikte aç”, then open/close the pinned rail and resize across the placement threshold. Verify there is no horizontal overflow, overlap, console error or CSP violation. Test keyboard links and both reduced-motion settings too.

Automated graph tests verify neighbourhood membership, shared degree values and renderer interactions. Visual/browser checks were blocked in this session by preview-port `EPERM`, an unavailable browser access host and a headless browser process that exited before attachment; they remain owner checks.
