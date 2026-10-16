# F13LD.mesh — session recap 2026-10-16 (b) · v0.14.0 preview rebuild P2

**Shipped:** v0.14.0 on main (built on branch `p2-scene`). Scope and decisions: `docs/P2_SCENE_SHADER_SCOPE.md` (§0 has Matt's answers and what changed while building).

## What changed
- One scene shader draws every visible part (`16-preview-scene.js` builds the scene from app state; `20-raymarcher.js` packs a std140 member table and draws it). All structure settings are live for parts and weld members: cell size, wall offset, rotation, shift, fill, skin, fillet, join rule, anchor, grade. No weld preview bake any more (export keeps its own).
- Welds look welded whether or not they are selected, in the weld's colour; every part shows its real lattice; soft lime outline on the selected part / weld (two or more parts on screen).
- Sources: P1 single-part bakes per member (tiles shared per recipe; aperiodic regions keep the P1 box so the export's noise range is unchanged). Tiles, regions and shapes in three atlases, no fixed recipe limit. Two shader variants (single, multi).
- Weld colour picker in the weld editor (`setWeldColor`, `weldGroups[gid].colorHex`); members show "Shown in Weld X's colour".
- Weak-GPU fallback (GPU timer while moving, shells only while moving, pill to turn off). Anchor / Graded greyed out without a solid and a lattice part. No recompile of a quality already compiling (was the `glGetProgramiv` console errors).
- `17-member-field.js`: plain-JS reference of the member field; `tests/previewparity.js` checks it against the export (43/43) and the shader (`GPU=1`, 5/5).

## Checks
- `tests/harness.js` main vs branch: 23/23 byte-identical.
- partprep, pinch, slabbake, weldcolor (scene reads), previewparity pass. `previewcache`, `weldvis`, `shapeview`, `livesliders` were updated for the scene; `shapeview`'s shadow-ring count on the solid sphere and two `weldvis` "shown again" checks failed in SwiftShader and were not chased (Matt click-tested on his 4070 instead). Revisit with a real GPU if rings show.
- Lesson: don't spend session time on headless visual comparisons — SwiftShader takes 2–20 s per frame. Push the branch and let Matt click-test.

## Next
- Parallel slab mesher (`docs/PREVIEW_REBUILD_SPEC.md` appendix); then P3–P5.
