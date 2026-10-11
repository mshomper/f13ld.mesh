# F13LD.mesh — session recap, 2026-10-11 · v0.9.9 noise revision 2

**Main:** v0.9.9. One release across F13LD.noise v0.12.0, F13LD.lab v0.26.2, F13LD.sweep v0.29.4, F13LD.vault v0.8.1 and F13LD.ingest v0.11.0. The spec and the checks: `f13ld.noise/docs/NOISE_REV2.md`. The Mesh next-steps list is still in [`SESSION_RECAP_2026-10-04.md`](SESSION_RECAP_2026-10-04.md) (plus the items in [`SESSION_RECAP_2026-10-10.md`](SESSION_RECAP_2026-10-10.md)).

## Why
Mesh's noise library is a copy of F13LD.noise's CPU code, which had a simplex lattice error: the gradient index used a truncated 1/7, and the fold test `h <= 0` flips with rounding on 7 of the 49 gradients. About 41 % of sample points differed from the tool's 3D preview, and the raw range came out ±4.5 instead of ±1, which skewed the center / half-width band. A default simplex sheet printed 86 % solid. Domain warp also displaced with all octaves here and 2 in the preview.

## What shipped (v0.9.9)
- `surface.noise_rev` picks the math (`worker/m10-noise.js`, `Noise.setRev`; set by `evalNoiseRaw` in `worker/m20-sdf-noise-tpms.js`):
  - **1 (absent)** — recipes from F13LD.noise ≤ v0.11.0. Prints exactly as before.
  - **2** — F13LD.noise v0.12.0+. Exact integer mod 49 / 7, integer fold test `|4x−13| + |4y−13| ≥ 14`, PCG3D integer hash for Worley cell seeds, warp displacement from min(octaves, 2) octaves. The same field the tool's GPU preview and F13LD.lab / F13LD.sweep build.
- A revision newer than 2 is refused with a message (`noiseRevOf`), in the SDF build and the preview bake.
- The noise summary card shows the revision (`1 (legacy)` or `2`).

## Checks
- `tests/harness.js <main> <branch>`: every case byte-identical, including the two legacy noise recipes.
- F13LD.sweep `tests/parity/noise-legacy.js`: 19 F13LD.noise v0.11.0 recipes build the same voxels as before; their revision-2 versions agree with Sweep within 0.09 %.
- F13LD.sweep `tests/parity/parity.js` (all families): PASS.

## Next (Mesh)
- Nothing new for noise. Any future change to the noise field is a revision 3, made here, in F13LD.lab's `F13LD-GEOM-NOISE` block and in F13LD.noise in one release.
- The 2026-10-04 and 2026-10-10 lists still hold.
