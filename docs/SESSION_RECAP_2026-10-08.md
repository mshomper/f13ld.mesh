# Session recap — 2026-10-08 · v0.9.7 (grain generator, from the F13LD.sweep session)

**Main:** v0.9.7 (`e0a4476`). Done as part of the F13LD.sweep refactor session. Sweep's side: `f13ld.sweep/docs/SESSION_RECAP_2026-10-08.md`; Lab's: `f13ld.lab/docs/SESSION_RECAP_2026-10-08_sweep-parity.md`. The previous Mesh recap ([`SESSION_RECAP_2026-10-04.md`](SESSION_RECAP_2026-10-04.md)) still holds the Mesh next-steps list.

## Why

A cross-check of Sweep, Lab and Mesh on 47 recipes built with each design tool's own export code found Mesh exporting **different grain geometry from what was designed**: 22–50 % of voxels off on spinodoid, GRF and hyperuniform recipes.

Cause: F13LD.grain, Sweep and Lab seed grain fields with an xorshift32 generator that grain calls "mulberry32". Mesh used the standard mulberry32. Seed 42's first draw was 0.0026 in grain / Sweep / Lab and 0.6011 in Mesh, so every grain part Mesh exported was a different random realization from the one designed and analysed.

Matt's call (2026-10-08): Mesh switches to F13LD.grain's generator.

## What shipped (v0.9.7)

| Change | Where |
|---|---|
| Grain's generator copied byte for byte. Covers spinodoid, GRF, hyperuniform and reaction-diffusion (Gray-Scott, Brusselator, Schnakenberg). | `worker/m11-grain-fields.js`, `worker/hu-bake-worker.js` |
| Noise: `warp_strength: 0` stays 0 (`??` instead of `\|\|`), as in F13LD.noise. It used to become 1. | `worker/m20-sdf-noise-tpms.js` |
| New Node test: generator identical to grain's and the same draws for seeds 0, 1, 42, 12345, 2³¹−1; reaction-diffusion grids match grain's builders; grain SDFs agree with Lab's grain rasterizer on 32³. | `tests/grainrng.js` (`tests/README.md`) |

### Behaviour change (approved)

**Grain exports change for existing recipes.** A grain part exported before v0.9.7 is not the design shown in F13LD.grain. Re-export any grain part that matters. Other families are untouched (warp noise only changes when `warp_strength` is 0).

## Checks

| Check | Result |
|---|---|
| `tests/grainrng.js` | pass |
| Mesh vs Lab per family, 48³ (export field) | grain 0.000 %, TPMS and beam 0 %, noise ≤ 0.40 % (same as the noise tool vs Mesh) |
| Sweep `tests/parity/parity.js --quick` (Sweep, Lab, Mesh; 9 design-tool recipes + 8 jittered Sweep designs) | Sweep vs Mesh 0.00 % on every row |

## Found, not fixed

| Item | Notes |
|---|---|
| Hyperuniform: grain tool vs Mesh | The grain tool's own voxelizer differs from Mesh by 1.8 % on a periodic hyperuniform recipe (Mesh = Lab = Sweep exactly). Tool side; check which wrap F13LD.grain intends. |
| Grain seed 0 | The shared generator sticks at 0 for seed 0. A fix must go into grain, Lab, Mesh and Sweep together. |

## Related changes elsewhere

- **F13LD.sweep** now sends Mesh the exact recipe it solved (`#r=` link, Mesh button on every result row), including jittered wall thickness, cell scale (`cell_scale_x/y/z`), normalize flags, noise range and grain seed per design.
- **F13LD.lab v0.26.0** builds noise and anisotropic shells as Mesh prints them; Lab = Mesh on every family.
