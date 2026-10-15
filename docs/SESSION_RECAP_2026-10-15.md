# F13LD.mesh — session recap, 2026-10-15 · v0.10.0 part prep

**Main:** v0.10.0, merged from `part-prep` after Matt's click-test (part prep, compact sidebar, standoff, shadow banding fix).

## Why
Matt wanted part-preparation numbers typical of 3D-print prep (weight, % volume filled, support areas). Proposal approved with these decisions:

- All print processes, with a process picker.
- Build direction rotates the exported geometry (build direction is +Z).
- Reuse F13LD.lab's material library.
- "% volume filled" for shape-clipped parts is measured against the shape's volume.
- Phases 1 (part stats) and 2 (orientation + overhangs) ship together.

## What shipped (v0.10.0)
- `52-materials.js` — `PP_PROCESSES` (LPBF, EB-PBF, polymer powder bed, resin vat, FFF; default overhang limit 45° / 45° / none / 30° / 45°) and `PP_MATERIALS`: the 44 Lab materials with a density (Lab `15c-materials.js` v0.7.2; Ti-24Nb-4Zr-8Sn left out, no density). No resins in the library yet → custom density.
- `53-part-prep.js` — panel above the export controls (`partPrepPanel()` from `exportPanel()`), settings remembered per browser (`localStorage f13ld.mesh.partPrep.v1`, print view not remembered).
  - **Live estimate** (`ppEstimate`): mirrors the viewer's `implicit()` on the baked preview field — 64³ samples over the export cube, or 56³ over the shape bbox counted against the shape SDF. Volume = fraction × cube volume or × exact shape-mesh volume. Weld groups: size only.
  - **Exact stats** (`ppComputeStats`, after every export path): signed-tetra volume, area, oriented size, separate pieces (union-find), downward-face area in 15° tilt bands, area needing support (tilt below the limit), projected support footprint, plate-contact area (faces facing down within 30° and within max(0.02, 0.6·edge) mm of the lowest point).
  - **Orientation** (`ppOrientForExport`): R = Ry(tiltY)·Rx(tiltX)·Rup. At +Z / no tilt the vertex buffer is passed through untouched (byte-identical 3MF). Otherwise vertices are rotated about the bbox centre, centred in X/Y and dropped to Z = 0; filename gets `_upX` / `_upnegY` / `_tilt…`.
  - **Print report**: Markdown download from the measured block.
- `20-raymarcher.js` — `setPrintView(cfg, snap)`: uploads Rᵀ·rot so the camera orbits the print frame; gridded build plate (`plateLayer`), tint on hit (jade = on plate, red = below the limit, amber = within 10° above it). Snap = Z-up ¾ view, zoom ≥ 4.6 × viewH. `_fieldData` kept for the estimate; estimate refreshed after each bake and structure-transform change.
- `61-export.js` — weld, solid and lattice paths call `ppOrientForExport` before `buildMinimal3MF` and `ppAfterExport` after the download.
- `F13LD_MESH_VERSION` and header label 0.10.0.

## Sidebar + click-test follow-ups (same branch)
- `54-sidebar.js` — `sidebarEnhance(summaryEl)` after every summary render (10-state ×2, 70-view-state). The recipe title + settings cards become one small card in the family colour with a one-line summary (first four settings with a value; numbers carry their label). Hover (mouse) or tap (touch) opens the full settings as a key/value list in a fixed card beside the sidebar, kept inside the window. Every `hr.div + sec-lbl` section becomes a collapsible group (drawn chevron, state in `localStorage f13ld.mesh.sidebar.v1`); Homogenization and Measured start collapsed. Collapsed Estimate / Measured show a one-line readout (`sidebarPeek`). Builders unchanged — DOM is rearranged, ids and handlers kept.
- Part prep split into three groups: part prep, estimate · from preview, measured · exported part.
- Plate opacity slider (print view on), 0–100 %, default 90 %, remembered (`uPlateAlpha`).
- Standoff from the plate (mm, default 0, processes with supports only). Analysis and view only — the export is never lifted (Matt's call). With a standoff nothing counts as on the plate: the lowest downward faces count as needing support, the plate in print view drops by the standoff (`uLifted` turns off the on-plate tint), build height and the report include it.

## Checks
- `tests/harness.js` old (v0.9.10) vs new: all 23 cases byte-identical (default orientation).
- `tests/partprep.js` (new): cube gyroid estimate 19.13 % vs measured 19.05 %; panel volume and area equal an independent read of the 3MF; 50 × 14 × 6 box solid fill: 4,192 mm³ (−0.2 %), plate 692 mm²; part +X up → 6 × 14 × 50 on Z = 0; 35° tilt puts the 700 mm² bottom face in the 30–45° band as needing support; solid body exact 4,200 mm³ / 2,168 mm² and −Y up → 50 × 6 × 14; PA12 mass; report downloads.
- `tests/loadorder.js`: no forward references.
- Standoff 3 mm on the box: export identical to no standoff, plate contact 0, bottom face 694 mm² needs support.
- Shadow banding on bounding-shape surfaces (pre-existing on main): shadow/occlusion rays started one lattice-voxel off the surface, but the shape SDF grid is coarser (64 steps across the longest side), so the ray hit its own interpolated surface and striped it. Fix in `20-raymarcher.js`: `uShapeEps` = shape grid step in world units; on hits where the shape is the surface (solid mode, or shape ≥ scaffold) `f13Shade` gets eps = max(uNrmStep, uShapeEps). Lattice surfaces keep uNrmStep; the shared F13LD-SHADE block is untouched. Viewshots: open cube and lattice surfaces unchanged; solid box and shape cut faces lose the stripes. Harness shape + TPMS cases byte-identical.

- `SIDEBAR=<dir> node tests/partprep.js <build>`: foam, TPMS and beam sidebars have no sideways overflow, details card opens on hover inside the window, groups collapse, Measured readout after export.

## Open / next
- Phase 3: islands (layer-by-layer unsupported starts) and support volume with a ray cast to the part below (three-mesh-bvh is loaded).
- Phase 4: trapped powder / resin (void flood fill), cross-section area vs Z, powder-removal channel check, 3MF metadata.
- Weld-group "volume filled" is not reported (members can overlap); volume and mass are.
- Lab materials: copy changes from Lab `15c-materials.js` into `52-materials.js` by hand.
