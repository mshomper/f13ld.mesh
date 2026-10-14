# F13LD.mesh — session recap, 2026-10-14 · v0.9.10 hyperuniform speed

**Main:** v0.9.10, merged with F13LD.lab v0.29.2 and F13LD.sweep v0.33.1 after Matt's click-test. Lab's recap has the full story: `f13ld.lab/docs/SESSION_RECAP_2026-10-14_hu-speed.md`. The Mesh next-steps list is still in [`SESSION_RECAP_2026-10-04.md`](SESSION_RECAP_2026-10-04.md) (plus the items in [`SESSION_RECAP_2026-10-10.md`](SESSION_RECAP_2026-10-10.md) and below).

## Why
Matt found hyperuniform Grain designs very slow in F13LD.lab (every kernel visited at every point). Mesh's cube-mode and periodic evaluators had the same loop over all design kernels — ~50 µs per sample on a 205-kernel recipe, so a Fine (0.05 mm) 10 mm cube needs several minutes against the 180 s export timeout.

## What shipped (v0.9.10)
- `worker/m11-grain-fields.js` — `buildHUIndex(kernels, periodic)`: 24³ bins over [-π, π]³ + 0.5, each listing (in kernel order) the kernels whose cut-off shape reaches it; the periodic index lists a kernel wherever any of its 27 images reaches. Cached on the kernel array (`_huIdx`, `_huIdxP`). `evalHUField` and `evalHUFieldPeriodic` skip a term when R^m ≥ 40·max(1, 1/P) — the same rule as F13LD.lab v0.29.2 — at every point; queries outside the grid use the full loop. The periodic variant takes the bin from the query folded into the cell and the displacements from the query itself, as before.
- Shape-mode `evalHUFieldMM` (its own reach-sized hash) is unchanged.
- `F13LD_MESH_VERSION` and header label 0.9.10.

## Checks
- Old vs new evaluators at 40,000 random points (inside and 10 % beyond the cell) on Matt's recipe and the three Sweep HU fixtures: identical or one rounding step (≤ 2.2e-16); 1–12× faster (3–4× on Matt's recipe — Mesh carries only the design kernels, so the gain is smaller than Lab's).
- `tests/harness.js … hyperuniform`: `grain-hyperuniform` and `shape-hyperuniform` 3MF exports byte-identical.
- `tests/fieldtest.js`: A2–A4 pass (preview vs export correlation 1.000, weld tiling 500/500).
- Not run: `tests/grainrng.js` (needs an F13LD.grain checkout).

## Open
- Shape-mode export could use the same oriented-box index in `evalHUFieldMM` (its hash checks a 3×3×3 block of reach-sized buckets). Only worth doing if hyperuniform shape exports are still slow at Fine.
