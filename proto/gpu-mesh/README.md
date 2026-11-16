# GPU mesh prototype (expedition spike)

**GPU path written but not executed by the expedition.** The expedition had no GPU. The CPU reference and its selftest were run; the WebGPU page was only read and syntax-checked, so it may need fixes on first run. No GPU speed number exists yet.

## What it is
A small standalone page that meshes a TPMS wall (gyroid, Schwarz-P, diamond) with **marching tetrahedra in WebGPU compute shaders**: field evaluation, per-point/per-cell counts, a multi-level exclusive prefix-sum (stream compaction), then emit of **shared vertices** (one per crossed grid edge) and **indexed triangles**. It draws the result (orthographic, wheel zoom, right-drag orbit, middle-drag or shift+right-drag pan, left-drag does nothing, pinch zooms). It does not touch any existing F13LD.mesh file.

Method note: this uses a cube split into 6 tets (Kuhn/Freudenthal), not the body-centred lattice of `worker/m34-slab-mesher.js`. Same method, different lattice: not a byte-parity target. Crossings are held 1e-4 of an edge off grid points (like `SLAB_TCLAMP`). The field is padded negative on the outer layer so every part is closed. Fields are positive-inside, wall form `f = wall - |g|`; sphere `f = r - |x - c|`.

Files: `tables.mjs` (single source of truth; the WGSL tables are generated from it by `wgslTables()`), `cpu-mesher.mjs` (reference), `meshcheck.mjs` (closed-mesh check, volume), `selftest.mjs`, `gpu-mesher.mjs`, `viewer.mjs`, `main.mjs`, `index.html`, `serve.mjs`.

## Check the CPU reference (Node, no install)
From the repository (or worktree) root: `node proto/gpu-mesh/selftest.mjs`. Exits 0 only if every mesh is closed with positive volume and the sphere volume is within 1 % of 4/3 pi r^3. `--break` drops a triangle per mesh and must fail with `OPEN_EDGES`.

## Run the GPU page on your PC (no install)
1. Open a terminal in the worktree root (`.claude/worktrees/exp-20261116-which-gpu-mesh-techniques-are-worth-adop-2`).
2. `node proto/gpu-mesh/serve.mjs` (Node is already installed; if you prefer Python: `python -m http.server 8090` and open `/proto/gpu-mesh/`).
3. Open `http://localhost:8090/` in Chrome or Edge (modules do not load from `file://`).
4. It meshes a 64 gyroid once on load. Look at the log panel (right side): shader compile messages and GPU errors appear there as text.
5. Press **Compare with CPU** (two-rectangles icon). Expect PASS lines for triangle count, vertex count, vertex positions (tolerance 1e-3 of a cell), identical index lists and closed mesh. The GPU field is float32 while the CPU reference computes in float64, so small position differences are expected and a rare count difference near zero-field points is possible.
6. Press **Bench** (stopwatch icon): runs N=64 and 128 (1 warm-up + 5 repeats, median), and 256 only if buffer limits allow, otherwise it prints `skipped: buffer limits`.
7. Press the **copy** icon (or select the log) and paste the whole log back, especially the block between `=== F13LD.mesh GPU mesh bench` and `=== end ===`.
8. Optional: the download icon saves a binary STL (box scaled to 20 mm) for inspection.

If WebGPU is missing the page says so in plain words (use current Chrome or Edge).
