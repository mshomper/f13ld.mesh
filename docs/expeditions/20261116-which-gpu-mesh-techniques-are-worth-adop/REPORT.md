# Report: which GPU mesh techniques are worth adopting in F13LD.mesh

> **Status: stopped by the user before the build or any source check.** No prototype was built, the plan gate never closed (so the success test was not frozen or run), and **no claim in this report was checked**. None of the research agents had web access, so **no outside source was opened**. Everything below from outside the repo is from memory and is a lead to verify, not a finding.

## 1. Answer (provisional, unverified)

Best first step: **move the field evaluation onto the GPU and keep the meshing and clean-up on the CPU**. Second step: **try GPU marching tetrahedra** that copies the current export's rules (topology from signs only, box-face capping, crossings kept off grid points), with a CPU closed check on the result. **Skip GPU simplification and GPU booleans** for now: they would break the tear-safe guarantees and the byte-identical harness, and Manifold already does booleans reliably. A desktop native path is not worth it while the browser path is unexplored. This ranking comes from reading the repo plus unverified background knowledge, not from opened sources.

## 2. Findings

What exists (read from `CLAUDE.md`, `docs/SESSION_RECAP_2026-10-17.md`, `worker/m34-slab-mesher.js`, `docs/PREVIEW_REBUILD_SPEC.md`):
- Export meshes with the project's own marching tetrahedra on Manifold.levelSet's body-centred cubic grid, in z slabs on every core (`m34`). Topology comes only from signs, and crossings are kept 0.01 % of an edge off grid points (`SLAB_TCLAMP`), so the raw mesh is always a closed 2-manifold. Snapping was tried and dropped because it made 4-way edges.
- Clean-up (`m35`/`m36`): tear-safe simplify, band rounds A/B, rows pass, edge flips, closed checks. Welds and clipping use Manifold booleans.
- Fields are pre-baked on the CPU across all cores (`m32`/`m33`); TPMS term lists compile to one function (`m20 compileTermsList`).
- Matt's foam-weld bench at High on 15 cores (recap): slabs 3.77 s, round A 2.10 s, round B 1.29 s, union 2.15 s, rows 0.24 s, flips 0.62 s. So meshing and field work (the slabs) are only part of the time. Clean-up and the union take as long.
- P5 in the preview spec is "WebGPU compute for tile / region bakes (as F13LD.lab uses), IndexedDB bake cache", marked optional.

### Ranked recommendation table (provisional; outside facts unverified)

| Rank | Technique | What it buys F13LD | Effort | Risk to watertightness | Call |
|---|---|---|---|---|---|
| 1 | GPU field evaluation (TPMS, implicit) feeding the existing CPU mesher | Faster bakes for export and preview (P5); mesher unchanged | Medium | Low if values match the CPU bake. Float32 vs the CPU's float64 can flip signs near the surface: needs a parity check and coordinates reduced to the cell period | **Try first** |
| 2 | GPU marching tetrahedra (same rules as `m34`) | Moves the slab stage onto the GPU | Medium | Low: sign-only topology, no ambiguity. Shared vertices need global edge keys | **Try** (after 1) |
| 3 | GPU closed / manifold check (sort edge keys, count) | Cheap check of GPU output before CPU clean-up | Low | None (it only reads) | **Try** (with 2) |
| 4 | WebGPU in the browser | The platform for 1 to 3 | — | — | **Adopt as the target** for P5; limits below need checking |
| 5 | Marching cubes | Nothing over tets | Medium | Ambiguous cases can leave holes unless a full table or decider is used | **Skip** |
| 6 | Sparse / narrow-band grids (active bricks) | Memory and empty-space skipping on big parts | High | Real: a dropped brick with a crossing leaves a hole. Needs a margin of at least 1 cell | **Try later** |
| 7 | Surface nets | Fewer triangles | Medium | Can go non-manifold at saddles and thin walls | **Skip** |
| 8 | Dual contouring (incl. manifold DC) | Sharp features, which TPMS doesn't need | High | Plain DC gives non-manifold vertices; the manifold variant is complex | **Skip** |
| 9 | Adaptive / octree grids (Transvoxel-style) | Fewer triangles in flat regions | High | Cracks unless transition cells are used | **Skip** for now |
| 10 | GPU simplification (parallel edge collapse) | Would speed up the clean-up rounds | High | High: tear locks are hard to carry over, and the result changes from run to run | **Skip** |
| 11 | GPU booleans | — | Very high | High; research-grade | **Skip**; keep Manifold |
| 12 | Desktop native path (CUDA / Vulkan / wgpu native / NanoVDB) | Bigger buffers, float64, no browser limits | High plus install and signing cost | Same as the browser path | **Skip** until the browser path hits a limit |

### WebGPU facts (from memory, NOT checked; verify in the W3C spec and webgpureport.org)
- Spec defaults as recalled: maxStorageBufferBindingSize 128 MiB, maxBufferSize 256 MiB, 8 storage buffers per shader stage, 16 KiB workgroup storage, 256 invocations per workgroup, 65,535 workgroups per dimension. Desktop adapters usually allow more through `requiredLimits`.
- WGSL has no f64. Atomics are i32/u32 only. Subgroups and f16 are optional features.
- Readback goes `copyBufferToBuffer` → MAP_READ buffer → `mapAsync`. Large meshes cost real time and memory copies; no numbers were checked.
- Recalled support: Chrome/Edge since 113, Firefox 141 on Windows, Safari 26. WebGPU is available in dedicated workers. Windows resets the GPU after about 2 s (TDR), so long work must be split into several dispatches.
- The F13LD pack notes "Max 8 storage buffers per stage" for Pullout, which matches the recalled default.

### Desktop path (from memory, NOT checked)
Manifold is recalled as Apache-2.0 with an optional TBB backend. OpenVDB/NanoVDB is recalled as MPL-2.0, with CPU volume-to-mesh. meshoptimizer is MIT and CPU-only. A native helper adds per-vendor code, installers and signing, which is a large cost for a small MIT project.

## 3. Skeptic's objections
None. The Skeptic was never started, because the expedition stopped first. My own reservations:
- The table's ranking leans on the bench: if GPU field evaluation only speeds up the slab stage, the foam weld gains at most about a third of its time, because clean-up and the union stay on the CPU.
- Float32 sign flips near the surface could change topology compared with the CPU bake. Parity has to be checked before ranking 1 holds.

## 4. Decisions made on Matt's behalf
1. The prototype would use GPU marching tetrahedra on a regular cube grid with a 6-tet split and box capping, in `gpu-proto/`. It was not built.
2. Round-2 research used the general gatherer type after the expedition gatherers had no web tools. They had none either.
3. Outside facts were to be sourced by the Skeptic. This never happened because of the stop.

## 5. Build status
**Not built.** No worktree work, no `gpu-proto/` folder, no Builder started. The draft success test is in `test/` (`CHECKLIST.md`, 12 items; `run.json`, 4 checks). It was never reviewed at the gate, frozen or run. **0 of 12 items pass.** No GPU timings were run, as the brief asked. Nothing for you to run yet.

## 6. Parked items / proposed next expeditions
- **Rerun this expedition with web access for the research agents.** Every subagent this time had only Read and Write. Check that the gatherer type gets WebSearch / WebFetch before launch.
- **Build the prototype page** (`gpu-proto/`) to the draft test: WebGPU TPMS field plus marching tets, CPU reference with closed check, Node self-test, and a "Time it" button whose results you record on your PC.
- **GPU-vs-CPU field parity study:** how often float32 GPU values flip sign compared with the float64 CPU bake on real recipes.

## 7. How it ran
(Generated by the hub.)

## 8. Sources
**No outside source was opened** by me or any gatherer. The links the notes name (W3C WebGPU and WGSL specs, webgpureport.org, caniuse, github.com/elalish/manifold, AcademySoftwareFoundation/openvdb, zeux/meshoptimizer, NVIDIA/kaolin, gfx-rs/wgpu, Dawn) are unopened leads and don't count as sources.
Repo files read: `CLAUDE.md`, `docs/SESSION_RECAP_2026-10-17.md`, `docs/PREVIEW_REBUILD_SPEC.md` (P5 row), `worker/m34-slab-mesher.js` (header and first 110 lines). Notes: `notes-1.md`, `notes-2.md`, `notes-3.md` (from memory); `notes-4.md` to `notes-6.md` say only "NO WEB TOOLS".

<!-- hub-generated: everything below this line is written by the hub from the event log -->

## Claims check

Claims not checked: the hub stopped the expedition before the Verifier finished its claims pass. Treat the numbers and claims above as the Lead's, not verified.

## Parked, as proposed next expeditions

None.

## How it ran

Generated from the hub's event log (usage events and expedition events), not estimated. Stop reason: Matt. Elapsed: 3 min.

| Role | Agents | Turns | Time at work | Tokens (in / out) | Cost |
|---|---|---|---|---|---|
| Lead (incl. gatherers) | 1 | 4 | 3 min | 1.35M / 31.5k | $1.30 |
| Advisor | 1 | 1 | 1 min | 85.3k / 5.9k | $1.01 |
| **Total** | | 5 | 4 min | 1.44M / 37.5k | $2.32 |

Gatherers run inside the Lead, so their time and cost are in the Lead's line and are not split out.

Build-verify loops: none. Decisions made on the user's behalf: 3. Parked: 0.

Spend figures here are the results' logged usage. While a turn runs, the hub's watchdog counts an upper-bound estimate that each result replaces (memo M046), so a limit may trip a little early, never late.
