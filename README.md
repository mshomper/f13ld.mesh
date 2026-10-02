# F13LD.mesh

**Scaffold mesh exporter for the F13LD design suite.**

Converts implicit scaffold recipes from F13LD's design tools into watertight 3MF files, ready for nTopology, slicers, or any manufacturing workflow. Built on [Manifold](https://github.com/elalish/manifold) — guaranteed manifold output, no mesh repair needed.

**Live tool:** [mshomper.github.io/f13ld.mesh](https://mshomper.github.io/f13ld.mesh)

---

## What it does

- Ingests JSON recipes from any F13LD design tool (TPMS, Beam, Grain, Noise, Bundle)
- Evaluates the implicit SDF field in-browser using the same math as the source tools
- Meshes the isosurface via Manifold's marching-tetrahedra LevelSet — guaranteed watertight
- Exports a valid `.3mf` file at a physical domain size and triangle resolution you control
- No installation, no server, no build step — runs entirely in the browser

---

## Supported recipe types

| Source tool | Recipe type | Notes |
|---|---|---|
| **TPMS Builder** | `terms` | All standard presets: gyroid, schwarzP/D, neovius, IWP, and custom term trees |
| **TPMS Builder** | `raw_preset` | Double-frequency presets: split-P, F-RD, Fischer-Koch S, gyroid-harmonic, primitive-C, octo, P-harmonic, lidinoid |
| **Beam Builder** | `beam` | Strut/beam lattices — all unit-cell topologies; analytical capsule SDF, cubic tiling via wrap + halo neighbors |
| **Bundle Builder** | `bundle` | Twisted fiber array — beam cross-section twisted along Z |
| **Bundle Builder** | `helicoid` | Multi-start helicoid sheets; **Alternating** reverses chirality every other period (smooth spring/perversion) |
| **Bundle Builder** | `braid` | N-strand helical braid |
| **Bundle Builder** | `weave` | Over/under woven warp + weft |
| **Grain Explorer** | `spinodoid` | VMF-sampled wave superposition, all directional modes (single, orthotropic, isotropic) |
| **Grain Explorer** | `gaussian` | Gaussian random field with spectral envelope |
| **Grain Explorer** | `hyperuniform` | Jittered-grid kernel field |
| **Grain Explorer** | `reaction-diffusion` | Structure "grown" from competing fields |
| **Noise Explorer** | `noise` | All 7 noise types: simplex, cellular, FBM, ridged, billow, curl, warp |
| **F13LD.foam** | `open` · `closed` · `plateau` | Voronoi cell-boundary foams (struts, walls, Plateau borders) from Poisson-disk, Lloyd, random, Weaire–Phelan or Kelvin seeds. Periodic foams only; seed positions travel in the recipe |

All geometry modes are supported: sheet, half-solid, solid, and PI-TPMS (two-phase intersection). The Bundle family carries its own topology (sheet / half-solid / solid via iso offset and sheet width) through the same pipeline.

---

## Getting a recipe into the mesher

### One-click from the design tool (recommended)

Every F13LD design tool has an **⬡ Open in F13LD.mesh** button in its header. Click it and the current recipe opens in the mesher pre-loaded — no file download, no copy-paste.

The recipe is URL-encoded as a `?r=` query parameter. The resulting URL is bookmarkable and shareable.

F13LD.foam sends `#r=` instead: its recipes carry every seed position (up to ~28 KB), and the part after `#` never goes to the server, so there is no length limit. Mesh reads both the same way.

### Drop or pick a file

Drag a `.json` recipe file onto the drop zone, or click **or pick a file** to browse. The recipe is recognised automatically and the preview renders.

---

## Export controls

### Domain size

Sets the physical size of the output scaffold cube in millimetres. Default 10 mm, range 1–100 mm.

The scaffold always fills the full domain — a 10 mm domain produces a 10 × 10 × 10 mm cube with one or more unit cells inside, depending on the `cell_scale` / `frequency` (TPMS, Noise, Grain), the cell size (Beam), or the structural period (Bundle) set in the source tool.

### Quality presets

| Preset | Triangle edge length | Use case |
|---|---|---|
| Draft | 0.20 mm | Quick sanity check — fast, coarse |
| Standard | 0.10 mm | Typical production export |
| Fine | 0.05 mm | Thin walls, high-detail surfaces |

Edge length is scaled with domain size so the triangle density stays physically consistent regardless of the output size. A 0.10 mm triangle at 10 mm is the same relative resolution as 0.10 mm at 80 mm.

### Export

Clicking **Export 3MF** recomputes the mesh at the selected quality, scales vertex positions to the chosen domain size in millimetres, and downloads a `.3mf` file.

File naming: `[type]_[preset]_[size]mm_[date].3mf`

A quality report appears after each export: triangle count, domain size, edge length, file size, and compute time.

---

## Coordinate system

All SDF evaluation runs in a `[-5, 5]³` world space. The TPMS and Grain evaluators map this to `[-π·cellScale, π·cellScale]` to match the coordinate system used by their respective source tools. Noise evaluators use `[-5, 5]` directly with a 16³ prepass normalisation step.

**Beam** lattices evaluate in a millimetre-scaled domain (struts in physical units) and tile cubically via wrap + halo neighbors. **Bundle** evaluates over its native `[-π, π]³` design domain, with one structural cell mapped to a fixed world span (10 world units per cell) so the Z-twist period tiles correctly; because that twist period rarely equals the in-plane period, Bundle bakes with **per-axis (anisotropic) world bounds**, the same mechanism the Beam family uses.

**Foam** uses the `[-5, 5]` cube directly: one foam tile is one mesh cell, and world points are wrapped into the tile with nearest-periodic-image seed distances.

All SDFs return positive-inside values (Manifold convention). The box boundary is intersected via a `max()` SDF operation to ensure the mesh closes cleanly at the domain edges.

---

## Architecture

No build step and no npm. Since v0.8.0 the tool is split into plain files (same layout as F13LD.lab) instead of one large `index.html`. The page must be served over http(s): GitHub Pages, or locally with any static server:

```
python3 -m http.server 8000      # then open http://localhost:8000
```

Opening `index.html` straight from disk (`file://`) won't work, because browsers block module scripts and Web Workers there.

### Project structure

Files load in numeric order and share one global scope, so a file can use anything defined in a lower-numbered file. `00-libs.js` is the only ES module; it loads Three.js, the loaders, fflate and three-mesh-bvh through the import map and publishes them as globals.

| File | What it holds |
|---|---|
| `index.html` | Page markup, import map, script tags |
| `mesh.css` | All styles |
| `00-libs.js` · `01-config.js` · `02-html.js` | Library loader · version + worker URL helper · HTML escaping |
| `03-registry.js` | Family and loader registries (`registerFamily`, `registerLoader`), family labels/colours, type badge |
| `families/fam-*.js` | One descriptor per design tool: detection, validation, summary, periodicity, bake bounds, export caps and estimates |
| `loaders/ld-*.js` | One file per recipe source: `?queue=`, `?r=`, `#r=` |
| `05-ui-chrome.js` | Spinner orb, status indicator |
| `10-state.js` · `11-structure-state.js` | Bodies, recipes, weld groups, ghosts · structure transform state |
| `12-shape-sdf-bake.js` · `13-hu-bake.js` | Shape SDF and hyperuniform bake worker pools |
| `20-raymarcher.js` · `21-gimbal.js` | WebGL2 preview · orientation gimbal |
| `30-shape-import.js` · `31-body-cards.js` | Body file intake · body cards, weld drag/drop, recipe library |
| `40-mesh-worker-host.js` · `41-quality-estimate.js` | Quality tiers, mesh worker launcher, cancel · grid clamp and estimates |
| `42-preview-bake.js` · `43-bundle-cells.js` · `44-preview-trigger.js` · `45-structure-handlers.js` | Preview pipeline |
| `50-recipe-router.js` · `51-summaries.js` | Recipe family detection + validation · summary cards |
| `60-export-ui.js` · `61-export.js` · `62-threemf.js` | Export pipeline and 3MF writer |
| `70-view-state.js` · `99-init.js` | Overlay / error / recipe view state · boot, `?r=`, `?queue=`, file drop |

### Adding a design tool

1. `families/fam-<id>.js` — call `registerFamily({...})`; the fields are documented at the top of `03-registry.js`.
2. `worker/m2x-sdf-<id>.js` — write the SDF builder (negative-inside, world units) and call `registerSDF('<id>', {build(recipe){…}})`.
3. Add one `<script defer>` line to `index.html` and one entry to the `importScripts` list in `worker/mesh-worker.js`.
4. Add a case to `tests/recipes.json`.

Nothing else should need to change; if it does, the registry is missing a field. A new recipe source (e.g. `?vault=`) is one `loaders/ld-<id>.js` calling `registerLoader`.

### Workers (`worker/`)

| File | What it holds |
|---|---|
| `mesh-worker.js` | Mesh worker entry; loads the `m*.js` parts below in order |
| `m00-libs.js` | Manifold + meshoptimizer loaders |
| `m05-sdf-registry.js` | `registerSDF` — each SDF file registers its builder (and, for stochastic fields, its raw preview field) |
| `m10-noise.js` · `m11-grain-fields.js` · `m12-reaction-diffusion.js` | Field primitives |
| `m20-sdf-noise-tpms.js` · `m21-sdf-beam.js` · `m22-sdf-grain.js` · `m23-sdf-bundle.js` · `m24-sdf-wave.js` · `m25-sdf-foam.js` | One SDF builder per recipe family |
| `m30-sdf-assembly.js` | Weld-group union and `buildSDF` (looks the family up in the registry) |
| `m90-onmessage.js` | Bake / preview / export message handler |
| `shape-sdf-worker.js` · `hu-bake-worker.js` | Shape SDF and hyperuniform slab bakes |

Worker files are requested with `?v=<version>` so a deploy never mixes a fresh page with stale cached worker code. Bump `F13LD_MESH_VERSION` in `01-config.js` (and the header label in `index.html`) on each release.

**Libraries loaded from CDN at runtime:**
- [Manifold 3.4.1](https://github.com/elalish/manifold) — WASM mesh kernel (LevelSet, manifold guarantee, 3MF-friendly topology)
- [Three.js r158](https://threejs.org) — 3D preview with OrbitControls
- [fflate 0.8.2](https://github.com/101arrowz/fflate) — ZIP compression for 3MF packaging

**SDF evaluators** are ported verbatim from their source tools (TPMS Builder, Beam Builder, Grain/Spinodoid Explorer, Noise Scaffold Explorer, Bundle Builder) and produce numerically identical output. The noise simplex evaluator matches the GLSL shader output exactly; the grain wave evaluator uses the same Mulberry32 RNG and VMF sampling as the GPU raymarcher; the Bundle evaluators (bundle / helicoid / braid / weave) are the same negative-inside `scene()` math as F13LD.bundle, re-scaled to return world-unit distances and tiled through the shape via GL_REPEAT.

**3MF output** is a hand-built ZIP containing `[Content_Types].xml`, `_rels/.rels`, and `3D/3dmodel.model`. Vertex coordinates are in millimetres. Triangle winding follows the 3MF spec (CCW from outside). Manifold guarantees watertight, non-self-intersecting output — no mesh repair required downstream.

---

## F13LD suite

| Tool | Description |
|---|---|
| [f13ld.tpms-builder](https://mshomper.github.io/f13ld.tpms) | Periodic TPMS surface design with PI-TPMS and FFT-CG homogenisation |
| [f13ld.beam](https://mshomper.github.io/f13ld.beam) | Strut/beam lattice design — multiple unit-cell topologies, 3MF Beam Lattice export |
| [f13ld.bundle](https://mshomper.github.io/f13ld.bundle) | Twisted fiber bundles, helicoids, braids, and weaves |
| [f13ld.noise](https://mshomper.github.io/f13ld.noise) | Stochastic noise scaffold explorer |
| [f13ld.grain](https://mshomper.github.io/f13ld.grain) | Spinodoid / Gaussian / hyperuniform anisotropic grain fields |
| [f13ld.foam](https://mshomper.github.io/f13ld.foam) | Voronoi foams — open, closed and Plateau-border cellular scaffolds |
| **f13ld.mesh** | This tool — implicit scaffold → watertight 3MF |

All tools share a common JSON recipe schema. Any recipe exported from one tool can be ingested by f13ld.mesh.

---

## Known limitations

- Without an imported body the export is a cube; to export any other envelope, import it as a body (STL / OBJ / 3MF / STEP / IGES) and fill it with the recipe
- Warped Bundle recipes (warp mode on) bake non-periodically over the shape rather than tiling, since the warped field has no finite repeating cell
- A non-zero Bundle Z-ramp is treated as a periodic input; if the ramp isn't set so the cell self-tiles, seams may appear at the tile borders
- Fine quality at large domain sizes (e.g. 80 mm Fine) may take 30–60 seconds in-browser due to the density of SDF evaluations; use Standard for iteration and Fine for final export

---

## Credits

Built by [Not a Robot Engineering](https://notarobot-eng.com) as part of the F13LD computational materials design suite.

Manifold geometry kernel by [Emmett Lalish](https://github.com/elalish/manifold).
