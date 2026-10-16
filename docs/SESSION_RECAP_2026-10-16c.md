# Session recap — 2026-10-16 (c) · v0.15.0 parallel slab mesher

Branch `slab-mesher`. Matt's decisions this session: the mesher switch is a **visible setting**; volume may differ from the classic mesher by up to 1–2 %; welds come in a second step after he has click-tested single parts; every export gets a **loose-piece clean-up** that splits the mesh and drops junk pieces.

## What shipped

- `worker/m34-slab-mesher.js` — our own marching tetrahedra on exactly the grid `Manifold.levelSet` samples (`weldGridDims`, m31). Tets are the BCC tetrahedralisation (two neighbouring cell centres + one edge of their shared face); every tet covers three layers L..L+2 and a slab owns tets with L in [La, Lb). Edges in layers Lb, Lb+1 are shared with the next slab: their crossings are interpolated from the owner end with identical arithmetic, reported with a global key (point id · 8 + slot), and `joinSlabs` welds them. Values on the outer grid layer are clamped ≤ 0 and positions clamped to the box (caps land exactly on the box faces, as levelSet). Winding comes from each tet pattern's handedness (`BASE`, 12 patterns). Snap: a crossing within 0.1 % of an edge goes onto the grid point (merges the near-coincident vertices TPMS fields give at symmetry points); a 10 % snap was tried and rejected — it collapsed walls thinner than one edge into shared edges. Values stream through a rolling window of layers (halo 2), so memory per slab is a few layers.
- `worker/m35-slab-cleanup.js` — `safeSimplify` (meshopt with per-vertex locks; if the result isn't closed, lock the triangles around the tear and redo, growing one ring per retry; gives up to the unsimplified input), `simplifySlab` (locks the triangles holding an open seam edge), `simplifySeamBands` (second pass over triangles within 4 edges of each seam, outer edges locked), `meshClosedReport` (every directed edge once with its reverse; sort-based), `removeLoosePieces`.
- `worker/m36-slab-pool.js` — the jobs (≈3 per worker, ≥ 24 layers each) go to `field-bake-worker.js` (new `mesh` job); under 150 k points or one core it runs as one slab in the mesh worker. Results join in slab order, so the output doesn't depend on worker timing.
- `worker/m90-onmessage.js` — open-cube and shape-clipped fine pass use the slab mesher unless `d.mesher==='classic'`; any error or a result that isn't closed falls back to classic (`slabFallback`, shown in the report). The shape coarse pass is still Manifold (64× fewer points). Welds stay classic. Classic simplify is unchanged (byte-identical); its open edges are counted and shown as a warning chip.
- Export tab (`56-dock.js`): **Mesher** (Slab · every core / Classic · Manifold) and **Loose pieces** (Keep all / under 0.1 % / 1 % (default) / 5 % of the largest piece), stored in `localStorage` (`f13ld.mesh.mesher`, `f13ld.mesh.looseFrac`, helpers in `60-export-ui.js`). The estimate has its own learned key per mesher (`…:slab`).

## Findings

- **The classic path ships torn meshes on thin walls.** Manifold splits pinch points into duplicate vertices where walls are about one edge thick; meshoptimizer then opens them (thousands of open edges on a thin gyroid sheet; Draft exports of the noise, grain and shape-tpms harness cases hit it). Smaller tolerances don't help. The slab mesher doesn't make those duplicates, so it stays closed.
- Volume: the slab mesher is closer to exact than Manifold on the sphere and gyroid (e.g. gyroid solid at 0.2: −0.25 % vs −0.40 %; sheet at 0.1: within 0.2 %).
- Speed on one core (Node): gyroid 8.4 M points 3.6 s vs Manifold 7.4 s; sphere 9.4 M points 3.6 s vs 3.0 s (cheap field, our per-point overhead shows). Multi-core it divides by the slab count.

## Tests

- `tests/slabmesh.js` (Node): raw meshes closed and identical at 1/2/7/16 slabs; simplified meshes closed, volume within 1 % across slab counts; loose-piece clean-up.
- `tests/harness.js`: `MESHER=classic LOOSE=0` → byte-identical to older builds; `GEOM=1` → slab vs older build by shape (closed, volume within `GEOM_TOL` %).
- `tests/regress.html`: Mesher and Loose pieces settings for this build (reference always classic, clean-up off), geometry comparison (volume, area, triangles, open edges, max vertex distance), PASS when identical or closed and within 2 %; one-core vs multi-core slab runs are compared by shape.

## Open / next

- Matt: click-test and run `tests/regress.html` from the branch on his machine (real core counts).
- Welds on the slab mesher (lattice regions in the weld bake workers, union with exact solids as now).
- Needles along seams on flat caps (box at fine edges: 116 vs 12 triangles) — harmless, could take a third pass.
- Per-point overhead of the mesher on cheap fields (`setV` / `edgeVert` in the hot loop).
- Recalibrate `EXPORT_SLAB_US` from Matt's timings (the estimate also learns per family).
