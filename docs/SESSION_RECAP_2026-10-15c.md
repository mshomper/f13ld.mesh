# F13LD.mesh — session recap, 2026-10-15 (c) · v0.12.0 UI refresh

**Main:** v0.12.0, merged from `ui-refresh` on 2026-10-16 after Matt's click-test and the fixes below. Mockup: `docs/mockups/mesh-ui-v0.12.html` (v3 is the approved one).

## Matt's decisions
- Layout in line with F13LD.lab / F13LD.sweep: header actions, view strip, dock + Configure drawer, inspector.
- Structure settings are edited beside the view, in the **left rail** under the parts list (not in the drawer — he needs the view while editing). Parts and recipes stay in the left rail.
- Welds: a weld is a card with its own selectable header. Ticking (multi-select) appears **only after a long-press**. Merging two welds keeps the **target's** settings. A weld left with one part shows **"Weld dissolved"**.
- Built in one pass: layout, gap fixes, skin fill, Anchor / Graded join rules.

## What was built (parallel agents, one file set each)
- **Skeleton (lead):** `index.html` regions (`#vstrip`, `#workArea` = `#rail` | `#previewArea` | `#inspector`, `#progRow`, `#dockWrap` > `#drawer` + `#dock`, hidden `#legacyHold` for old containers), `ui12.css` (tokens: Mesh tile #FCEAF5 / stroke #6B0A4C, on-dark accent #E46BB0; grid; phone ≤ 860 px), header actions + ripple status + `meshToast` (`05-ui-chrome.js`), empty state, drawn icons, version 0.12.0.
- **View strip** (`23-view-strip.js`, `viewstrip.css`, `20-raymarcher.js`): Design / Print / Section tabs; section plane X/Y/Z + slider + flip (preview only, cut face tinted); Show joins tint from member `sdfGhost`s (≤ 4 members); skin drawn in the shape-mode shader; overlays restyled.
- **Left rail** (`55-rail.js`, `rail.css`, `31-body-cards.js`, `45-structure-handlers.js`): recipe cards with popover; parts list with weld cards; long-press tick + Weld; drag to join / onto a weld / out to separate; unlink; editor for parts (weld row, fill Solid / Lattice / Lattice + skin, recipe, skin, cell, wall offset, rotation, shift, trim, colour, Remove part with a second-tap confirm) and welds (members, add, fillet, join rule, anchor / grade, show joins, separate all). State helpers `bodyFill`, `setBodyFill`, `setBodySkin`, `weldTogether`, `weldSeparateAll`, `weldSetRule/Anchor/Grade/ShowJoins`. Cell size no longer locked while welded.
- **Dock** (`56-dock.js`, `dock.css`, `51`, `53`, `54`, `60`, `61`, `41`): dock tags, Configure drawer (Part prep, Export), export progress strip with stage / elapsed / Cancel (the centre overlay no longer covers exports), inspector Estimate / Measured (+ time split, print report) / Homogenization. Shape export message carries `fill` / `skinMm`.
- **Geometry** (`worker/m30`, `m32`, `14-weld-bake.js`, `m33`): weld members now use their own rotation, offset, iso, trim (were identity before); skin `min(sh, max(sc, skinMm − sh))`; join rules `union` | `anchor` (lattice clip grown into solids by anchorMm; only changes the part with trim to nodes) | `graded` (iso grows up to gradeMaxMm, default 0.15 × cell, within gradeMm of solids). `tests/weldfill.js` checks identity / transforms / skin / rules.
- **Tests** updated for the new UI (`harness.js` adapter block detects the rail UI; `partprep`, `fixtests`, `fixtests2`, `weldexport`, `measure`, `importtest`, `a6test`, `viewshot`). `regress.html` bench drives both UIs and uses the Mesh colours.

## Checks run here
`harness.js` tpms-gyroid and shape-tpms identical to main; `partprep.js` all pass; `weldfill.js`, `weldtest.js` (draft), `fieldtest.js`, `loadorder.js`, `shadesync.js` pass. Desktop and 390 px screenshots: no console errors, no horizontal scroll. Long and multi-core runs are Matt's (bench page).

## Open
- Touch drag isn't supported on phones (long-press tick + Weld is the phone path).
- Show joins handles up to 4 members; large welds look speckled at the 64³ preview grid.
- Anchor only matters with trim to nodes — revisit with Matt whether to keep it.
- Parallel slab mesher prototypes (scratch only): exact seams work; next is snapping near-corner crossings and a seam-band simplify.

## Click-test fixes (2026-10-16, merged with v0.12.0)
- Status pill shows the full F13LD mark (both waves ripple while busy); the centre loader is the F13LD robot "Centrifuge" from Matt's animation sampler (`05-ui-chrome.js`; reduced motion shows it still). The header status keeps the mark.
- Cell size is a number box only (no slider, no upper bound); wall offset slider −2…+2 mm; shift sliders ± one structural period per axis (`structurePeriodMm`, `45-structure-handlers.js`); number boxes accept any value.
- Larger type everywhere (labels 12 px, values 13 px, hints / buttons 12.5–13 px); quality chips centred.
- Weld visibility: the weld header has its own shown / ghost / hidden button; member eyes work inside welds; welding a hidden part shows it; **everything hidden drops out of export** and no longer stretches the weld box; all-hidden weld or a hidden single part → clear message, empty view.
- Next session: the preview rebuild (`docs/PREVIEW_REBUILD_SPEC.md`), then the parallel slab mesher (appendix of the same spec).
