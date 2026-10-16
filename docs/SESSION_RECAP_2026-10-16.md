# F13LD.mesh — session recap, 2026-10-16 · v0.13.0 preview rebuild P1

**Branch:** `preview-rebuild` (not merged; Matt click-tests first). Spec: `docs/PREVIEW_REBUILD_SPEC.md`, phase P1 (caches and no distortion).

## Matt's decisions
- Slider response: as instant as possible; some delay is acceptable for noise / grain.
- Preview cache per session only (no IndexedDB). Interested in what WebGPU's newer architecture could improve across the tool, so P2's scene shader is laid out so its field sources and per-part data can move to WebGPU later (P5).
- Lower detail for the members of a big weld that aren't being edited: fine, but only as a weak-GPU / phone fallback; left out unless the phone test needs it.
- Approved starting P1.

## What was built
- **Preview bake workers** (`worker/preview-bake-worker.js`, `worker/m40-preview-bake.js`): the bake handler moved out of `m90` into `m40`, shared by the mesh worker and a new light worker that loads only the SDF families (no Manifold / meshoptimizer download and compile per bake).
- **Pool, split, cancel** (`42-preview-bake.js`): workers kept warm between bakes (three started at load, up to cores − 1), every bake big enough is split into z-slabs — SDF bakes now too, welds always — and stitched on the main thread (`_bakeSdfLipschitz` is a copy of `m40 bakeSdfLipschitz`). `cancelPreviewBakes()` terminates the workers of every running bake; `triggerPreview` calls it first. Weld member shape grids are sent to each worker once and then referred to by id (`keepGrids`).
- **Baked-field cache** (`42`): results keyed by recipe content, grid size, bake options and member grid ids (`previewBakeKey`, `previewBakeLookup`), LRU 32 entries / 256 MB. A raw (noise / grain) bake's key leaves out the recipe's cached preview range, which it measures itself. `F13LD_previewBake.stats()` / `.workers()` for tests.
- **Raymarcher** (`20-raymarcher.js`): shape, ghost and join textures cached per grid object (`_texForGrid`, freed by `pruneGridTextures` from `syncGhostsToRaymarcher`); keyed field textures (`useField`, LRU 12); `setScaffoldField` writes to scratch textures that no snapshot draws; `holdView` / `releaseView` / `isHeld` — the last drawn scene is captured after every frame and drawn while held, with the live camera rescaled to the held view box (20 s safety release).
- **Trigger** (`44-preview-trigger.js`): the view is held from the start of a preview; assembly mode, world box, view fit and field are committed together when the field lands; a cache hit commits in the same tick with no overlay ("preview · cached"). A standalone solid part doesn't bake. `previewSettle()` when a change needs no preview.
- **Call sites:** `switchActiveBody` holds, keeps the camera (`preserveCamera`), and settles when nothing previews; welds preview even with a solid member selected. Holds before the debounced re-bakes (rail cell size, visibility in a weld, `railPreviewSoon`). In a weld, rotation / shift / wall offset now re-bake (`_scheduleStructXformRebake`); a standalone aperiodic part keeps its live uniform preview during the re-bake (`{hold:false}`). The legacy cell input goes through `railSetCellMm`, so noise / grain re-bake by themselves; the "outdated" banner on cell size is gone.

## Checks run here
- `tests/slabbake.js` (new, Node): split vs one-worker bakes bit-identical — field, range and Lipschitz — for all 23 `recipes.json` cases (SDF and raw) and a solid + gyroid + beam weld.
- `tests/previewcache.js` (new, browser): switching lattice parts, selecting a solid part and switching inside a weld cause no bake; weld rotation and wall offset re-bake with the view held and the camera kept; a newer preview cancels the older bake; no console errors.
- `tests/loadorder.js`: no forward references.
- `tests/harness.js` main vs branch: all 23 exports byte-identical. `tests/fixtests2.js`: all pass (stale preview range, out-of-order previews, camera on add, structure settings, preview quality). `tests/partprep.js`: all pass. `tests/viewshot.js`: cube, shape and grain previews render.

## Open / next
- P2 (scene shader with per-member uniforms, tile and region sources, all sliders live in welds) is next; then P3 (exact GLSL sources), P4 (speed), then the parallel slab mesher.
- Bench page has no preview tab yet (P4).
