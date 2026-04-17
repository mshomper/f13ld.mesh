# F13LD.mesh

**Scaffold mesh exporter for the F13LD design suite.**

Converts implicit scaffold recipes from F13LD's design tools into watertight 3MF files, ready for nTopology, slicers, or any manufacturing workflow. Built on [Manifold](https://github.com/elalish/manifold) — guaranteed manifold output, no mesh repair needed.

**Live tool:** [mshomper.github.io/f13ld.mesh](https://mshomper.github.io/f13ld.mesh)

---

## What it does

- Ingests JSON recipes from any F13LD design tool (TPMS, Noise, Grain)
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
| **Noise Explorer** | `noise` | All 7 noise types: simplex, cellular, FBM, ridged, billow, curl, warp |
| **Grain Explorer** | `spinodoid` | VMF-sampled wave superposition, all directional modes (single, orthotropic, isotropic) |
| **Grain Explorer** | `gaussian` | Gaussian random field with spectral envelope |
| **Grain Explorer** | `hyperuniform` | Jittered-grid kernel field |

All geometry modes are supported: sheet, half-solid, solid, and PI-TPMS (two-phase intersection).

---

## Getting a recipe into the mesher

### One-click from the design tool (recommended)

Every F13LD design tool has an **⬡ Open in F13LD.mesh** button in its header. Click it and the current recipe opens in the mesher pre-loaded — no file download, no copy-paste.

The recipe is URL-encoded as a `?r=` query parameter. The resulting URL is bookmarkable and shareable.

### Drop or pick a file

Drag a `.json` recipe file onto the drop zone, or click **or pick a file** to browse. The recipe is recognised automatically and the preview renders.

---

## Export controls

### Domain size

Sets the physical size of the output scaffold cube in millimetres. Default 10 mm, range 1–100 mm.

The scaffold always fills the full domain — a 10 mm domain produces a 10 × 10 × 10 mm cube with one or more unit cells inside, depending on the `cell_scale` or `frequency` set in the source tool.

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

All SDF evaluation runs in a `[-5, 5]³` world space. The TPMS and Grain evaluators map this to `[-π·cellScale, π·cellScale]` to match the coordinate system used by their respective source tools. Noise evaluators use `[-5, 5]` directly with a 16³ prepass normalisation step. All SDFs return positive-inside values (Manifold convention). The box boundary is intersected via a max() SDF operation to ensure the mesh closes cleanly at the domain edges.

---

## Architecture

Single HTML file. No build step, no npm, no server.

**Libraries loaded from CDN at runtime:**
- [Manifold 3.4.1](https://github.com/elalish/manifold) — WASM mesh kernel (LevelSet, manifold guarantee, 3MF-friendly topology)
- [Three.js r158](https://threejs.org) — 3D preview with OrbitControls
- [fflate 0.8.2](https://github.com/101arrowz/fflate) — ZIP compression for 3MF packaging

**SDF evaluators** are ported verbatim from their source tools (TPMS Builder, Noise Scaffold Explorer, Grain/Spinodoid Explorer) and produce numerically identical output. The noise simplex evaluator matches the GLSL shader output exactly. The grain wave evaluator uses the same Mulberry32 RNG and VMF sampling as the GPU raymarcher.

**3MF output** is a hand-built ZIP containing `[Content_Types].xml`, `_rels/.rels`, and `3D/3dmodel.model`. Vertex coordinates are in millimetres. Triangle winding follows the 3MF spec (CCW from outside). Manifold guarantees watertight, non-self-intersecting output — no mesh repair required downstream.

---

## F13LD suite

| Tool | Description |
|---|---|
| [f13ld.tpms-builder](https://mshomper.github.io/f13ld.tpms) | Periodic TPMS surface design with PI-TPMS and FFT-CG homogenisation |
| [f13ld.noise](https://mshomper.github.io/f13ld.noise) | Stochastic noise scaffold explorer |
| [f13ld.grain](https://mshomper.github.io/f13ld.grain) | Spinodoid / Gaussian / hyperuniform anisotropic grain fields |
| **f13ld.mesh** | This tool — implicit scaffold → watertight 3MF |

All tools share a common JSON recipe schema. Any recipe exported from one tool can be ingested by f13ld.mesh.

---

## Known limitations

- Gradient mode (spatially-varying cell scale) in TPMS recipes is parsed but not yet applied in the mesher — gradient recipes export at uniform cell scale
- Domain shape is cubic only; non-box clipping geometries are planned for a future release
- Fine quality at large domain sizes (e.g. 80 mm Fine) may take 30–60 seconds in-browser due to the density of SDF evaluations; use Standard for iteration and Fine for final export

---

## Credits

Built by [Not a Robot Engineering](https://notarobot-eng.com) as part of the F13LD computational materials design suite.

Manifold geometry kernel by [Emmett Lalish](https://github.com/elalish/manifold).
