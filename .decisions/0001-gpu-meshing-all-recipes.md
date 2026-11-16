# 0001 How should F13LD.mesh mesh on the GPU for every recipe?

- Status: open
- Date: 2026-11-16
- Lenses: solver, architecture

## In short

Pick how GPU meshing reaches every recipe. I recommend A: the CPU keeps building the field exactly as today for every family, and the GPU only cuts the surface out of it, so every recipe gets GPU meshing at once and files stay the same on any PC. Confidence: lean.

For you:

- A new Mesher choice, GPU, that Auto picks when your browser has WebGPU; slab and classic stay as fallbacks
- Exports get faster by at most the meshing stage (about 3.8 s of the 10.7 s foam-weld bench); field building, clean-up and welds stay on the CPU
- Hard to undo: B would move every family's field maths into GPU code, a large port that has to match Lab and Sweep and gives slightly different files on different GPUs

## Context

Expedition 2 (draft PR #17, board memo M001) built a WebGPU marching-tets mesher that matched the CPU exactly on Matt's RTX 4070 Ti Super: gyroid 256 grid, 7.6 M triangles in about 30 ms on the GPU. Its report advised preview-only use because the GPU computes the field in float32. Matt (2026-11-16): 'I want GPU meshing regardless of recipe.' Today every export builds its field on the CPU through worker/m32-export-field.js (field pool on every core), then meshes in z slabs (worker/m34 marching tets, m35 clean-up, m36 pool). Exports must stay watertight, and the harness requires byte-identical exports for unchanged families.

## Options

### A: CPU field, GPU surface cut (recommended)

The CPU bakes the field as today (all families, welds and imported shapes included) and uploads it; the GPU finds the crossing cells and builds the shared-vertex triangle list; vertex positions are computed in double precision on the CPU from the GPU's edge list, so the raw mesh equals the slab mesher's. The slab clean-up (m35) runs unchanged afterwards.
- Pro: Works for every recipe on day one, because the field code is not touched
- Pro: Same file on every PC: the GPU only decides which edges cross, from the CPU's exact field
- Pro: Checkable: the raw mesh must equal the slab mesher's, so the existing harness and tests/slabmesh.js apply
- Con: Gain capped at the meshing stage; field building stays on the CPU and may become the slowest step
- Con: Uploading big fields (256 to 512 grids) costs time and GPU memory; large parts may need bricks
- Effort: Medium: one solver worker, the prototype's kernels reused with the slab mesher's tables and crossing rule

### B: Everything on the GPU

Port each family's field (TPMS, noise, grain, hyperuniform, foam, wave, beam, bundle, imported shapes, welds) to GPU code, then mesh there too. The fastest path, and the same code could drive live preview meshes.
- Pro: Largest speed-up: field and mesh both on the GPU, nothing large crosses back until the end
- Pro: Opens live, full-quality preview meshes
- Con: Eight-plus families to port and keep matched to Lab, Sweep and Grain's random generator
- Con: Float32 maths: the same recipe can give slightly different files on different GPUs, so byte-identical exports end
- Con: Long build before every recipe is covered
- Effort: Large: one family at a time, each with its own parity checks

### C: A now, GPU fields family by family later

Ship A for every recipe, then move a family's field to the GPU only when a bench shows its field build is the slow step, each as its own decision.
- Pro: Every recipe gets GPU meshing first, with exact files
- Pro: Field ports happen only where measured time says they pay
- Con: Two field paths to maintain for ported families
- Con: Each later port reopens the float32 question for that family
- Effort: Medium now, more later only where it pays

## Recommendation

A (lean). A gives GPU meshing to every recipe at once without touching any field code, and the raw mesh can be proved equal to today's slab mesher, so exports stay exact. C is A plus a later door; it needs no separate pick now.
