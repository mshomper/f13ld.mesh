# Report: which GPU mesh techniques are worth adopting for F13LD

Expedition 20261116-which-gpu-mesh-techniques-are-worth-adop-2 · Lead exp-lead-2 · 2026-11-16

**Nothing about GPU speed in this report was run by the expedition.** The expedition had no GPU. Every speed figure below is a source's own number on that source's hardware, and every F13LD speed question is listed in section 5 for Matt to run.

## 1. Answer

Few GPU techniques pay off for F13LD right now, and none of them belong in the export path yet.
- **Worth doing next, in the browser:** a measurement step first: a preview bench tab (bake time per family, frame time while orbiting). After that, WebGPU compute for the **TPMS preview bakes only**, keeping the WebGL2 path as the fallback. For TPMS this does not touch the export. The TPMS preview never sets the cached min and max (`16-preview-scene.js:59`), and the TPMS export builder ignores them (`worker/m20-sdf-noise-tpms.js:455`). Noise, grain and hyperuniform bakes do feed the export's normalisation, so porting those needs the byte-identical harness to pass (or their min and max must stay on the CPU). Run the harness for TPMS too, as a guard.
- **GPU meshing (the prototype built here):** a WebGPU marching-tetrahedra mesher with shared vertices. Its CPU twin is proven closed in Node. The GPU version was run only on a software GPU (SwiftShader), where it matched the CPU triangle for triangle at 64 and 128 once a one-character shader bug was fixed. It has never run on a real GPU. Use it only for preview meshes and benches. The GPU computes in float32, and the result can differ between two GPUs, so the same recipe could give different files on different PCs. Even at best it replaces only the extraction stage: about 3.8 s of the 10.7 s foam-weld export in Matt's 2026-10-17 bench. The simplify, flip and union stages stay on the CPU.
- **Keep as is:** Manifold (CPU only; the WASM build is serial), and the existing CPU slab mesher.
- **Desktop:** the cheapest way to reuse code is the same WGSL running in Node through Dawn's `webgpu` package, for headless regression runs, though its timings won't match the browser's. A Tauri shell gets WebGPU on Windows only through a developer flag. For desktop Python, Warp (Apache-2.0, works without a GPU) and CuMesh (MIT, needs CUDA) are worth a trial.
- **Skip:** the learning-oriented research meshers: Occupancy-based Dual Contouring (code is non-commercial), FlexiCubes (built for gradient-based mesh optimisation in PyTorch) and fVDB (machine learning on NVIDIA hardware). 3MF Volumetric as the print path is also a skip: the spec is published, but the expedition could not confirm any slicer that reads it.

## 2. Findings

Verdicts, ranked within each group. n1 to n6 are the gatherer notes in this folder. "Opened" means a gatherer fetched the page; "snippet" means only a search result was seen, and nothing snippet-only is ranked above trial.

### A. F13LD in the browser

| # | Technique | Verdict | Why (one line) | Source | Maturity · date |
|---|---|---|---|---|---|
| 1 | WebGPU compute for **TPMS** preview tile and region bakes (P5), WebGL2 fallback | **adopt, after measuring** | F13LD.lab already uses WebGPU compute and Chrome and Edge ship it; TPMS bakes don't feed the export (other families do, so they wait for bench numbers). | web.dev WebGPU in major browsers (opened, n1, 2025-11-25); gpuweb implementation status (opened, n6) | shipping API |
| 2 | Timestamp queries in the bench tab | **adopt** (if the browser has them) | They give real GPU time per stage. Shipped in Chrome 121. | Chrome "New in WebGPU 145" release index (opened, n6) | shipping (Chrome) |
| 3 | GPU count, scan and emit isosurface with **shared vertices** (marching tets, this prototype) | **trial, preview and bench only** | Edge-manifold by the table, closed on the CPU and on a software GPU; float32 output differs from the CPU, so preview and bench only (at best 3.8 of 10.7 s). | Pipeline design: Usher, WebGPU marching cubes (opened, n1, 2024-04-22); repo Twinklebear/webgpu-marching-cubes, MIT (opened, n6) | our code: run on a software GPU only |
| 4 | Preview empty-space skipping beyond today's Lipschitz step (P4) | **trial** | The raymarcher already steps by Lipschitz bounds; P4 can add tile min/max culling, and Keeter's test shows no speed gain (interval 12 ms vs 18 ms). | Keeter, "Gradients are the new intervals" (opened, n2, 2025-05-14) | technique |
| 5 | Empty-cell skip in the CPU slab mesher (bound proves no crossing, so the cell emits nothing) | **trial** | A correct bound leaves the output unchanged, so it can be checked with the byte-identical harness. Warp ships the same idea as a Lipschitz octree. | Keeter (opened, n2); Warp geometry docs, sparse marching cubes (opened, n3) | technique; Warp dev docs (1.20.0.dev0) |
| 6 | shader-f16 for preview atlases | **trial** | The preview already stores 16-bit atlases. Shipped in Chrome 120; Firefox and Safari status unconfirmed. | Chrome 145 release index (opened, n6) | shipping (Chrome) |
| 7 | meshoptimizer simplifier | **skip for export; trial for a lossy preview mesh** | The `vertex_lock` added in v0.25 is on the "sloppy" simplifier, which ignores topology. That is not tear-safe, and the classic simplify must stay byte-identical. | meshoptimizer releases (opened, n5) | shipping library |
| 8 | Manifold v3.5.x (WASM) for weld unions | **adopt (keep as is)** | No GPU path. WASM is serial-only, and multithreaded WASM is "not recommended". | github.com/elalish/manifold (opened, n3); releases (opened, n5) | shipping |
| 9 | 3MF Beam Lattice v1.2.0 beside the mesh (Beam family) | **trial** | Spec published (2025-02-27); nTop and Magics use is snippet-only and no consumer slicer is confirmed. | 3mf.io/specification (opened, n4) | published spec, 2025-02-27 |
| 10 | 3MF Volumetric v1.0.0 as the print path | **skip, watch** | Published (voxel and implicit data inside 3MF), but no confirmed reader was found. | 3mf.io/specification (opened, n4); 3MFConsortium/spec_volumetric, BSD-2 (opened, n4) | published spec, 2025-11-13 |
| 11 | Subgroups and subgroup-size-control in scans | **skip for now** | Chrome has them (size control in Chrome 151-152, post dated 2026-08-12); other browsers' status is snippet-only, and a scan has to work without them anyway. | Chrome "New in WebGPU 151-152" (opened, n1/n6) | Chrome only |
| 12 | Unindexed marching cubes (triangle soup, as Usher's article) | **skip** as a mesher | Triangle soup with no shared vertices can't feed a watertight 3MF; its scan design is reused in the prototype. | Usher (opened, n1) | MIT code |
| 13 | Lipschitz Pruning of primitive SDFs (CGF 2025) | **skip for now** | Built for CSG trees of thousands of primitives, not closed-form TPMS. Only the landing page was opened. | ip-paris research portal (opened, n6) | paper, 2025 |
| 14 | Occupancy-based Dual Contouring | **skip** | The code is CC BY-NC-SA 4.0 (non-commercial) and Python/PyTorch, with no watertight claim. | arXiv 2409.13418 (opened, n2); KAIST-Visual-AI-Group/ODC LICENSE (opened, n4) | research code, 2024-09 |
| 15 | FlexiCubes | **skip** | Apache-2.0, but its README says plain SDF extraction is "not its designated use case". | nv-tlabs/FlexiCubes, LICENSE (opened, n2/n4) | research code, 2023 |
| 16 | fVDB / NanoVDB | **skip** | NVIDIA hardware and machine learning, no browser path. Snippet only. | arXiv 2407.01781 (snippet, n2) | 2024 |
| 17 | Fidget (interval evaluation plus dual-contouring meshing) | **skip** | The README calls it experimental. CPU first; its browser build has no JIT. MPL-2.0. | github.com/mkeeter/fidget (opened, n4) | experimental |

### B. Desktop mesh work

| # | Technique | Verdict | Why | Source | Maturity |
|---|---|---|---|---|---|
| 1 | Manifold native (multi-core through TBB) | **adopt if a desktop build happens** | Multi-core booleans, which the WASM build lacks. | github.com/elalish/manifold (opened, n3) | shipping |
| 2 | Dawn's Node bindings (npm `webgpu`): same WGSL, headless | **trial** | Builds for win64 and lets regression runs reuse the browser kernels; a new dependency (needs Matt's OK); timings won't match the browser (validation forced to "full", snippet, n3). | github.com/dawn-gpu/node-webgpu (opened, n5) | open code |
| 3 | Tauri / WebView2 WebGPU | **trial** | Windows works only through `--enable-unsafe-webgpu`, and Microsoft says production apps should not ship developer flags. | tauri issue 6381 (opened, n3/n5); WebView2 flags page (opened, n5) | flag route only |
| 4 | NVIDIA Warp (marching cubes, sparse marching cubes) | **trial** for desktop Python | Apache-2.0, CPU backend everywhere and CUDA on Windows; watertight output not confirmed. | github.com/NVIDIA/warp (opened, n5); Warp geometry docs (opened, n3) | shipping library (dev API) |
| 5 | CuMesh (GPU decimation, repair) | **trial** | MIT, CUDA. A small project; its output needs the closed and tear checks before printing. | github.com/visualbruno/CuMesh (opened, n2) | open code |
| 6 | PaMO (GPU tear-safe mesh processing) | **skip for now, watch** | Snippet only. | (snippet, n2) | paper, 2025 |
| 7 | OpenVDB volumeToMesh | **skip** | CPU mesher, snippet only. | (snippet, n3) | shipping |
| 8 | Deno WebGPU | **skip** | Follows a March 2024 spec draft, "very much in flux". | denoland/deno ext/webgpu (opened, n5) | experimental |

### Cutting edge (2023 to 2026), found in the sources
- **Occupancy-based Dual Contouring**: SIGGRAPH Asia 2024, arXiv 2024-09. Open code, non-commercial (n2, n4).
- **FlexiCubes**: SIGGRAPH 2023. Open code, Apache-2.0 (n2, n4).
- **"Gradients are the new intervals"** (Keeter): blog and benchmark, 2025-05-14 (date taken from the URL; the page shows none) (n2).
- **Lipschitz Pruning**: Computer Graphics Forum 2025. Paper; abstract only read (n6).
- **WebGPU marching cubes at near-native speed** (Usher, 2024-04-22): blog plus MIT code. 256³ in about 31 to 54 ms on an RTX 3080 and an M2 Max, on the source's own hardware (n1).
- **3MF Volumetric v1.0.0** (2025-11-13) and **Beam Lattice v1.2.0** (2025-02-27): published specs (n4).
- **Warp sparse marching cubes on a Lipschitz octree**: library, dev build 1.20.0.dev0 (n3).
- **WebGPU subgroup-size-control**: in Chrome 151-152 (post dated 2026-08-12) (n1, n6).

### The expedition's own proposals
These are the expedition's own claims, not findings. "Not found" covers only the searches in n1, n6 and SKEPTIC.md (about 12 by the Skeptic's count).
1. **Closed, shared-vertex marching tetrahedra in browser WebGPU, with a CPU twin that proves the case tables are closed.** This differs from Usher's unindexed marching cubes, which has no manifold guarantee. Nearby prior art does exist: indexed WebGPU marching cubes (conorpo, snippet), a geometry-shader marching-tets patent (US 7,965,291, snippet), and a Rust crate using the same six-tet split (snippet). The expedition found no WebGPU marching-tets mesher, so the claim is narrow. It is built and matches the CPU on a software GPU, but has not run on a real GPU.
2. **Bound-certified empty-cell skipping inside that WebGPU mesher, staying closed.** As an idea this is not new: Warp and libigl have Lipschitz octrees, and MPR (2020) skips empty space with intervals when rendering. What may be new is the combination of browser WebGPU, marching tets, TPMS fields and a watertight print target. Not built.
3. **A TPMS written into 3MF Volumetric as an implicit, beside the mesh.** nTop exports beam lattices but excludes surface lattices (snippet). Low value until a slicer reads it. Not built.

## 3. The Skeptic's objections and what changed

The full text is in SKEPTIC.md. Three high objections, all accepted:
- **H1: "a preview bake never touches the export" was false.** The selected part's preview bake sets `recipe._previewFieldMin/Max` (`16-preview-scene.js`), which the export reads for its normalisation (`worker/m30-sdf-assembly.js`, `m20`, `m23`). **Changed:** WebGPU bakes are now "adopt after measuring, TPMS first, harness must stay byte-identical (or keep min/max on the CPU)". The Verifier later found this link does not exist for TPMS (TPMS preview bakes don't set the cached min and max, and the TPMS export ignores them), so the harness condition is for the other families.
- **H2: float32 risk understated.** The CPU export computes the TPMS term in float64. WGSL's sin and cos accuracy is implementation-defined, so two GPUs may give different bits (the exact WGSL bound was not confirmed; that check is parked). **Changed:** the GPU mesher gets no export use at all, only preview meshes and benches.
- **H3: no benefit side.** Matt's foam-weld bench (2026-10-17 recap): slabs 3.77 s, round A 2.10, round B 1.29, rows 0.24, flips 0.62, union 2.15 (10.7 s total; the six listed stages sum to 10.17 s, the rest is clean-up and overhead). **Changed:** the best case for GPU meshing is stated as about 3.8 of 10.7 s, and nothing GPU is to be built before the bench shows where time goes.

Medium and low objections:
- **M1: Lipschitz skip in the preview is already there.** Changed to "trial: what P4 adds beyond it".
- **M2: meshoptimizer's lock is on the sloppy simplifier.** Changed to "skip for export".
- **M3: "watertight by construction" was overclaimed.** Now "edge-manifold by the table; vertex-manifold untested on the GPU". On the CPU twin the selftest reports 0 non-manifold vertices on every mesh tested.
- **M4: desktop libraries dropped silently.** Parked as unresearched, not rejected.
- **M5: cost of porting eight families.** TPMS first, the others after bench numbers.
- **L1: novelty prior art.** Rephrased as "not found in about 12 searches".
- **L2: Dawn timings not comparable.** Noted.
- **L3: inferred dates.** Flagged in the notes.

## 4. Decisions made on Matt's behalf

See DECISIONS.md (numbered). In short:
1. The prototype is a WebGPU TPMS marching-tets page with a CPU twin checked in Node.
2. Research was split into three questions, plus one second round on the gaps.
3. Advisor gate (approve with changes): PowerShell-safe checks, a merge-base diff, a negative control and a known-volume sphere, a six-tet cube split ("same method, different lattice"), and the 256 bench gated on the GPU's buffer limits. The Verifier later found the premise behind that last one does not hold for this design: 256 fits.
4. The Skeptic's high objections were folded in as above.

## 5. Build status and what to run yourself

**Built:** `proto/gpu-mesh/` on branch `expedition/20261116-which-gpu-mesh-techniques-are-worth-adop-2` (final commit 382c3ab; success test 10 of 10 in Verifier run 3). New files only; no existing file is changed. Files: `tables.mjs` (the one source of the tet split and case tables; the GPU tables are generated from it), `cpu-mesher.mjs`, `meshcheck.mjs`, `selftest.mjs`, `gpu-mesher.mjs`, `viewer.mjs`, `main.mjs`, `index.html`, `serve.mjs`, `README.md`.

**Run by the expedition (CPU, Node):** the selftest passes. Every mesh is closed: 0 open edges, 0 non-manifold edges, 0 badly oriented faces, 0 zero-area triangles and 0 non-manifold vertices.

| Mesh | Triangles | Vertices | Volume (unit box) |
|---|---|---|---|
| gyroid 32 | 108,168 | 53,306 | 0.2194 |
| gyroid 64 | 454,728 | 227,258 | 0.2431 |
| Schwarz-P 32 | 87,744 | 43,808 | 0.3061 |
| Schwarz-P 64 | 361,248 | 180,560 | 0.3240 |
| diamond 64 | 541,944 | 270,738 | 0.2320 |
| sphere r=0.35, 32 | 14,232 | 7,118 | 0.17888 |
| sphere r=0.35, 64 | 56,544 | 28,274 | 0.17942 (exact 0.17959, −0.10 %) |

With `--break` (one triangle removed per mesh) the selftest prints `OPEN_EDGES=3` per mesh and fails, as it should.

**Run on a software GPU only (substitute environment).** The Verifier ran the page in headless Chrome on SwiftShader, a GPU emulated on the CPU, not Matt's GPU.
- **First run:** two shaders failed to compile because a generated comment swallowed a table. The fix was one character.
- **With the fix:** the GPU and CPU triangle lists were identical at 64 (1,364,184 index entries) and 128 (5,650,776 entries), the GPU mesh was closed, and volumes agreed within 0.014 %.
- **Positions:** vertex positions differed from the float64 CPU by at most 0.006 cell at 64 and 0.019 cell at 128, because the GPU computes the field in float32. Compare now measures against the CPU meshing the GPU's own field, and reports the float64 gap as information.
- **No speed:** no software-GPU timing is quoted anywhere.
- **On the fixed build** (12e0cc0, Verifier run 2):
  - every Compare line passed at 64 and 128. Positions were within 6e-8 box units of the CPU meshing the GPU's own field, and the float64 gap had a 99th percentile of 0.0012 cell at 64 and 0.0036 cell at 128;
  - the "WebGPU not available" message showed with WebGPU removed or with no adapter;
  - Bench, STL and re-meshing worked without GPU errors.

**Not run by the expedition on a real GPU:** everything about speed, and real-driver behaviour. Matt's first run may still show driver-specific errors; they appear as text in the page's log. Claims resting on reading only:
- the bench's 256 case on a real GPU. On the software GPU (1 GiB limits) it ran: 7,611,816 triangles at the default gyroid, 2 cells, wall 0.4. At WebGPU's default 128 MiB binding limit it should fit at those settings (field about 68 MB, index buffer about 91 MB), but more cells can push the output past the limit. The "skipped: buffer limits" path was not exercised;
- that the page behaves the same on Matt's GPU as on the emulated one.

**To run on your PC (no install):**
1. In a terminal at the worktree root `.claude\worktrees\exp-20261116-which-gpu-mesh-techniques-are-worth-adop-2`, run `node proto/gpu-mesh/serve.mjs`. Modules don't load from a double-clicked file.
2. Open `http://localhost:8090/` in Chrome or Edge. It meshes a gyroid at 64 on load. Shader messages and GPU errors show in the log panel.
3. Press **Compare with CPU** (two-rectangles icon). Expect PASS lines for counts, indices, positions and closed mesh (the CPU meshes the GPU's own field), plus an information line on the float32 vs float64 gap.
4. Press **Bench** (stopwatch icon). It runs 64, 128 and 256; 256 is skipped only if your GPU's buffer limits are too small.
5. Press the **copy** icon and paste the whole log back, especially the block between `=== F13LD.mesh GPU mesh bench` and `=== end ===`.
Optional: `node proto/gpu-mesh/selftest.mjs` repeats the CPU check (about 2 s).

## 6. Parked: proposed next expeditions
- **A preview bench tab in F13LD.mesh** (bake time per family, frame time while orbiting, slider latency). Every GPU "adopt" depends on it, and it changes existing code, so it was outside this brief.
- **Check WGSL sin and cos accuracy, and run the prototype's mesh on two GPUs** to see whether float32 output can match across machines.
- **The unresearched desktop libraries:** Open3D, Kaolin, CGAL, libigl (including its Lipschitz octree), PyMeshLab, and how nTop, Carbon, Materialise and Hyperganic take implicits to print.

## 7. How it ran

(generated by the hub from its logs)

## 8. Sources

Opened by a gatherer or the Skeptic (each is listed with its notes file):
- Usher, WebGPU marching cubes: https://www.willusher.io/graphics/2024/04/22/webgpu-marching-cubes (n1, n6)
- https://github.com/Twinklebear/webgpu-marching-cubes (n6)
- MDN GPUSupportedLimits: https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits (n1)
- https://web.dev/blog/webgpu-supported-major-browsers (n1)
- https://developer.chrome.com/blog/new-in-webgpu-145 (n6)
- https://developer.chrome.com/blog/new-in-webgpu-151-152 (n1, n6)
- https://github.com/gpuweb/gpuweb/wiki/implementation-status (n6)
- https://arxiv.org/abs/2409.13418 and https://github.com/KAIST-Visual-AI-Group/ODC (n2, n4)
- https://www.mattkeeter.com/blog/2025-05-14-gradients/ (n2)
- https://3mf.io/?p=2174 (n2); https://3mf.io/specification/ and https://github.com/3MFConsortium/spec_volumetric (n4)
- https://github.com/nv-tlabs/FlexiCubes (n2, n4)
- https://github.com/visualbruno/CuMesh (n2)
- https://github.com/mkeeter/fidget and https://www.mattkeeter.com/research/mpr/ (n4)
- https://researchportal.ip-paris.fr/en/publications/lipschitz-pruning-hierarchical-simplification-of-primitive-based-/ (n6)
- https://github.com/elalish/manifold and its releases page (n3, n5)
- https://github.com/tauri-apps/tauri/issues/6381 (n3, n5)
- https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/webview-features-flags (n5)
- https://github.com/dawn-gpu/node-webgpu (n5)
- https://github.com/denoland/deno/tree/main/ext/webgpu (n5)
- https://github.com/NVIDIA/warp (n5); https://nvidia.github.io/warp/latest/api_reference/warp_geometry.html (n3)
- https://github.com/zeux/meshoptimizer/releases (n5)
- A 3dprint.com article on 3MF Volumetric was opened by the Skeptic, but its URL was not recorded, so it is not counted as a source here.

Repository files read: `CLAUDE.md`, `docs/PREVIEW_REBUILD_SPEC.md`, `docs/SESSION_RECAP_2026-10-17.md`, `16-preview-scene.js`, `worker/m30-sdf-assembly.js`, `worker/m34-slab-mesher.js`.

<!-- hub-generated: everything below this line is written by the hub from the event log -->

## Claims check

Claims not checked: verify/VERDICT.md has no claims or corrections section. Treat the numbers and claims above as the Lead's, not verified.

## Parked, as proposed next expeditions

1. Desktop libraries not researched: Open3D, Kaolin, CGAL, libigl (incl. lipschitz_octree), PyMeshLab, and how nTop / Carbon / Materialise / Hyperganic go from implicit to print. (why parked: Gatherer search caps ran out; these are unresearched, not rejected, and a second pass would exceed this expedition's gatherer limit.). Launch pre-fills a brief from this line.
2. A P4 preview bench tab in F13LD.mesh (bake time per family, frame time while orbiting, slider latency) to decide whether WebGPU bakes or a GPU mesher are worth building. (why parked: Changes existing mesh code, which this brief excludes; it is the measurement every GPU adopt rating depends on.). Launch pre-fills a brief from this line.
3. Confirm WGSL sin/cos accuracy bounds and test whether one GPU's float32 TPMS field gives the same mesh on another GPU. (why parked: Spec fetches were truncated; settles whether any GPU-meshed output could ever be offered as an export.). Launch pre-fills a brief from this line.

## Requests that were not allowed

- Bash: cd /c/Users/mshom/Documents/GitHub/f13ld.mesh/.claude/worktrees/exp-20261116-which-gpu-mesh-techniques-are-worth-adop-2/proto/gpu-mesh && cat > meshcheck… (A second heredoc or here-string after one already taken out: the hub cannot tell which markers open one)
- Bash: cd /c/Users/mshom/Documents/GitHub/f13ld.mesh/.claude/worktrees/exp-20261116-which-gpu-mesh-techniques-are-worth-adop-2/proto/gpu-mesh && cat >> meshchec… (Uses a variable the hub cannot check (${z}); Uses a variable the hub cannot check (${nonManifoldVertexCount(idx))
- Bash: node -e "import('./proto/gpu-mesh/tables.mjs').then(t=>{const s=t.wgslTables();console.log(s.length, s.split('\n').map(l=>l.slice(0,110)).join('\n'))})" (Inline code the hub cannot read in full: only a few exact read-only strings (the temp-dir print, version prints) are al…)
- Bash: node -e "const fs=require('fs'),p='proto/gpu-mesh/';for(const f of ['index.html','selftest.mjs']){if(!fs.existsSync(p+f)){console.error('missing '+f);pro… (An inline script that could reach the network)
- Bash: node proto/gpu-mesh/selftest.mjs --break | grep -E "OPEN_EDGES|FAIL" | head -4; echo "exit=${PIPESTATUS[0]}" (Uses a variable the hub cannot check (${PIPESTATUS))
- Bash: git diff --name-only --diff-filter=MDRT $(git merge-base main HEAD); echo "diff-done"; git status --short | head (A command substitution that could be an option of git, which can write files or run programs)
- Bash: node proto/gpu-mesh/selftest.mjs --break; echo "exit=$?"; echo ---; node -e "import('./proto/gpu-mesh/gpu-mesher.mjs').then(()=>console.log('loaded'),e=>… (Inline code the hub cannot read in full: only a few exact read-only strings (the temp-dir print, version prints) are al…)
- Bash: cd "/c/Users/mshom/Documents/GitHub/f13ld.mesh/.crux/expeditions/20261116-which-gpu-mesh-techniques-are-worth-adop-2/verify/run-1" && grep -n "PORT = \|s… (Uses a variable the hub cannot check (${mode}))

## How it ran

Generated from the hub's event log (usage events and expedition events), not estimated. Stop reason: passed. Elapsed: 47 min.

| Role | Agents | Turns | Time at work | Tokens (in / out) | Cost |
|---|---|---|---|---|---|
| Lead (incl. gatherers) | 1 | 12 | 8 min | 6.25M / 163.3k | $3.40 |
| Advisor | 1 | 1 | 2 min | 280.2k / 12.3k | $1.32 |
| Synthesizer | 1 | 0 | 3 min | 0 / 0 | $0.00 |
| Skeptic | 1 | 0 | 2 min | 0 / 0 | $0.00 |
| Builder | 1 | 3 | 10 min | 4.91M / 91.9k | $2.05 |
| Verifier | 1 | 3 | 32 min | 13.38M / 123.2k | $7.47 |
| **Total** | | 19 | 57 min | 24.82M / 390.6k | $14.23 |

Gatherers run inside the Lead, so their time and cost are in the Lead's line and are not split out.

Build-verify loops: 1 (3 passing); 2 (9 passing); 3 (10 passing). Decisions made on the user's behalf: 3. Parked: 11 (8 of them requests that were not allowed).

Spend figures here are the results' logged usage. While a turn runs, the hub's watchdog counts an upper-bound estimate that each result replaces (memo M046), so a limit may trip a little early, never late.
