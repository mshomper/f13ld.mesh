# F13LD.mesh — session recap, 2026-10-16 · v0.13.0 preview rebuild P1

**Main:** v0.13.0, merged from `preview-rebuild` on 2026-10-16 after Matt's click-tests (weld visibility and single-part view fixes below). Spec: `docs/PREVIEW_REBUILD_SPEC.md`, phase P1 (caches and no distortion).

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

## Weld visibility fixes (after Matt's click-test, same day)
Matt: P1 good, but weld groups still had visibility problems; check before merging. Traced 15 eye steps on main and the branch (same behaviour — all from v0.12.0) and approved fixes A–E; per-quality grid cap fine; a ghosted part's fillet disappearing from view while ghosted is acceptable.
- **A · step size** (`20-raymarcher.js`): in weld mode the shape's Lipschitz (10 / cell) no longer caps the step — the union field is in world units with its own Lipschitz. Rays used to run out of steps before the thin walls, so welds looked faint and speckled at Draft / Low.
- **B · finer weld bake** (`44 weldPreviewN`): about 8 voxels across the finest lattice cell in the weld, never below the quality's single-cell size, capped Draft 96 / Low 128 / Med 160 / High 192 / Ultra 256, a multiple of 4. Weld fields are stored at 16-bit (`useField(…, {hi16})`, R16F, clamped); single parts keep their tiled 8-bit field. Uploads use `UNPACK_ALIGNMENT 1`.
- **C · hidden weld**: hiding every member re-previews (`_visibilityChanged`) to the empty view with "Every part in this weld is hidden"; it used to keep showing the weld.
- **D · ghosts in the selected weld**: ghosted members (the selected one too, and a ghosted weld) leave the preview union and draw as translucent shells; export still includes them. The selected part's eye is no longer muted inside a weld.
- **E**: the empty weld view commits the weld's box; a selected solid part commits a neutral box.
- `tests/weldvis.js` (new) checks every step. Re-run after the fixes: `weldvis`, `previewcache`, `slabbake`, `loadorder`, `fixtests2` all pass; `harness.js` main vs branch, all 23 exports byte-identical.

## Single-part view fixes (Matt's second click-test, same day)
Matt: selected parts didn't hide; changing quality didn't sharpen a part; banding rings on a sphere. All three were already on main. Approved all fixes; wants finer shape grids at High / Ultra; accepts the lighter, even solid shading (the old darkening was the bug).
- **Hiding the selected part** (`10-state.js` `syncGhostsToRaymarcher` → `rm.setActiveVis`): hidden isn't drawn ("This part is hidden"), ghosted draws as a translucent shell; its eye is no longer greyed out. Export already refused a hidden part.
- **Per-quality shape grids** (new `15-shape-preview-grids.js`): Draft 96 / Low 128 / Med 192 / High 224 / Ultra 256 (capped by the GPU's 3D texture size), baked in the background on the shape-SDF pool, newest request first, "refining shape" in the pill; weld members up to 160. Kept in `body.previewGrids`, separate from `body.sdfGrid`, which export reads — so 3MF output doesn't depend on preview quality. LRU budget 512 MB, the selected part and its weld kept. A quality click now also sets the ray steps for a solid part (it returned before `setQuality`).
- **Rings** (`20-raymarcher.js` `sampleShape`): outside the part's box the distance was the distance to the box, so shadow rays leaving near a box face saw a near hit and drew rings. Now `max(box distance, grid value at the box − box distance)`, still a lower bound.
- **Step size**: the shape SDF is Lipschitz 1 in world units; the old 10 / cell bound (from before `sampleShape` was scaled) shortened steps 3–7×. Solid part: 1; lattice in a part: max(lattice, 1); weld: the union's. Lattices inside parts no longer look dark and pitted; occlusion no longer over-darkens solids.
- `tests/shapeview.js` (new): rings, grid per quality with the export grid untouched, the selected part's eye, a gyroid in the sphere drawn solidly. Full re-run: `shapeview`, `weldvis`, `previewcache`, `slabbake`, `loadorder`, `partprep`, `fixtests2` all pass; `harness.js` main vs branch, all 23 exports byte-identical.

## v0.13.1 · pinch to zoom (afternoon)
Matt: pinch to zoom didn't work in the mobile browser. Approved: pinch zooms about the centre of the view, like the wheel (not toward the fingers).
- `21-gimbal.js`: two fingers zoom by their spread (same limits as the wheel) and pan by their midpoint together; lifting one finger carries on rotating from the other; a second finger landing just off the canvas joins the gesture; `touchcancel` ends it; `preventDefault` only on cancelable events.
- `ui12.css`: `#rmCanvas{touch-action:none}` so the browser doesn't zoom the page from the view.
- `tests/pinch.js` (new) passes.

## Open / next
- P2 (scene shader with per-member uniforms, tile and region sources, all sliders live in welds) is next; then P3 (exact GLSL sources), P4 (speed), then the parallel slab mesher.
- Bench page has no preview tab yet (P4).
