# proto/gpu-bake: GPU field bake prototype

New files only; nothing existing was changed. Question: can the open-cube field bake run on the GPU in float32 and still give the byte-identical mesh the CPU float64 bake gives?

## Run

| What | Command (from the worktree root) |
|---|---|
| Node selftest, no GPU (about 10 s, 6 threads) | `node proto/gpu-bake/selftest.mjs` |
| Negative control | `node proto/gpu-bake/selftest.mjs --expect-break` |
| One-core CPU timing, real worker code (about 20 s) | `node proto/gpu-bake/cpu-bench.mjs` |
| The page, served | `node proto/gpu-bake/serve.mjs` then open `http://localhost:8091/` |
| The page, double-click | `proto/gpu-bake/gpu-bake-single.html` (rebuild: `node proto/gpu-bake/build-single.mjs`, check: `node proto/gpu-bake/check-single.mjs`) |
| Headless smoke test of the page | `node proto/gpu-bake/smoke.mjs file` (or a served URL); `SMOKE_FLAGS` adds browser flags |

Page buttons (icons, hover for the label): **Compare** (families x 64 and 128), **Bench**, **Copy log**. Paste back the block between `=== F13LD.mesh GPU bake bench` and `=== end ===`. Without WebGPU or an adapter the page says so in plain words.

## What is compared

* **CPU side** = the real worker code (`worker/m05 .. m32`, loaded by `lib/loader.mjs` in one function scope, the same files `field-bake-worker.js` imports). The field is `buildExportField(d, edge)` for an open-cube job, i.e. `p => -sdf(p)`; grid points follow `weldGridDims` / `weldBakeLayers` (m31): `n = trunc(10/edge + 1) - 1`, main points `min + s*i`, offset points `min + s*(j - 0.5)`, main lattice first then the offset lattice. `lib/grid.mjs` re-writes the walker; selftest proves it equals the real one.
* **GPU side** = WGSL float32 compute kernels (`lib/wgsl.mjs`): TPMS term-list gyroid sheet / solid, and Grain spinodoid. One f32 per point in the same order. Coordinates are the exporter's float64 coordinates rounded once to float32 (small tables), not recomputed on the GPU. The PI-TPMS pair, the gradient-normalised shell and GRF / hyperuniform are not built (dropped for time).
* Spinodoid: the wave vectors and phases come from the real generator `buildSpinodoidWaves` (m11, xorshift) on the CPU and are uploaded; no random number is drawn on the GPU.
* **Whole-grid numbers come from the CPU.** The spinodoid export field normalises by `fieldMid / fieldHalfR` from `recipe._previewFieldMin/Max` (the preview bake's range, cached on the recipe by the app; m30 `buildSDF` -> m22) or, when absent, from a 16^3 pre-scan over world [-5,5]. Float32 cannot supply a global min / max, so the page takes it from the CPU (`lib/params.mjs`) and uploads it. Selftest and the page set `_previewFieldMin/Max` from a 32^3 raw scan of the real spinodoid field (standing in for `runPreviewBake`). TPMS has no whole-grid number. `cN` and `hN` are also computed on the CPU.

## Sign convention

Everywhere: **field = -sdf = Manifold's convention, positive inside**, exactly what m90 hands `levelSet` for an open cube (`cubeFn = p => -sdfFn(p)`). "Inside" is `value > 0` (the slab mesher's `v>0`); a sign change on an edge is `(a>0) !== (b>0)`. The GPU kernels compute the canonical sdf and negate it.

## Which edges the mesher reads

m34 (and Manifold's levelSet) tetrahedralise the BCC grid: two neighbouring cell centres (offset-offset axis edge) plus one edge of their shared face (main-main axis edge), plus the four main-to-offset diagonals. Over the grid that is every axis edge of both lattices and every `main(i,j,k)-offset(i+dx,j+dy,k+dz)`, `dx,dy,dz in {0,1}` (`forEachEdge`, `lib/grid.mjs`; 14 neighbours per interior point).

## Float32 emulation (NOT a GPU)

`lib/emu.mjs`: the kernels' operations in the same order with `Math.fround` after each; sin / cos are correctly rounded float32 results, better than any GPU. It shows what plain float32 arithmetic does; it cannot show a GPU's sin / cos error or fused multiply-add. A float64 mirror of the same kernel code (no rounding) equals the real field bit for bit (selftest), which proves the kernel formulas and operation order.

## Hybrid pass

Input: float32 values. (a) Re-evaluate in float64 on the CPU every point with `|f32| < BAND` (or not finite); (b) then every point at either end of a lattice edge whose signs still differ. Judged against the CPU bake: (i) every sign equal, (ii) float64 values at both ends of every sign-changing edge equal the CPU bake bit for bit, (iii) escapes = wrong-sign float32 points that were not re-evaluated = 0. **(iv) added by the builder: max |f32 - CPU| <= BAND** ("band holds"). Reason: rule (b) repairs almost any wrong sign by itself, so (i)-(iii) still pass when the float32 error is 3x larger than the band the budget assumed. A 1e-6 perturbation shows it: (i)-(iii) PASS, (iv) fails. The negative control uses (iv). `pass` = (i)-(iii); `certified` = pass and (iv).

The re-evaluated share is dominated by (b): the ends of sign-changing edges (8-56 % of points at these grids), not by the band (about 0.003 %).

## BAND derivation (fixed in code before any compare, `lib/bands.mjs`)

Computed only from the kernel parameters (term coefficients / frequencies, wave vectors, the normalisation range); never from the CPU bake of the judged grid. Per-operation float32 round-off `u = 2^-24` counted along the real data flow, added in quadrature, plus an absolute error `ESC` per sin / cos, times a coverage factor `K = 2`. Argument error is `3uA` (`5uA` when the kernel range-reduces), `A` the largest argument magnitude.

| ESC | value | status |
|---|---|---|
| emulation | 2^-24 | exact for `Math.fround(Math.sin)`; the selftest band |
| assumed GPU | 2^-16 | **assumption**, not proven; the page reports the observed GPU error and escapes, so it is measured |
| WGSL spec | 2^-11 | the only **proven** band, and only inside [-pi, pi] and only if the driver honours the spec |

The kernels range-reduce the argument into [-pi, pi] when the field's arguments exceed pi (`maxArg` printed per family), because WGSL promises accuracy only there. The observed emulation error is 4.8x to 14.6x inside the band. K = 2 is the smallest factor that still lets the negative control fire; do not read K as a proof. Identical files across PCs follow from the float64 re-evaluation plus the proven spec band, not from a measured band.

## What the numbers mean

* **max abs diff**: largest `|f32 - CPU float64|` over all points (field units).
* **sign changes**: points whose float32 sign differs from the CPU sign.
* **re-evaluated share**: re-evaluated points / all points; split into band and edge-end parts.
* **escapes**: see (iii). **band holds**: see (iv).
* **CPU skip share (rigorous Lipschitz bound)**: share of points with `|f| > L*e`, `L` a rigorous Lipschitz bound from the kernel parameters, `e` the longest lattice edge: what a CPU-only skip could avoid.
* Page Bench: setup (requestAdapter + requestDevice, shader compile) timed once at load; per grid GPU dispatch + readback (median of 5, timestamp-query too when available) beside the CPU one-thread bake (a sample of points scaled to the grid), then the hybrid pass split into CPU scan and CPU re-evaluation and the total hybrid wall time.
* `cpu-bench.mjs` microseconds per point are one core of the machine that ran it, through `buildExportField` (no Manifold, no levelSet callback overhead).

## Known limits

Not run by the expedition: any GPU. The headless browsers on the build machine exposed no WebGPU adapter (not even a fallback one), so the WGSL kernels were never executed; they are compile-checked only by the page on a machine with WebGPU. Grids over the adapter's `maxStorageBufferBindingSize` are skipped with a reason (slab splitting is not built).
