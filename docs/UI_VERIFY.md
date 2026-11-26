# F13LD.mesh UI refresh: independent verification

Branch `ui-refresh`, HEAD cbcc5ac, baseline main f933dc0. Headless Chrome on the real GPU (D3D11), served over http, one browser at a time. Verifier did not build it. No app code edited.

Verdict: **READY**. No real breakage found. Two failures in the builder's old scripts are script staleness, not app defects (see notes 4, 8 and 10).

| # | Check | Result | Notes |
|---|---|---|---|
| 1 | 0 page errors at 390 / 1024 / 1440: empty, part + gyroid, weld of two parts, Print and Section views | PASS | 9 scenarios, 0 errors. Screenshots `docs/ui-audit/verify-*.png` |
| 2 | No horizontal scroll at 390 / 700 / 1024 / 1440 | PASS | Page and `#ctrlScroll`, all three sections, Print view, empty / part / weld |
| 3 | One section at a time; rail / tab bar sync; Export 3MF in footer; inspector at 1280 | PASS | Real mouse clicks on the rail (1024, 1440) and tab bar (390). Exactly one `.sec` visible, Export 3MF on screen each time. 1440 to 390 and back keeps the section in both widgets. Inspector hidden at 1279, 300 px wide at 1280 |
| 4 | No visible replaced native; widget to app and app to widget | PASS | 0 visible mapped natives, 3 sections, 1440 and 390. Slider, dropdown, segmented, toggle, radio, each both ways. Rail editor remounts after a part switch (7 sliders, 2 segmented, 2 dropdowns). Prep re-render remounts |
| 5 | Transform fold, colour row, help "show" | PASS | Fold opens by click, help show for Rotation opens it. 17 cards sampled at 1440 and 390: 11 or 12 land, 5 to 6 give a note, 0 nothing. Counts: 35 cards, 34 show buttons, 25 (i) |
| 6 | OVERLAP (kit-wave4) | PASS | 0 stolen taps at 390 peek, 390 full, 1440; design, prep, export, Section tab, view menu open |
| 7 | Render | PASS | 0 compiles in a 40-move wall-offset drag (compile counter 2 before, during and after). Interactive frames drawn, one rest frame after release. Idle 1 s: 0 rAF, 0 draws (after load, after drag, after context restore). Strips equal one-pass rest frame. Forced context loss recovers in 0.64 s, `getError` 0 |
| 8 | Results clearing | PASS | Measured: kept through Section / Design, cleared by rotation, refilled by export, cleared by an export quality change. Homogenization (wave recipe with injected numbers): shown, hidden with rotation, shown, hidden with wall offset, shown |
| 9 | One-bar export with Cancel; byte identity vs main | PASS | Running label "meshopt simplify · ~9 s left", Cancel in the dock (44 px), after Cancel the bar drains and Cancel returns to its row (1440 and 390). `tests/harness.js` CORES=4, Draft, open cube vs main f933dc0 (git archive): tpms-gyroid-sheet, noise-simplex-sheet, noise-ridged-half, grain-spinodoid, grain-hyperuniform, bundle-twist, bundle-warped (warp_mode 1): 7/7 identical tris and verts. Harness copy in scratch only, launched on the GPU |
| 10 | No-WebGL fallback | PASS | 0 widgets, native fold button opens the fold, rotation and wall offset boxes drive the app, Export 3MF, quality, mesher, process select, section axis, view menu checkboxes all visible and working, 0 page errors |
| 11 | `node tests/loadorder.js .` with acorn from AcuLoad | PASS | main 52 files, worker 20 files, 0 forward refs |

## Notes

- Check 4, 5, 6, 9 (bar) and the context-loss, strips and Measured parts of 7 and 8 reused the builder's scratch scripts (`mesh-kit5-*`, `mesh-s4-checks`) against HEAD. Checks 1, 2, 3, the drag / idle / sharpen part of 7, Homogenization, no-WebGL and the export identity run are my own scripts (`mesh-verify-*`).
- `mesh-s4-checks.js` reports FAIL on Homogenization: it uses a TPMS recipe, and TPMS summaries never render the homogenization block (known, logged in stage 4). With a wave recipe it passes.
- The older `mesh-s3-nogl.js` times out filling the rotation box: the Transform fold is closed by default since the compact-panel change and the script never opens it. Script is stale. My version opens the fold first and passes.
- Print view with a weld shows the Estimate and Measured cards on the right at 1440; layout reads fine in `verify-1440-weld-print.png`.

## Not covered

- Reduce Motion, stall stress (injected main-thread stalls), field view of every widget mid-motion.
- Repo preview tests (`livesliders`, `previewparity`, `previewcache`, `weldvis`, `shapeview`, `slabbake`); the weak-GPU fallback (off under automation); feel on Matt's CPU.
- Shape-mode and weld exports against main; Medium and finer quality (only Draft, open cube).
- OVERLAP with the weld editor open; compile count on sliders other than wall offset.
- Help (i) count and 44 px target sizes were not re-measured against main (Matt: no nitpicking).
- Content of the inspector cards inside Prep / Export at 1279 and below was not inspected beyond the inspector being hidden.
