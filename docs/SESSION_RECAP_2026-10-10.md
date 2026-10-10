# F13LD.mesh — session recap, 2026-10-10 · v0.9.8 wave cell stretch

**Main:** v0.9.8. Done as part of the F13LD.sweep Wave session. Sweep's side: `f13ld.sweep/docs/SESSION_RECAP_2026-10-10.md`. The Mesh next-steps list is still in [`SESSION_RECAP_2026-10-04.md`](SESSION_RECAP_2026-10-04.md) (plus the items below).

## Why
Cubic, Chiral and Schoen waves give equal stiffness on all three axes on a cube, so a Sweep of them could not move anisotropy. Matt chose to stretch the cell: F13LD.wave v0.6 has stretch x / y / z sliders and F13LD.sweep v0.29 draws a stretch per design. Mesh has to print the stretched cell.

## What shipped (v0.9.8)
- `worker/m24-sdf-wave.js`: `field.stretch` [sx, sy, sz] — one wave cell spans world 10·s_i along axis i (q_i = p_i·π/5 ÷ s_i). Absent or invalid = a cube (older recipes unchanged).
- `42-preview-bake.js` `computeWaveBakeBounds`: the bake tile is stretched to match, so the GL_REPEAT preview stays seamless.
- Wave summary card shows the stretch.

## Checks
F13LD.sweep `tests/parity/parity.js --family wave` (Mesh's worker files loaded directly): 11 Wave-tool recipes (two stretched) and 24 swept designs — Sweep ~ Mesh ≤ 0.5 % of voxels. Matt click-tested Open in Mesh from the Wave tool and Sweep.

## Next (Mesh)
- **Bundle** for Sweep v0.30.0: Sweep will solve the true bundle cell box ((Kx·Pxy) × (Ky·Pxy) × Lz, `43-bundle-cells.js`); keep Mesh's cell-box rules as the reference and check parity when it lands.
- The 2026-10-04 list still holds.
