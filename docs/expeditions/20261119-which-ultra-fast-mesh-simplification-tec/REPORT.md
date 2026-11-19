# Which ultra-fast mesh simplification for F13LD? (expedition 20261119)

Branch `expedition/20261119-which-ultra-fast-mesh-simplification-tec`. Prototype in `proto/simplify-bench/`. Lead exp-lead-4, 2026-11-19.

## 1. Answer

**The fastest win is not a new simplifier: it is a faster safety check around today's one.** Most of the slab simplify time is spent checking that meshoptimizer kept the mesh closed, not in meshoptimizer itself. Replacing that check with a faster one that gives exactly the same verdicts, and skipping the check of the raw input unless something goes wrong, cut **21-54 % of total simplify CPU** on five of the six families tested. Exports stayed identical, hash for hash. The sixth family, open foam, ran too noisily to read. It ships in v0.16.5 as a new option ("fast checks"), off by default, with classic simplify untouched. Once your byte-identity run confirms it, it can become the default.

- Where the time goes (one thread, Med, 6 families): checks and locks are **38-56 %** of slab simplify, and the check of the raw input alone (19-38 %) costs more than the first meshoptimizer call (12-26 %) on every family. Retries after tears only matter on spinodoid and noise.
- Rejected by measurement: patch-only tear repair, a wider first lock ring, a hash-table check (about 3-5x slower than today's sort), and Regularize as a time saver. Regularize is a quality option: needles fall from about 1.6 % to 0.02 %, and it had no self-intersections. But it makes 2.2-5x the triangles at the same deviation.
- Next lever: the final pass, and how well the work spreads over your cores. It waits for your High run below.
- **New problem found:** today's slab output is closed and seam-exact, but a sampled check finds **a few self-intersecting triangle pairs**: up to 22 per mesh at Draft and up to 4 at Med. The top pick doesn't change this, because its output is identical. It is its own follow-up.
- For your other tools: anything that wraps meshoptimizer in a "simplify, check closed, retry" loop should use the same per-vertex check and check its input only when a problem shows.

All timings come from a substitute set-up: Node, one thread, Med (0.12 mm), on 10 mm open-cube jobs built in Node from `tests/recipes.json` through the real field and marching code. No headless browser was available for DUMPJOB. The machine was shared with other agents, so read the ratios, not the milliseconds. Your wall time at High on all cores is not measured. That is the click test.

### Click test for Matt (about 10 minutes, not run by the expedition)
1. **Your High bench, all cores (not run by the expedition).** Open `https://raw.githack.com/mshomper/f13ld.mesh/expedition/20261119-which-ultra-fast-mesh-simplification-tec/tests/regress.html`. The link works once the branch is on GitHub, which happens when this report's draft pull request opens. Set **High**, Mesher **Slab**, all cores, tick the same 11 cases as memo M003, press Run, then **Download report**. **Paste back:** the downloaded report, or for each case the export time, the stage times and the new **"simplify CPU split"** line. This shows how much of your wall time is checks, meshoptimizer, retries and the final pass. It decides whether the final pass is the next lever.
2. **Bench page (one thread, your machine).** In the branch folder, double-click `proto/simplify-bench/simplify-bench-single.html`. Press the self-test icon, then run on the bundled mesh, or drop a mesh. **Paste back:** the results table (time, triangles, open edges, intersections, deviation, needles, min-angle for "today" and "B1a"), or a screenshot.
3. **Byte-identity on a browser (not run by the expedition).** If your machine has Playwright's Chromium: `MESHER=classic LOOSE=keep node tests/harness.js <main folder> <branch worktree>`, then the same with `MESHER=slab GEOM=1`. **Paste back:** the last lines (identical / differs per case). The branch changes only timing code. The expedition proved identical output in Node by hashing main against the branch, but not in a browser.

Also **not run by the expedition**, and covered by step 1 or left as follow-ups:
- real DUMPJOB export jobs (the bench used Node-built jobs instead);
- shaped parts and welds;
- the full unsampled Med bench (`node proto/simplify-bench/bench.mjs --quals med --check`, a few minutes on one core);
- any GPU timing (none was needed).

## 2. Findings

### 2a. Where today's simplify time goes (measured)
Source: `proto/simplify-bench/results/breakdown.md` and `breakdown.json`, from the Builder's `measure.mjs`, committed in b39f4b1. Set-up: Node-built jobs, **Node, one thread**, Med (6 slabs), best of 3, Ryzen 7 7700X, CPU ms. Shares are of the slab simplify total. The raw-input check is part of "checks + locks".

| Family (Med) | Slab simplify ms | Raw-input check | First meshopt call | Checks + locks | + retry meshopt calls | Retries | Final pass ms (A / B / rows / flip) |
|---|--:|--:|--:|--:|--:|--:|--:|
| TPMS gyroid sheet | 673 | 38 % | 25 % | 56 % | 60 % | 1 | 165 (111 / 20 / 22 / 5) |
| noise simplex sheet | 1,198 | 28 % | 21 % | 49 % | 69 % | 6 | 275 (162 / 56 / 37 / 12) |
| hyperuniform | 1,094 | 33 % | 26 % | 53 % | 56 % | 1 | 276 (173 / 56 / 29 / 9) |
| spinodoid | 2,738 | 19 % | 14 % | 38 % | 79 % | 17 | 272 (168 / 48 / 30 / 18) |
| foam (open, Lloyd) | 2,306 | 19 % | 12 % | 53 % | 64 % | 6 | 2,119 (1,195 / 606 / 116 / 175) |
| foam (closed Kelvin) | 1,054 | 30 % | 24 % | 50 % | 58 % | 2 | 408 (260 / 60 / 68 / 12) |

- The check (`meshClosedReport`, a sort of two Float64 arrays of every directed edge) runs on the raw input, after every meshoptimizer try, and after every flip pass (`worker/m35-slab-cleanup.js` `safeSimplify`, `checkedFlip`).
- Flips and compaction (CPU ms, from `breakdown.json`), given as slab-phase flips / slab-phase compaction / final-pass compaction:
  - gyroid 73.7 / 2.7 / 0;
  - noise 92.6 / 4.0 / 1;
  - hyperuniform 114.8 / 6.2 / 1;
  - spinodoid 135.3 / 4.6 / 0;
  - open foam 506 / 11.7 / 8;
  - closed foam 143 / 5.8 / 1.
  The final flip is the last number in the table's final-pass column. Slab-phase flips are included in the slab simplify total, but not in "checks + locks".
- The raw-input check alone (19-38 %) costs more than the first meshoptimizer call (12-26 %) on every family. Retry calls add a lot only on spinodoid (38 % to 79 % with retries) and noise (49 % to 69 %).
- **Against memo M003:** the slab-simplify to final-pass CPU ratio here is 4.1:1 (gyroid), 4.3:1 (noise), 4.0:1 (hyperuniform), 10:1 (spinodoid), 1.1:1 (open foam) and 2.6:1 (closed foam). M003 has 9.7 s to 5.8 s = 1.7:1 in wall time at High on the pool. These are the same order but **not comparable**: one thread against 15 workers, Med against High, no shaped parts or welds. M003 counts shaped hyperuniform alone at 3.96 s of the 9.7 s, and there is no shaped job here. The worker now forwards the timing split, so the High run in the click test settles it.
- Simplify was 14-43 % of total CPU in the first Node measurement (commit 7d10da1, the Skeptic's arithmetic), against two thirds of wall time in M003. So in your wall time, how well each stage spreads over the cores matters as much as total CPU. The slab job count is capped near the core count for parts under about 16 mm at High (`m36` `slabJobs`). At Med the final rounds had only 3 and 2 bands.

### 2b. Candidates on the same meshes (measured)
Source: `proto/simplify-bench/results/bench-med-b1.json` (best of 3), plus `exp-rings.json` (best of 3), and `exp-tolx.json` and `bench-med-A.json` (one run each). Total simplify CPU (slabs plus final pass), Med, one thread. "Today" is from the same run.

| Family (Med) | Triangles (all three) | Max deviation, mm (all three) | Today ms | B1a (fast check) | B1a + lazy input check | Saving, B1a | Saving, B1a + lazy |
|---|--:|--:|--:|--:|--:|--:|--:|
| TPMS gyroid sheet | 7,938 | 0.0363 | 811 | 594 | 459 | 27 % | 43 % |
| noise simplex sheet | 19,710 | 0.0544 | 1,530 | 1,196 | 1,207 | 22 % | 21 % |
| hyperuniform | 23,018 | 0.0330 | 1,121 | 878 | 795 | 22 % | 29 % |
| spinodoid | 21,622 | 0.0326 | 4,595 | 3,400 | 2,851 | 26 % | 38 % |
| foam (open, Lloyd) | 221,690 | 0.0072 | 4,727 | 2,381 | 3,556 | 50 % | unreliable (spread 1.7-2.9 s) |
| foam (closed Kelvin) | 9,794 | 0.0501 | 1,740 | 988 | 804 | 43 % | 54 % |

Triangles and deviation are the same for all three methods, because the outputs are identical. Deviation is the sampled two-sided distance from the raw marching mesh. Candidate A's same-tolerance and matched-deviation figures are below; they come from `results/bench-med-A.json` (one run, not best of 3).

- **Matched output:** B1a and B1a + lazy give **hash-identical** vertex and index arrays to today's pipeline on every mesh, at Draft and Med. That includes an open input (the "unsafe" path) and stress runs at 25x and 100x tolerance that force retries and one give-up. So time is the only difference. Their closedness and self-intersection counts are therefore today's: closed everywhere, with the self-intersections listed in 2c. B1b's outputs were also closed and seam-exact.
- **How:** B1a builds a per-vertex list of outgoing half-edges (the layout `flipEdges` already uses) instead of sorting every edge. Source: `results/microbench.json`, per Med slab, median of 5 runs. The check takes 6-21 ms against 36-112 ms for the sort: **about 5-7x faster** on per-mesh totals (5.5-6.8x in the saved file; the Verifier's rerun gave 3.5-5.5x on a loaded machine). An open-addressing hash table was tried first: 138-453 ms per check, **about 3-5x slower** than the sort (3.2-4.7x saved; 4.1-5.3x in the rerun). Its code was recovered from commit 1162fe9 to re-measure it. The Skeptic predicted the cache problem.
- **Lazy input check:** meshoptimizer runs first. The raw input is checked only if the result shows a tear or a changed seam edge. Output is the same whenever the input is closed, which the marching code guarantees.
- **B1b, re-simplify only the patch around a tear: rejected.** The patch was accepted in 0 of 4 / 24 / 4 / 24 / 28 / 8 attempts at Med (gyroid, noise, hyperuniform, spinodoid, open foam, closed foam). At Draft, hyperuniform accepted 2 of 4, which changed its output slightly. At Med it was slower than B1a on 4 of 6 families (gyroid 557 against 594 ms, hyperuniform equal). meshoptimizer's first pass moves edges near the patch boundary, so the patch never fits back.
- **Wider first lock ring (3 rings): rejected.** Spinodoid went from 3,929 to 5,438 ms with twice the triangles (21,622 to 43,138). Noise retries went from 6 to 11.
- **A, meshoptimizer Regularize (in the pinned 1.1.1): quality, not speed.** Source: `results/bench-med-A.json`; 4 non-foam families, with foam skipped for time.
  - **At the same tolerance** it gave 7.5-19.5x the triangles (gyroid 7,938 to 154,486) and took 1.6-2.2x the time (gyroid 709 to 1,529 ms; spinodoid 3,706 to 7,658 ms).
  - Needles fell from 0.34-1.60 % to 0.01-0.02 %. The 5th-percentile minimum angle rose from 7.7-11.3° to 28.4-31.4°.
  - **Self-intersections dropped to 0** on every family, where today had 3 on gyroid and 3 on spinodoid.
  - **Tuned to today's max deviation** (tolerance x1.7-2.6) it still gave 2.2-5x the triangles: gyroid 25,256 (3.2x), noise 43,350 (2.2x), spinodoid 108,032 (5.0x). Time was 1.06-1.67x today's.
  - Hyperuniform did not reach a match in 7 steps: at 2.9x tolerance it gave 25,344 triangles with 91.5 % more deviation.
  - Every output was closed, with seam edges kept.
  - Permissive and Prune were not tried for export: Permissive relaxes how seam and locked vertices are treated, and Prune deletes small pieces.
- **Open foam's tolerance is a big lever.** Source: `results/exp-tolx.json`, today's pipeline, one run. At 1x, 4x and 10x tolerance it gave 221,690 / 61,278 / 16,804 triangles in 3.0 / 1.6 / 1.3 s. Today's rule sets the tolerance to 5 % of the thinnest feature, which is very tight for 0.1 mm walls. Loosening it trades deviation for time, so it is your call, not a technique.

### 2c. Checks on today's output (measured)
- Every output (today's and every candidate's) is closed (0 open edges, 0 non-manifold edges) and keeps each slab's seam edges exactly.
- **Self-intersections:** the sampled checker found intersecting triangle pairs in today's simplified meshes. At Draft: noise 22, hyperuniform 8, spinodoid 12. At Med: gyroid 3, spinodoid 3, open foam 1, closed foam 4. Pairs that share a vertex are not tested, and under `--quick` the check is sampled (6,000 triangles).
- **Not yet known:** whether they come from the raw marching mesh, the slab simplify, the final pass or the flips, and whether classic exports have them too.
- **Likely cause (reasoning, not tested):** meshoptimizer's only guard against folding is a local normal test (about 75°). Nothing stops faces from two nearby sheets crossing, the same thin-wall situation that causes tears.
- **Checkers checked:** `--check` plants defects and fails unless they are found: one triangle removed (open edge found), a non-manifold edge, two crossing triangles (1 pair; separated triangles and a sphere 0), and deviation on a plane and a sphere offset by a known distance (within 0.1 %).

### 2d. Technique table
Licence: F13LD.mesh is MIT. Copyleft and non-commercial code is out, and MPL is flagged. "Own" means build it ourselves. Rows marked measured are this expedition's one-thread Med results. Other rows give what the opened sources say. "Snippet" means only a search result backs the claim.

| Technique | Speed | Closed / tear-free | Deviation control | Triangle quality | Browser multi-core / GPU fit | Licence | Effort | Verdict | Sources |
|---|---|---|---|---|---|---|---|---|---|
| Today: meshoptimizer 1.1.1 under `safeSimplify` | Baseline; checks + locks 38-56 % of slab simplify | Closed, seam-exact; a few self-intersections | Absolute, approximate | Flips on flat areas | Slabs on all cores; final rounds use few cores | MIT | — | Baseline | [simplifier.cpp][s1], [README][s2] |
| Own: B1a fast check + lazy input check | **Measured −21 to −54 %** of total simplify CPU | Identical output (hash) | Same | Same | Same; less memory than the sort | Own, MIT | Low | **Ship as a new option, off by default first** | bench results |
| Own: hash-table check | **Measured about 3-5x slower** than the sort (microbench.json) | Same | Same | Same | Cache-bound | Own | Low | Rejected | bench results |
| Own: patch-only tear repair (B1b) | **Measured: slower than B1a on 4 of 6 families**, 0 patches accepted at Med | Patch boundary never matches | Same | Same | Same | Own | Medium-high | Rejected | bench results |
| QEM variants: link-condition serial QEM | Unknown in JS; usually slower per collapse than WASM | Link condition proves it only for closed meshes; open slab pieces need boundary rules | QEM | Needs a filter | Per slab | Own, MIT | High | Not needed now that checks are cheap | [arXiv 2512.19959][s3], [CGAL docs][s4] |
| QEM, parallel forms (independent regions, atomic-min rounds) | GPU papers: 7.2 M faces in 4.29 s on a laptop GPU; 2 M faces to 20 k in about 3 s on an RTX 4090 | Link condition plus a post-pass that undoes intersections; no proof | QEM | Penalty terms | CUDA only; WebGPU lacks 64-bit atomics (snippet) | Papers; PaMO code AGPL-3.0 | High | Not now | [Mousa & Hussein][s5], [PaMO arXiv][s6], [PaMO repo][s7] |
| meshoptimizer newer options: Regularize (in 1.1.1) | **Measured: 1.6-2.2x slower** at the same tolerance; 1.06-1.67x at matched deviation | Closed, seam-exact, **0 self-intersections** on 4 families | 2.2-5x the triangles at matched deviation | **Needles about 1 % → 0.01-0.02 %; P5 angle 8-11° → 28-31°** | As today | MIT | Low | Quality option only | [meshoptimizer.h][s8] |
| meshoptimizer: Permissive, Prune, Sloppy (in 1.1.1); RegularizeLight, PreserveFolds, ErrorClamped (1.2-1.3) | Not measured | No manifold claim; Prune drops pieces; Sloppy ignores topology | — | — | Newer ones need a second copy (classic pins 1.1.1) | MIT | Low | Reject the first three; not tried | [releases v1.3][s9], [meshoptimizer.h][s8] |
| Vertex clustering (incl. lock-free parallel, P-Weld) | 3.86x on a 14 M-vertex mesh (P-Weld) | Not addressed; needs a manifold repair | No bound | Poor | Workers with shared memory | Paper; own MIT | Medium-high | Rejected (no manifold rule) | [P-Weld][s10] |
| Simplifying during extraction: surface nets | About half the triangles of marching cubes in one 65³ demo | Can be non-manifold | Unknown | Unknown | Per slab | Own, MIT | High | Longer bet | [0fps][s11], [Kitware][s12] |
| Simplifying during extraction: dual contouring / manifold DC | Relative figures only (k-d tree vs octree) | Manifold DC claims closed (snippet) | QEF | Unknown | Per slab | Own, MIT | High | Longer bet, its own decision | [Informatica 2024][s13] |
| Own ideas: octree / cell merge by field error, per-cell clustering on the marching grid, coarse mesh + Newton projection | Unknown | Unknown; needs a manifold rule | The field itself | Unknown | Per slab | Own, MIT | Medium-high | Longer bet | **Unsourced** (snippets only; scouts 7 and 8) |
| Periodic unit-cell tiling (TPMS) | Unknown | Needs matched faces | As the cell | As the cell | Parallel | Own, MIT (UnitCellEngine Apache-2.0; Microgen GPLv3) | Medium-high | Later decision | [UnitCellEngine][s14], [Microgen][s15] |
| Feature-aware / isotropic remeshing | No timing | No guarantee | Projection | The goal | Unknown | Own, MIT | High | Not a speed play | [chipnbits][s16] |
| GPU decimation (WebGPU own; CUDA research) | CUDA only; one SIGGRAPH 2023 talk, no numbers | Post-check undo | QEM | — | No WebGPU code found | Papers; own MIT | Very high | Only with the GPU mesher (D0001) | [Gautron et al.][s17], [PaMO arXiv][s6] |
| Desktop: Manifold Simplify / Decimate | Not benched | Manifold by design (may split vertices); needs a closed input | Under the tolerance | Delaunay check | One thread | Apache-2.0 | Low to try | Bench row still open | [Manifold API][s18], [edge_op.cpp][s19] |
| Desktop: pmp-library | Unknown | Not stated | Hausdorff, normal deviation | Aspect-ratio check | C++ / WASM | MIT | Medium | Desktop option | [pmp licence][s20], [pmp decimation][s21] |
| Desktop: CGAL | Unknown | Link condition | Envelope | Filter | C++ | **GPL** | — | Rejected | [CGAL docs][s4] |
| Desktop: libigl / sp4cerat | Unknown / about 4x MeshLab | Not stated / weak on thin parts | Edge length / threshold | — | C++ | MPL-2.0 (flagged) / MIT label | Medium | Reference only / not for lattices | [libigl decimate.h][s22], [sp4cerat][s23] |
| Desktop: OpenMesh, VCG / MeshLab, Open3D | Not assessed | — | — | — | — | — | — | Not assessed | **Unsourced** (no page opened) |

### 2e. Ranked recommendations
**F13LD.mesh**, ranked by time saved against effort and risk. Savings are one-thread Med CPU of total simplify; your High run gives wall time.

| Rank | Option | Time saved | Effort | Risk | When |
|---|---|---|---|---|---|
| 1 | **Fast checks + lazy input check** (new option, off by default first) | **Measured 21-54 %** (five families; open foam unreliable) | Low | Low: identical output by hash; classic untouched | Build now (plan in section 5) |
| 2 | **Final pass and spread over cores**: more jobs than cores, more or narrower bands, skip rules ranked by ms per triangle removed | Not measured in wall time. CPU: open foam's final pass 2.1 s, others 0.16-0.41 s | Low-medium | Medium: output changes; box must stay at 12 triangles | After your High run |
| 3 | **Find and fix the self-intersections** (correctness, not speed) | — | Unknown | — | Next expedition |
| 4 | **Looser tolerance for thin foam walls** | Open foam 3.0 → 1.6 s at 4x (one thread) | Very low | More deviation on 0.1 mm walls | Your call |
| 5 | **Regularize as a quality option** | None: costs 1.06-2.2x the time and more triangles | Low | Larger files | If you want better triangles, or as the self-intersection cure |
| 6 | Manifold Decimate as a bench row | Not benched | Low | Medium-high (may split vertices) | Open question |
| 7 | **Fewer triangles at extraction** (dual contouring, cell merging by field error), its own Crux decision | Goes after the first meshoptimizer call (12-26 %) plus marching | High | High: closedness claims unverified | Longer bet |
| 8 | TPMS unit-cell tiling; GPU decimation; JS link-condition QEM | — | High | High | Later, or not needed |

- **Rejected by measurement:** patch-only tear repair, a wider first lock ring, a hash-table check, Regularize as a time saver.
- **Rejected on licence:** CGAL (GPL), PaMO (AGPL-3.0), Microgen (GPLv3). libigl is MPL, for reference only.

**Matt's other tools** (desktop and browser):
1. Every tool that wraps meshoptimizer in a "simplify, check closed, retry" loop should:
   - check closedness with a per-vertex half-edge list, not a sort of every edge, and never with a JavaScript hash table (about 3-5x slower than the sort here);
   - check the input only when a problem shows;
   - keep check functions separate from any count users see.
   This cut 21-54 % here with identical output.
2. **Check outputs for self-intersections too:** closed and seam-exact does not mean intersection-free.
3. **Browser previews and level of detail:** plain meshoptimizer `simplify`, or `simplifySloppy` where topology doesn't matter.
4. **Analysis or FE meshes:** Regularize, for far fewer needles.
5. **Desktop closed export meshes:** native meshoptimizer with the same wrapper (MIT), then pmp-library (MIT, Hausdorff and aspect-ratio controls), then Manifold's simplify (Apache-2.0).

## 3. Skeptic's objections (and what was done)
1. **One-thread CPU is not your wall time; shaped parts are missing.** The worker now forwards the split, and the High run is in the click test. **Still open:** shaped parts and welds are unmeasured (no Node-built shaped job), although the top pick's output is identical by construction.
2. **"Same output" needs proof, and a lazy input check may be cheaper than a rewrite.** Both were built and benched. The hashes are identical on every mesh plus the open and give-up stress cases, and both sit in the top pick.
3. **The final pass was ranked too low.** It is now rank 2, waiting for your High run. Per-round times are in 2a.
4. **Open foam's weak reduction is not evidence for extraction-side headroom.** Partly upheld. Locks are not the limit (240 locked vertices), but the tolerance run shows tolerance is (2b). Extraction-side options face the same tolerance, so they stay a longer bet.
5. **Licences:** CGAL's simplification package is GPL, and the PaMO repo is AGPL-3.0. Both are rejected.
6. **Classic does not use `safeSimplify`; it shares only `meshClosedReport`, whose counts appear in the export report.** The fast checks use new names and never shadow it. The stale comment in `m35` is to be fixed in the build.
7. **Measurement hygiene:** runs are best of 3 with the spread printed. The machine was shared, open foam's lazy row is unreliable, and noise's flat lazy result is probably noise.
8. **Regularize is a quality option, not a time saver.** Measured and agreed (2b).

## 4. Decisions made on Matt's behalf
- Prototype in `proto/simplify-bench/`. Candidates were chosen after measuring, by the Advisor's rule: checks + retries at 40 % or more of simplify time means fix the checks first. The rule fired on every family.
- No headless browser (Playwright 1.56's Chromium is missing) and nothing installed. Meshes were built in Node through the real code and marked as such. Byte-identity was proven by hashing main against the branch in Node, and the browser harness moved to the click test. The worktree reuses an existing test-packages folder through a link; nothing was copied or installed.
- Candidate A is Regularize only, on the pinned 1.1.1. Permissive and Prune were dropped (seam and lost-piece risk), and no newer meshoptimizer was installed.
- Candidate B is B1a (same output) plus B1b (patch repair). B1b was rejected by measurement.
- Matt asked for more researchers mid-run. The last two research runs searched freely for build-it-ourselves options instead of reading a fixed page list (8 runs in all, the hub's cap).
- The top pick is planned as a new option, off by default, made default only after your byte-identity run, rather than as a silent drop-in.
- Classic simplify is untouched. Existing files change only for timing: `worker/m35-slab-cleanup.js`, `worker/m36-slab-pool.js`, `worker/field-bake-worker.js` and `tests/regress.html`.

## 5. Build status and what to run yourself
- **On the branch:** timing-only counters and their forwarding from the workers, shown on the bench page as a "simplify CPU split" line. Also `proto/simplify-bench/`:
  - `make-jobs.mjs`: Node-built jobs. The Draft data is committed; regenerate Med in about 40 s.
  - `measure.mjs`: the time breakdown.
  - `bench.mjs`: methods today / B1a / B1a-lazy / B1b / A, with every metric and `--check`.
  - `cand/`: the candidates.
  - `index.html` and `page.mjs`: the page.
  - `build-single.mjs`: the single double-click HTML.
  - `README.md`: dependencies and licences. meshoptimizer 1.1.1 is MIT; the rest is own code.
- **Checks run by the expedition (Verifier, loop 1):**
  - `node tests/slabmesh.js quick` passes (all slab meshes closed, raw meshes identical across slab counts, box at 12 triangles).
  - `node proto/simplify-bench/bench.mjs --quick --check` passes in 26 s: checker self-tests; baseline equal to `m35` / `m36` run directly; branch equal to main (main's files read with `git show`); B1a and lazy equal to today, all by hash.
  - `node proto/simplify-bench/build-single.mjs --check` passes: one 4.06 MB file, nothing external.
- **`tests/harness.js` was not run**, neither classic byte-identity nor slab `GEOM=1`. Playwright 1.56's Chromium is not on this machine, and nothing may be installed. The Node hash check above stands in, and covers `m35` / `m36`. It cannot cover the three timing fields added to `worker/field-bake-worker.js` messages or the one display line in `tests/regress.html`. Those are browser-only, so the harness run is in your click test.
- **Meshes are "Node-built jobs":** the `tests/recipes.json` cases built in Node through the real field code (`buildSDF`) and marching code (`m34 slabMeshLayers`). DUMPJOB jobs needed the same missing browser.
- **Not wired into exports.** The top pick is a prototype in `cand/fast.js` and `cand/lazy.js`.
- **Not looked at in a browser:** the page's layout and icons are unseen. The single file was executed in Node on a stand-in page.
- **Build plan for the top pick (v0.16.5, a new option, identical output):**
  - **As an option, not a silent change:** a setting `f13ld.mesh.fastChecks` in `localStorage`, carried on the export job the way the Mesher and Loose-pieces settings are. It is **off by default** in v0.16.5, so exports run exactly today's code. With it on, slab exports use the fast checks. Once your harness and `regress.html` runs show identical exports with it on, a later release can make it the default, with today's checks kept behind the same switch. The bench and harness can run both paths in one build.
  - **Files:** port `cand/fast.js` and `cand/lazy.js` into `worker/m35-slab-cleanup.js` as new functions `closedEdgesFast`, `openEdgeCountsFast` / `openEdgeChangesFast` and `ringLockFast`. Comment the invariant that a shared edge has both ends open.
  - **Hooks:** in `safeSimplify`, the ring lock, the raw-input check (made lazy: checked only when the first result shows a problem; an open input still returns "unsafe" with the input unchanged), the seam baseline and the per-try problem check. In `checkedFlip`, its closed check.
  - **Unchanged:** `meshClosedReport` (classic's report and the tests keep it), classic simplify, `m34` and `m36`. Fix the stale "classic uses it too" comment.
  - **Also:** the timing forwarding from this branch, and the version bump (`01-config.js`, `index.html` label, worker cache key).
  - **Checked by:**
    1. the old and new checks agree on planted cases (`node --test proto/simplify-bench/microcheck.test.mjs`): closed sphere, triangle removed, duplicate, flipped, and seam sub-meshes. Only the `bad` count differs, and nothing in `safeSimplify` uses it;
    2. `bench.mjs --check` hashes main against the build on all 12 jobs plus the stress cases;
    3. `tests/slabmesh.js` and `tests/flipedges.js`;
    4. your harness run, classic and slab byte-identical;
    5. your `regress.html` High run, v0.16.4 against v0.16.5.
  - **If any hash differs with the option on, the option does not ship.**

## 6. Parked items, proposed as next expeditions
1. **Self-intersections in slab output:** find whether they come from marching, slab simplify, the final pass or flips; whether classic has them; and a fix. A correctness item.
2. **Final pass and parallel spread:** more jobs than cores, narrower or more bands, and skip rules ranked by ms per triangle removed. Do this after your High run.
3. **Shaped parts and welds** in the bench (a Node-built shaped hyperuniform job), plus a Manifold Decimate row.
4. **Thin-foam tolerance:** what deviation you accept for 0.1 mm walls (4x tolerance took open foam from 3.0 s to 1.6 s and from 221,690 to 61,278 triangles, one thread).
5. **Fewer triangles at extraction** (dual contouring, merging cells by the field's error, per-cell clustering) and **TPMS unit-cell tiling**, as a Crux decision once the cheaper levers are in.
6. **Regularize as an export quality option** (for FE meshes), if you want better triangles at the cost of larger files. Test it also as a cure for item 1: it had 0 self-intersections where today had 3 on gyroid and 3 on spinodoid.

## 7. Sources
Pages a gatherer actually opened (notes-1 to notes-8), plus two the Skeptic checked:
- [s1]: https://github.com/zeux/meshoptimizer/blob/master/src/simplifier.cpp and https://raw.githubusercontent.com/zeux/meshoptimizer/master/src/simplifier.cpp
- [s2]: https://github.com/zeux/meshoptimizer
- [s3]: https://arxiv.org/html/2512.19959
- [s4]: https://doc.cgal.org/latest/Surface_mesh_simplification/index.html
- [s5]: https://pmc.ncbi.nlm.nih.gov/articles/PMC8341488
- [s6]: https://arxiv.org/html/2509.05595v1
- [s7]: https://github.com/SarahWeiii/pamo (Skeptic)
- [s8]: https://raw.githubusercontent.com/zeux/meshoptimizer/master/src/meshoptimizer.h
- [s9]: https://github.com/zeux/meshoptimizer/releases/tag/v1.3 and https://github.com/zeux/meshoptimizer/releases
- [s10]: https://history.siggraph.org/?p=214578
- [s11]: https://0fps.net/2012/07/12/smooth-voxel-terrain-part-2/
- [s12]: https://www.kitware.com/really-fast-isocontouring/
- [s13]: https://informatica.si/index.php/informatica/article/view/5420
- [s14]: https://github.com/unitcellhub/unitcellengine
- [s15]: https://microgen.readthedocs.io/
- [s16]: https://chipnbits.github.io/blog/posts/isotropic-remeshing/index.html
- [s17]: https://history.siggraph.org/learning/interactive-gpu-based-decimation-of-large-meshes-by-gautron-kubisch-and-lorach
- [s18]: https://manifoldcad.org/docs/html/classmanifold_1_1_manifold.html and https://github.com/elalish/manifold
- [s19]: https://raw.githubusercontent.com/elalish/manifold/master/src/edge_op.cpp
- [s20]: https://raw.githubusercontent.com/pmp-library/pmp-library/main/LICENSE.txt
- [s21]: https://www.pmp-library.org/decimation.html
- [s22]: https://raw.githubusercontent.com/libigl/libigl/main/include/igl/decimate.h
- [s23]: https://github.com/sp4cerat/Fast-Quadric-Mesh-Simplification
- Also opened: https://cdn.jsdelivr.net/npm/meshoptimizer@1.1.1/README.md, https://cdn.jsdelivr.net/npm/meshoptimizer/package.json, https://raw.githubusercontent.com/zeux/meshoptimizer/master/js/meshopt_simplifier.d.ts, https://libigl.github.io/license, https://seonghunn.github.io/pamo/
- The CGAL GPL licence statement comes from the Skeptic's check of the CGAL package reference; cgal.org/license.html was seen as a search result only.

<!-- hub-generated: everything below this line is written by the hub from the event log -->

## Claims check

The Verifier's claims pass ran (verify/VERDICT.md has a claims or corrections section).

## Parked, as proposed next expeditions

None.

## Requests that were not allowed

- Bash: cd C:/Users/mshom/Documents/GitHub/f13ld.mesh/.claude/worktrees/exp-20261119-which-ultra-fast-mesh-simplification-tec/tests && node -e " const {chromium}… (An inline script that reads environment variables or the home folder)
- Bash: cd C:/Users/mshom/Documents/GitHub/f13ld.mesh/.claude/worktrees/exp-20261119-which-ultra-fast-mesh-simplification-tec && node tests/slabmesh.js quick 2>&… (the permission check could not settle it: Not a plain `node --test` run. It runs tests/slabmesh.js, which loads scripts…)
- Bash: cd C:/Users/mshom/Documents/GitHub/f13ld.mesh/.claude/worktrees/exp-20261119-which-ultra-fast-mesh-simplification-tec && node tests/slabmesh.js quick 2>&… (the permission check could not settle it: Runs node tests/slabmesh.js, not a plain node --test run. It loads existing s…)
- Bash: cd C:/Users/mshom/Documents/GitHub/f13ld.mesh/.claude/worktrees/exp-20261119-which-ultra-fast-mesh-simplification-tec && node tests/slabmesh.js quick (the permission check could not settle it: Not a plain `node --test` run, and the scripts it loads (slabmesh.js, manifol…)
- Bash: cd C:/Users/mshom/Documents/GitHub/f13ld.mesh/.claude/worktrees/exp-20261119-which-ultra-fast-mesh-simplification-tec && node proto/simplify-bench/bench.… (the permission check could not settle it: The bench imports lib/geom.mjs and lib/pipeline.mjs, which exist but were not…)
- Bash: cd C:/Users/mshom/Documents/GitHub/f13ld.mesh/.claude/worktrees/exp-20261119-which-ultra-fast-mesh-simplification-tec && node proto/simplify-bench/bench.… (the permission check could not settle it: Runs a bench whose loader env.mjs, geom.mjs and pipeline.mjs are unseen, and…)
- Bash: cd C:/Users/mshom/Documents/GitHub/f13ld.mesh/.claude/worktrees/exp-20261119-which-ultra-fast-mesh-simplification-tec && git add -A proto && git commit -… (the permission check could not settle it: Runs node --test on proto/simplify-bench/microcheck.mjs, which is not under a…)
- Bash: cd C:/Users/mshom/Documents/GitHub/f13ld.mesh/.claude/worktrees/exp-20261119-which-ultra-fast-mesh-simplification-tec && git rm -q -f proto/simplify-benc… (the permission check could not settle it: Not a plain test run (test file is not under a test folder) and it is joined…)
- Bash: cd C:/Users/mshom/Documents/GitHub/f13ld.mesh/.claude/worktrees/exp-20261119-which-ultra-fast-mesh-simplification-tec && BENCH_ARGS="--sample --check --t… (the permission check could not settle it: Test file isn't under a test folder, so it isn't a plain test run. pipeline.m…)
- Bash: cd C:/Users/mshom/Documents/GitHub/f13ld.mesh/.claude/worktrees/exp-20261119-which-ultra-fast-mesh-simplification-tec && node proto/simplify-bench/build-… (the permission check could not settle it: The check executes scripts I can't see (lib/pipeline.mjs, lib/slabparse.mjs,…)
- Bash: cd C:/Users/mshom/Documents/GitHub/f13ld.mesh/.claude/worktrees/exp-20261119-which-ultra-fast-mesh-simplification-tec && git add -A proto && git commit -… (the permission check could not settle it: Not a plain test run: the test file isn't in a test folder, and lib/env.mjs (…)
- Bash: cd C:/Users/mshom/Documents/GitHub/f13ld.mesh/.claude/worktrees/exp-20261119-which-ultra-fast-mesh-simplification-tec && node --test proto/simplify-bench… (the permission check could not settle it: lib/env.mjs, which loads files named at run time, is not shown, and the test…)
- Bash: cd C:/Users/mshom/Documents/GitHub/f13ld.mesh/.claude/worktrees/exp-20261119-which-ultra-fast-mesh-simplification-tec && node --test proto/simplify-bench… (the permission check could not settle it: Plain test run is fine, but lib/env.mjs, which loads code at run time, is uns…)
- Bash: cd C:/Users/mshom/Documents/GitHub/f13ld.mesh/.claude/worktrees/exp-20261119-which-ultra-fast-mesh-simplification-tec && git add -A proto && git commit -… (An inline script that reads environment variables or the home folder)

## How it ran

Generated from the hub's event log (usage events and expedition events), not estimated. Stop reason: passed. Elapsed: 1 h 09 min.

| Role | Agents | Turns | Time at work | Tokens (in / out) | Cost |
|---|---|---|---|---|---|
| Lead (incl. gatherers) | 1 | 22 | 13 min | 13.39M / 200.4k | $6.03 |
| Advisor | 1 | 1 | 2 min | 333.0k / 10.3k | $1.47 |
| Synthesizer | 1 | 6 | 14 min | 5.49M / 122.9k | $5.41 |
| Skeptic | 1 | 1 | 6 min | 2.67M / 47.1k | $1.53 |
| Builder | 1 | 5 | 44 min | 30.18M / 182.6k | $6.25 |
| Verifier | 1 | 3 | 18 min | 8.26M / 71.5k | $4.84 |
| unknown | 1 | 65 | 0 min | 489.6k / 11.4k | $0.87 |
| **Total** | | 103 | 1 h 37 min | 60.80M / 646.2k | $26.41 |

Gatherers run inside the Lead, so their time and cost are in the Lead's line and are not split out.

Build-verify loops: 1 (3 passing); 2 (8 passing); 3 (10 passing). Decisions made on the user's behalf: 5. Parked: 14 (14 of them requests that were not allowed).

Spend figures here are the results' logged usage. While a turn runs, the hub's watchdog counts an upper-bound estimate that each result replaces (memo M046), so a limit may trip a little early, never late.
