# Report: how should F13LD.mesh bake its fields on the GPU

Expedition 20261119-how-should-f13ld-mesh-bake-its-fields-on · Lead exp-lead-3 · 2026-11-19

**Nothing about GPU speed in this report was run by the expedition.** Every GPU speed figure is marked "not run by the expedition" and is in the click tests (section 5) for Matt to run. CPU figures marked "measured by the expedition" come from `proto/gpu-bake/cpu-bench.mjs` on one core of an AMD Ryzen 7 7700X, the same CPU model as Matt's.

## 1. Answer

**Don't port the field bake to the GPU now.** On today's exports the field is already a small part of the time. A GPU bake that keeps files byte-identical also gives back a good share of what it saves.
- **The field is cheap now.** Measured on one core with the real export code, a field point costs 0.08 µs (gyroid, sheet mode) to 1.7 µs (foam).
  - For a default 10 mm open cube at High (2.85 M grid points), that is 0.04 to 0.34 s: one core for gyroid and beam, where the pool doesn't start, and 15 cores otherwise.
  - That is about 1 to 15 % of a classic export (projected). The one-core level set is most of the rest.
  - These per-point costs are 3 to 26 times lower than the table in the 2026-10-15b recap, which timed older code, most likely on a 2-core dev VM (F2).
- **Where it could matter:** big shape-clipped parts and weld region bakes.
  - Shape-clipped parts of 60 to 100 M points: projected field 0.3 to 4.9 s on 15 cores, plus a one-core coarse pass of up to 1.6 s (whole-box upper bound).
  - Welds: the bench doesn't time the weld field bake at all, so its size is unknown (click test C).
- **Byte-identical GPU files can't be promised.**
  - WGSL only promises sin and cos to 2⁻¹¹ inside [−π, π], and it lets the compiler reorder and fuse operations. So any error band is measured on one GPU, not proven.
  - The prototype's hybrid keeps files identical: the GPU bakes the far field, then the CPU redoes the surface in float64. It worked in emulation and on a software GPU.
  - But it has to redo **9 % (gyroid) to 19 % (spinodoid) of the points at High**, and 4 to 62 % across grid sizes. Those points are the two ends of every edge that crosses the surface, not a thin band.
- **Do first, on the CPU (byte-identical by construction):**
  - get the stage numbers from Matt's PC (click tests B and C);
  - move the shape-clipped coarse pass onto the pool;
  - let the slab pool use all 15 cores (it uses 9 on a 10 mm High cube);
  - bake once for Auto's slab retry;
  - skip far-field blocks with a Lipschitz bound. The prototype finds 42 to 62 % of points skippable for a one-cell gyroid, but 0 to 7 % for dense fields.
- **If a GPU bake is built later:** put it behind an opt-in setting that allows GPU-dependent files, for big shape-clipped exports only. Port the TPMS term lists (including the PI pair) and grain spinodoid / GRF. Leave foam, noise rev 1 and rev 2, beam, wave, bundle and hyperuniform on the CPU.

## 2. Findings

Citation tags: **[code]** = notes-code.md (repo survey, file:line inside); **n1–n8** = gatherer notes; **[R15b]**, **[R10-17]**, **[R16c]** = the session recaps 2026-10-15b, 10-17, 10-16c; **[bench]** = `cpu-bench.mjs` output; **[selftest]** = `selftest.mjs` output; **[V]** = verify/VERDICT.md (the Verifier's runs); **[SK]** = SKEPTIC.md. "Projected" = arithmetic shown, not measured.

### F1. Where export time is reported today
- **Classic mesher (Auto's first choice):** `msBreakdown.field` is the pool's wall time (m33:136). Below 200 k points, or when a timed sample says the pool won't pay (one-core field under 0.4 s), the field runs inside the level set and is not split out [code §A3, §A6].
- **Slab mesher:** `msBreakdown.field` is 0. Each slab worker evaluates its own field inside its `mesh` job, together with marching tets and the per-slab simplify (`field-bake-worker.js:57-68`), so the field is inside `stages.mesh` [code §A4]. Neighbouring slabs evaluate the shared layers `[La−2, Lb+4)` twice [code §A5]. The slab pool uses `min(cores, floor((layers − 2) / 24))` workers (m36:119), which is 9 on a 10 mm High cube [SK H3].
- **Shape-clipped coarse pass:** one core, direct field, `Manifold.levelSet`, about 1/64 of the fine points. Not reported anywhere (m90:288) [code §A6].
- **Welds:** the region field is pre-baked on the main thread (`14-weld-bake.js bakeWeldRegion`) before the job reaches the mesh worker. Its time goes to `bakeMs` in the `[export][weld]` console line (`61-export.js:114`), not into `stages`. **The bench page starts timing after that bake, so the weld bench times exclude the weld field** [code §A6, §B].
- **Auto bakes the field twice on torn parts:** a classic attempt bakes the field in the pool. If the result is torn or runs out of memory, the slab retry evaluates the field again, because `trySlab` passes no lookup (m90:61, 354-358, 466-474) [SK M2].

### F2. Measured field cost per point (one core, real export code)
`cpu-bench.mjs` loads the worker files as the repo's Node tests do and builds the field with `buildExportField`. It then times one field call per point on a strided walk through the 64³ export grid (`lib/grid.mjs`, the same coordinate arithmetic as m31, checked by the selftest) [bench; V]. Two runs on the same machine differed by up to about 10 % [V]. µs per point (each value within that 10 % of both runs):

| family | measured by the expedition | 2026-10-15b recap (one core, older code) |
|---|---|---|
| TPMS gyroid, sheet mode (fixture) | 0.08 | 1.15 (before `compileTermsList`) |
| TPMS PI field pair | 0.85 | 10.5 (before `compileTermsList`) |
| grain spinodoid | 0.94 | 5.42 |
| grain GRF (built from defaults) | 0.95 | none |
| grain hyperuniform | 0.47 | none (older per-evaluation list: 58, before the v0.9.10 index) |
| noise rev 1 | 0.20 | 5.17 |
| noise rev 2 (fixture with `noise_rev` set) | 0.21 | none |
| foam open Lloyd / plateau Poisson | 1.52 / 1.71 | 4.24 |
| wave cubic | 0.24 | none |
| beam BCC | 0.12 | 1.39 |
| bundle twist / helicoid | 0.89 / 0.38 | none (older per-evaluation list: 101) |

- The default TPMS mode is "shell" with gradient normalisation (m20:173, 196). It evaluates the field several more times per point, so it costs more than the sheet fixture. Its cost was not measured.
- **Why the recap numbers are 2.8 (foam) to 25.9 (noise rev 1) times higher (explained in part, not proven).** These recap figures are not Matt's bench. The recap timed the field inside a one-core export of pre-v0.11.0 code, most likely on the 2-core dev VM (R15b line 32 says the session's VM had 2 cores; lines 5-14 name no machine). Its field column likely also included Manifold's WASM-to-JS callback for every point. The TPMS rows predate the compiled term lists [R15b].
- As a cross-check, the Verifier's own whole-grid timing (2.09 M points, sequential) gave the same or lower figures: gyroid 0.06, PI pair 0.61, spinodoid 0.56, noise 0.15, beam 0.09, foam 1.17 µs/pt [V].

### F3. Grid sizes per export quality
Edge per quality: draft 0.40, low 0.20, med 0.12, high 0.09, ultra 0.075 mm (`40-mesh-worker-host.js:26`). The grid is the body-centred main + offset lattice of m31. Open cube [bench]:

| quality | 10 mm domain (default) | float32 | 20 mm domain | float32 |
|---|---|---|---|---|
| draft | 37,259 | 0.15 MB | 273,259 | 1.1 MB |
| low | 273,259 | 1.1 MB | 2,091,509 | 8.4 MB |
| med | 1,206,829 | 4.8 MB | 9,399,095 | 37.6 MB |
| high | 2,847,825 | 11.4 MB | 22,328,991 | 89.3 MB |
| ultra | 4,866,479 | 19.5 MB | 38,282,995 | 153 MB |

Shape-clipped example: a 50 mm cube part (56 mm padded box) is about 5.7 M points at draft (22.7 MB) and 44.6 M at low (178 MB). From med up, the family voxel caps clamp it to about 100 M points (TPMS), 80 M (noise, grain, wave, bundle) or 60 M (foam, beam), which is 240 to 400 MB [code §B]. The CPU pre-bake already stores Float32 above 25 M points and does not pre-bake above 150 M (m33:20-24).

### F4. WGSL float32 accuracy (the spec, opened by the Skeptic)
From the WGSL spec source (`gpuweb/gpuweb` `wgsl/index.bs`) and the CTS floating-point primer [SK H2]:
- sin, cos: "Absolute error at most 2^-11 when x is in the interval [-π, π]"; outside it "the accuracy is undefined".
- exp, exp2: "3 + 2 * |x| ULP".
- x / y: "2.5 ULP" (for |y| in [2⁻¹²⁶, 2¹²⁶]).
- +, −, ×: correctly rounded.
- sqrt: inherited from 1 / inverseSqrt (2 ULP).
- "An implementation may reassociate operations." It may also fuse them if the result is at least as accurate.
- "WGSL does not specify a rounding mode."
- Implementations "may assume that overflow, infinities, and NaNs are not present". So the CPU's NaN guards can't be carried into a shader.
- WGSL has no concrete f64 type (n1, n4).
- Double-float (df64) libraries exist (jesedv/df64: about 48 bits, no throughput figures, n4). They have no sin, cos or exp, and their correctness depends on rounding points WGSL need not preserve (luma.gl, n1).

**So no error band can be proven from the spec at the arguments these fields use.** Spinodoid's cosine argument reaches 21.7 rad in the open cube [selftest], and shape-mode TPMS arguments grow with absolute position. The prototype reduces arguments into [−π, π] before calling sin or cos, but the compiler may reorder that reduction. Any band is a measurement on the GPU it ran on. No measurement of differences between GPU vendors was found (n1).

### F5. What the prototype measured
**Float32 emulation in Node** (`Math.fround` after every operation; not a GPU) [selftest]:
- The page's CPU reference equals the real export field (`buildExportField` + `weldBakeLayers`) bit for bit at all 562,121 points of a 64³ grid, for TPMS gyroid, TPMS at 4 cells and spinodoid.
- A float64 mirror of the kernel formulas also matches bit for bit, so the kernels compute the same formula in the same order.

| case | max abs difference | points that change sign | re-evaluated share (hybrid) | CPU Lipschitz skip share |
|---|---|---|---|---|
| TPMS gyroid 64³ | 5.84e-7 | 0 | 16.17 % | 41.9 % |
| TPMS gyroid 128³ | 5.84e-7 | 0 | 8.12 % | 62.0 % |
| TPMS 4 cells 64³ | 1.26e-6 | 705 | 56.08 % | 0.0 % |
| spinodoid 64³ | 8.16e-7 | 1 | 31.67 % | 0.05 % |
| spinodoid 128³ | 8.61e-7 | 2 | 16.84 % | 7.4 % |

- **The hybrid** passed every check. It takes GPU float32 everywhere, then redoes on the CPU in float64 every point with |f| under a fixed band, then both ends of every edge that changes sign, repeated until no point is added. Result: all signs equal, float64 values bit-equal at both ends of every crossing edge, 0 escapes, band held.
- The band itself catches 0 to 0.27 % of points; the crossing-edge ends are the rest of the re-evaluated share. So the hybrid's CPU cost is roughly the share of points next to the surface. It grows with the number of cells and shrinks as the grid gets finer.
- **Negative control:** a 1e-6 relative change to one kernel constant gives a max difference of 6.3e-6 to 4.0e-5 and a hybrid FAIL in 4 of 4 runs.
- **CPU Lipschitz skip share:** the points where |f| exceeds a rigorous bound (L × edge length). A CPU pass could fill those with their sign and never evaluate them exactly. The share is large for a one-cell gyroid (42 to 62 %) and 0 to 7.4 % for the 4-cell gyroid and spinodoid (spinodoid's bound, L = 5.06, is loose).
- The emulation bands (3.1e-6 to 1.8e-5) are 4.8 to 14.6 times the observed emulation error. They are assumed bands, not spec bounds.

**On a software GPU** (SwiftShader in headless Chrome 157; substitute environment, not Matt's GPU; no speeds quoted) [V]. The real WGSL kernels ran, served and from the single file, with no shader or validation errors:
- The GPU error was much larger than the emulation's: max abs difference 4.33e-4 for gyroid and gyroid at 4 cells, and 1.47e-4 to 1.57e-4 for spinodoid. That is 180 to 740 times the emulation's error, close to the spec's 2⁻¹¹ (4.9e-4) sin/cos allowance.
- Points with a different sign, 64³ / 128³: gyroid 0 / 288, gyroid 4 cells 717 / 717, spinodoid 40 / 276.
- With an assumed GPU band of 2⁻¹⁶, only the "band holds" check fails, in every case. Spinodoid's edge rule needed a second round.
- With the spec band of 2⁻¹¹, all four checks pass, with 0 escapes. The band itself catches 0.24 to 0.47 % of points.
- **Re-evaluated share at the export grids** (10 mm domain, draft / low / med / high / ultra):
  - gyroid: 38.8 / 20.5 / 12.5 / 9.3 / 7.8 %;
  - spinodoid: 61.5 / 38.6 / 25.3 / 19.3 / 16.2 %;
  - at 256³: 4.1 % (gyroid) and 8.5 % (spinodoid).

So a hybrid sized from the spec's 2⁻¹¹ held on this software GPU at little extra cost. But the bound only covers [−π, π], and the compiler may reorder the range reduction, so it remains a measurement per GPU. What an NVIDIA driver gives is click test A.

### F6. WebGPU limits and plumbing
- **Limits.** Defaults: `maxStorageBufferBindingSize` 128 MiB, `maxBufferSize` 256 MiB, 65,535 workgroups per dimension, 256 invocations per workgroup. Higher limits come only through `requiredLimits` when the adapter reports them (W3C spec, MDN; n2).
  - The only raised value the expedition saw is SwiftShader's 1 GiB for both (substitute) [V].
  - What Chrome reports for an RTX 4070 Ti Super was not found (n2, n5). The page prints it.
- **Workers and browsers.** `navigator.gpu` exists in Web Workers, secure context only (MDN, n5). Chrome and Edge on Windows have it since 113, Firefox on Windows since 141 (web.dev, n2).
- **Adapters and time-outs.** `requestAdapter` can return null; check `isFallbackAdapter` (MDN, n5). The Windows `TdrDelay` default is 2 s (Microsoft Learn, n5), so long dispatches must be split.
- **Timing and readback.** Timestamp queries need the `timestamp-query` feature and are quantised to 100 µs (Chrome 121 post, n5). `mapAsync` needs MAP_READ, an offset that is a multiple of 8 and a size that is a multiple of 4 (MDN, n5). No readback bandwidth figure was found.
- **Grids.** Hardware texture filtering snaps to 1/256 texel (Reed Beta, n3), and float32 filtering is an optional feature (Chrome 119 post, n3). So shape SDF and hyperuniform grids must be sampled with manual trilinear from a storage buffer.
- **Foam.** Jump flooding is approximate (demofox, NUS JFA page; n3, n6), so it can't stand in for foam's exact distance.

### Time breakdown (checklist item 2)
Labels: **M** = Matt's bench (recap named); **E** = measured by the expedition (cpu-bench, one core, ±10 %); **P** = projected.
- Projected field = E µs/pt × points ÷ 15 cores, or one core where the pool would be skipped (one-core field under 0.4 s or under 200 k points), marked 1c. Pool start-up (setup × 1.5 + 120 ms, m33:69) is not added.
- Shape-clipped = the 50 mm cube part in F3, with about 71 % of points inside the part (the lattice is skipped outside, m32:169). The open-cube µs/pt is applied; the extra cost of shape sampling is not included.
- Coarse pass = one core, 1/64 of the capped fine points, direct field, whole box. This is an upper bound: the 71 % inside share is not applied, though the coarse pass skips the lattice outside the shape too.

**The table, all families (seconds; P unless labelled).**

| family | E µs/pt | field, open cube 10 mm: draft · low · med · high · ultra | field, shape-clipped 50 mm: draft · low · med and up (cap) | coarse pass at cap (one core, whole box, upper bound) |
|---|---|---|---|---|
| TPMS gyroid (sheet) | 0.08 | 0.003 · 0.02 · 0.10 · 0.23 · 0.39 (all 1c) | 0.32 (1c) · 0.17 · 0.38 | 0.12 |
| TPMS PI pair | 0.85 | 0.03 1c · 0.23 1c · 0.07 · 0.16 · 0.28 | 0.23 · 1.80 · 4.03 | 1.33 |
| noise rev 1 | 0.20 | 0.01 1c · 0.05 1c · 0.24 1c · 0.04 · 0.06 | 0.05 · 0.42 · 0.76 | 0.25 |
| noise rev 2 | 0.21 | 0.01 1c · 0.06 1c · 0.25 1c · 0.04 · 0.07 | 0.06 · 0.44 · 0.80 | 0.26 |
| grain spinodoid | 0.94 | 0.04 1c · 0.26 1c · 0.08 · 0.18 · 0.31 | 0.25 · 1.99 · 3.57 | 1.18 |
| grain GRF | 0.95 | 0.04 1c · 0.26 1c · 0.08 · 0.18 · 0.31 | 0.26 · 2.01 · 3.61 | 1.19 |
| grain hyperuniform | 0.47 | 0.02 1c · 0.13 1c · 0.04 · 0.09 · 0.15 | export reads a Float32 HU grid baked on the main thread; that bake is not timed [code §C3] | not separate |
| foam (plateau) | 1.71 | 0.06 1c · 0.03 · 0.14 · 0.32 · 0.55 | 0.46 · 3.62 · 4.87 | 1.60 |
| wave | 0.24 | 0.01 1c · 0.07 1c · 0.29 1c · 0.05 · 0.08 | 0.06 · 0.51 · 0.91 | 0.30 |
| beam | 0.12 | 0.004 1c · 0.03 1c · 0.15 1c · 0.34 1c · 0.04 | 0.03 · 0.25 · 0.34 | 0.11 |
| bundle twist | 0.89 | 0.03 1c · 0.24 1c · 0.07 · 0.17 · 0.29 | 0.24 · 1.88 · 3.38 | 1.11 |
| imported shapes | no field per point | no open cube: a shape is always clipped to its own box | the shape SDF grid is baked on the main thread before export (about 4 µs per voxel by the estimate constant), not timed in export [code §C8, §D] | n/a |
| welds | per member | no open cube: weld members are shapes | the main-thread region bake (`bakeMs`) is not on the bench; projected 4.7 to 24 s at High [SK M3] | n/a |

Example: spinodoid, open cube, high: 0.94 µs × 2,847,825 = 2.68 s on one core; ÷ 15 = 0.18 s.

**The other stages (the same for every family at a given grid size, because they scale with points):**

| case | field | mesh | simplify / final pass | union | clean-up | total |
|---|---|---|---|---|---|---|
| Open cube 10 mm High, classic | 0.04–0.34 (table above) | level set on one core 2.0–4.6 (P: the recap's 0.70–1.6 µs/pt × 2.85 M; dev VM, older code) | inside the level-set figure (the estimate constant of 2.0 µs/pt covers both) | none (one body) | not reported | about 2.0–4.9 (P) |
| Open cube 10 mm High, slab | inside "mesh" (F1): 0.03–0.68 on 9 workers incl. the 25 % halo (P) | 0.51 at the estimate constant (1.6 µs/pt × 2.85 M ÷ 9 workers), incl. per-slab simplify | rounds A / B, rows, flips: no single-body figure in any recap (click test B) | none | not reported | unknown |
| Open cube 20 mm High (22.3 M points), classic | 0.12–2.5 (P) | level set 16–36 on one core (P) | inside the level set | none | not reported | about 16–38 (P) |
| Shape-clipped 50 mm, med and up, slab | 0.34–4.87 + coarse pass 0.11–1.60 (table above) | 6.4–10.7 at the estimate constant (60–100 M points ÷ 15) | not in any recap | none | not reported | unknown. The one measured big slab case is a 20 × 20 × 40 mm part at High: 93 s in the v0.15.0 session [R16c line 3] |
| Weld solid + foam + solid, High, 15 cores (M, R10-17) | main-thread bake, not on the bench | slabs 3.77 (lookup only) | round A 2.10, round B 1.29, rows 0.24, flips 0.62 | 2.15 | about 0.5 (the unlisted rest) | 10.7 |
| Weld solid + gyroid + solid (M, R10-17) | not on the bench | the recap gives the total only | total only | total only | total only | 6.21 |
| Weld two gyroids (M, R10-17) | not on the bench | total only | total only | total only | total only | 8.77 |

**Reading across:**
- On the default 10 mm cube, the field is about 1 to 15 % of a classic export (projected).
- On big shape-clipped parts, the field plus the one-core coarse pass is a few seconds, against mesh stages of 6 to 11 s or more.
- For welds, the one field number that matters is not measured.

### Per-family GPU bake (checklist item 3)
How the gain is worked out:
- The ceiling is the family's field time from the table at **High**: open cube 10 mm, and shape-clipped at the cap.
- With GPU-dependent files (option c) the gain is at most that ceiling. With the byte-identical hybrid (option a) it is at most ceiling × (1 − r).
- r = 9.3 % for gyroid and 19.3 % for spinodoid at High (software-GPU Bench, F5). Other families' r is unmeasured; 19.3 % is used as a stand-in, labelled "r?".
- **The shape-cap hybrid gains are upper bounds.** r depends on grid points per lattice period, and the capped grid is coarser than High (edge 0.15 to 0.18 mm against 0.09). At a 10 mm cell its r sits between low and med: about 12.5–20.5 % for gyroid and 25.3–38.6 % for spinodoid. For spinodoid that gives a hybrid gain of 2.19–2.67 s, not 2.88.
- Both are before GPU bake + readback, device and shader compile, and the CPU edge scan, all not run by the expedition.
- "Whole-grid number" = a min / max or prepass that feeds the field. Float32 can't reproduce it, so it stays a CPU-computed uniform.

| family | ports cleanly | hard part | whole-grid number | effort | risk | gain at High: open cube · shape cap (option c / hybrid) |
|---|---|---|---|---|---|---|
| TPMS (term lists) | sum of coef × sin/cos products; `compileTermsList` already walks the list once and could emit WGSL. Sheet kernel built and checked [selftest, V] | shape-mode arguments grow with position and need range reduction; shell normalisation divides by a finite-difference gradient (step 0.012), which magnifies float32 error. Not built | none for a plain sheet | S open cube / M shape modes | low / medium | 0.23 / 0.21 · 0.38 / ≤ 0.34 (0.30–0.33 at a 10 mm cell). **Not worth it alone** |
| TPMS PI field pair | same emitter, 14 evaluations per point | the angle-corrected distance and gradient evaluations in float32 need a wider band, so a higher r | yes: `ampB` from a 16³ RMS prepass (CPU) | M | medium | 0.16 / 0.13 r? · 4.03 / 3.25 r? |
| noise rev 1 | structure only | **its float64 constant**: `0.142857142857` is just below 1/7 in float64, but its nearest float32 is above, so a plain port picks different gradient indices. An integer shim could reproduce it [SK L1] | yes: noise prepass normalisation (16³ prescan or the preview min / max) | M–L | high | 0.04 / 0.03 r? · 0.76 / 0.61 r?. **Do not port** |
| noise rev 2 | integer hash designed to be exact on GPUs | the float parts (fbm sums, Worley sqrt) are still float32 | yes: the same normalisation | M | medium | 0.04 / 0.03 r? · 0.80 / 0.65 r?. **Do not port** |
| grain spinodoid | Σ cos(k·x + φ) / √N. **Random generator parity is not a GPU problem:** all randomness runs at build time, so the real CPU generator makes the waves and they are uploaded [code §C3]. Built and checked [selftest, V] | argument up to 21.7 rad, reduced in the kernel; no spec bound outside [−π, π] | yes: the preview range or a 16³ prescan (CPU) | S | low–medium | 0.18 / 0.15 · 3.57 / ≤ 2.88 (2.19–2.67 at a 10 mm cell) |
| grain GRF | same kernel as spinodoid | as spinodoid; no fixture in `recipes.json` | yes | S once spinodoid exists | low–medium | 0.18 / 0.15 · 3.61 / ≤ 2.91 (2.22–2.70 at a 10 mm cell) |
| grain hyperuniform | kernel sum with a cutoff; the CSR bins upload as integer buffers | the **hyperuniform kernel index** (24³ bins built lazily and cached on the array); shape mode reads a separate main-thread HU grid built by another code path (`evalHUFieldMM`) | yes | M + M (the HU grid bake) | medium | 0.09 / 0.07 r? · HU grid bake untimed. **Do not port** (time the HU grid bake first) |
| foam | seeds upload; brute force over ≤ 500 seeds is exact in structure | **foam's exact distance field**: data-dependent ring growth, a full-scan fallback, sorted smooth-min lists, tolerances 1e-9 / 1e-12 tuned for float64, ties broken by strict `>`. A flipped tie is a large error, so the band would be wide | none | L–XL | high | 0.32 / 0.26 r? · 4.87 / 3.93 r?. Most expensive per point, but **do not port now** |
| wave | mode × cos products, no state | stretch / scale arguments in float32 | none found | S | low | 0.05 / 0.04 r? · 0.91 / 0.73 r?. **Do not port** (unless it falls out of the TPMS emitter) |
| beam | capsule loop, 26 neighbour images | the trim-to-nodes byte mask to upload | none | M | low–medium | 0.34 (1c) / 0.27 r? · 0.34 / 0.27 r?. The pool already didn't pay [R15b]. **Do not port** |
| bundle | closed-form or fixed-iteration kernels | braid: 5 Newton iterations converge to different bits in float32; `pow`, atan2, `%` | unclear (the Advisor and the code survey disagree on whether m23 reads the preview min / max) | M–L | medium | 0.17 / 0.14 r? · 3.38 / 2.73 r?. **Do not port** |
| imported shapes | the shape grid is already Float32; manual trilinear from a storage buffer | the **shape SDF grid** must use the same voxel-centre rule and outside-box distance (m32:95-105); hardware filtering snaps to 1/256 texel | none (fixed input) | S, only as part of shape-clipped kernels | low | none on its own; the grid bake (BVH) is outside export |
| welds | regions already carry `main` / `off` arrays from `bakeWeldRegion` | every member's family kernel, shape sampler and blend; `unionGradNorm` = 7 evaluations per point; **weld lookups** need the exact m31 layout | per member, as its family | L (needs the member families first) | medium–high | **unknown until `bakeMs` is measured** (click test C); projected 4.7 to 24 s of field at High [SK M3] |

### Determinism options (checklist item 4)
The slab mesher's output depends only on the sign at every grid point and the values at both ends of every edge that changes sign [R16c; the selftest's check (ii)]. Whether Manifold's classic `levelSet` reads anything else was not confirmed.

| option | how | time cost | code cost | harness |
|---|---|---|---|---|
| (a) GPU far field + CPU float64 near the surface | GPU bakes every point; CPU redoes points under a fixed band, then both ends of every crossing edge until none is added | GPU + readback + compile + a sign / edge scan over every point + **r of the field on the pool** (9.3 % gyroid, 19.3 % spinodoid at High; 4 to 62 % across grids, F5) | per-family WGSL, a shared band / edge pass, a pool job type taking index lists, float64 storage for the redone points | identical to the CPU only while the band holds (0 escapes). The band is measured, not proven (F4), so **no claim of identical files across PCs** |
| (b) GPU only for the crossing search | GPU marks cells that may cross; CPU evaluates only those cells' points in float64; the other points get the GPU sign and a sentinel value | about (a) without most of the readback (1 bit per point) | GPU kernel + bitmask + sentinel arrays | the same weakness as (a); also needs proof that sentinels don't change Manifold's mesh |
| (c) GPU-dependent files behind a setting | GPU float32 values go straight into the mesher; a setting, off by default | the full saving: field − GPU − readback | the smallest: kernels + the hook + the setting | the default stays byte-identical and the harness is unchanged; GPU files are checked by shape (closed, volume), as slab exports are today with `GEOM=1` |
| (d) df64 on the GPU | pairs of float32 | "expensive", no figures (n1, n4) | write your own df64 sin / cos / exp | still not bit-equal to JS `Math.sin`; rejected |
| (e) Stay on the CPU, make it faster | coarse pass on the pool; one bake reused by Auto's slab retry; the slab pool on all cores; time the slab field and the weld bake | per item; up to 1.6 s for the coarse pass on a big part | small, inside existing files | byte-identical by construction |
| (f) Lipschitz far-field skip on the CPU | evaluate block corners; where \|f\| > L × block size, fill the block with its sign and skip it | saves the skip share: 42–62 % for a one-cell gyroid, 0–7.4 % for spinodoid and the 4-cell gyroid (F5) | small; the TPMS bound comes from the term list; distance fields (beam, bundle, foam) have L = 1 | byte-identical as long as no skipped point is the end of a crossing edge; the harness checks it |

**Recommendation:** (e) and (f) first. If a GPU bake is built, use (c), off by default, for big shape-clipped exports. Keep (a) as the page's way of measuring how far a GPU drifts. As a shipping path, (a) redoes a fifth of the field at High for spinodoid and adds a full scan, to protect a guarantee that can only be measured, not proven.

### Memory and limits (checklist item 5)
- Every 10 mm open-cube grid fits the defaults (≤ 19.5 MB), and so does a 50 mm shape-clipped part at draft (22.7 MB). A 20 mm cube at ultra (153 MB) and shape-clipped parts from low up (178 to 400 MB) exceed the 128 MiB default binding.
- Raised limits: requested through `requiredLimits` when the adapter reports them. SwiftShader reported 1 GiB for both limits (substitute) [V]. The RTX 4070 Ti Super's values are unknown; click test A prints them.
- Split along z by m31 layers into tiles of ≤ 64 MiB (about 16.7 M points). That is the same cut the bake pool and the slab pool use, and it needs no raised limits. Read each tile back through a MAP_READ staging buffer while the next one computes. Each tile can feed the matching slab's lookup slice directly.
- Use 2-D dispatch to stay under 65,535 workgroups per dimension. Size dispatches to about 100 ms or less, against the 2 s Windows TDR and so the WebGL2 preview on the same GPU doesn't stall [SK L4]. On `device.lost`, finish on the CPU.
- A hybrid needs float64 values for the points it redoes on the CPU (8 bytes each). A float32 tile layout doesn't hold them [SK M2].

### Ranked recommendations (checklist item 6)
Ranked by time saved against effort and risk.

1. **Measure on Matt's PC (no code).** Click tests B and C: the bench page's stage tables at High, and the weld `bakeMs` line. They decide whether rank 3 is ever worth doing. Effort: one bench run.
2. **CPU work, byte-identical (options e and f). Effort S–M each, risk low.**
   - Coarse pass of shape-clipped exports on the pool (m90:288). Saves up to 1.6 s of one-core time on a big part.
   - Pass the classic bake to Auto's slab retry (`trySlab` with `opts.lookup`, m90:61 → m36:114). Removes the second bake on torn parts.
   - Slab pool on all cores (m36:119, `SLAB_JOB_LAYERS`).
   - Lipschitz block skip in the bake pool (m33) for TPMS and the distance-type families (beam, bundle, foam).
   - Report the slab field and the weld bake in `stages`, so the bench shows them.
3. **GPU bake behind an opt-in setting, only if rank 1 shows the field (or the weld bake) is ≥ 20 % of big exports. Effort M, risk medium.** First the TPMS term-list emitter (sheet, then shell and the PI pair) and grain spinodoid / GRF, which the prototype already has. Then welds, once their bake time is known.
   - **Files to add:**
     - `worker/m37-gpu-device.js`: adapter and device in the mesh worker, limits, tiles, staging readback, timing, `device.lost`;
     - `worker/m38-gpu-kernels.js`: WGSL per family from recipe parameters, the TPMS emitter beside `compileTermsList`, grain waves from the real generator;
     - a main-thread twin for welds feeding `bakeWeldRegion`;
     - `tests/gpubake.js` (Node, float32 emulation, like the prototype's selftest) and a GPU column on `tests/regress.html`.
   - **What the kernel mirrors:** `worker/m32-export-field.js` is where the field is composed. That covers `buildExportField` and `exportShapeCtx`, the shape sampler, the structure transform, the trim mask and the `min(scaffold, shape)` flip. A GPU kernel takes its inputs from there and must mirror it exactly; any change to the shape-clipped field goes there (CLAUDE.md, v0.11.0).
   - **Hooks:**
     - Classic: inside `prebakeExportField` (m33:61-137), try the GPU first and return the same `{fn: makeWeldLookup(...), ms, ...}` object. It is consumed at m90:346-347 (shape-clipped) and m90:382-383 (open cube).
     - Slab: `trySlab` (m90:59-76) passes `opts.lookup = {main, off}` to `slabMeshExport`, which already accepts it (m36:114, 146-151).
     - Welds: `bakeWeldRegion` (`14-weld-bake.js:275-342`).
   - **Fallback:**
     - No `navigator.gpu`, a null adapter or `isFallbackAdapter`: the CPU pool, unchanged.
     - A shader error, limits below one tile, or `device.lost` mid-bake: finish the remaining tiles on the CPU, and log it.
     - A timed sample that predicts GPU + readback slower than the pool: skip the GPU.
     - The setting is off by default, and nothing ever blocks an export.
4. **Do not port:** foam (exact distance, high risk, ≤ 0.32 s on a default cube at High), noise rev 1 (its float64 constant), noise rev 2, hyperuniform, beam, wave, bundle (each ≤ 0.34 s on a default cube at High). Imported-shape sampling comes only inside shape-clipped kernels.

## 3. The Skeptic's objections and what changed

Full text: SKEPTIC.md. The Skeptic re-checked every projected number in the synthesis and found the arithmetic right; the objections are about the model.
- **H1 (high), the gain formula left out costs as big as the gain:** device and shader compile, the CPU sign and edge scan over every point, pool start-up for the re-evaluation, and the copies.
  - **Changed:** the headline is now "don't port now", and the GPU step depends on a measured share.
  - The page times device, compile, dispatch + readback, scan and re-evaluation separately.
  - The Skeptic predicted r of 10 to 40 %. The measured r at High is 9.3 % (gyroid) and 19.3 % (spinodoid); at draft it is 39 to 62 %.
- **H2 (high), the WGSL accuracy table:** the gatherers couldn't reach it; the Skeptic opened the spec source and closed the question (F4). **Changed:** "not reached" became "can't be proven from the spec at these arguments", with the table. The software-GPU run then showed errors close to the spec's 2⁻¹¹.
- **H3 (high), a cheaper CPU alternative was missing:** Lipschitz far-field skipping, plus the slab pool's 9-of-15-cores cap and Auto's double bake. **Changed:** added as options (e) and (f) and ranked above any GPU work. The selftest now prints the skip share.
- **M1, slab shares not reconciled with the 93 s big-part case:** the synthesis's slab-mode shares are dropped. The 93 s case is in the stage table, and Matt's bench (click test B) gives real slab stages.
- **M2, the hybrid needs float64 storage, and Auto bakes twice:** both added (memory section, F1, rank 2).
- **M3, the weld field estimate was weak:** shown as a range (4.7 to 24 s) and made click test C.
- **M4 and M5, the hyperuniform and bundle ceilings and the level-set bias:** replaced by the measured µs/pt in F2. Hyperuniform is 0.47 µs and bundle 0.89 µs per point, not 58 and 101.
- **Low:**
  - noise rev 1 could be ported with an integer shim (noted; still "do not port");
  - Matt's 15 cores are the CPU's best case, so a weaker PC gains more from a GPU (noted);
  - readback bandwidth is unlikely to be the issue;
  - the GPU is shared with the preview (dispatch slicing).

## 4. Decisions made on Matt's behalf

From DECISIONS.md:
1. Plan gate: approve with changes (Advisor). The hybrid is judged by signs, both ends of every crossing edge and escapes, with a fixed band and a negative control.
2. "Do not port" is an allowed answer for any family (Advisor).
3. A measured band is not grounds to claim identical files across PCs (Advisor).
4. The prototype's harder family is grain spinodoid, with its random parameters made on the CPU. Foam stays out of the build (Lead).
5. The hybrid check gets a fourth test, "band holds", because without it the negative control could not fail (Lead).

## 5. Build status and what to run yourself

**Built:** `proto/gpu-bake/` on branch `expedition/20261119-how-should-f13ld-mesh-bake-its-fields-on` (commit 6779250). New files only:
- the page: `index.html`, `main.mjs`, `serve.mjs`, and the double-click copy `gpu-bake-single.html`;
- `selftest.mjs`, `cpu-bench.mjs`;
- `build-single.mjs`, `check-single.mjs`, `smoke.mjs`;
- `lib/` (loader, grid, field, params, emulation, bands, hybrid, WGSL, threads);
- `README.md`.

The page bakes TPMS gyroid (1 and 4 cells, sheet mode) and grain spinodoid on the GPU and compares them with the real CPU field.

**Not built:**
- the PI pair, shell-normalised TPMS, and the GRF and hyperuniform kernels;
- tiling above the adapter limits (oversize grids are skipped with a reason).

**Run by the expedition (CPU, Node):** selftest, negative control and cpu-bench pass (numbers in F2 and F5), and the single file rebuilds identically.

**Run by the Verifier on a software GPU (SwiftShader in headless Chrome 157; substitute environment, no speed quoted):** the served page and the single file opened from disk both ran with no shader or validation errors.
- Max difference: 4.33e-4 (TPMS), 1.47e-4 to 1.57e-4 (spinodoid).
- 0 escapes everywhere.
- With the spec band, all four checks PASS. With the assumed 2⁻¹⁶ band, only "band holds" FAILs.
- Bench ran to the end without errors.
- With WebGPU hidden, the page says so plainly.

**Not run by the expedition:** any GPU speed, and any run on a real GPU.

The "measured by the expedition" CPU figures come from an AMD Ryzen 7 7700X (8 cores, 16 threads), Windows 11, Node v24.21.0.

### Click test A: the GPU bake page (about 2 minutes)
1. Double-click `proto\gpu-bake\gpu-bake-single.html` in the branch's worktree (`.claude\worktrees\exp-20261119-how-should-f13ld-mesh-bake-its-fields-on`). Or run `node proto/gpu-bake/serve.mjs` there and open `http://localhost:8091/`. Use Chrome or Edge.
2. Check that the top of the log shows your adapter (NVIDIA) and its limits. Shader errors, if any, show in the log.
3. Press **Compare** (two-rectangles icon). Expect **PASS on every "WGSL-spec band" line** for TPMS, TPMS 4 cells and spinodoid at 64 and 128. A FAIL on an "assumed-GPU band" line only means your GPU's error is above 2⁻¹⁶. Paste it back; that is the measurement we want.
4. Press **Bench** (stopwatch icon). It times 128, 256 and the export grid sizes that fit.
5. Press **Copy log** and paste back the block from `=== F13LD.mesh GPU bake bench` to `=== end ===`. It should include the adapter name, and per family and grid:
   - max difference, sign changes, re-evaluated share and escapes;
   - device + compile ms, GPU bake + readback ms, CPU scan ms and CPU re-evaluation ms;
   - total hybrid time against the CPU one-thread bake.

### Click test B: where export time goes on your PC (bench page, about 5 minutes)
1. Open `tests/regress.html` from main (as usual) with quality **High** and mesher **Classic**, and run the cube and shape cases. Paste back the Markdown report.
2. Run it again with mesher **Slab** and paste that report too. It includes the stage table: slabs, round A, round B, rows, flips, union, clean-up.

### Click test C: the weld field bake
1. In the live tool, export each of the three bench welds at High (or your cage).
2. Open the console (F12) and paste back the `[export][weld]` lines. `bakeMs` is the main-thread field bake that the bench doesn't count.

## 6. Parked: proposed next expeditions
- **Confirm WGSL accuracy from the spec text.** Parked when the gatherers could not reach it. The Skeptic later opened the spec source, so this is mostly closed; what remains is a check of the exact wording.
- **CPU field speed-ups (options e and f) in F13LD.mesh:** coarse pass on the pool, one bake shared with Auto's slab retry, the slab pool on all cores, a Lipschitz block skip, and the slab field and weld bake shown in `stages`. These change existing files, so they were outside this brief.
- **Run the page on two GPUs** (NVIDIA plus an integrated GPU) to see how far float32 bakes differ between vendors, and whether the spec band holds on both.

## 7. Sources

Opened by a gatherer or the Skeptic (notes file in brackets):
- W3C WebGPU spec, limits: https://www.w3.org/TR/webgpu/#limits (n2)
- MDN GPUSupportedLimits: https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits (n2)
- web.dev, WebGPU in major browsers: https://web.dev/blog/webgpu-supported-major-browsers (n2)
- MDN WorkerNavigator.gpu: https://developer.mozilla.org/en-US/docs/Web/API/WorkerNavigator/gpu (n5)
- Chrome, New in WebGPU 121: https://developer.chrome.com/blog/new-in-webgpu-121 (n5)
- Microsoft Learn, TDR registry keys: https://learn.microsoft.com/en-us/windows-hardware/drivers/display/tdr-registry-keys (n5)
- MDN GPU.requestAdapter: https://developer.mozilla.org/en-US/docs/Web/API/GPU/requestAdapter (n5)
- MDN GPUBuffer.mapAsync: https://developer.mozilla.org/en-US/docs/Web/API/GPUBuffer/mapAsync (n5)
- luma.gl, GPU floating-point precision: https://luma.gl/docs/api-guide/shaders/gpu-floating-point-precision (n1)
- jesedv/df64: https://github.com/jesedv/df64 (n4)
- public-gpu list, April 2022: https://lists.w3.org/Archives/Public/public-gpu/2022Apr/0003.html (n4)
- WGSL spec source: https://raw.githubusercontent.com/gpuweb/gpuweb/main/wgsl/index.bs (SKEPTIC.md)
- WebGPU CTS floating-point primer: https://kdab.searchfox.org/firefox-main/source/dom/webgpu/tests/cts/checkout/docs/fp_primer.md (SKEPTIC.md)
- Reed Beta, texture coordinate precision: https://reedbeta.com/blog/texture-gathers-and-coordinate-precision (n3)
- Chrome, New in WebGPU 119: https://developer.chrome.com/blog/new-in-webgpu-119 (n3)
- NUS, Jump Flooding: https://www.comp.nus.edu.sg/~tants/jfa.html (n3)
- demofox, JFA: https://blog.demofox.org/2016/02/29/fast-voronoi-diagrams-and-distance-dield-textures-on-the-gpu-with-the-jump-flooding-algorithm/ (n6)

Opened, but with nothing usable for this report:
- the WGSL spec pages at gpuweb.github.io and w3.org/TR, which were truncated before §15 (n1, n4, n7);
- webgpureport.org, which returned no data in the fetch (n5);
- arXiv 1204.1461 and 2608.15934, and the I3D 2006 JFA PDF (n6);
- the CTS spec files, which hold TODOs only (n8).

Repository files read: CLAUDE.md, docs/SESSION_RECAP_2026-10-15b.md, -10-16c.md and -10-17.md, the previous expedition's REPORT.md, and the worker and test files listed in notes-code.md.

<!-- hub-generated: everything below this line is written by the hub from the event log -->

## Claims check

The Verifier's claims pass ran (verify/VERDICT.md has a claims or corrections section).

## Parked, as proposed next expeditions

1. Confirm WGSL's published float32 accuracy for sin, cos, exp, sqrt, division and fma (spec section 15.7 and the CTS case files), to decide whether a near-surface band can be proven rather than measured. (why parked: Three reader runs could not reach the section (the fetch tool truncates the spec at ~464k characters; the CTS files hold only TODOs); the gatherer allowance of 8 runs is used up.). Launch pre-fills a brief from this line.

## Requests that were not allowed

- Bash: sed -n 360,470p worker/m90-onmessage.js | grep -n "open\|else\|bbox\|HALF\|edge\|levelSet" | head -40; echo ----; node -e "const r=require('./tests/recip… (Inline code the hub cannot read in full: only a few exact read-only strings (the temp-dir print, version prints) are al…)
- Bash: cd "C:/Users/mshom/Documents/GitHub/f13ld.mesh/.crux/expeditions/20261119-how-should-f13ld-mesh-bake-its-fields-on/verify/run-1" && node _browser.mjs "C:… (Inline code the hub cannot read in full: only a few exact read-only strings (the temp-dir print, version prints) are al…)
- Bash: cd "C:/Users/mshom/Documents/GitHub/f13ld.mesh/.crux/expeditions/20261119-how-should-f13ld-mesh-bake-its-fields-on/verify/run-2" && node xbench-shell.mjs… (the permission check could not settle it: The script is shown, but it dynamically loads lib files from the worktree (lo…)

## How it ran

Generated from the hub's event log (usage events and expedition events), not estimated. Stop reason: passed. Elapsed: 57 min.

| Role | Agents | Turns | Time at work | Tokens (in / out) | Cost |
|---|---|---|---|---|---|
| Lead (incl. gatherers) | 1 | 17 | 13 min | 23.35M / 222.9k | $10.65 |
| Advisor | 1 | 1 | 2 min | 330.2k / 10.8k | $1.72 |
| Synthesizer | 1 | 1 | 7 min | 751.8k / 43.2k | $2.07 |
| Skeptic | 1 | 1 | 7 min | 2.55M / 62.5k | $1.42 |
| Builder | 1 | 2 | 24 min | 15.33M / 150.2k | $4.23 |
| Verifier | 1 | 4 | 24 min | 15.35M / 134.1k | $8.29 |
| unknown | 1 | 6 | 0 min | 34.4k / 1.2k | $0.06 |
| **Total** | | 32 | 1 h 17 min | 57.70M / 625.0k | $28.44 |

Gatherers run inside the Lead, so their time and cost are in the Lead's line and are not split out.

Build-verify loops: 1 (6 passing); 2 (9 passing); 3 (14 passing); 4 (15 passing). Decisions made on the user's behalf: 2. Parked: 4 (3 of them requests that were not allowed).

Spend figures here are the results' logged usage. While a turn runs, the hub's watchdog counts an upper-bound estimate that each result replaces (memo M046), so a limit may trip a little early, never late.
