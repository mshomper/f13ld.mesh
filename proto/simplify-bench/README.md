# Simplify bench (expedition spike)

Where does slab-export simplify time go, and do any candidates beat today's? New files only; **nothing here is wired
into the export path**. The only edits to existing files are timing counters (see "Edits to existing files").

**Substitute environment.** No headless Chromium matching Playwright 1.56 is installed here, so `tests/harness.js` /
DUMPJOB did not run. The meshes are **Node-built jobs**: `tests/recipes.json` open-cube cases built in Node through the
real field code (`buildSDF`) and the real marching code (`m34 slabMeshLayers`), one thread. All timings are **one thread,
Ryzen 7 7700X**, CPU sums, not pool wall time. High on all cores, `tests/regress.html` and `tests/harness.js` are in the
click test of the report.

## Run
From the repository (or worktree) root; Node only, no install (packages come from `tests/node_modules`).
- `node proto/simplify-bench/make-jobs.mjs --quals draft,med` build the raw slab meshes into `data/` (Draft is committed; Med is
  git-ignored, about 40 MB, about 45 s to rebuild).
- `node proto/simplify-bench/measure.mjs` where simplify time goes -> `results/breakdown.json`, `results/breakdown.md`.
- `node proto/simplify-bench/bench.mjs --quick --check` the bench on the Draft meshes with the self-test of the checkers,
  the main-vs-branch hash proof, the same-output proof for B1a and the unsafe / gave-up checks (under 120 s).
  Without `--quick`: all triangles checked; `--quals med --sample --tune` for Med; `--methods today,A,B1a,B1lazy,B1b,rings`;
  `--tolx 4,10` prints today's output size at a scaled tolerance; `--reps 3` prints the time spread.
- `node proto/simplify-bench/build-single.mjs --check` builds `simplify-bench-single.html` (double-click, no server) and
  fails if it references any external script or file; it also runs the inlined page in Node on a fake DOM.
- Page from source: `node proto/simplify-bench/serve.mjs` then open `http://localhost:8091/proto/simplify-bench/`.
- In an environment where running a script directly is not allowed, `node --test proto/simplify-bench/bench.test.mjs`
  (arguments from `bench.args`) and `node --test proto/simplify-bench/build-single.test.mjs` run the same code.

## Methods
`today` is the real `worker/m35-slab-cleanup.js` / `m36-slab-pool.js` of this branch evaluated unmodified. Candidates are
scripts in `cand/` evaluated after them: `a.js` (A: Regularize flag), `fast.js` (B1a: same output, linear-time checks, new
function names, never shadows `meshClosedReport`), `lazy.js` (B1a-lazy), `window.js` (B1b: windowed tear repair, output
changes), `rings.js` (experiment: tear lock starts at 3 rings).

## Dependencies and copied code (all MIT-compatible; F13LD.mesh is MIT)
| what | where | licence |
|---|---|---|
| meshoptimizer 1.1.1 `meshopt_simplifier.js` (WASM simplifier), vendored copy | `vendor/` (+ `vendor/meshoptimizer-LICENSE.md`); Node runs use `tests/node_modules` | MIT, Arseny Kapoulkine |
| F13LD.mesh worker scripts `m31`, `m34`, `m35`, `m36` (embedded as text in the single file) | `../../worker/` | MIT (this repo) |
| acorn (parse check in `build-single.mjs --check`, only if present in `tests/node_modules`; not bundled) | `tests/node_modules` | MIT |
| Closest-point-on-triangle in `lib/geom.mjs` follows the algorithm in C. Ericson, *Real-Time Collision Detection* §5.1.5 (the algorithm, written out here; no code copied) | `lib/geom.mjs` | own code, MIT |
| BVH, triangle intersection, deviation sampling, edge statistics, hashing, slab file format | `lib/` | own code, MIT |
| `build-single.mjs` follows the approach of `proto/gpu-mesh/build-single.mjs` (expedition branch, same repo) | | MIT (this repo) |

Nothing here is copyleft or non-commercial. No network access at run time (the CDN fallback import in `m35` is replaced in
the single file by a rejection; the page never reaches it because the simplifier is passed in).

## Edits to existing files (timing / counters only, no output change)
`worker/m35-slab-cleanup.js` (timers in `safeSimplify`, `simplifySlab`, `simplifyBandJob`, `bandStats`; extra fields on
the returned objects), `worker/m36-slab-pool.js` (compact / join ms, collecting the band and slab timers into the stage
times), `worker/field-bake-worker.js` (forwards `simpT`, `flipMs`, `compactMs` in the `meshslab` and `band` messages),
`tests/regress.html` (one extra line, "simplify CPU split"). `bench.mjs --check` proves the simplified vertex and index
arrays hash the same as `main`'s m35 / m36 on every bundled mesh; it cannot cover the `field-bake-worker.js` message fields or the
`regress.html` line (they run only in a browser pool).

## Limits
Self-intersections ignore triangle pairs that share a vertex. Deviation is sampled (two-sided, seeded), so its maximum is a
lower bound. Under `--quick` self-intersections test a seeded sample of 6000 triangles per mesh (pairs involving a sampled
triangle) and deviation uses 1500 points per side; the output says so.
