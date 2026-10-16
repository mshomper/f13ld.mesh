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
- It compares every vertex and triangle bit for bit, shows the times, the speed-up, the split between field / level set / simplify, and how many points came from the field pre-bake. A case that differs also shows the volume change.
- Settings (quality, cores, reference URL, time limit, ticked cases) are remembered in the browser. **Download report** saves the results as Markdown.

## Comparing two builds

Most scripts take two folders: an older build and a newer one. Each is a plain copy of the repo, e.g. a `git worktree` or an exported tag.

| Script | What it checks |
|---|---|
| `harness.js <old> <new> [filter]` | Exports every case in `recipes.json` (all families + shape mode) at Draft from both builds; compares 3MF mesh data byte for byte. Main regression check. `QUAL=med` picks another quality, `CORES=n` sets the core count for cases without one (the field pre-bake needs at least 3, and skips grids under 200 k points, so use `QUAL=med CORES=3` to exercise it), `VERBOSE=1` prints each export report and `[export][field]` line. |
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
| `slabbake.js <build> [N] [slabs]` | v0.13.0, Node, no browser: preview bakes split into z-slabs and stitched equal the one-worker bake bit for bit (field, range, Lipschitz) for every `recipes.json` case, SDF and raw, and a 3-member weld. |
| `previewcache.js <build>` | v0.13.0 preview rebuild P1: switching lattice parts, selecting a solid part and switching inside a weld cause no bake; weld rotation / wall offset re-bake with the view held and the camera kept; a newer preview cancels the older bake; no console errors. `CORES=n` (default 6). |
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
