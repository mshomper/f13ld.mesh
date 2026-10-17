# F13LD.mesh — dev test harness

Dev-only. Nothing here is loaded by the app or served to users.

Every test runs the real app in headless Chromium. CDN requests are answered from the locally installed npm packages, at the exact versions the app pins, so tests run offline and old and new builds load identical libraries.

## Setup

```
cd tests
npm install            # same pinned versions as the app's CDN imports, plus playwright
python3 fixtures/make_bigsphere.py   # only needed for the large-OBJ import test
```

Chromium must be available to Playwright (`PLAYWRIGHT_BROWSERS_PATH`).

## Bench page (run on your own machine)

`tests/regress.html` runs the same comparison as `harness.js` in your own browser, on your own cores, so long or core-heavy checks don't need the headless setup. Open it from the branch you want to test, e.g. `https://raw.githack.com/mshomper/f13ld.mesh/<branch>/tests/regress.html` (any http(s) server works; `file://` does not).

- For each ticked case in `recipes.json` it loads the recipe in the real app (the pane at the bottom), imports the shape fixture for shape cases, catches the export job the tool sends its mesh worker, and meshes that job with the **reference build** (default: the live tool, its worker loaded from a blob) and with **this build** at the chosen core count.
- It compares every vertex and triangle bit for bit, shows the times, the speed-up, the split between field / level set / simplify, and how many points came from the field pre-bake. A case that differs is compared by shape (volume, area, triangles, open edges, approximate max vertex distance); it passes when this build's mesh is closed and its volume is within 2 % of the reference.
- The reference always runs the classic mesher and keeps all loose pieces. **This build mesher** is Auto (the app's default), Slab (the bench's default) or Classic; **Loose pieces** is Keep all, Remove specks or Largest piece only. Both are set on the job, so they apply to weld jobs too.
- **Weld cases** (v0.16.0) are a separate group of tick boxes. Each one makes STL boxes in the page, imports them into the app pane, gives the lattice boxes the named `recipes.json` recipe at a 10 mm cell, welds every part with a 0.4 mm fillet (`F13LD_weld.all`) and catches the weld export job, the same set-up as `weldexport.js`: `weld-solid-gyroid-solid` (solid + `tpms-gyroid-sheet` + solid, hybrid), `weld-solid-foam-solid` (solid + `foam2-open-lloyd` + solid, hybrid) and `weld-gyroid-gyroid` (two overlapping gyroid boxes, no solids, not hybrid). **Welds only** ticks just these.
- Triangle quality for both builds on every case card and in the report: needles (triangles whose height over their longest edge is under 0.05) as a count and %, and the 5th-percentile minimum angle in degrees.
- Settings (quality, cores, reference URL, time limit, mesher, loose pieces, ticked cases and weld cases) are remembered in the browser. **Download report** saves the results as Markdown.

## Comparing two builds

Most scripts take two folders: an older build and a newer one. Each is a plain copy of the repo, e.g. a `git worktree` or an exported tag.

| Script | What it checks |
|---|---|
| `harness.js <old> <new> [filter]` | Exports every case in `recipes.json` (all families + shape mode) at Draft from both builds; compares 3MF mesh data byte for byte. Main regression check. v0.15.0: `MESHER=classic LOOSE=0` picks the classic mesher with the loose-piece clean-up off (byte-identical to older builds); `GEOM=1` compares slab exports to the older build by shape instead (closed, volume within `GEOM_TOL` %, default 2). `QUAL=med` picks another quality, `CORES=n` sets the core count for cases without one (the field pre-bake needs at least 3, and skips grids under 200 k points, so use `QUAL=med CORES=3` to exercise it), `VERBOSE=1` prints each export report and `[export][field]` line. |
| `fixtests.js <old> <new> [filter]` | v0.8.1 safety/crash fixes (escaping, `%` links, bad recipes, 2-core hyperuniform, warped bundle, large OBJ, overlapping exports, cancel, keep bodies, κ = 0). |
| `fixtests2.js <old> <new> [filter]` | v0.8.3 fixes (stale preview range, cube voxel cap, body removal/import/camera, structure settings, preview quality, domain size, solid export). |
| `weldtest.js <old> <new> [draft\|low\|med]` | v0.9.3 weld export, in Node: `levelSet` grid formula (bit-for-bit), weld plan, pre-baked vs one-thread mesh byte identity, mesh worker weld branch incl. the open-solid fallback, old vs new time and volume (old only at Draft unless `OLD=1`). |
| `weldexport.js <old> <new> [low,med]` | v0.9.3 weld export in the browser: three STL boxes (solid, lattice, solid) welded and exported from both builds; time, volume, open edges, estimate, `[export][weld]` logs. `SKIP_OLD=1` runs the new build only. |

## Single-build checks

| Script | What it checks |
|---|---|
| `partprep.js <build> [outDir]` | v0.10.0 part prep: live estimate vs measured volume filled, panel stats vs an independent read of the 3MF, box volume / area / plate / support at three orientations, solid-body export, print report. `outDir` saves print-view screenshots. `SIDEBAR=<dir>` runs the sidebar checks instead (overflow, details card, collapse, readouts) and saves screenshots there. |
| `measure.js <build> <label> [draft,med,…]` | Exports a fully solid fill clipped to a 50 × 14 × 6 mm box and a Ø20 × 20 mm cylinder; reports size error per side and radial error. Set `ONLY=box` or `ONLY=cyl` to run one. |
| `importtest.js <build> <label>` | STL with real normals welds watertight; inch-unit, moved 3MF lands in mm at the right place. |
| `a6test.js <build> <label>` | Thin-strut beam in shape mode exports (coarse pass fallback). |
| `fieldbake.js <build> [case] [quality]` | v0.11.0 single-body field pre-bake: Cancel while the field is computed on several cores leaves no workers running, and the next export works and reports its cores. `CORES=n` (default 4). |
| `slabmesh.js [quick]` | v0.15.0, Node, no browser: slab mesher on a sphere, gyroid sheet and solid, a box cap and a thin wall at 1/2/7/16 slabs — raw meshes closed and identical whatever the slab count; after simplify, closed, volume within 1.5 % across slab counts, triangle and needle counts and volume next to Manifold + one simplify and the exact value; plus the loose-piece clean-up. |
| `slabbake.js <build> [N] [slabs]` | v0.13.0, Node, no browser: preview bakes split into z-slabs and stitched equal the one-worker bake bit for bit (field, range, Lipschitz) for every `recipes.json` case, SDF and raw, and a 3-member weld. |
| `previewcache.js <build>` | v0.13.0 preview rebuild P1: switching lattice parts, selecting a solid part and switching inside a weld cause no bake; weld rotation / wall offset re-bake with the view held and the camera kept; a newer preview cancels the older bake; no console errors. `CORES=n` (default 6). |
| `weldvis.js <build>` | v0.13.0 weld visibility: every eye (part, selected part, weld) with the weld selected and with another part selected — hidden parts leave the weld and aren't drawn, ghosted parts leave the solid weld preview and draw as shells, a fully hidden weld shows an empty view with its message, the weld grid is sized to the weld and the weld lights at least `MINLIT` of the frame. |
| `previewparity.js <build> [filter]` | v0.14.0 preview ↔ export parity (P2 scope §5). Phase A, Node, no browser (about 80 s at Draft): for every `recipes.json` case the preview source is baked as the scene bakes it (`16-preview-scene.js sceneSourceNeed` → `worker/m40`), a one-part box scene is evaluated with the JS reference `17-member-field.js` (`sceneFieldMm`) and compared with the single-part export field (`worker/m32`) at 4000 random points, plain and (some cases) rotated / shifted / wall-offset; plus a skin part and 3-member welds (solid + gyroid at 30° + beam or noise) for each join rule against `buildAssemblySDF(specs, k, true)`. Pass: signs agree for ≥ 99.5 % where \|d\| > ½ preview voxel, and \|Δd\| ≤ ½ voxel for ≥ 99 % near the surface. `res` = signs agree and p99 ≤ 1 voxel (tile resolution only, still a pass). The welds use the export's rule outside a part's box; the `[preview rule]` rows use the preview's lower bound, which can differ by design (`diff`, reported, not gated). `QUAL=low\|med` (default draft), `PTS=n`. `GPU=1` adds phase B: the shader's `rm.debugSceneDistances` vs `sceneFieldMm` on the live scene (part, rotated part, weld per join rule; about 2.5 min in SwiftShader). |
| `shapeview.js <build>` | v0.13.0 single-part view on a 50 mm sphere: no shadow rings, each preview quality refines the shape grid while the export grid stays the import one, the selected part's eye (ghost shell / hidden with message / shown), a gyroid in the part drawn solidly. `SHOTS=<dir>` saves the ghost frame. |
| `pinch.js <build>` | v0.13.1 touch gestures in a phone-sized touch browser: pinch out / in zooms within the wheel's limits, two fingers together pan, a second finger landing off the canvas still pinches, lifting one finger keeps rotating without a jump, the canvas has `touch-action: none`. |
| `fieldtest.js <build> <label>` | Loads the worker SDF code in Node; checks preview-vs-export agreement for hyperuniform/RD, RD tile seam, weld hyperuniform tiling. |
| `radtest.js <build>` | Trim-to-nodes strut radius vs measured radius. |
| `loadorder.js <build>` | Static check that no load-time code uses something from a later-numbered file. |
| `grainrng.js <build> [F13LD.grain index.html] [F13LD.lab dir]` | Node, no browser. Grain PRNG is byte-identical to F13LD.grain's (`hu-bake-worker.js` too) and gives the same draws for seeds 0, 1, 42, 12345, 2³¹−1; reaction-diffusion grids match grain's builders exactly; spinodoid/GRF/hyperuniform SDFs agree with F13LD.lab's grain rasterizer on a 32³ grid (inside/outside mismatch %). |
| `foamseeds.js <build> <F13LD.foam index.html> [recipes.json]` | The FoamSeeds generator block is byte-identical in mesh and F13LD.foam; for each foam recipe, regenerated seeds match the embedded positions and the field tiles seamlessly. |
| `viewshot.js <build> <outDir> [case,…] [quality]` | Saves a viewport screenshot per `recipes.json` case, for shader/viewer work. Run once per build and compare. `VIEW='{"shadows":false}'` presets the view menu. |
| `shadesync.js <file-or-folder> …` | The shared F13LD-SHADE (GLSL) and F13LD-VIEW (view menu) blocks are byte-identical in this repo and the other tool checkouts passed in. |

## Notes

- Shape-mode cases report 8 cores (`"cores"` in `recipes.json`) so the worker-pool paths run.
- Imported bodies default to Solid; tests click the recipe chip to assign it before exporting.
- The thin-strut beam case is left out of `recipes.json`, because older builds fail it by design (finding A6).
