# Session recap — 2026-10-17 · v0.16.0 slab welds, triangle quality, weld bench

Branch `slab-welds`. Matt's decisions this session: slab welds keep the imported solid parts exactly as imported (not re-simplified), accepting somewhat larger weld files; slab exports may change triangle layout again from the flip pass as long as shape and volume hold; the export estimate keeps learning from his exports (no manual recalibration); both items in one v0.16.0 branch; benchmarks run on his machine with `tests/regress.html`, not on the session VM.

## What shipped

- **Welds on the slab mesher** (`worker/m90-onmessage.js` weld branch). Welds follow the Export **Mesher** setting: Auto (classic first; slab when classic runs out of memory or its result is torn), Slab, Classic. Each lattice region meshes in z slabs on every core from the field the main thread already pre-baked (`14-weld-bake.js` → `bakeWeldRegion`): `m36 slabMeshExport(…, {lookup:{main, off}})` sends each slab worker only the layers it reads, `[La−2, Lb+4)` (`weldLayerKRange`, `makeWeldLookupSlice` in `m31`; `field-bake-worker.js` `init` with `lookupOnly`). A point outside the slice throws → classic fallback. A region without a bake meshes in the mesh worker on one thread. Each region is checked closed, unioned with the exact solids (Manifold, as before), tiny shells dropped (hybrid), flipped, checked closed again. No second simplify, so imported solids come through as imported. Any failure falls back to classic (`slabFallback`). The weld report shows the mesher chip. Slab weld timing learns its own factor (`weldCalKey(slab)` → `f13ld.mesh.weldCal.v1:slab`), recorded only when the mesher used matches the estimate's.
- **Triangle quality** (`worker/m35-slab-cleanup.js`): `flipEdges(pos, idx, lockV, opts)` — deterministic edge flips (Delaunay test) only where the two triangles are within 1° of flat, never moving a vertex, never creating an existing edge; `lockMode:'edge'` in the slab and band passes (no edge between two locked vertices is removed or created, so seams still join), `'vertex'` otherwise. `checkedFlip` keeps the unflipped mesh if the result isn't closed. Called after `simplifySlab` and `simplifyBandJob`.
- **Final pass over the joined slab mesh** (`m36 _slabFinish`, when there is more than one slab): one tear-safe `safeSimplify` of the whole, already-simplified mesh with nothing locked, then `checkedFlip`. The slab and band locks left rows of vertices that split flat areas into strips of thin triangles; this removes them. Node (`tests/slabmesh.js`, 8 slabs): box cap 5,896 → 12 triangles (classic 12), needles 204 → 0; gyroid solid at 0.2 needles 281 → 39 (classic 66), triangles 6,966 vs classic 7,336; gyroid sheet at 0.2 needles 275 → 33 (classic 29); sphere 0.05 needles 90 → 0. The pass took ≤ 60 ms on these cases; it is single-threaded, so watch it on big parts on the bench.
- `triQuality(pos, idx)` (m35): needles (height / longest edge < 0.05), needle %, 5th-percentile minimum angle, mean minimum angle. The mesh worker's `done` message now carries `quality` and `finalFlips`.
- **Bench page** (`tests/regress.html`): Mesher choice Auto / Slab / Classic; **Weld cases** group (`weld-solid-gyroid-solid`, `weld-solid-foam-solid`, `weld-gyroid-gyroid`) made in the page and welded with a 0.4 mm fillet, same set-up as `weldexport.js`; needles and min angle p5 for reference and this build on each card and in the Markdown report.
- `tests/weldtest.js` 6b: the weld message on the slab mesher, from the field and pre-baked (closed, volume within 1.5 % of classic). `tests/weldexport.js`: `MESHER=auto|slab|classic`. New `tests/flipedges.js` (Node): flip rules, both lock modes, determinism, closed, volume.

## Findings

- Classic weld exports are torn on the test welds (Draft gyroid weld 196 open edges, Low foam weld 7,031); the slab weld results are closed, volume within 0.05 % of classic.
- Hybrid weld (solid + gyroid + solid, Draft): needles 5.7 % vs classic 1.2 %, min angle p5 3.0° vs 11.4°. The lattice-only weld is close to classic (0.5 % vs 0.3 %), so these come from the union cutting the exact solids' flat faces (thin triangles between a face's corners and the lattice's cross-sections). The faces stay exactly flat; only the classic path's full re-simplify removed them. If they matter, a simplify limited to triangles touching the cut would do it without changing the solids' shape.
- Timings on the session VM (2 threads, shared) mean nothing; use the bench.
- Classic harness (`MESHER=classic LOOSE=keep`, Draft): 22/23 identical on the first run; `shape-hyperuniform` differed by one vertex under load and was identical on rerun (old vs old and old vs new) — a timing flake, not this change.

## Matt's bench and click-test (16 threads, High, slab, Remove specks)

- His implant cage with a tough foam exports at Medium in under 7 s.
- Weld bench vs the live tool (classic): solid + gyroid + solid 29.5 s → 3.36 s (8.8×), 25 → 0 open edges; two gyroids 36.8 s → 8.54 s (4.3×), 119 → 0; solid + foam + solid 14.1 s → 19.5 s (0.72×), 195 → 0, 16 % fewer triangles. Volumes within 0.02 %. Needles 3.3 % → 4.6 % on the solid + gyroid weld, equal or better on the other two.
- The foam weld's extra time is the final pass: foam's thin walls tear when simplified, so `safeSimplify` redoes the whole mesh (Node, foam weld at Low: 1.0 M triangles, 4 redos, 8.5 s on one thread), and the final pass runs on one core over the joined mesh.
- Decisions: merge v0.16.0 now; the parallel final pass is v0.16.1; leave the union-cut thin triangles on hybrid welds (the faces stay exactly flat).

## v0.16.1 parallel final pass (branch `parallel-final`)

- Two ideas tried and dropped: wide bands alone (re-cut at slab middles) can't flatten a flat face once it is strips spanning two seams — any split into pieces locks those rows (box: 1,156 triangles, also without ring locks); seeding the one-thread whole-mesh pass with the slabs' tear locks only cut its redos 3 → 2 (foam weld region at Low: 3.1 → 2.2 s).
- Shipped (`m35` `finalBandRounds`, `markBandRows`, `simplifyRows`, `simplifyFinalRounds`; `m36 _slabFinish`): round A (wide bands around the even seams) and round B (odd seams) on the pool, each band reaching to the other round's seams, then the one-thread rows pass with everything locked except round B's band-edge rows plus 2 rings (`SLAB_ROWS_RINGS`). Replaces v0.15.0's narrow seam bands and v0.16.0's whole-mesh pass. Tear locks found by the slabs and bands (`safeSimplify` now returns `tearLock`, `simplifySlab` / band jobs return `tearV`, sent by `field-bake-worker.js`) stay locked in every later pass (`seed`).
- Node (`tests/slabmesh.js`, 8 slabs): box cap 12 triangles (classic 12); gyroid solid at 0.2: 6,818 triangles, 31 needles (v0.16.0 6,966 / 39; classic 7,336 / 66). Foam weld region at Low, 24 slabs, one thread: rounds 3.1 s + 5.0 s of work split over 10 / 11 bands, rows pass 2.4 s, 236 k triangles, needles 2.25 %, closed — vs v0.16.0's 5.8 s finish on one core.
- Stage times: the `done` message carries `stages` (slabs, round A, round B, rows, flips, union, clean-up; `m36 slabStageTimes`); the bench page shows them on each card and as a second table in the report.
- Checks: `slabmesh.js`, `flipedges.js`, `weldtest.js` pass; `GEOM=1 MESHER=slab QUAL=low CORES=3` harness on gyroid sheet, open foam, shape gyroid, wet foam: closed, volume within 0.01 % of v0.15.0.
- If the rows pass shows up as the big stage on Matt's bench, it can be split per row onto the pool next.

## Matt's v0.16.1 bench (High, 15 cores) and v0.16.2

- v0.16.1: solid + gyroid + solid 7.02 s vs classic 20.2 s; foam weld 15.0 s vs 11.9 s (v0.16.0: 19.5 s); two gyroids 9.44 s vs 27.4 s; all closed (classic 25 / 195 / 119 open edges). Foam weld stages: slabs 3.88, round A 2.12, round B 1.28, rows 2.97 (one core), flips 1.60 s, and ~3 s unaccounted — the union: Manifold evaluates booleans lazily, so the work happens in `isEmpty` / `getMesh`, outside the timed call.
- Decisions: build v0.16.2 now; merge v0.16.1 and v0.16.2 together after his next bench.
- v0.16.2 (same branch):
  - Rows pass on the pool: `m35 rowsJobs` splits the free set into connected pieces (triangles joined through free vertices) and packs them into about 2 jobs per worker; a piece is never cut, so a flat face crossing several slabs stays one piece and still collapses (box: 12 triangles). Splitting by height instead (nearest row) brought the box strips back (1,106 triangles). Rows jobs lock only their outer vertices (`noRing`), non-free vertices through `seed`. `simplifyRows` removed.
  - Welds: regions skip their own flip (`opts.noFlip` → `_slabFinish`) and the weld flips once after the union; no separate closed checks (the Manifold constructor throws on a non-manifold region → classic; `checkedFlip` checks itself; the union is closed by construction); a lone region with no exact solids skips Manifold entirely (closed check instead). The union is timed through `getMesh`, including building the Manifolds (`stages.union`).
  - Node: box caps 12, gyroid solid 0.2: 6,820 triangles / 31 needles (as v0.16.1); slabmesh / flipedges / weldtest pass. In the browser on this VM weld jobs run on one slab (its workers see 2 real cores), so the pool path is checked through the bench page with cores set.

## Matt's v0.16.2 bench (High, 15 cores)

- solid + gyroid + solid 6.21 s vs classic 20.0 s (3.2×); solid + foam + solid 10.7 s vs 11.9 s (1.11×, was 15.0 s in v0.16.1, 19.5 s in v0.16.0); two gyroids 8.77 s vs 27.2 s (3.1×). All closed (classic 25 / 195 / 119 open edges), volumes within 0.02 %, 2–18 % fewer triangles.
- Foam weld stages: slabs 3.77, round A 2.10, round B 1.29, rows 0.24 (was 2.97), flips 0.62 (was 1.60), union 2.15 s (now measured).
- v0.16.1 + v0.16.2 merged to main together, as Matt asked, after the classic byte-identical harness.

## Open / next

- Remaining big stages on the foam weld: the slabs themselves, round A, the union. Possible later work: shrink what goes into the union (only lattice near the solids), fewer tear redos in round A.
- Then P3 (exact-math GLSL sources), P4, P5.
- (done in v0.16.1) final pass in parallel — re-cut the joined mesh at the middle of each original slab so every old seam lies inside a piece, simplify + flip each piece on the pool with only its cut edges locked; stage times (slab mesh / bands / final pass + redos / union / clean-up) on the bench cards.
- Then P3 (exact-math GLSL sources), P4 (empty-space skipping, adaptive resolution, bench preview tab), P5 (WebGPU, IndexedDB).
