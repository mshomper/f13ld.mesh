# F13LD.mesh — session recap, 2026-10-15 (b) · v0.11.0 multi-core field bake

**Main:** v0.11.0, merged from `perf-multicore-bake` on 2026-10-15 after Matt's bench run and click-test.

Matt felt the mesher was far slower than other tools. Profiling (one core, 10 mm cube, 0.1 world edge, 2.09 M levelSet grid points):

| Recipe | Field | levelSet from cache | Tris |
|---|---|---|---|
| tpms-gyroid-sheet | 2.41 s (1.15 µs/pt) | 3.16 s | 0.36 M |
| tpms-pi-fieldpair | 21.87 s (10.5 µs/pt) | 1.47 s | 0.14 M |
| beam-bcc | 2.90 s | 1.36 s | 0.11 M |
| foam2-open-lloyd | 8.87 s | 2.19 s | 0.38 M |
| grain-spinodoid | 11.32 s | 3.38 s | 0.67 M |
| noise-simplex-sheet | 10.80 s | 2.46 s | 0.55 M |

Findings: only weld groups had the multi-core field bake (v0.9.3); open-cube and shape-clipped single bodies evaluated every point on one thread. The TPMS term loop re-read each factor's trig text at every point (PI-TPMS does this ~14× per point for its gradients). Manifold's level set is ~0.7–1.6 µs per grid point on one thread and is the floor once the field is parallel.

## What changed (v0.11.0)

- **`worker/m32-export-field.js`** — the shape-clipped export field (shape SDF sampler, structure transform, trim-to-nodes mask, `min(scaffold, shape)` flip) moved here unchanged from `m90`, plus `exportShapeCtx(d)` and `buildExportField(d, edge)`. The mesh worker and the bake workers build the field through it, so they evaluate the same function.
- **`worker/m33-field-pool.js`** — `prebakeExportField`: from inside the mesh worker, starts `min(cores, 15)` `field-bake-worker.js` workers (cores = all but one, sent by the page as `d.cores`), splits the levelSet grid (`m31-weld-grid.js`) into z-layer jobs (~6 per worker), stores the values (Float64 up to 25 M points, Float32 above, no pre-bake above 150 M or under 200 k points), and hands levelSet `makeWeldLookup`. A missed point is evaluated directly. Any pool failure falls back to one core with a progress note. Per-worker copies of the shape / HU grids are capped at 1.5 GB in total.
- **Open cube**: whole grid pre-baked. **Shape-clipped**: coarse pass unchanged (1/64 the points), fine pass pre-baked over the coarse-pass box.
- **`compileTermsList` (`m20`)** — each TPMS term list (A and field-pair B) is built once into one function with the same arithmetic order; bit-identical on 1.2 M random points across every TPMS case plus synthetic phase-shift / frequency / −0 / non-trig terms. Falls back to the loop for anything unexpected.
- Export report gains a **cores** chip; the console logs `[export][field] {workers, ms, f32, points, cached, direct}`.

## Checks

- `harness.js` all 23 cases at Draft, `CORES=4`: ALL PASS, byte-identical.
- `QUAL=med CORES=3 VERBOSE=1` on gyroid, PI pair, spinodoid, foam, beam, noise: byte-identical, every point `cached`, `direct` 0. Shape-tpms at Low on the 8-core case: 455 k points, all cached, identical.
- `fieldbake.js`: Cancel during the field bake leaves no workers; the next export works.
- `loadorder.js`, `fieldtest.js`: clean.
- The dev VM has 2 cores, so it can't show the speed-up. Matt runs that on his machine with the new bench page `tests/regress.html` (see `tests/README.md`): branch vs. live tool, byte for byte, with times. Checked here once in headless Chromium (gyroid, PI pair, shape-tpms at Med, 3 cores): 3 / 3 identical.

## Matt's results and follow-ups (same branch)

Matt's machine (Ryzen 7700X, 16 threads, 15 cores): his PI-TPMS pair part (20 × 20 × 40 mm, 0.12 mm edge, 1.25 M tris) went from 60 s on main to 29 s; bench at High, 19 / 19 cube cases identical, 1.83× overall (PI pair 4.4×, filleted foam 3.6×), four shape cases identical. Two cases got slower: reaction-diffusion 0.73× (15 workers each re-grow the pattern) and beam-bcc 0.68× (field too cheap for the pool). Field is now 0.1–1.6 s per case; the one-core level set is most of what is left.

Follow-ups, approved 2026-10-15:
- **Pool sizing** (`m33` `sampleFieldUs`): the mesh worker times its own field setup (`setupMs`, buildSDF + shape field) and a deterministic sample of grid points, and skips the pool when the one-core field would take under 400 ms or the pool (setup × 1.5 + 120 ms + field / cores) wouldn't cut it by a quarter. Logged as `[export][field] one core: {…}`. Mesh unchanged either way (harness at Med: beam, RD, PI pair identical; RD now stays on one core).
- **Learned estimate** (`60-export-ui.js`): time from level-set grid points (2 × box volume / edge³) × (2 µs mesher + family field cost ÷ cores), triangles from the old surface model, both scaled by factors learned per family and open cube / shape from each finished export (`recordExportTiming`, localStorage `f13ld.mesh.exportCal.v1`, halfway in log terms each time). Matt's PI part: the old estimate said ~359 k tris / 44 s against 1.25 M / 29 s.
- **Report chip** "field · mesh · simplify" from the worker's `msBreakdown` ("in mesh" when the pool was skipped).
- Matt tests real parts on the live pages; no "your design" panel in the bench.

## Next: parallel slab mesher (approved 2026-10-15)

Matt accepted that exports may then differ slightly in triangle layout (same shape and volume). Tested on 2026-10-15: Manifold can't join independently meshed slabs cleanly — touching pieces stay separate after union, overlapping pieces leave doubled-surface slivers (+60 % tris), and trim + weld fails because Manifold re-tidies each cut differently (even one mesh cut from both sides gave 390 vs 394 seam points). Plan: our own marching-tetrahedra on the same body-centred grid per z slab, in the bake workers, with every slab sampling the shared seam plane so seam vertices match exactly; concatenate, `Mesh.merge()`, and let `new Manifold(mesh)` confirm it is watertight. 8 slabs: slowest slab 1.4 s vs 6.5 s whole on one core.

Also open: the export time estimate (`estimateMeshStats`, 0.12 ms per triangle) predates the multi-core field and will read high; recalibrate once Matt has times from his machine.
