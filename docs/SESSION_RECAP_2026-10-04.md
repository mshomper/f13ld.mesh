# Session recap — 2026-10-04 (v0.9.3: fast weld export)

**Main:** v0.9.3 (`bc72aee`). **Suite on main:** F13LD.lab v0.17.3 · F13LD.foam v0.6.0. **Pick up:** [Next steps](#next-steps) below.

**Also merged today** (separate session, PR #8):
- **v0.9.2:** F13LD.foam exact field (`geometry.field: 2`, `buildFoamSDF2`, byte-identical with F13LD.foam and F13LD.lab).
- **v0.6.0 foams:** wet Plateau borders, fillet / node, two-size mix, symmetric seeds, FCC / C15.
- **Tests:** six new foam cases in `tests/recipes.json`. Older foam recipes build exactly as before.

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
| **Fallbacks.** A solid whose mesh isn't closed is level-set as before. The main thread pairs edges (`meshIsClosedOutward`). It welds identical positions first if needed, since the STEP/IGES loader doesn't weld; skips collapsed triangles; and flips an inside-out mesh's copy. If Manifold still rejects a mesh, the worker meshes the whole group as before. | `14-weld-bake.js`, `m90` |
| **Tiny-shell cleanup.** A lattice that only shares a face with an exact solid can leave pockets a few µm thick at that face, plus specks at corners. After the union, shells under 0.1 voxel in volume are dropped (`dropTinyShells`). This also removes sub-0.1-voxel lattice dust in the group's mesh. | `m31`, `m90` |
| **No gradient normalization for true-distance families.** Foam, beam and bundle set `metric: true` on `registerSDF`. | `m05`, `m21`, `m23`, `m25`, `m30` |
| **Far-member skip.** A member is skipped where its shape distance is ≥ 2·fillet + 3 voxels. Far from every member the field is the nearest shape distance. | `m30` `buildAssemblySDF(…, {reachMm})` |
| **Multi-core bake.** The weld field is evaluated at exactly the points `levelSet` will ask for, on min(12, cores − 1) workers. Each worker gets only the cropped part of each member's grid. `levelSet` then reads the stored values (any point it doesn't recognise is evaluated directly). | `14-weld-bake.js` `bakeWeldRegion`; `worker/weld-bake-worker.js`; `worker/m31-weld-grid.js` |
| **Weld-aware estimate.** The panel now covers the whole group: fine-region points, member families, fillet, cores and shape re-bakes. A factor learned from finished weld exports on that machine (`localStorage` key `f13ld.mesh.weldCal.v1`) scales the result. | `14-weld-bake.js` `estimateWeldExport`; `41-quality-estimate.js` |

### Behavior changes (approved)

- Where a lattice meets an exact solid, the fillet is about one voxel smaller (0.12 mm at Med).
- Fillets on foam, beam and bundle members are no longer gradient-normalized. Volume moves by less than 0.4%.
- In a mixed group, solid-to-solid contacts are now a plain union with no fillet.
- An all-solid group keeps the old path, so its fillets stay.
- Shells under 0.1 voxel are dropped from a hybrid weld's mesh. The foam test scene at Draft drops 1,751 of 2,125 shells (sub-voxel foam dust), which moves the volume by 0.03%.

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

## Independent review (before merge)

A separate review pass checked the diff. It confirmed:
- crop index math is bit-identical (420 k random samples, N 1–33);
- layer/job splits have no gaps or overlaps (Float32 and Float64);
- multiple fine regions work;
- the reach skip is byte-identical for gradient-normalized families;
- no buffer is used after transfer;
- the single-body and cube paths are unchanged.

It found the following, all fixed before merge:
1. STEP/IGES solids failed the closed-mesh check because that loader doesn't weld. Collapsed triangles and inside-out meshes failed too. Fixed in `meshIsClosedOutward` / `solidMeshForWorker`; `weldtest.js` §7 covers it.
2. µm pockets where a lattice only shares a face with a solid (32 shells vs 1 at Med, fillet 0). Fixed by `dropTinyShells`; now 1 shell. `weldtest.js` §7 covers it.
3. Estimate calibration included the shape re-bake and fallback runs. The estimate now runs before the re-bake, and calibration is skipped when the worker fell back.
4. Bake hardening:
   - stall watchdog (120 s without a slab) and `onmessageerror`;
   - one pool per region with a settled flag;
   - pool size capped by grid-copy memory (1.5 GB);
   - the mesh worker builds the field only on a cache miss.
5. The estimate can no longer fail an export (try/catch).

Left as is: on very large solids (≥ 100 mm at Med), the solid's level-set copy can poke up to ~0.03 mm past the exact mesh along concave edges inside the fine region. The cause is the shape-grid interpolation. It's a harmless bump. A larger inset would cost fillet size.

## Found, not fixed

1. **Open edges after simplify.** meshopt simplify leaves some open or non-manifold edges on fragmented foam. This is pre-existing: the v0.9.2 export of the same scene had 5,176, v0.9.3 has 7,508. Manifold's own output is closed. Simplify is what opens it. Worth a look: skip collapses on tiny components, or re-check edges after simplify and keep the unsimplified mesh where they break.

   **Analysis (2026-10-04, after the wrap-up; proposal awaiting approval).**

   *Test:* one foam2-open-lloyd body, 20×20×10 mm, cell 10 mm, Low (0.2 mm), level set 629,640 triangles. The level set itself is closed.

   *Cause 1, holes:* Manifold's level set snaps grid points onto the surface. Where thin foam walls nearly touch, this leaves 7,769 vertices sharing a position with another vertex. meshopt treats same-position vertices as one point, and its collapses tear them apart. 81 % of the bad edges touch one of these vertices.

   *Cause 2, edges shared by more than two triangles:* collapses on very thin struts.

   *Effect on volume:* simplify also thins the foam. At tolerance 0.03 mm the volume drops 7 %; at 0.015 mm, 2 %.

   *Things that don't fix it:*
   - meshopt's `Prune`, `Regularize` or `Sparse` flags;
   - locking the shared-position vertices;
   - dropping tiny shells first;
   - a smaller tolerance (4,630 open edges remain at 0.0075 mm).

   *Things that partly fix it:* separating the shared-position vertices by 0.1 µm first leaves 0 open edges, but 2,300–3,100 edges still shared by more than two triangles.

   *Manifold's own simplify* gives 0 bad edges at every tolerance:

   | Tolerance | meshopt (today): triangles · bad edges · volume · time | Manifold simplify: triangles · bad edges · volume · time |
   |---|---|---|
   | 0.03 mm | 208 k · 6,171 · −7.0 % · 0.7 s | 379 k · 0 · −4.4 % · 1.4 s |
   | 0.015 mm | 325 k · 5,254 · −2.0 % · 0.7 s | 452 k · 0 · −1.0 % · 1.6 s |
   | 0.0075 mm | 427 k · 4,887 · −0.5 % · 0.7 s | 505 k · 0 · −0.2 % · 1.3 s |

   *Proposed fix:*
   1. Simplify with meshopt as now, then check every edge (about 0.1 s).
   2. If any edge is bad and the mesh is under about 4 M triangles, simplify the Manifold result with Manifold's own simplify instead. Manifold's simplify crashed above about 10 M triangles in the past, which is why meshopt replaced it.
   3. Above that size, separate the shared-position vertices before meshopt (no holes; some edges still shared by more than two triangles), and show the count in the export report.

   Meshes meshopt simplifies cleanly (TPMS and most other families) are unchanged byte for byte. Foam exports come out closed, with about 1.2–1.8× the triangles and less volume loss, at roughly 2–3× the simplify time.
2. **Triangle estimate for foam is far off.** The shape-mode surface model said ~4.9 k; the real count is 395 k. The time estimate no longer depends on it, but the panel still shows the count.
3. **Weld edge clamp.** The weld voxel cap still uses the whole group box, not the fine regions, so large mixed groups get a coarser edge than they need.
4. **STEP/IGES bodies are imported without welding.** The faces of a STEP/IGES body don't share vertices (`30-shape-import.js` `loadCADFormat`). Exporting such a body on its own as a solid writes a mesh whose faces aren't stitched. Running `mergeVertices` at import (as STL does) would fix it. That would change single-body STEP exports, so it needs a decision.

## Next steps

1. **Matt: check v0.9.3 on the real design.**
   - Reload and check the header says v0.9.3.
   - Export the foam + two solids weld group at Med.
   - Paste the console lines starting `[export][weld]`: plan, level-set timings, shells dropped, estimate calibration.
   - Note the estimate before the first export and after one or two exports; it should settle near the real time.
   - Check in a slicer that the solids look as imported and the foam joins them.
2. **Found-not-fixed items, in Matt's priority order (2026-10-04)** (propose before building):
   1. **Open edges after simplify** (item 1).
   2. **Weld edge clamp**: a coarser edge than needed on large groups (item 3). Proposed:
      - Clamp the edge against the fine regions' total volume instead of the group box. The regions depend on the edge, so take one pass at the raw edge and, if the voxel cap is exceeded, a second pass at the enlarged edge.
      - Make the same change in `estimateWeldExport`.

   **Decisions for Matt at the start of the next session** (the fixes are described under item 1 and above):
   - **Open edges:** build the proposed fix (meshopt, then an edge check, then Manifold's simplify when something broke), or take a different option?
     - Option A, the proposal: closed foam exports, about 1.2–1.8× the triangles, less volume loss, about 2–3× the simplify time.
     - Option B, separate the same-spot vertices before meshopt only: fast and no holes, but some edges stay shared by more than two triangles.
     - Option C, always use Manifold's simplify: closed, but it crashed above about 10 M triangles in the past.
   - **Size ceiling for Manifold's simplify:** about 4 M triangles is suggested. Lower is safer on memory; higher keeps more exports closed.
   - **Weld edge change:** ship it in the same release as the open-edges fix, or separately after?
   3. Then, still to schedule: STEP/IGES welding at import (item 4), foam triangle estimate (item 2).
3. **If the level set dominates at Med or High:** split the lattice region into slabs and level-set them in parallel workers. The seams need overlapping slabs plus a union to stay closed. This costs byte-identity with a one-thread run, so it needs a decision first.
4. **Housekeeping.** Matt approved deleting every branch except `main` (all are merged). Claude sessions can't delete branches (the proxy blocks it). Run this with `gh` on Matt's machine (Git Bash or WSL on Windows). It covers all three repos and turns on auto-delete for future merges:

   ```bash
   for r in f13ld.lab f13ld.foam f13ld.mesh; do
     gh api "repos/mshomper/$r/branches?per_page=100" --jq '.[].name' | grep -v '^main$' |
     while read b; do gh api -X DELETE "repos/mshomper/$r/git/refs/heads/$b" && echo "deleted $r/$b"; done
     gh api -X PATCH "repos/mshomper/$r" -F delete_branch_on_merge=true >/dev/null
   done
   ```

## Tests added

- `tests/weldtest.js <old> <new> [draft|low|med]` runs in Node and covers:
  - grid formula;
  - plan;
  - one-thread vs pre-baked byte identity;
  - the mesh worker's weld branch, including the open-mesh fallback;
  - old vs new timing and volume.
- `tests/weldexport.js <old> <new> [low,med]` runs in the browser, end to end: three STL boxes, weld, export from both builds. It reports time, volume, open edges, the estimate and the `[export][weld]` logs. The `CORES`, `CELL` and `SKIP_OLD` environment variables are described in the file.
