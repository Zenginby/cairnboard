# Graph (Bağlantı grafiği)

Visual and interaction reference for stage B's `/graph`. Run `npm run design:serve`, then open `/prototypes/graph/` on the local preview server. The existing prototype server's routes stay unchanged.

## Try the behaviours

- Drag empty canvas space to pan. Wheel or trackpad pinch zooms around the pointer; two touch pointers zoom around their moving midpoint. The + / − buttons zoom around the centre; “Grafiği sığdır” fits again.
- Drag a node to fix its position for this loaded page's lifetime. Remaining nodes settle around it. Filtering a node out and back in retains its fixed coordinates. Nothing is written to storage; navigation or reload starts a fresh layout.
- Hover a node to show its name, status and backlink count. Its neighbours and their labels stay bright; unrelated nodes and edges fade. Click a resolved node to open its existing page. Ghosts and ignored raw sources have no document destination.
- Use the Grafik / Liste tabs with the shared keyboard tab pattern. In Liste, Tab selects ordinary page links and Enter opens them. The canvas is not an extra keyboard navigation system. The local panel also has a link list.
- Search highlights titles and tags without filtering out nonmatches or restarting the layout. Clicking a tag node searches for its tag.
- Filters compose: entity type, note kind, one project, one tag, orphans, ghosts, journals and cards. Journals, cards and tag nodes are off by default; ghosts and orphans are on. An orphan has no entity edge in the complete fixture, rather than merely losing a neighbour to a filter. Backlink counts also use the complete fixture.
- Every filter and search change uses `history.pushState`; `popstate` restores the controls and graph on Back/Forward. Defaults are omitted from the query. Example: `?type=note&kind=concept&project=mutfak-defteri&tag=tarif&orphans=0&ghosts=1&journals=0&q=Çorba`. Extra switches use `cards=1` and `tags=1`. Unknown filter values remain visible and produce an empty result instead of silently widening the selection.
- Open `?limit=3` to see “Süzgeci daralt” and the original/displayed counts. The limit accepts positive integers, capped at 3,000. Filters run before truncation; highest backlink counts win, with stable ID ordering for ties. Tag nodes also count toward the cap. Search remains highlighting, so narrowing the selection means changing a filter.
- Open `?focus=note-1`, or use a local panel's “Grafikte aç”, to centre and highlight the open page. Prototype states remain dolu, boş, yükleniyor, hata and uzun metin.

“Etiketleri göster” mirrors Obsidian's **Tags** option. It is off by default and must be added to spec §3.2, pending owner confirmation. It creates synthetic tag nodes/edges without changing any entity's `degree` or radius.

## Data and drawing

`app.js` loads the merged shared sample/workspace and `data.json`. `_shared/graph-data.js` builds the common graph for this page and the [local panel](../_shared/README.md). The document frame loads the additional graph notes on participating pages so their existing note/research URLs open actual fixture documents.

The stage B API shape is:

```js
{
  nodes: [{ id, ref, title, type, kind, project, degree, ghost? }],
  edges: [{ source, target, count }],
  truncated
}
```

Here `id`, `source` and `target` are stable strings; `ref` is a prototype page href for a resolved entity. B should resolve its real references through the app router. `degree` is the incoming backlink occurrence count before filters, tags or truncation; it is not the undirected drawing degree. Fixture link tuples represent directed occurrences. Parallel links in either direction aggregate into one undirected drawing edge with summed `count`. Radius grows with `log1p(degree)`; edge width with `1 + log2(count)`.

Prototype-only fields: `tags` supports filtering/search/synthetic nodes; `target_name` names unresolved nodes; `ambiguous` marks warning-coloured ghosts; `ignored` marks raw targets under `ignore`. `total` is added by filtering for the truncation message. B must supply the corresponding index metadata alongside the API result rather than infer ambiguity from a title.

The fixture includes notes, wiki pages, projects, research, one node per journal file, optional cards, an unresolved “Saklama koşulları” target, an ambiguous “Hazırlık” target and an ignored “Tartım çizelgesi” raw source. Ghosts are faded dashed rings; ambiguous ghosts use the warning token and explicit status copy; ignored sources are outlined squares. Colours use `--graph-<type>` / `--graph-note-<kind>` aliases in `_shared/graph.css`, read with `getComputedStyle`. Theme and system colour-scheme changes repaint the canvas. Project tinting is optional in the spec and is not implemented; type/kind colouring is the reference here.

## What moves, and what B replaces

`_shared/graph-layout.js` provides the shared simulation, canvas drawing, hit testing and camera. Repulsion separates unrelated nodes; springs pull linked nodes together; centring keeps the graph near its origin. It warms up before painting, then cools over at most 300 iterations, stops early when movement settles, and leaves no perpetual animation loop. User camera interaction stops settling. A node drag pins its world coordinates and restarts settling for other nodes. Drawing never refits the camera; explicit fit, filter rebuilds and canvas size changes do.

With either `prefers-reduced-motion: reduce` or `html[data-motion="less"]`, all simulation work runs before one paint, including after a drag. Pointer-driven pan/zoom/drag still responds directly. A mid-animation motion preference change cancels the pending frame and finishes synchronously.

For B, replace the bounded O(n²) prototype force loop with **d3-force** (charge, links, centring, cooling and `fx`/`fy` pins), and fixtures/filtering with the spec API. Keep the shared renderer/camera contract, logarithmic backlink sizing, aggregated edge counts, token-driven colours, explicit stop/reduced-motion handling, accessible links, query history and local-depth semantics. This small fixture is an interaction reference, not a 3,000-node performance benchmark. The prototype adds no dependency or external resource.

## Verification

`node --test test/design-graph.test.mjs` covers aggregation/backlinks, composed filters, defaults, truncation, local depth, force termination/pins, hover/search, pointer-anchored wheel zoom, panning, node drag/click, two-pointer pinch, theme repaint and both motion preferences through a canvas event harness. `npm run design:lint` checks tokens and CSP/inline restrictions. Run `npm test` for the repository suite.

Browser acceptance remains required: with `npm run design:serve`, open graph, note, project and research-item at 375, 1280 and 2000 px in light and dark. Check console/CSP errors, horizontal overflow and the pinned rail with the local panel open; try filters/Back, real touch pinch, list Enter, both depths and reduced motion. This implementation session could not bind the preview port (`EPERM`); the browser access host was unavailable and isolated headless Chromium could not stay running. The event harness is not visual or real-device verification.
