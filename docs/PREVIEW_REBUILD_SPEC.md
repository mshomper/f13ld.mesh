# F13LD.mesh — preview rebuild spec

**Status:** P1 built and merged to main 2026-10-16 (v0.13.0, recap `SESSION_RECAP_2026-10-16.md`); P2 next. Matt's answers: sliders as instant as possible, some delay acceptable for noise / grain; per-session cache only; keep P2 ready to move to WebGPU; lower-detail weld members only as a weak-GPU fallback.
**Scope:** the on-screen preview only. Export keeps its exact, multi-core CPU field and must stay byte-identical.

---

## 1. Why

What Matt hit while click-testing v0.12.0, and the cause of each (code refs from the 2026-10-16 pipeline map):

| What Matt sees | Cause today |
|---|---|
| Weld previews are slow | One fused field for the whole weld is baked on **one** worker (`m90` bake, `buildAssemblySDF(…, rawPreview=true)`), over the group's whole box, at N³ = 48–192³. Every change throws it away. |
| Bodies look squished until the bake lands | `triggerPreview` switches to the new world box (`setAssemblyMode`, `setWorldBounds`, 44:25/33) **before** the new field arrives, so the old texture is sampled through the new box. |
| Cell size first scales the whole object | `rm.setCellSize` (20:167) rescales the view at once; the re-bake corrects it later. |
| Rotation / shift sliders do nothing in a weld | `render()` drops `_structXform` in assembly mode (20:967), and periodic recipes never re-bake on those sliders (45:33). |
| Switching parts re-bakes everything | `switchActiveBody` re-uploads the 64³ shape texture and re-bakes the lattice, even for solid parts (10:133–137). There is no cache. |
| Every structure change waits for a bake | The lattice is **always** a baked R8 texture (`uField`); the shader never evaluates any lattice itself. |

The common root: the preview has one "current field" slot and rebuilds it from scratch for every change.

## 2. Goals

1. **Every structure setting is live** for single parts and weld members: cell size, wall offset, rotation, shift, skin, fill, fillet, join rule. Target: the next frame (< 16 ms), no bake.
2. **Switching the selected part costs nothing** — no upload, no bake, camera kept.
3. **No distorted frames.** A view never shows a texture through the wrong box; when a bake *is* needed, the previous picture stays until the new one is ready.
4. **Bakes that remain are multi-core, cached and cancellable**, and their cost does not grow with part size where the recipe is periodic.
5. **Preview matches export** within a stated tolerance, checked by an automated parity test.
6. No change to export output (`tests/harness.js` byte-identical).

Non-goals: changing export, changing recipe formats, WebGPU as a hard requirement.

## 3. Architecture

Three layers, each cached on its own:

```
 Field sources (per recipe)        Part resources (per part)        Scene shader (per frame)
 ─────────────────────────         ─────────────────────────        ────────────────────────
 A. exact math in GLSL             shape SDF texture, baked once     for each visible member:
 B. periodic unit-cell tile        at import / quality change,         d_i = compose(shape_i,
 C. region texture (aperiodic)     kept on the GPU                                field_r(T_i · p))
        │                                   │                        weld: smooth-min with fillet,
        └──────────────┬────────────────────┘                        join rule, show-joins tint
                       ▼
          uniforms per member: transform, cell, iso, fill, skin, source, range
```

### 3.1 Field sources

Each recipe resolves to one source kind:

| Kind | Families / types | How the shader gets the field | Cost of a slider change |
|---|---|---|---|
| **A · exact math** | TPMS (term lists, raw presets, PI-TPMS incl. field pair and normalise), beam (capsule struts with wrap + halo), wave (mode sums, stretch) | GLSL generated from the recipe (same arithmetic as `m20` / `m21` / `m24`), compiled once per recipe signature | none — uniforms only |
| **B · periodic tile** | foam (exact distance, Plateau, wet), reaction-diffusion, bundle, any A-family whose GLSL is too heavy (fallback) | One unit cell baked to a 3D texture with `REPEAT` wrap (`bakeBounds` already gives the tile); N_tile = 48 / 64 / 96 by preview quality | none — uniforms only |
| **C · region texture** | noise, spinodoid / GRF, hyperuniform (aperiodic) | Baked once over the part's **bounding sphere in the lattice frame** plus a shift margin of one period, so any rotation and any shift within the margin stays inside the baked region | none inside the margin; a background re-bake (double-buffered) beyond it, or when cell size changes by > 25 % |

Notes:
- Type A needs a GLSL generator per family. TPMS is the big one: `compileTermsList` (`m20`, v0.11.0) already turns term lists into one expression; the same walk emits GLSL. PI-TPMS normalise (≈ 14 field evaluations per point) is fine on the GPU.
- Noise could later move to type A too: F13LD.noise already renders it in GLSL (`m20` notes the simplex evaluator matches that shader exactly). Kept as C in the first pass.
- Hyperuniform has a periodic evaluator (`evalHUFieldPeriodic`); when the recipe is periodic it can be type B.

### 3.2 Part resources

- One **shape SDF texture per part**, baked by the existing pool (`12-shape-sdf-bake.js`) at import and when the preview quality rises; kept until the part is removed. Solid parts need nothing else.
- Stored in a **3D texture atlas** (bricks) instead of one texture per part, so 8 parts fit in a few texture units (WebGL2 guarantees 16 units; today 8 ghost + join + field + shape slots already crowd it).
- Memory budget: R16F 96³ ≈ 1.8 MB per part; 8 parts ≈ 15 MB; atlas capped at 64 MB with LRU eviction of the least-recent quality level.

### 3.3 Scene shader

One raymarcher program for single parts and welds (replaces the separate assembly path):

- **Per member uniforms** (arrays, up to 8): atlas offset/size of its shape, world↔mm mapping, rotation (3×3), pivot, shift, cell size, wall offset, fill (solid / lattice / skin), skin thickness, source index + field range, visibility (shown / ghost / hidden), colour.
- **Member field:** `lattice = source_r(R^T·(p − pivot − shift)/cell)`; `member = clip(shape, lattice)`; skin `min(sh, max(sc, skin − sh))` — the same formulas as `worker/m32` / `m30`.
- **Weld union:** smooth-min with the fillet (`blendK`), plus the join rule: graded raises the wall offset by up to `gradeMaxMm` within `gradeMm` of the solid members (distance from their shape SDFs); anchor grows the lattice's clip into solids (no visible change except with trim to nodes).
- **Show joins:** tint where two or more member surfaces are within the fillet band — already prototyped in v0.12.0 with ghost textures.
- **Hidden members** are skipped entirely (not in the union, not in the box). Ghost members draw translucent, outside the union.
- **Section plane** and print view stay as in v0.12.0.

### 3.4 Rendering speed

- **Per-member box culling:** each ray first intersects every visible member's box and only evaluates members it enters (big win for welds of separated parts).
- **Empty-space skipping:** a coarse 16³–32³ "minimum distance" grid per scene lets the ray jump through empty space in big steps before switching to the full field.
- **Adaptive resolution:** render at half resolution while the camera moves or a slider is dragged; full resolution (and shadows / occlusion) once still for ~150 ms. Same look as today when idle.
- **Shader variants** per scene signature (member count, source kinds, fill modes) compiled lazily and cached; uniform-only changes never recompile.

### 3.5 Bakes that remain

- **Scheduler:** one priority queue for all bakes (shape, tile, region), newest request wins, superseded jobs are **cancelled** (today they run to completion and are dropped by `_previewSeq`).
- **Multi-core:** tile and region bakes split into z-slabs over the existing field-bake worker pool (v0.11.0).
- **Progressive:** a 32³ version lands first (≈ 1/8 the work), then the full size; both double-buffered.
- **Cache key:** recipe content hash + source kind + quality (tiles, regions); file hash + quality (shapes). Kept in memory for the session; optional IndexedDB cache across reloads is a later step.

## 4. Behaviour by action

| Action | Today | After |
|---|---|---|
| Drag cell size / wall offset / rotation / shift (any part, any weld) | re-bake (or nothing in welds) | uniform update, next frame |
| Change fill / skin | re-bake | uniform update (variant recompile once if a new fill mode appears) |
| Fillet, join rule, anchor, grade | weld re-bake (120 ms debounce) | uniform update |
| Select another part | upload + re-bake | nothing |
| Show / ghost / hide a part or weld | re-bake | uniform update |
| Add a part | shape bake + re-bake | shape bake only (multi-core, progressive) |
| Change preview quality | re-bake | re-bake shapes / tiles at the new size in the background, old picture kept |
| Edit an aperiodic part beyond its margin | — | background region re-bake, old picture kept |

## 5. Preview ↔ export parity

- New `tests/previewparity.js`: for each `recipes.json` case (and a weld of two members with a rotated lattice), read field values back from the shader at ~10 000 random points (render to a float texture) and compare with the worker field at the same points.
- Pass: sign agreement ≥ 99.5 % of points away from the surface (|d| > 0.5 voxel), and |Δd| ≤ 0.5 voxel near it. Exact-math sources should agree to float precision.

## 6. Phases

Each phase ships on its own and is click-tested before the next.

| Phase | Delivers | Checks |
|---|---|---|
| **P1 · caches and no-distortion** | Per-part shape textures kept on the GPU (atlas), selection change does nothing, double-buffered field slot, the world box only changes together with the field that matches it, bake scheduler with cancel. | Switching parts costs no bake (log), no squished frames (screenshot sequence during a weld re-bake), harness identical. |
| **P2 · scene shader** | One composition shader for single parts and welds with per-member uniforms; tile (B) and region (C) sources; all structure sliders live in welds; hidden members skipped. | Rotation / shift / cell / iso / skin / fillet / rule live on a 3-member weld; parity test passes for B and C. |
| **P3 · exact math sources** | GLSL generators for TPMS (incl. PI-TPMS), beam, wave. | Parity at float precision; slider latency < 16 ms on Matt's RTX 4070 Ti Super. |
| **P4 · speed** | Member box culling, empty-space skipping, adaptive resolution, progressive bakes. | Bench page gets a "preview" tab: time to first frame, frame time while orbiting, slider latency — live tool vs branch on Matt's machine. |
| **P5 · optional** | WebGPU compute for tile / region bakes (as F13LD.lab uses), IndexedDB bake cache. | Same parity; bake times on the bench. |

## 7. Risks

- **Texture units / uniform limits** on low-end GPUs → the atlas, and a member cap with a clear message (8 today).
- **Shader compile time** for large TPMS term trees → cache programs per recipe signature; fall back to a type B tile if compile exceeds a budget.
- **Precision:** R8 textures today; tiles and regions move to R16F to keep thin walls accurate after scaling.
- **Large aperiodic parts:** a region texture over a big bounding sphere loses resolution → cap the voxel size by quality and show the existing "preview coarse" note; export is unaffected.
- **Phones:** keep the adaptive-resolution path on by default; members beyond what the device supports draw as ghosts.

## 8. Questions for Matt

- Is the < 16 ms slider target right, or is "within a quarter second" good enough for the aperiodic (noise / grain) recipes?
- Should the preview cache survive a page reload (IndexedDB), or is per-session enough?
- For very large welds, is it acceptable that ghosted (not selected) members render at a lower resolution than the selected one?

---

## Appendix · parallel slab mesher (built in v0.15.0 — see `SESSION_RECAP_2026-10-16c.md`)

Findings from the 2026-10-15 Node prototypes (scratch only, not in the repo):

- Manifold can't stitch independently level-set slabs: touching slabs stay separate after union, overlapping slabs leave doubled surfaces, and trim + weld fails because Manifold tidies each cut differently.
- Our own marching tetrahedra on the same body-centred grid, with every slab sharing the seam plane and vertices keyed by global edge, builds a watertight Manifold every time (gyroid, beam; 1 and 8 slabs). Slowest of 8 slabs ≈ 10 % of Manifold's one-core time.
- Open: 2.5–3× more triangles and many slivers (no snapping of crossings near grid points); volume 0.4–0.8 % high vs Manifold. Next: snap near-corner crossings, then simplify.
- Per-slab meshoptimizer simplify with `['ErrorAbsolute','LockBorder','Sparse']` stitches watertight; slowest slab 10–17× faster than one whole-mesh simplify, but ≈ 2× triangles concentrated in a dense band at each seam → add a second, light simplify pass over the seam bands only.
- Matt approved that exports may then differ slightly in triangle layout (same shape and volume).
