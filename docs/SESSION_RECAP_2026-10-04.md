# Session recap — 2026-10-04 (v0.9.3: fast weld export)

## Problem

A weld group of two solid bodies with a foam body between them ran for 83 s and more at Med, while the export panel said about 3 s.

Five things added up:

1. **Wrong estimate.** The panel estimated the active body alone. The weld group was never considered.
2. **The whole group was meshed at the fine edge**, solids included, so the solids were re-meshed from their SDF grid at fine resolution.
3. **Every member was evaluated at every grid point**, including bodies tens of mm away.
4. **Seven evaluations per point per lattice.** With a fillet, each lattice member was gradient-normalized (`unionGradNorm`). Foam, beam and bundle are already true distances, so this did nothing for them.
5. **One thread.** `Manifold.levelSet` calls the field from JS on a single thread.

## Shipped: v0.9.3

| Change | Where |
|---|---|
| **Exact solids.** A solid with a closed mesh comes straight from its imported mesh (`Manifold.union` at the end). Only boxes around lattice members (+ fillet + 3 voxels) are level-set. Inside those boxes the solid is pulled one voxel in (`insetMm`), so the exact mesh covers it. | `14-weld-bake.js` `planWeld`; `worker/m90-onmessage.js` weld branch |
| **Fallbacks.** A solid whose mesh isn't closed is level-set as before. The main thread checks edges + orientation (`meshIsClosedOutward`); if Manifold still rejects the mesh, the worker meshes the whole group as before. | `14-weld-bake.js`, `m90` |
| **No gradient normalization for true-distance families.** Foam, beam and bundle set `metric: true` on `registerSDF`. | `m05`, `m21`, `m23`, `m25`, `m30` |
| **Far-member skip.** A member is skipped where its shape distance is ≥ 2·fillet + 3 voxels. Far from every member the field is the nearest shape distance. | `m30` `buildAssemblySDF(…, {reachMm})` |
| **Multi-core bake.** The weld field is evaluated at exactly the points `levelSet` will ask for, on min(12, cores − 1) workers. Each worker gets only the cropped part of each member's grid. `levelSet` then reads the stored values (any point it doesn't recognise is evaluated directly). | `14-weld-bake.js` `bakeWeldRegion`; `worker/weld-bake-worker.js`; `worker/m31-weld-grid.js` |
| **Weld-aware estimate.** The panel now covers the whole group: fine-region points, member families, fillet, cores and shape re-bakes. A factor learned from finished weld exports on that machine (`localStorage` key `f13ld.mesh.weldCal.v1`) scales the result. | `14-weld-bake.js` `estimateWeldExport`; `41-quality-estimate.js` |

### Behavior changes (approved)

- Where a lattice meets an exact solid, the fillet is about one voxel smaller (0.12 mm at Med).
- Fillets on foam, beam and bundle members are no longer gradient-normalized. Volume moves by less than 0.4%.
- In a mixed group, solid-to-solid contacts are now a plain union with no fillet.
- An all-solid group keeps the old path, so its fillets stay.

### `levelSet` grid (manifold-3d 3.4.1)

Checked bit-for-bit on four boxes (`tests/weldtest.js` §1):

- `n = trunc(dim/edge + 1) − 1` cells per axis; `s = dim/n`.
- Main points: `min + s·i`, i = 0..n.
- Offset points: `min + s·(j − 0.5)`, j = 0..n+1.
- Each point is asked for once. No extra calls with the default tolerance.

## Measurements (this VM: 2 cores, Node 22 / headless Chromium)

**Scene:** solid 25×20×10 | foam2-open-lloyd 20×20×10 (overlapping 2 mm each side) | solid 25×20×10, fillet 0.4 mm.

| Run | v0.9.2 | v0.9.3 |
|---|---|---|
| Node, Draft, one thread | 40–51 s, 0.68 M points | 4.1 s, 0.26 M points (10×) |
| Node, Low, one thread | (not run, ≈ 6 min) | 27 s. Field 26.6 s of that is split across workers in the app; level set from cache 3.9 s |
| Browser, Low, end to end, 8 cores reported | 193.7 s | 21–22 s (8.7×), on 2 real cores |
| Volume vs v0.9.2 | — | −0.37% Draft, −0.54% Low |
| Estimate shown, Low | "~2 s" | "~13 s"; the calibration factor moved to 1.3 after one export |

**Other checks:**
- The pre-baked mesh is byte-identical to the one-thread mesh: 0 points evaluated directly.
- `tests/harness.js` passes: all 23 open-cube and shape exports byte-identical to v0.9.2.
- `fieldtest.js` is unchanged.
- Cancel during the bake is clean: the button resets, no workers are left running, and the next export works.

**Scaling to Med:** time grows about 4.6× from Low (points ∝ 1/edge³). Field evaluation divides by the core count. The level set itself still runs on one thread at about 2 µs per grid point, or roughly 7 µs per output triangle. That is now the largest single-thread part.

### Per-evaluation cost by family (Node, export field; ×7 if a fillet normalizes it)

| tpms | noise | grain | grain HU | beam | bundle | wave | foam |
|---|---|---|---|---|---|---|---|
| 1.3–23 µs | 12–31 | 1.6–8 | 58 | 2.2 | 101 | 4.1 | 5.8–45 |

These seed the estimate table (`WELD_EVAL_US`).

## Found, not fixed

1. **Open edges after simplify.** meshopt simplify leaves some open or non-manifold edges on fragmented foam. This is pre-existing: the v0.9.2 export of the same scene had 5,176, v0.9.3 has 7,508. Manifold's own output is closed. Simplify is what opens it. Worth a look: skip collapses on tiny components, or re-check edges after simplify and keep the unsimplified mesh where they break.
2. **Triangle estimate for foam is far off.** The shape-mode surface model said ~4.9 k; the real count is 395 k. The time estimate no longer depends on it, but the panel still shows the count.
3. **Weld edge clamp.** The weld voxel cap still uses the whole group box, not the fine regions, so large mixed groups get a coarser edge than they need.

## Next steps

1. **Matt:** export the real foam + two solids design at Med. Paste the console lines starting `[export][weld]` (plan, timings, calibration). Compare the estimate before and after one or two exports.
2. If the level set dominates at Med or High, split the lattice region into slabs and level-set them in parallel workers. Overlapping slabs plus a union would be needed to keep the seams closed. This costs some byte-identity, so it needs a decision first.
3. Items 1–3 above.

## Tests added

- `tests/weldtest.js <old> <new> [draft|low|med]` runs in Node and covers:
  - grid formula;
  - plan;
  - one-thread vs pre-baked byte identity;
  - the mesh worker's weld branch, including the open-mesh fallback;
  - old vs new timing and volume.
- `tests/weldexport.js <old> <new> [low,med]` runs in the browser, end to end: three STL boxes, weld, export from both builds. It reports time, volume, open edges, the estimate and the `[export][weld]` logs. The `CORES`, `CELL` and `SKIP_OLD` environment variables are described in the file.
