# F13LD.mesh — P2 scope · one scene shader for parts and welds

**Status:** built in v0.14.0 (2026-10-16, branch `p2-scene`); see §0 for what changed from this scope. Written 2026-10-16, after v0.13.2. Parent spec: `docs/PREVIEW_REBUILD_SPEC.md` §3–§6 (phase P2). P1 shipped in v0.13.0–v0.13.2; see `docs/SESSION_RECAP_2026-10-16.md`.
**Branch to use:** `p2-scene`. **Target release:** v0.14.0. **Export must stay byte-identical** (`tests/harness.js`).

---

## 0. Decisions at the start of the P2 session (Matt, 2026-10-16) and what changed

| Question | Answer |
|---|---|
| Q1 colour | Every part in a weld draws in the weld's colour, selected or not. The weld editor had no colour picker: added (16 swatches, reset = automatic colour); a member's part editor shows "Shown in Weld X's colour" instead. |
| Q2 lattice on unselected parts | Always show the real lattice. |
| Q3 selection cue | Soft lime outline (only with two or more parts on screen; not on the selected part's own surface or its fillets). |
| Q4 recipe limit | Push it to what the GPU can do → no fixed limit: tiles, regions and shapes live in three atlases (3 texture units), up to one recipe per part (8). |
| Weak GPU | Auto-switch: slow back-to-back frames with two or more lattices → parts not being edited draw as shells (toast once). |

Changes from the scope below, made while building: region sources keep the **P1 box** (AABB of the transformed part) instead of a bounding sphere + margin, because that bake sets the noise / grain range the export reads (`_previewFieldMin/Max`); a sphere box would change exports. Rotation, shift or cell size therefore re-bake an aperiodic part's region — in the background, with the old region drawing meanwhile (no hold). Shapes moved into an atlas too (sampler if-chains evaluated all eight textures in software rendering), and the shader has two variants (`single`, `multi`), compiled once each per quality. The part prep live estimate keeps its own CPU sampler, which already reads the selected member's source and transform.

## 1. What P2 delivers

1. **Every structure setting is live**, for a single part and for every member of a weld: cell size, wall offset, rotation, shift, fill (solid / lattice / lattice + skin), skin thickness, fillet, join rule (union / anchor / graded) and its distances. The next frame shows the change; no bake, no hold.
   Matt's target (2026-10-16): "as instant as possible"; some delay is acceptable for noise / grain.
2. **The whole scene is drawn together.** Every visible part is a *member* of one scene. Welded parts look welded (fillet, join rule) whether or not the weld is selected. Today, selecting a part outside a weld turns the weld into separate solid boxes.
3. **Bakes that remain are per recipe, not per weld**: a unit-cell tile for periodic recipes, a region for aperiodic ones. They are cached (P1 cache) and never depend on transforms or other members.
4. **Preview ↔ export parity test** (spec §5) for single parts and welds.
5. **Data laid out for WebGPU** (P5): the member table maps one-to-one onto a WGSL struct array; sources are plain 3D textures.

Out of scope (later phases): exact-math GLSL sources (P3), empty-space skipping / adaptive resolution / bench preview tab (P4), WebGPU and IndexedDB (P5).

## 2. Decisions already made (keep)

| Date | Decision |
|---|---|
| 10-15 | Structure editor lives in the left rail; welds are cards; merging keeps the target's settings; a one-part weld is "Weld dissolved". |
| 10-16 | Everything hidden drops out of export. Ghosted parts still export. |
| 10-16 | Ghosted parts in a weld leave the solid preview and draw as translucent shells (the fillet where they meet is not shown while ghosted). Hidden parts aren't drawn. The selected part follows its eye. |
| 10-16 | Preview cache per session only. P2 must be ready to move to WebGPU. Lower detail for unedited weld members only as a weak-GPU fallback. |
| 10-16 | Preview shape grids per quality (Draft 96 … Ultra 256) live in `body.previewGrids`; export reads only `body.sdfGrid`. |
| 10-16 | Weld previews: about 8 voxels per finest cell, per-quality caps (P1 union bake; P2 removes the union bake but keeps the caps' intent for region sources). |
| 10-16 | Pinch zoom about the view centre. |

## 3. Where the preview stands after P1 (what changes)

- `20-raymarcher.js` draws **one active part** (`implicit0`: shape clip of one lattice field, optional skin), up to 7 **ghost** shells (units 2–8, 48³ ghost grids) and, in weld mode, a **join tint** for up to 4 members (units 9–12). A **weld** is a pre-baked union field (`setAssemblyMode(true)`, 16-bit, `weldPreviewN`), so member transforms cost a full bake.
- Field texture: unit 0 (R8 + REPEAT tiles; R16F clamped for welds). Shape: unit 1 (R16F).
- Lipschitz: solid 1; lattice in a part max(lattice, 1); weld: the union's.
- Shared shading block `19-f13-shade.js` (F13LD-SHADE) is byte-identical across tools and must not change; the tool defines `f13Map`.
- Code outside the shader that reads raymarcher state (constrains renames): `53-part-prep.js _ppScaffoldSampler` (CPU copy of `sampleRaw` / `rawToSDF` / `xformStructure`, reads `_fieldData, bakeN, worldMin/Max, isPeriodic, fieldMin/Max, topology, _assemblyMode, _structXform`); `23-view-strip.js` (clip plane, joins, `_assemblyMode`, `shapeData.cellSizeMm`); `21-gimbal.js` (camera); `HOLD_KEYS`; tests `partprep.js, previewcache.js, shapeview.js, weldvis.js, pinch.js, fixtests2.js`.

## 4. Target architecture

### 4.1 Scene = members + groups + sources

```
scene
 ├─ members[0..7]   one per visible part (MAX_BODIES = 8)
 │    shape tex (unit 1+i), bbox mm, kind solid | lattice | ghost
 │    lattice: source index, cell mm, rot (mat3, stored as Rᵀ like structXform), pivot mm, shift mm, iso mm,
 │             fill solid | lattice | skin, skin mm, colour, group index
 ├─ groups[0..7]    weld groups: fillet k (mm), join rule, anchorMm, gradeMm, gradeMaxMm (0 = 0.15 × member cell)
 │                  a standalone part is a group of one
 └─ sources[0..3]   one per distinct lattice recipe in view: tile | region texture + decode params
```

- **Frame:** the scene keeps today's world = mm × 10 / refCell, refCell = the selected part's cell size, so camera, view box, section plane, print view and pinch stay as they are. Every member is evaluated in **absolute mm** inside the shader and converted at the end (×10/refCell), exactly as `worker/m30` does.
- **Uniform layout:** one uniform buffer object (`std140`) `Members { MemberData m[8]; GroupData g[8]; SourceData s[4]; ivec4 counts; }`. Each struct packed to vec4 boundaries so the same bytes map to a WGSL `array<Member, 8>` later. Updates are `bufferSubData` of the changed member only.
- **Texture units (WebGL2 guarantees 16):** 0 – 3 sources, 4 – 11 member shapes, 12 – 15 spare (plate / future). Samplers can't be indexed by a variable in GLSL ES 3.0, so shape and source lookups use the same if-chain pattern `sampleGhostSlot` uses today. Member shapes use the **preview grids** (`previewShapeGrid(b)`), not the 48³ ghost grids — shells get sharper too.
- **Shader:** compiled once with `MAX_MEMBERS = 8`, `MAX_SOURCES = 4`, loops bounded by those constants and early-out on `counts`. No per-scene recompiles (measure compile time on Matt's machine and a phone; split variants only if it is slow).

### 4.2 Sources (bakes that remain)

| Kind | Recipes | Texture | Changes that re-bake |
|---|---|---|---|
| **Tile** | TPMS (incl. PI-TPMS, field pair, normalise), beam, wave (supercell S, stretch), foam (all modes), bundle when not warped, reaction-diffusion grain, hyperuniform grain (periodic evaluator) | one tile in the recipe's world frame, today's `bakeBounds` box, R8 + REPEAT (as now) | recipe content, quality (tile N) — never transform, cell size, iso, fill, other members |
| **Region** | noise, spinodoid / GRF grain, warped bundle | baked over the member's **lattice-frame bounding sphere** + one period of shift margin, R16F clamped | leaving the margin (shift), rotation moving the box out of the sphere (it can't: a sphere is rotation-invariant), cell size change > 25 %, quality |

- Tile bakes are exactly today's periodic / cube bakes (`42 bakeField` with the same options) — same cache keys, so P1's cache and the bench comparisons carry over. A tile is shared by every member that uses the recipe.
- A region source is **per member** (its box depends on that member's shape and cell). Re-bakes run in the background (P1 pool, cancellable) and swap in when ready; the old one keeps drawing (no hold). Regions are the one place "some delay is acceptable" applies.
- Raw (stochastic) sources keep their decode params on the source: `fieldMin/Max` (range, cached on the recipe as `_previewFieldMin/Max` as today — the export reads it), `topology {center, halfW, topoMode, halfInvert, rawUnits}`.
- More than four distinct lattice recipes visible at once: the fifth and later members draw as solid shells with a one-line note ("Preview shows up to 4 recipes at once"). Export unaffected.

### 4.3 Member field (GLSL port of `worker/m30`, preview mode)

All in mm, negative inside. `p` = scene point in mm.

1. **Shape:** `sh = sampleShapeMm(i, p)` — trilinear in the member's preview grid; outside its box the P1 lower bound `max(boxDist, clampedTex − boxDist)` (the weld export adds box distance instead; preview keeps the lower bound so marching stays safe).
2. **Lattice frame:** `P` = centre of the member's bbox (mm); `q = p − P − shift`; `l = A·q` with `A` the stored Rᵀ (`mat3(rot)` in GLSL reproduces m30's column-major read); `x = (l + P) · 10 / cell` (lattice world).
3. **Lattice value:** from the source: tile → `texture(src, (x − tileMin)/tileSize)` with REPEAT; region → clamped uvw in its own box. Decode exactly like `sampleRaw` + `rawToSDF` today (SDF sources: value as is; raw sources: normalise, topology). Then `sm = value · cell/10 − iso` (positive iso = thicker walls). Non-finite → 1e3.
4. **Join rules** (only when the group has at least one solid and one lattice member): `ds = min over the group's solid members of sh_j` (grid distance, no inset).
   - anchor (A = anchorMm): `D0 = ramp = A/4`; if `ds < −D0`: `sh −= A · smoothstep01((−ds − D0)/ramp)` (before clip and skin).
   - graded (G = gradeMm, gMax = gradeMaxMm or 0.15 × this member's cell): if `ds < G`: `sm −= gMax · smoothstep01(1 − max(ds,0)/G)` (after iso, before clip).
   - `smoothstep01(t) = t²(3 − 2t)`, t clamped to [0,1].
5. **Fill:** solid → `f = sh`; lattice → `f = max(sm, sh)`; skin → `f = max(sh, min(sm, −(skin + sh)))`.
6. **Group union:** `acc = 1e9; acc = smin(acc, f_i, k)` over the group's members, `smin(a,b,k) = k ≤ 1e-6 ? min(a,b) : min(a,b) − h²·k/4, h = max(k − |a−b|, 0)/k`. No gradient normalisation (preview = `rawPreview`, as today).
7. **Scene:** `min` over groups (parts that aren't welded don't blend). Ghost and hidden members are excluded here.
8. **To scene world:** `d_world = d_mm · 10 / refCell`, then the section plane `max(d, clipD)` and the view box, as today.

Trim to nodes (beam) stays export-only, as today (the preview has always shown the untrimmed lattice).

### 4.4 Marching, normals, shading

- **Lipschitz:** shapes are 1 in world units; a lattice member is `lip_src` (the tile/region Lipschitz, world-per-world, unchanged by the mm round trip); `smin` and `min` don't raise it. Use `max(1, max over visible lattice members of lip_src)` for the march and `f13Map`. Do **not** reintroduce a 10 / cell bound (CLAUDE.md).
- **Per-member box culling (cheap, do it in P2):** before evaluating member i, test the point against its padded box (pad = fillet + |iso| + skin + one shape voxel); outside → use the box distance as that member's lower bound and skip both texture lookups. Most steps then evaluate one or two members.
- **Hit material:** the scene function also returns `(member, term)` where term = shape cap | lattice | skin, so `nrmField`, cut-face shading (`isCut`) and colour work per member. Normals: central differences of the scene function with step = max(field voxel of the hit member's source in world, shape voxel of the hit member).
- **Colour:** per member (`resolveBodyColor`), weld members in their weld colour — see open question Q1. Section plane, print view (overhang tint, plate), view-box caps and the shared F13LD-SHADE block unchanged.
- **Join tint:** computed from the member shape distances directly (two or more members of the same group within the band) — no extra textures, so the 4-member limit goes away.
- **Ghost shells:** members with eye = ghost go through the existing translucent accumulation pass, sampling their member shape texture. Hidden members are skipped everywhere. The selected part follows its eye (P1 rule).

### 4.5 CPU side

- **New `16-preview-scene.js`:** `buildPreviewScene()` turns `bodies`, `assignments`, `weldGroups`, `bodyGroup`, visibility and per-body settings into `{members, groups, sourceNeeds}`; `diffScene(prev, next)` says what changed: member uniforms only / a source missing / a region margin left. One entry point `previewSceneChanged(reason)` replaces most `triggerPreview` calls.
- **`44-preview-trigger.js`:** `triggerPreview` becomes "ensure sources, then commit the scene". The weld union bake leaves the preview (it stays for export in `14-weld-bake.js`). Hold only when a member's source is missing on first show (P1 hold logic, same tick commit on cache hits). Uniform-only changes never hold or cancel.
- **Handlers:** the rail sliders (`45-structure-handlers.js`, `55-rail.js`: cell, rotation, shift, iso, fill, skin, fillet, join rule, anchor / grade) call `previewSceneChanged` → uniform write. Region margin checks run on rotation / shift / cell changes and queue a background re-bake.
- **`20-raymarcher.js`:** `setScene(scene)`, `updateMember(i, fields)`, `setSource(j, tex, params)`; the scene replaces `setAssemblyMode`, `setGhosts`, `setJoins`, `setSolidMode`, `setActiveVis`, `setStructureTransform` (keep thin wrappers while tests still call them). `HOLD_KEYS` snapshots the scene object.
- **Part prep live estimate (`53-part-prep.js`):** `_ppScaffoldSampler` must sample the *selected member* from its source with the member transform. Move the decode + transform into one small JS function that mirrors §4.3 (also used by the parity test), so the GLSL and the CPU copy are checked against each other.
- **Retire** in the preview: assembly-mode union bake, `weldPreviewN` (keep the per-quality caps as region N caps), ghost 48³ grids (keep for the shell fallback on weak GPUs only if needed), join textures.

### 4.6 Limits and fallbacks

| Limit | Value | When exceeded |
|---|---|---|
| Members | 8 (= MAX_BODIES) | can't happen |
| Distinct lattice recipes in view | 4 | later members draw as solid shells + note |
| Texture units | 16 guaranteed (sources 4 + shapes 8 + spare) | check `MAX_TEXTURE_IMAGE_UNITS` at start; below 16 → 2 sources / shells beyond |
| Uniform buffer | 16 KB guaranteed (`MAX_UNIFORM_BLOCK_SIZE`) | member table is ~2 KB |
| Weak GPU / phone | — | unedited weld members may draw as shells (Matt: fallback only); adaptive resolution is P4 |

## 5. Tests

- **New `tests/previewparity.js`** (spec §5): a debug render mode writes the scene distance (mm) for a list of points to a float target (`EXT_color_buffer_float`); compare with the worker field at the same points — `buildAssemblySDF(specs, k, true)` for welds, `m32` single-part field for parts. Cases: every `recipes.json` case in a box; a 3-member weld (solid + gyroid rotated 30° + beam) with each join rule; a skin part; a noise member. Pass: sign agreement ≥ 99.5 % for |d| > 0.5 voxel, |Δd| ≤ 0.5 voxel near the surface.
- **New `tests/livesliders.js`:** on a 3-member weld and a single part, change cell, rotation, shift, iso, fill, skin, fillet, join rule, anchor, grade → bakes +0, no hold, frame differs, export bytes unchanged afterwards. A region member: shift past the margin → one background bake, no hold.
- **Update:** `weldvis.js` (welds no longer re-bake on eye changes; same visibility checks), `previewcache.js` (structure changes now 0 bakes), `shapeview.js`, `partprep.js` (live estimate through the new sampler), `fixtests2.js`, `pinch.js`, `viewshot.js` before / after sheets for every case.
- **Unchanged and required:** `harness.js` main vs branch, all 23 byte-identical; `slabbake.js`; `loadorder.js`.
- **Matt on his machine:** the bench page as today (exports); preview timing waits for P4's preview tab — in P2 report frame time and slider latency from a dev overlay (`?debug=1`) he can read on his 4070 Ti Super and his phone.

## 6. Work plan (suggested order, small subagents in parallel where marked)

| Step | Delivers | Can run in parallel with |
|---|---|---|
| S1 | `16-preview-scene.js` (scene builder + diff), UBO plumbing in the raymarcher, single part drawn through the member table with a tile source — pixel-identical to v0.13.2 for single parts | S2 (JS mirror of §4.3) |
| S2 | JS reference of the member field (§4.3) + `previewparity.js` against the worker | S1 |
| S3 | Multi-member composition: groups, smin fillet, join rules, skin, per-member culling, hit material, join tint, ghost shells from member shapes; welds stop baking | S4 |
| S4 | Region sources (noise / grain / warped bundle): sphere + margin bake, background re-bake, 4-source limit + note | S3 |
| S5 | Handlers → `previewSceneChanged`; retire the weld union preview bake; part prep sampler; hold rules | — |
| S6 | Tests updated + `livesliders.js`, viewshot sheets, harness, docs (CLAUDE.md, README structure table, recap), v0.14.0, push branch for Matt's click-test | — |

Each step leaves the branch working; click-test links after S3 and S6.

## 7. Risks

- **Shader cost with 8 members:** per-member culling keeps most steps to 1–2 members; measure frame time early (S3) on a 6-member weld and on a phone.
- **Compile time** of one big shader with loops and if-chains: measure on Chrome/ANGLE (Windows) and iOS Safari; split into variants by member count only if needed.
- **Region sources for large aperiodic parts** lose resolution (bounding sphere > box): cap voxel size by quality, show the existing "preview coarse" note.
- **Parity of stochastic members:** they depend on the cached normalisation range; the parity test must seed it the same way the export does.
- **Tests that poke `rm.*` fields** will need updates; keep wrappers until the last step.

## 8. Questions for Matt (start of the P2 session)

- **Q1 · colour:** when a weld isn't selected, should its parts show in the weld's colour (one welded part) or each in its own part colour?
- **Q2 · lattice on unselected parts:** today unselected parts draw as solid shells. With P2 every part can show its real lattice all the time — do you want that, or should unselected parts stay as shells unless you choose to show them?
- **Q3 · selection cue:** with everything drawn the same way, how should the selected part stand out — a soft outline, a slight brightening, or nothing (the rail shows it)?
- **Q4 · recipe limit:** is "up to 4 different recipes visible at once, more draw as shells" acceptable for the first version?
