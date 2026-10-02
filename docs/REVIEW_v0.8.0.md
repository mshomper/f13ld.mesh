# F13LD.mesh v0.8.0 — split review, findings and plug-in design

*2026-10-01 · refactor branch `refactor/split-files`*

## 1. What v0.8.0 changed

The single 8,591-line `index.html` is now 24 page files + 14 worker files, using the same numbered layout as F13LD.lab (see README → Project structure). The split was done by a script, not by hand:

- **Same code, same order.** Every original line lands in exactly one file, in its original order. Rebuilding the old single file from the new files reproduces it exactly; the only differences are the version label and some blank lines at file ends.
- **Only glue changed.** The import block moved into `00-libs.js`, and the three worker launchers now point at worker files instead of building workers from inline text. The worker code itself is word-for-word.
- **No load-order traps.** A static check confirmed that no code which runs at page load uses something from a later file (0 hits in the page code, 0 in the worker code).
- **Trade-off:** the page now needs to be served over http(s), like F13LD.lab. Opening it straight from disk no longer works.

### Side-by-side test results

Old single file vs new split version, same browser, same pinned library versions, Draft export, 3MF mesh data compared byte for byte.

| Test case | Triangles (old / new) | Mesh identical |
|---|---|---|
| TPMS gyroid sheet | 3,126 / 3,126 | ✓ |
| TPMS raw preset (split-P) solid | 3,554 / 3,554 | ✓ |
| PI-TPMS field pair (P + octo ×2) | 2,988 / 2,988 | ✓ |
| Noise simplex sheet | 7,372 / 7,372 | ✓ |
| Noise ridged half | 2,586 / 2,586 | ✓ |
| Grain spinodoid | 20,586 / 20,586 | ✓ |
| Grain hyperuniform | 9,154 / 9,154 | ✓ |
| Beam BCC | 2,458 / 2,458 | ✓ |
| Bundle twist | 2,516 / 2,516 | ✓ |
| Wave cubic | 1,484 / 1,484 | ✓ |
| Shape mode · TPMS in cylinder | 28,348 / 28,348 | ✓ |
| Shape mode · hyperuniform in cylinder | 54,486 / 54,486 | ✓ |
| Grain reaction-diffusion | 2,284 / 2,284 | ✓ |
| Shape mode · beam (1.8 mm struts) in cylinder | 1,272 / 1,272 | ✓ |
| Shape mode · beam (0.36 mm struts) in cylinder | both fail the same way | same error — finding A6 |

All worker files (mesh, shape SDF, hyperuniform bake) loaded and ran from their new locations.

---

## 2. Findings — things that look broken

Three reviewers read every file; I spot-checked the top items against the code. **Verified** = reproduced in the browser. **Confirmed** = I read the code path myself. **Traced** = a reviewer traced it with a concrete trigger; not yet reproduced. Everything here was already in v0.7.1 — none of it comes from the split.

### A. Exported geometry accuracy (affects real parts)

| # | Problem | Status |
|---|---|---|
| A1 | **Shape-clipped exports come out about half a shape-grid voxel too big on every side.** The shape distance grid is baked at voxel *centres* but read back at voxel *corners*, which scales the shape by N/(N−1) about its centre. At Draft (64³) on a 50 mm part that is ~0.4 mm per side. The preview reads it correctly, so preview and export disagree. Same mismatch for the hyperuniform grid. (`m90-onmessage.js:269`, `m30-sdf-assembly.js:39`, `m22-sdf-grain.js:237`) | Confirmed |
| A2 | **Reaction-diffusion has a seam at every tile face**, because the periodic grid is read with the non-periodic formula — the wrap from the last cell back to the first is never blended. (`m12-reaction-diffusion.js:134`) | Traced |
| A3 | **Reaction-diffusion and hyperuniform patterns in shape mode are shifted** between preview and export (export anchors the repeating cell at the part's bounding-box corner; preview anchors at the cell centre). For hyperuniform, rotating the structure also moves the pattern. | Traced |
| A4 | **A hyperuniform body inside a weld group only gets lattice in one cell**; beyond that it is all solid or all void. | Traced |
| A5 | **Trim-to-nodes uses the wrong strut radius** whenever the cell size you set differs from the recipe's, so struts get trimmed too much or too little. | Traced |
| A6 | **The fast coarse pass misses thin features.** It samples at 4× the export voxel size, so thin struts can fall between samples: a BCC beam lattice with 0.36 mm struts in a 12 mm cylinder (6 mm cells) fails *every* Draft export with "Empty mesh — check shape/scaffold overlap", even though it passes the thin-feature guard. Near the part edge it can also clip features, because the coarse box margin is smaller than the coarse voxel. Fix: fall back to the full box when the coarse pass is empty, and pad by the coarse voxel size. | **Verified** |
| A7 | **Imported 3MF bodies ignore placement transforms and units** (e.g. an inch-unit 3MF, or a multi-object file with positioned parts). | Traced |
| A8 | **"Solid" body exports can be non-manifold**: vertex welding skips corners because the per-face normals keep them apart. | Traced |

### B. Crashes and hangs

| # | Problem | Status |
|---|---|---|
| B1 | **Hyperuniform shape export crashes on machines reporting ≤2 CPU cores** (2-core VMs, Firefox privacy mode). The fallback path calls functions that only exist inside the worker. | **Verified** |
| B2 | **Preview never finishes for a warped bundle with no shape loaded.** | Traced |
| B3 | **Large OBJ / 3MF imports fail** (~60k+ vertices, common for implant meshes) from a JavaScript argument-count limit. STL is unaffected. (`30-shape-import.js:41`) | Confirmed |
| B4 | **Starting a second export while one is running** can leave the Export button permanently disabled with no way to cancel. | Traced |
| B5 | **Some failures leave the "computing" overlay stuck** — errors in the shape or hyperuniform pre-bake during export, and any worker error in the shape-mode preview of noise/grain. | Traced |
| B6 | **Cancel leaves the bake jobs hanging in memory** (the waiting code never hears back from a stopped worker). | Traced |
| B7 | **Out-of-order preview results can corrupt a later export** — switching recipes mid-bake lets an old noise/grain range get written onto the new recipe, changing wall thickness or emptying the mesh. | Traced |
| B8 | **Open-cube exports have no voxel cap** (the cap function exists but is never called): a 100 mm domain at Low is 125M voxels → out-of-memory or the 180 s timeout. The estimate for these is also ~100× too high. | Traced |
| B9 | **Weld-group exports use the active body's voxel cap**, not the strictest member's. | Traced |

### C. Input handling and safety

| # | Problem | Status |
|---|---|---|
| C1 | **Recipe text is inserted into the page without escaping.** A crafted `?r=` link or shared F13LD.queue code could run script on the f13ld origin; a recipe name containing `<` just breaks the panel. Affects summary cards, recipe chips, body cards and error messages. | Confirmed |
| C2 | **Any `?r=` recipe containing a `%` character fails silently** — the parameter is decoded twice. | Confirmed |
| C3 | **Bad recipes fail silently** — routing and summary errors happen outside the error handler, leaving a half-drawn panel and no message. Same for a malformed item in a `?queue=`. | Traced |
| C4 | **Zero values get replaced by defaults** in grain (kappa 0 → 6, seed 0 → 42, orthotropic weights) and TPMS factor frequencies. Preview and export agree, but they may not match F13LD.grain. Needs a check against the grain tool. | Traced |
| C5 | **Unknown values fall back silently** — an unknown noise type becomes domain warp; unknown wave symmetry becomes "pure". | Traced |

### D. Body / recipe state

| # | Problem | Status |
|---|---|---|
| D1 | Removing the active body (×) leaves the deleted body's settings live — the cube preview can go blank. | Traced |
| D2 | Every body import resets the camera and briefly shows the active body unclipped; a failed import leaves it unclipped. | Traced |
| D3 | A body that has never been active inherits the previous body's rotation / offset / iso / cell size. | Traced |
| D4 | Removing the last recipe chip deletes **all bodies and weld groups** with no confirmation. | Traced |
| D5 | Dropping a second body file while one is baking can exceed the 7-body limit (one goes invisible). | Traced |
| D6 | Editing structure rotation/offset re-bakes the preview at the default quality, not the one selected. | Traced |

---

## 3. Quick wins (low risk)

- **Leftover debug code:** remove the "TEMPORARY DEBUG" block in the worker (it builds every weld member's SDF a second time on each weld preview, including a full reaction-diffusion run) and the debug logging in `44-preview-trigger.js`.
- **Speed:** cache the reaction-diffusion grid (re-simulated on every call); skip the smooth-union gradient term in weld exports when blend is 0.
- **Downloads:** the 3MF download link is revoked immediately after clicking, which can cancel the download in Firefox/Safari.
- **Solid-body export failures** only show in the browser console; show them in the export report.
- **3MF writer:** reject degenerate triangles (spec requires three distinct vertices); sanitize preset names used in filenames.
- **Domain size** resets to 10 mm whenever the panel re-renders; the stale-preview refresh button always uses Medium.
- **One CDN for three.js:** the page loads it from jsdelivr, the shape worker from esm.sh.
- **README:** "Known limitations" still says domain is cube-only and mentions TPMS gradient mode.

---

## 4. Proposal — making new design tools and recipe loaders plug in

### Today: adding a family touches ~15 places in ~12 files

The reviewers found family-specific branches in the router, summaries, labels, colours, palette defaults, voxel caps, thinnest-feature check, wall-fraction estimate, periodicity check, bake-bounds chain, raw-bake/normalization, seam badge, beam cell-size default, trim toggle, hyperuniform pre-bake, filenames — plus the worker's dispatcher and two family checks in the message handler.

### Proposed: one descriptor file per design tool

```
families/                         worker/
  fam-tpms.js    ─┐                 m20-sdf-tpms.js   ─┐
  fam-beam.js     │ register          m21-sdf-beam.js    │ registerSDF('beam', …)
  fam-grain.js    ├──────────▶ FAMILIES ──▶ every     m22-sdf-grain.js   ├────────▶ buildSDF
  fam-noise.js    │  { id, label,     branch reads      …                │          looks up
  fam-bundle.js   │    color, … }     the descriptor                    ─┘          the family
  fam-wave.js    ─┘
```

Each `fam-*.js` declares, in one place, everything the app currently branches on:

```js
registerFamily({
  id: 'foam', label: 'Foam', color: '#…',
  detect(json)          { /* return subtype, or null if not mine */ },
  summary(recipe, ui)   { /* cards built with escaped helpers */ },
  isPeriodic(recipe)    { … },
  bakeBounds(recipe)    { … },          // preview tile
  stochastic: false,                    // needs range normalization?
  maxExportVoxels: 50e6,
  thinnestFeature(recipe, cellMm) { … },
  defaultCellMm(recipe) { … },
  options: { trimToNodes: false },
});
```

**Adding F13LD.foam then becomes:** one `fam-foam.js`, one `worker/m25-sdf-foam.js`, and one line in each of `index.html` and `mesh-worker.js`. Nothing else changes.

### Proposed: one loader pipeline for recipe sources

Today `?r=`, `?queue=`, file drop and file pick each have their own parsing and error handling (the source of C2/C3). Proposed:

```
 source ──▶ loader ──▶ validate ──▶ detect family ──▶ library ──▶ preview
 (?r=, ?queue=, drop,     one shared path, one error message on failure
  pick, future: Vault id, F13LD.lab handoff, paste)
```

Each loader is a small file: `registerLoader({ id, matches(urlParams), load() → recipes[] })`. Adding a new source (e.g. `?vault=<id>`) is one file.

### Removing the duplicate code (your efficiency ask)

Page scripts and worker scripts are now both plain files, so **one file can be loaded in both places**. The bundle tiling helpers (`43-bundle-cells.js` vs the worker copy) and the hyperuniform helpers (`hu-bake-worker.js` copies `m11`/`m22` line for line) would each become a single shared file under `shared/`, loaded by a script tag on the page and by `importScripts` in the worker. That also fixes B1 for free, since the page would then have the functions the fallback needs.

---

## 5. Test notes

- Tests ran in headless Chromium (software WebGL, 2 CPU cores) with CDN requests served from the same pinned npm versions. The harness reports 8 cores for shape-mode tests so the normal worker-pool paths run; at the real 2 cores it hits finding B1.
- Imported bodies default to **Solid**, so shape tests assign the recipe to the body before exporting (otherwise the export is just the body).
- Test recipes are hand-built from the F13LD.lab demo schemas, not exported from each design tool. A click-test with real exports from each tool is still worthwhile.

---

## 6. Suggested order

1. **Merge v0.8.0** (pure split) after your click-test.
2. **v0.8.1 — safety and crashes:** C1, C2, C3, B1, B3, B4, B5. Small, isolated changes.
3. **v0.8.2 — geometry accuracy:** A1–A8. These change exported geometry, so each gets a before/after measurement (e.g. export a known cylinder and measure the part envelope).
4. **v0.9.0 — family + loader registry and shared files.** Pure restructure, verified identical with the same side-by-side harness.
5. **State/UI fixes:** B6–B9, D1–D6, quick wins.

---

## 7. Status — v0.8.1 (safety and crash fixes)

Fixed in v0.8.1, each checked in the browser against v0.8.0:

| # | Fix | Browser check (v0.8.0 → v0.8.1) |
|---|---|---|
| C1 | All recipe, file-name and error text is escaped before it goes on the page (`02-html.js`) | Crafted `?r=` link ran script → shown as plain text |
| C2 | `?r=` no longer decoded twice | Recipe containing "%" never loaded → loads |
| C3 | Every recipe source goes through one check (`parseRecipe` / `validateRecipe`) and reports problems | `{"family":"tpms"}` gave no message → names the missing `surface` block |
| C4 | Grain zero values match F13LD.grain: κ = 0 is isotropic, an orthotropic weight of 0 means none on that axis | κ = 0 exported identical to κ = 6 → distinct mesh; κ = 6 unchanged |
| C5 | Unknown noise types are rejected with the supported list | Silently became domain warp → clear message |
| B1 | Hyperuniform pre-bake always uses the worker pool (one worker minimum) | Crash on 2 cores → exports the same mesh as 8 cores |
| B2 | Warped bundles no longer take the stochastic slab-bake path | Preview stuck forever → finishes |
| B3 | Body import merges meshes with plain loops | 125k-vertex OBJ failed → imports |
| B4 | One export at a time; a second click says one is running | — → message shown, first export completes, button resets |
| B5 | Any error escaping the export pipeline, or a shape-mode preview, resets the panel and shows the message | — |
| B6 | Cancel settles the shape-SDF, hyperuniform and mesh-worker waits | — → cancel mid-bake, next export runs normally |
| D4 | Removing the last recipe keeps bodies (as solid), keeps the library row with its + tile, and still allows solid export | All bodies deleted → kept |

Regression: all 14 shared test cases (every family, plus shape mode) produce byte-identical meshes in v0.8.0 and v0.8.1.

Still open after v0.8.1: section A (geometry accuracy) — see section 8 — plus B7–B9, D1–D3, D5–D6, quick wins, and the plug-in registry.

---

## 8. Status — v0.8.2 (geometry accuracy)

All of section A is fixed. Each fix was measured before and after on a known shape or checked directly on the field.

| # | Fix | Measurement (v0.8.1 → v0.8.2) |
|---|---|---|
| A1 | Shape grid read at voxel centres, matching how it is baked and how the preview reads it (export sampler, weld sampler, hyperuniform grid) | 50 × 14 × 6 mm box, Draft: **+0.397 / +0.111 / +0.048 mm per side → 0.000**. Ø20 × 20 mm cylinder, Draft: radial error **+0.157 mm → 0.001 mm RMS** |
| A2 | Reaction-diffusion grid read as periodic, so the last sample blends into the first at the tile face | Largest field jump at a tile face: **0.143 → 0.011** (largest jump inside a cell: 0.016) |
| A3 | Reaction-diffusion and hyperuniform tiles anchored at the preview's cell origin (−cell/2), not the part's bounding-box corner — independent of rotation/offset | Preview-vs-export field correlation in shape mode: hyperuniform **−0.04 → 1.000**, reaction-diffusion **−0.08 → 1.000** |
| A4 | Weld-group members evaluate hyperuniform periodically (same evaluator as the shape-mode preview) | Points 2–3 cells from the first cell matching their in-cell twin: **7/500 → 500/500** |
| A5 | Trim-to-nodes uses the strut's physical radius at the chosen cell size (new `beamStrutRadiusMm` helper) | Measured strut radius vs radius used: 0.750 vs **0.500 → 0.750**; 0.250 vs **0.500 → 0.250** mm |
| A6 | Coarse pass no longer decides emptiness; falls back to the full box, and pads by a whole coarse voxel | 0.36 mm BCC struts in a 12 mm cylinder, Draft: **"Empty mesh" → exports** |
| A7 | 3MF imports apply build-item/component transforms and the model's unit | Inch-unit box placed at +100 mm: imported at **0.08–2.05 → 102–152 mm** |
| A8 | Imported meshes weld on position only | STL box with real normals, solid export: **24 verts / 24 open edges → 8 verts / 0 open edges** |

**Regression vs v0.8.1:** every open-cube family the fixes don't touch (TPMS ×3, noise ×2, spinodoid, hyperuniform, beam, bundle, wave) is byte-identical. Reaction-diffusion and all shape-mode exports change, as intended.

**Expected visible changes for users:** shape-clipped parts come out at their CAD size (slightly smaller than before); reaction-diffusion patterns shift slightly and lose their tile seams; hyperuniform and reaction-diffusion patterns in shape mode now match the preview and stay put when rotating/offsetting.

Also removed: `main-names.json`, a test-script scratch file accidentally committed in v0.8.1.

---

## 9. Status — v0.8.3 (leftover bugs and quick wins)

| # | Fix | Browser check (v0.8.2 → v0.8.3) |
|---|---|---|
| B7 | Preview runs carry a sequence number; a superseded bake drops its result, and its field range is stored on the recipe it baked | Switch recipes mid-bake: new recipe's cached range was the old recipe's **(−4.95, 1.28) → its own (−1.99, 1.96)** |
| B8 | Open-cube exports use the family voxel cap; cube triangle estimate scales with edge⁻² | 100 mm noise at Low: **125M → 40M voxels**; estimate **18.8M tris / 2250 s → 292k tris / 35 s** |
| B9 | Weld exports cap by the strictest lattice member | Code-checked (not browser-tested) |
| D1 | Removing the active body syncs the promoted body's recipe/solid state; drops its weld membership; releases the scene origin when the last body goes | Remove the only (solid) body: cube preview **stayed solid-masked (blank) → restored** |
| D2 | Importing a body only clears the shape when none exist | Second import: camera **reset (zoom 618, pan 0) → framing kept** |
| D3 | New bodies start with identity structure transform, default trim, current cell size | Rotate body 1 by 30°, add body 2, select it: **30° inherited → 0°** |
| D5 | Body imports run one at a time; blocked while an export runs | Both pass — the test didn't reproduce the old race; fix is by construction |
| D6 | Structure-transform rebake (and stale-banner refresh) keep the selected quality | Medium selected, rotate: quality **undefined → med** |

**Quick wins done:**
- Removed the worker's weld debug block (rebuilt every member's SDF on each weld preview), the preview `TEMP DEBUG` logs, the worker's dead `computeTPMSBakeBounds`, and `SCALE2`.
- Reaction-diffusion grids are cached per worker.
- Weld unions skip gradient normalization when the fillet is 0.
- One download helper with delayed revoke.
- Solid-body export shows a report or error.
- Export filenames are sanitized (`my part #1 (v2).stl` → `my_part_1_v2_solid_…`).
- The 3MF writer skips degenerate triangles.
- Domain size survives panel re-renders.
- 3MF import calls `parse` directly.
- Grain parameter parsing lives in one worker helper.
- Misleading comments fixed; README limitations updated.

**Deliberately left:** unifying the three.js CDN. The shape-SDF worker needs `three-mesh-bvh` with its bare `three` import rewritten to the same pinned version. esm.sh's `?deps=` does that; jsdelivr's `+esm` resolves `three` to the latest release instead, which would load two different three.js builds. Switching the page to esm.sh instead risks the main app on a CDN this sandbox can't test. The two sources are pinned to the same version (0.158.0), so they serve identical code.

**Regression:** all 14 cases byte-identical to v0.8.2.
