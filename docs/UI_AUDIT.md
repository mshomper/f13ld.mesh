# F13LD.mesh — UI audit (stage 1, wave 2)

Branch `ui-refresh` from `main` f933dc0 (v0.16.6), 2026-11-26. Read-only: no app code changed.
Screenshots: `docs/ui-audit/` (Playwright, local Chrome, swiftshader, DPR 1). Scene: TPMS gyroid recipe, one `cyl20.stl` part filled with it, then a second `cyl20` (solid) welded to it.

| File | What |
|---|---|
| `desktop-empty.png` | 1440×900, no recipe (drop zone) |
| `desktop-recipe.png` | recipe loaded, open cube |
| `desktop-part.png` | one part, lattice fill, part editor in the rail |
| `desktop-rail-end.png` | rail scrolled to the end of the part editor (rotation, shift, colour) |
| `desktop-viewmenu.png` | view menu open |
| `desktop-section.png` | Section tab: cut plane controls bottom-right |
| `desktop-drawer-prep.png`, `desktop-drawer-export.png` | Configure drawer, Part prep and Export tabs |
| `desktop-weld.png`, `desktop-weld-editor.png` | weld card and weld editor (fillet, join rule, show joins, hue strip) |
| `w1024.png`, `w700.png` | breakpoint checks |
| `phone.png`, `phone-full.png`, `phone-editor.png` | 390×844: viewport first, page scrolls to the rail |
| `phone-drawer.png`, `phone-drawer-export.png` | drawer as a sheet |

## 1. Current state

- **Version:** v0.16.6 (`01-config.js`, header label). Multi-file app: `index.html` + 38 numbered classic scripts + `families/` + `loaders/` + `worker/`. No help drop-in, no queue client, no liquid-ui.
- **Layout (v0.12.0, Lab / Sweep pattern):**
  - Header: Open recipe, Add part, status mark, version, tool icon.
  - View strip (`23-view-strip.js`): Design / Print / Section tabs; on the right, PREVIEW Draft/Low/Med/High/Ultra and the view menu (`22-view-opts.js`).
  - Work area: left rail (`55-rail.js`: Recipes card, Parts card with weld cards, editor for the selected part or weld), viewport (`#previewArea`), right inspector (`56-dock.js`: Estimate, Measured, Homogenization).
  - Dock (`56-dock.js`): Configure (opens a drawer with Part prep / Export tabs), four summary tags, estimate line, Export 3MF. A progress strip with Cancel sits above it during an export.
  - Old containers stay hidden in `#legacyHold` (cell size, trim, structure transform inputs). The rail drives them through `45-structure-handlers.js` (`railSetCellMm`, `railSetXform`, `railSetTrim`).
  - Phone (< 860 px): one column, viewport on top, the page scrolls down to the rail, the dock stays at the bottom, the drawer opens as a sheet over the viewport.
- **Built at runtime, mostly by `innerHTML`:** view strip tabs and cut panel (load), rail cards (every `renderRail`), part / weld editor (`renderRailEditor`, rebuilt when its key changes, otherwise values refreshed in place by `rlEdSync`), dock + drawer + inspector (`dockEnsure`, first summary render), part prep (`ppBox`, re-rendered on every change), "Simplified while moving" pill (`16-preview-scene.js`).
- **Preview:** one scene shader for every visible part (v0.14.0), std140 member table + three atlases. Bakes run in warm workers, split into z-slabs, keyed, cancelled and cached (v0.13.0). `holdView` keeps the last correct frame while a source bakes.
- **Export:** the 3MF, plus a Markdown print report. No recipe JSON export, so no round-trip recipe import (the header Open recipe and file drop are the inputs).

**Runtime (Playwright, one browser):**

| | 1440 | 1024 | 700 | 390 |
|---|---|---|---|---|
| Horizontal scroll (page / rail / editor / drawer / inspector / dock) | 0 | 0 | 0 | 0 |
| Viewport size (part loaded) | 808×725 | 392×725 | 680×504 | 370×473 |
| Visible text < 11 px | 2–3 (`.rl-use`, `.rl-mini` 10.5 px) | 3 | 3 | 3 |
| Visible controls < 44 px (part / drawer open / weld) | 51 / 66 / 46 | 46 | 42 | 42 |
| Help (i) | 0 (no help system) | 0 | 0 | 0 |
| Page errors | 0 | 0 | 0 | 0 |

One console 404 (a missing static resource, not a script). DOM counts with one part and the drawer open: 6 `<select>` (+1 per editor dropdown), 8 ranges, 6 checkboxes (5 view menu + hidden `#trimToNodes`), 22 number fields (9 of them hidden legacy), 2 file inputs, 60 buttons, 2–4 `role=button` cards, 1 `role=slider` (hue strip).

## 2. Findings

Severity: H = blocks the standard or gives wrong output, M = visible defect / rule break, L = polish.

| # | Issue | Where | Sev | Rule |
|---|---|---|---|---|
| F1 | No liquid widgets: native ranges + number boxes, native selects, pill buttons | `55-rail.js` 340–360, `56-dock.js` 95–110, `53-part-prep.js` 408–430 | H | Goal: controls; lesson 5 |
| F2 | Three control places at once (rail, drawer, dock tags) plus the inspector. The Configure drawer covers the lower half of the viewport and the rail editor on desktop, and the whole viewport on phone | `56-dock.js` 70–112; `desktop-drawer-prep.png`, `phone-drawer.png` | H | One focus per screen; lesson 6 |
| F3 | Manual PREVIEW Draft/Low/Med/High/Ultra (5 buttons). Each tier is a different march step count baked into the shader (128…2048 → a recompile per tier), bake grid (48…192³), shape grid (96…256³) and oversample | `index.html` 82–88, `70-view-state.js` 117–121, `20-raymarcher.js` 555, `42-preview-bake.js` 254, `15-shape-preview-grids.js` 22 | H | Matt: render quality automatic |
| F4 | Measured (last export) and the print report are never cleared. After any edit they still describe the old part. The recipe's Homogenization card stays after rotation or wall offset change the part | `53-part-prep.js` 48, 262; `54-sidebar.js` | H | Matt: clear analysis results when the design changes |
| F5 | No help system: 0 (i), no cards. Long explanations live in visible hint paragraphs (Mesher, Loose pieces, Standoff) or in a `title` tooltip that touch can't reach (Simplify) | `56-dock.js` 101–110 | M | Matt: add missing help cards; lesson 7; chunking |
| F6 | At 1024 the viewport shrinks to 392 px between a 300 px rail and a 290 px inspector | `ui12.css` grid; `w1024.png` | M | One focus per screen |
| F7 | Phone: the page scrolls; the rail sits under the viewport, so editing a slider scrolls the view off screen. No bottom sheet, no section bar | `ui12.css` phone block; `phone-full.png` | M | Phone sheet pattern; lesson 6 |
| F8 | Targets < 44 px: header actions 29 px, view tabs 32, preview buttons 24, view button 27, rail icon buttons 20–24, tick boxes, quality chips, up-axis chips, number boxes ~30 | rail.css, viewstrip.css, dock.css | M | 44 px hit areas |
| F9 | Text 10.5 px: recipe use count (`.rl-use`), mini labels (`.rl-mini`) | rail.css | L | Type scale 11 / 13 / 15 / 20 / 28 |
| F10 | Hex colours, no OKLCH tokens (`--mesh:#E46BB0`, `--s1..3`, `--t1..3`); `--t3:#5f6582` used for labels is below 4.5:1 on `--s2`; inline hex in JS (`#scSimplified`, section axis buttons, gimbal) | `ui12.css` 10–18, `16-preview-scene.js` 318, `23-view-strip.js` 99–101 | M | OKLCH tokens; contrast |
| F11 | Print view has two controls: the Print tab and the Part prep "Print view" button (kept in sync by `rm.onViewChange`) | `53-part-prep.js` 428, `23-view-strip.js` 76 | L | Fewer choices |
| F12 | Section flip shows no state (an icon button, no pressed look) | `23-view-strip.js` 104 | L | Forgiving input |
| F13 | Dead UI: `setStale()` is never called, so the stale banner and its "Update preview" button never show. `#cancelMeshBtn` duplicates the progress strip's Cancel | `70-view-state.js` 12, `index.html` 128, 162 | L | Housekeeping |
| F14 | Domain size is shown with "Not used while a bounding shape is loaded" instead of hiding when a part exists | `56-dock.js` 98 | L | Contextual controls |
| F15 | Render loop: `requestAnimationFrame` runs forever (draws only when dirty); two 250 ms `setInterval` polls (`23-view-strip.js` join / fill signatures, plus `16-preview-scene.js` only with `?debug=1`) | `20-raymarcher.js` 1207–1229, `23-view-strip.js` 196 | M | Lesson 2: loop sleeps; CPU |
| F16 | No adaptive interactive scale and no strip rest frame. Moving frames only drop shadows (`uF13Interact`) | `20-raymarcher.js` 1125, `19-f13-shade.js` 37 | M | render-quality.md §2–3 |
| F17 | The "Simplified while moving" pill is a manual render-quality switch | `16-preview-scene.js` 311–321 | L | Matt: no manual quality controls |
| F18 | Page title "F13LD.mesh — Scaffold Exporter"; `Exo 2` header font is never loaded (no `@font-face` / link) | `index.html` 6, `ui12.css` 19 | L | Wording, type |

## 3. How the template maps onto mesh's layout

Mesh already has most of the standard's parts. Keep them; change only the hosts.

| Template | Mesh today | Proposal |
|---|---|---|
| `#viewPane` with viewer overlays | `#previewArea` + view strip above it | Keep. View strip becomes a viewer overlay row: Design / Print / Section (segmented) top-left, view menu top-right. PREVIEW buttons go (F3). Cut controls stay bottom-right in Section |
| `#ctrlPane` with `#sectionsRail` + one `.sec` at a time | Left `#rail` (lists + editor) + Configure drawer (two tabs) | The left rail **is** the control pane. Keep it on the left (same as Lab and Sweep). Widen to `--pane-w` (400–440 px), add the section rail (56 px icons) on its outer edge. Drawer panes move in as sections; the drawer and the Configure button go |
| Analyze section with results | Right `#inspector` | Desktop ≥ 1280: keep the inspector (read-only results beside the view). Below 1280 and on phone: its cards move into the Export section's Results group |
| Run button (progress) | Dock Export 3MF + progress strip | Keep Export 3MF always reachable: a footer bar at the bottom of the control pane (estimate line + Export 3MF progress button + Cancel). Dock tags go (the section rail replaces them) |
| Phone bottom sheet + `#sectionsBar` | Page scroll + drawer sheet | Viewer on top, control pane as the sheet (peek 45 dvh / full 88 dvh), tab bar Design / Prep / Export, Export 3MF in the sheet footer |
| `layout.js`, `F13UI` | none | Add as numbered files (§10) |
| Recipe menu | Open recipe, Add part | Not a design tool: keep the two header actions. No Recipe menu, no recipe import |

What stays as is: rail cards and their drag-and-drop, long-press tick and selection bar, weld cards, editor cache keys and in-place sync, the hue strip, the inspector cards, the progress strip logic, the gimbal, pinch / rotate, scene shader and bake pipeline, export pipeline.

## 4. Proposed section map

Three sections, in workflow order. Icons drawn (kit `cell`, plus mesh's own `plate` and `export` icons from `56-dock.js`).

| Section (icon) | Group | Controls |
|---|---|---|
| **01 Design** (part) | Recipes | recipe cards (details popover, Use on part), Add recipe |
| | Parts | part rows / weld cards (tick, eye, take out), selection bar (Weld, Clear), Add part |
| | Editor: part | weld with / Edit weld / Leave, Fill, Recipe, Skin, Cell size, Wall offset, Rotation X Y Z, Shift X Y Z, Reset, Trim to nodes + inset, Viewport colour, Remove part |
| | Editor: weld | parts in weld, add part or weld, Fillet, Join rule, Anchor depth / Grade over, Show joins, Viewport colour, Separate all |
| **02 Prep** (plate) | Process | Process, Material, density (custom) |
| | Orientation | Part axis up, Tilt X, Tilt Y |
| | Supports | Overhang limit, Standoff (support processes only) |
| | Plate | plate opacity (only in the Print view) |
| | Estimate (phone / < 1280) | Estimate card |
| **03 Export** (export) | Mesh | Quality, Domain size (open cube only), Mesher, Loose pieces, Simplify |
| | File | file name, cores note, estimate |
| | Results (phone / < 1280) | Measured (+ print report), Homogenization |

Footer (all sections): estimate line, Export 3MF, progress + Cancel while running.
Viewer overlays: Design / Print / Section, view menu, cut plane (Section only), type badge, chips, gimbal.
Header: Open recipe, Add part, status mark, help trigger (new), version, tool icon.
Badges: Export gets the results badge after an export; it clears with the results (F4).

Why the editor stays inside Design and isn't its own section: pick a part, then tweak it, is the core loop. A separate Edit section adds a switch per part, and the rail already puts the editor under the list "so the view stays clear". Design scrolls only when the editor is long (rotation + shift + colour); the cards fold.

## 5. Control → widget map

Sources: every `<select`, `type="range"`, `type="checkbox"`, `type="number"`, `<button`, `role=` in `index.html` and the JS builders (`23`, `16`, `22`, `53`, `55`, `56`), checked against the runtime DOM counts in §1. Repeated rows (one per recipe, part, weld) count once.

**Totals: 135 controls.**
- Widgets: 19 sliders, 8 dropdowns, 7 segmented (26 buttons), 1 radio (3 buttons), 8 toggles, 1 progress button, 2 drawer tabs → sections. That is 67 controls on widgets.
- Removed: 9.
- Native (restyled to tokens, 44 px hit areas, reason given): 47.
- Hidden legacy state inputs: 12.

### Header, drop zone, files

| # | Control | Type | Widget | Notes |
|---|---|---|---|---|
| 1 | `#hdrOpenRecipe` | button | native | Header action; 44 px, icon-only on phone (as now) |
| 2 | `#hdrAddPart` | button | native | As above |
| 3 | `#dropzone` / `#pickBtn` | clickable div | native | Empty-state file target |
| 4 | `#fileInput` | file | native, hidden | Clicked by 1 and 3 |
| 5 | `#shapeInput` | file | native, hidden | Clicked by 2 and the rail's Add part |

### View strip and viewer

| # | Control | Type | Widget | Notes |
|---|---|---|---|---|
| 6–8 | `.vtab` Design / Print / Section | tab buttons | `segmented` sm (one widget) | Clicks the native tabs (`setView`); `syncOn:['class','aria-selected']` |
| 9–13 | `#btnDraft` … `#btnUltra` | buttons | **removed** | F3. Quality becomes fixed (§7). `setBtns` / `setActivBtn` already null-check |
| 14 | `#viewOptsBtn` | button | native, restyled | Drawn eye icon already |
| 15–19 | `#viewOptsPanel input[data-vo]` ×5 | checkbox | `toggle` sm ×5 | Not the shared F13LD-VIEW block, so `viewMenu:true` won't find it: list them in `CONFIG.switches` style or a small mesh mount (`rm.setViewOption` stays the handler) |
| 20 | `#viewOptsReset` | button | native | Writes `.checked` via `sync()`: needs a `checked` mirror on the 5 boxes |
| 21–23 | `#secAxis` X / Y / Z | button group | `radio` sm (`CONFIG.clip`) | `get:()=>sec.axis`, `set:` clicks the native; no "none" (the Section tab is the off) |
| 24 | `#secPos` | range −100…100 | `slider` compact | Format the mm readout (`#secRead`) as the value |
| 25 | `#secFlip` | button | `toggle` sm | F12; stage 2 adds `aria-pressed` from `sec.flip` |
| 26 | `#scSimplified` | button | **removed** | F17; the shell fallback stays automatic |
| 27 | `#staleRefreshBtn` | button | **removed** | F13, dead (`setStale` has no callers) |
| 28 | `#cancelMeshBtn` | button | **removed** | F13, duplicate of `#pgCancel`; keep `showCancelBtn` tolerant |

### Rail: recipes and parts

| # | Control | Type | Widget | Notes |
|---|---|---|---|---|
| 29 | `.rl-rc` recipe card | `role=button`, draggable | native | Card + drag source + popover; no kit equivalent |
| 30 | `.rl-rx` remove recipe | button | native | 20 px today → 44 px hit |
| 31 | `.rl-add[data-act=addRecipe]` | button | native | |
| 32 | `.rl-fold[data-card=rec]` | button | native | |
| 33 | `#rlPop .rl-pop-use` | button | native, accent | Popover action |
| 34 | `.rl-part` row | `role=button`, draggable | native | Select / drag / long-press tick |
| 35 | `.rl-ck` tick (part and weld) | button | native | Only in tick mode; a check, not an on/off setting |
| 36 | `[data-act=vis]` eye (part and weld) | button | native | Three-state cycle (solid / ghost / hidden); no kit cycle widget |
| 37 | `[data-act=leave]` | button | native | |
| 38 | `.rl-whead` weld header | `role=button` | native | |
| 39 | `[data-act=foldWeld]` | button | native | |
| 40 | selection bar Weld | button | native, accent | |
| 41 | selection bar Clear | button | native | |
| 42 | `[data-act=dismissErr]` | button | native | |
| 43 | `.rl-add[data-act=addPart]` | button | native | Also a drop target |
| 44 | `.rl-fold[data-card=parts]` | button | native | |

### Rail: part editor (`rlEdPart`)

| # | Control | Type | Widget | Notes |
|---|---|---|---|---|
| 45 | `select[data-sel=weldWith]` | select | `dropdown` compact | Action menu (resets to ""); rebuilt each render |
| 46 | `[data-act=goWeld]` | button | native | |
| 47 | `[data-act=leaveMe]` | button | native | |
| 48 | Fill Solid / Lattice / Lattice + skin | button group | `segmented` | Disabled items without recipes |
| 49 | `select[data-sel=recipe]` | select | `dropdown` | |
| 50 | `input[type=range][data-k=skin]` (+ `.rl-num`) | range 0.1–2 | `slider` | Keep the `.rl-num` box in the DOM (tests fill it); the slider value tap edits it |
| 51 | `.rl-num[data-k=cell]` | number, no range | native | Deliberately unbounded (floor 0.05); tests fill it |
| 52 | `[data-k=isoOffsetMm]` | range −2…2 | `slider` | detent 0 |
| 53–55 | `[data-k=rotXDeg/rotYDeg/rotZDeg]` | range −180…180 | `slider` ×3 | detents 0, ±90 |
| 56–58 | `[data-k=spatialOffsetMmX/Y/Z]` | range ±period | `slider` ×3 | Range comes from the recipe period: the wire re-ranges from `min`/`max` |
| 59 | `[data-act=xreset]` | button | native | |
| 60 | `.rl-sw[data-act=trim]` | switch button (`aria-pressed`) | `toggle` | `syncOn:['aria-pressed','class']` |
| 61 | `.rl-num[data-k=inset]` | number 1–2 | `slider` | Stage 2 adds a range (1–2, 0.1) beside the box |
| 62 | `.rl-hue` hue strip | `role=slider` div | native (custom) | Already a drawn drag control with keyboard support; no kit hue widget. Restyle only |
| 63 | Shade Light / Mid / Deep | button group | `segmented` | `aria-pressed` set by `rlColSync` |
| 64 | `.rl-hrst` colour reset | button | native | |
| 65 | `[data-act=rmPart]` | button (two taps) | native, warn | |

### Rail: weld editor (`rlEdWeld`)

| # | Control | Type | Widget | Notes |
|---|---|---|---|---|
| 66 | `.rl-mname` pick member | button | native | |
| 67 | `[data-act=out]` | button | native | |
| 68 | `select[data-sel=addTo]` | select | `dropdown` compact | Action menu |
| 69 | `[data-k=w.fillet]` | range 0–1.5 | `slider` | |
| 70 | Join rule Union / Anchor / Graded | button group | `segmented` | Disabled options without a solid + lattice mix |
| 71 | `[data-k=w.anchor]` | range 0–2 | `slider` | Anchor only |
| 72 | `[data-k=w.grade]` | range 0.2–5 | `slider` | Graded only |
| 73 | `.rl-sw[data-act=joins]` | switch button | `toggle` | |
| 74 | weld hue strip | `role=slider` | native (custom) | As 62 |
| 75 | weld shade | button group | `segmented` | As 63 |
| 76 | weld colour reset | button | native | |
| 77 | `[data-act=sepAll]` | button | native, warn | |

### Dock, drawer, progress, inspector

| # | Control | Type | Widget | Notes |
|---|---|---|---|---|
| 78 | `#cfgBtn` | button | **removed** | Drawer goes (F2). Tests use it: see §10 |
| 79–81 | `.dk-tag` ×3 (+ static part tag) | buttons | **removed** (3 counted) | Section rail replaces them |
| 82 | `#expBtn` Export 3MF | button | `progress` (`CONFIG.run`) | Progress from the existing `_dkExport` timer; cancel stays native |
| 83–84 | `.dr-tab` Part prep / Export | tabs | `sections` | Become sections 02 / 03 |
| 85 | Quality chips Draft … Ultra (`#qDraft` …) | button group | `segmented` | **Export quality stays** (a real output setting). Sub-labels (edge mm) as option notes |
| 86 | `#expDomainMm` | number 1–100 | `slider` | Hidden when a part is loaded (F14) |
| 87 | `#expMesher` | select | `dropdown` compact | |
| 88 | `#expLoose` | select | `dropdown` compact | |
| 89 | `#expChecks` | select (2) | `dropdown` compact | A select-backed segmented isn't in the kit |
| 90 | `#pgCancel` | button | native | |
| 91 | `.ic-fold` ×3 | button | native | |

### Part prep (`ppBox`, re-rendered on change)

| # | Control | Type | Widget | Notes |
|---|---|---|---|---|
| 92 | `#ppProc` | select | `dropdown` | |
| 93 | `#ppMat` | select with `optgroup` | `dropdown` | `relabel` groups from the optgroups |
| 94 | `#ppRho` | number | native | Custom density, typed from a data sheet |
| 95 | Part axis up +Z −Z +X −X +Y −Y | button group | `segmented` (6) | Two rows on phone |
| 96–97 | Tilt about X / Y | number, step 5 | `slider` ×2 | −180…180, detents 0 / ±90 |
| 98 | Overhang limit | number 0–89 | `slider` | |
| 99 | Standoff | number 0–50 | `slider` | |
| 100 | `#ppViewBtn` Print view | button | **removed** | F11; the Print tab is the one control |
| 101 | Plate opacity | range 0–100 | `slider` | Shown in the Print view only |
| 102 | Download print report | button | native | |

### Hidden legacy state (`#legacyHold`)

| # | Control | Type | Widget | Notes |
|---|---|---|---|---|
| 103 | `#reloadBtn` | button | native, hidden | `resetToDropzone` |
| 104 | `#shapeCellSizeMm` | number | native, hidden | Tests' fallback path |
| 105 | `#trimToNodes` | checkbox | native, hidden | State for the trim toggle (60) |
| 106 | `#trimInsetMult` | number | native, hidden | |
| 107–113 | `#sxRotX/Y/Z`, `#sxOffX/Y/Z`, `#sxIso` | number | native, hidden | `UI_XFORM_INPUT` in the test adapter |
| 114 | `.sxr-reset` | button | native, hidden | |

Counting the buttons inside groups one by one gives the 135 above (6–8 = 3, 21–23 = 3, 48 = 3, 63 = 3, 70 = 3, 75 = 3, 85 = 5, 95 = 6).

New controls from this plan: help trigger, one (i) per card, help close, section rail / tab bar items (3).

## 6. Accent

Brand guidelines "Tool color system", Mesh row: tile `#FCEAF5`, stroke `#6B0A4C`.

| | Hex | OKLCH |
|---|---|---|
| Brand stroke | `#6B0A4C` | 0.357 0.142 345.7 |
| Current on-dark accent `--mesh` (`ui12.css`) | `#E46BB0` | 0.693 0.168 347.1 |
| **Proposed accent** (stroke hue, L 0.80) | **`#f99ad0`** | **0.80 0.13 345.7** |

- In sRGB gamut (max chroma at this L and hue is 0.143).
- Accent on panel 9.6:1. Dark text `oklch(0.22 0.06 345.7)` (`#2d0d21`) on the accent 8.9:1.
- It is the tool's existing pink, lifted. So this is a token change, not a new look.
- Lime (`#c8f542`) is TPMS's accent. Mesh uses it today in the status mark (the F13LD logo, keep), "Lime edges" (shared F13LD-SHADE option, keep), the `#scSimplified` pill (removed) and the selected-part outline in the shader. Keep the outline lime: it must read on any part colour, and pink parts are common (weld colours, the accent itself).
- Watch: weld colour `#fb7185` (hue 13) sits near the accent; the hue strip lets users pick pink parts. Neither is UI chrome.

## 7. Render cost (against `render-quality.md`)

**What mesh already does:**
- **Uniforms, not recompiles, for edits.** Every structure setting (cell, wall offset, rotation, shift, fill, skin, fillet, join rule) is a value in the `Scene` std140 block. A slider drag does not compile (v0.14.0, `tests/livesliders.js`).
- **Compiles:** per preview quality (the step count is a literal, `_buildShader` 555) × 2 variants (`single`, `multi`). `setQuality` never restarts a running compile.
- **Fixed canvas tier:** buffer = pane × min(DPR, 1.5), set in `_drawFrame`; no resize between moving and still frames (v0.13.2).
- **Moving frames:** shadows off (`uF13Interact`). Weak-GPU fallback: GPU timer (or frame gap) while the view moves, > 70 ms for ~1.5 s with ≥ 2 lattices → parts not being edited draw as shells while moving (`PSC.slowGpu`).
- **Bakes off the main thread:** warm worker pool, z-slab split, keyed cancel, content cache, shared in-flight bakes.
- **holdView / releaseView:** the last correct frame stays on screen while a source bakes (20 s cap).
- **Dirty-only drawing:** `render()` returns at once when `_dirty` is false; the scene signature (`previewSceneSig`) skips unchanged frames.

**Changes (stage 4):**
1. **Steps as a uniform.** Constant loop bound (today's Ultra, 2048) with `if(i>=uSteps)break`. Moving = today's Low (256 steps); rest = today's High (1024). Compiles drop to the 2 variants, once. Add `drawStats.compile`; assert 0 per drag and 0 on quality change.
2. **Adaptive interactive scale.** Moving frames into `lowFB` at 0.4–0.85 of the buffer, blit LINEAR. Keep the 1.5 DPR cap and `antialias:false`. The shell fallback stays as a second step after the scale hits its floor (no pill, F17).
3. **Rest frame in strips** (scissor on `gl_FragCoord`), swapped in once. Any interaction drops the strips. `holdView` frames are not re-rendered.
4. **Loop sleeps.** Stop the rAF chain when nothing is dirty, compiling or striping; wake from a `_dirty` setter (it is written in ~30 places, so a property setter beats editing each). Replace the 250 ms join / fill poll in `23-view-strip.js` with calls from the setters (`weldSetShowJoins`, `setBodyFill`, skin, cell). Assert 0 draws and 0 rAF in 1 s idle.
5. **Preview quality is fixed (Matt: automatic, fixed bake erring precise).** Use today's High everywhere: bake 128³ (`PREVIEW_BAKE_N`), shape grid 224³ (`SHAPE_PREVIEW_N`), weld cap 192, oversample 4. Not Ultra: 192³ / 256³ is ~3.4× the bake voxels and atlas memory, and each aperiodic recipe holds its own region. Today's default on first load is Low, so the view gets sharper and first bakes slower; measure first-bake time vs `main` on Matt's machine.
6. **Low-res while dragging (Matt: only if it doesn't slow things).** Periodic recipes already update live (no bake). For aperiodic regions (noise, spinodoid / GRF grain, warped bundle) a rotation / shift / cell drag re-bakes the region in the background. Option: bake at 48³ first while the drag moves, then 128³ at rest, through the existing keyed cancel. Only if the timing table shows the drag stays smooth; otherwise keep the held old region.
7. **Export quality stays** as is (Draft … Ultra edge length, its own `currentExportQual`).

## 8. Analysis results

- **Measured (last export)** + print report: clear (back to "Export once to measure…") when anything the export reads changes: the scene signature minus view-only keys, plus part prep orientation / standoff and export quality / domain / mesher / loose. Clearing also drops the Export badge.
- **Homogenization** (from the recipe, made by the design tool): hide when the part no longer matches what the design tool analysed: wall offset ≠ 0, rotation ≠ 0, or Lattice + skin. Show it again when those return to default.

## 9. Help

- Mesh has no help system. Add the shared help drop-in (as numbered files) with cards and (i) on every row. The count goes from 0 to about 34.
- Cards: Recipes, Parts, Weld (join, tick, take out), Fill, Recipe, Skin, Cell size, Wall offset, Rotation, Shift, Trim to nodes, Viewport colour, Fillet, Join rule, Anchor depth, Grade over, Show joins, Process, Material, Part axis up, Tilt, Overhang limit, Standoff, Plate opacity, Quality, Domain size, Mesher, Loose pieces, Simplify, Estimate, Measured, Homogenization, View (Design / Print / Section), Section plane, Render quality (automatic).
- The long hint paragraphs under Mesher, Loose pieces, Standoff and Overhang move into their cards; one line stays under the control.
- Rows rebuilt by the rail and part prep must keep `.sc-group` + `<label>` so the engine re-anchors. "Show" for a control in an editor that isn't open (no part selected) says so instead of flashing.

## 10. Risks

- **Export reads the preview bake.** The selected part's raw aperiodic bake sets `recipe._previewFieldMin/Max`, and the export reads them (CLAUDE.md, v0.14.0). Fixing the bake at 128³ (from today's Low 64³ default) can change noise / grain / warped-bundle export bytes vs `main`. Stage 4 must check `tests/harness.js` old vs new with the preview quality pinned the same on both, then once more at the new fixed quality, and Matt decides if a changed normalization is acceptable. A low-res drag bake must never write `_previewFieldMin/Max`.
- **Load order.** Vendor the bundle as `04-liquid-ui.js` (no dependencies; between `03-registry` and `05-ui-chrome`). Add `57-layout.js`, `58-f13ui-wire.js` and the help files after `56-dock.js` and before `60-export-ui.js`; top-level code in them may only touch globals from lower files. Run `node tests/loadorder.js`. `00-libs.js` is a module; the bundle must stay a classic script.
- **Controls the app rebuilds.** The rail editor, rail cards, part prep and the dock / drawer are built by `innerHTML` (the drawer only on the first summary render). The wire's DOM-ready mount sees almost none of them. Wrap `renderRailEditor`, `rlEdSync`, the part prep render and `dockEnsure` (TPMS `mountTermToggles` pattern), use `F13UI.ready`, and keep the editor's "never rebuild under a finger" guards (`railDrag`, `_rlColDrag`).
- **`previewSceneSig`.** Anything new the preview reads goes into it (CLAUDE.md). Steps / scale are draw-only and stay out. The fixed quality replaces `rm._quality` in the key; a drag-bake resolution, if added, must be in it, or the scene won't rebuild at rest.
- **Tests through the adapter** (`tests/harness.js` UI-ADAPTERS block, eval'd by `livesliders`, `pinch`, `previewcache`, `previewparity`, `shapeview`, `partprep`, `measure`, `importtest`, `fixtests*`, `a6test`). They use `#cfgBtn`, `#drawer .dr-tab[data-p]`, `drawer.classList.contains('open')`, `#railEditor .rl-num[data-k]`, `.rl-part .rl-nm`, `.rl-rc .rl-rx`, `#inspEst [data-fold]`, `#expDomainMm`, `#expBtn`, `#computeOverlay`. Keep those ids and the `.rl-num` boxes; switch `uiOpenDrawer` to `F13UI.showSection('prep'|'export')` with the old branch kept for old builds. Tests and `tests/regress.html` call `triggerPreview('ultra'|'med'|…)` and `setQual(q)`: keep both functions working.
- **Pointer handling.** Rail rows use HTML5 drag and long-press. Widgets in the editor must not capture the pointer on hosts holding buttons (lesson 9). The canvas keeps `touch-action:none` for pinch / rotate; the phone sheet handle must not cover it.
- **Phone change is the largest.** Page scroll → fixed viewer + sheet. The rail popover (`rlPopShow`) positions from `#rail`'s rect and the 860 px breakpoint; the template uses 899 px. Align the breakpoints.
- **CPU.** Matt's complaint: the forever rAF and 250 ms polls are the idle cost today; the help drop-in and widgets must not add idle loops (`Liquid.animator` only).

## Decisions for Matt

- **Accent:** mesh pink lifted to `oklch(0.80 0.13 345.7)` (`#f99ad0`)?
- **Layout:** control pane stays on the left (as in Lab and Sweep) with Design / Prep / Export sections, the Configure drawer and dock tags removed, the inspector kept on the right at 1280 px and wider. OK?
- **Fixed preview bake at today's High** may change noise / grain / warped-bundle export bytes (export reads the preview field range). Accept a one-time change, or keep the export's range from a separate fixed bake so exports stay byte-identical?
