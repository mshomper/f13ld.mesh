// proto/gpu-bake/lib/hybrid.mjs
// Hybrid pass: float32 values (GPU or emulated) + float64 re-evaluation on the CPU.
//   (a) every point with |f32| < BAND (or not finite) is re-evaluated in float64;
//   (b) every point at either end of a lattice edge whose signs still differ after (a) is
//       re-evaluated too (the edges the slab / levelSet mesher reads: forEachEdge in grid.mjs,
//       i.e. all axis edges of both lattices and all main-to-offset diagonals).
// BAND is a constant the caller fixes beforehand (bands.mjs). The pass never sees the CPU bake.
// Sign: value > 0 is inside (Manifold convention, see grid.mjs).
import { forEachEdge, totalPoints } from './grid.mjs';

// evalAt(t) -> float64 field value at all-points index t (CPU, the real field).
export function hybridPass(f32, g, band, evalAt) {
  const T = totalPoints(g), fin = new Float64Array(T), re = new Uint8Array(T);
  let nA = 0, nB = 0;
  for (let t = 0; t < T; t++) {
    const v = f32[t];
    if (!(Math.abs(v) >= band)) { fin[t] = evalAt(t); re[t] = 1; nA++; } else fin[t] = v;
  }
  const need = [];
  forEachEdge(g, (a, b) => {
    if ((fin[a] > 0) !== (fin[b] > 0)) { if (!re[a]) need.push(a); if (!re[b]) need.push(b); }
  });
  for (let q = 0; q < need.length; q++) { const t = need[q]; if (!re[t]) { fin[t] = evalAt(t); re[t] = 2; nB++; } }
  return { fin, re, nA, nB, total: T };
}

// Judge against the CPU bake (cpu: Float64Array, same layout).
//  (i)   sign(final) == sign(cpu) at every point
//  (ii)  at both ends of every sign-changing edge (by the CPU bake) final === cpu bit for bit
//  (iii) escapes: points whose float32 sign is wrong and that were not re-evaluated
//  (iv)  band check (added, see README): max |f32 - cpu| <= BAND everywhere. The edge rule (b)
//        repairs most wrong signs even when the error is larger than BAND, so (i)-(iii) alone can
//        pass while the error budget the band was derived from is violated; (iv) reports that.
//        `pass` = (i)(ii)(iii); `certified` = pass && (iv).
export function judgeHybrid(h, f32, cpu, g, band) {
  const T = h.total;
  let signMismatch = 0, escapes = 0, f32Flips = 0, bandViolations = 0, maxErr = 0;
  for (let t = 0; t < T; t++) {
    const wrong = (f32[t] > 0) !== (cpu[t] > 0);
    if (wrong) { f32Flips++; if (!h.re[t]) escapes++; }
    if ((h.fin[t] > 0) !== (cpu[t] > 0)) signMismatch++;
    const e = Math.abs(f32[t] - cpu[t]);
    if (!(e <= band)) bandViolations++;
    if (e > maxErr) maxErr = e;
  }
  let edges = 0, edgeBad = 0;
  forEachEdge(g, (a, b) => {
    if ((cpu[a] > 0) !== (cpu[b] > 0)) {
      edges++;
      if (!Object.is(h.fin[a], cpu[a]) || !Object.is(h.fin[b], cpu[b])) edgeBad++;
    }
  });
  return {
    i: signMismatch === 0, ii: edgeBad === 0, iii: escapes === 0,
    pass: signMismatch === 0 && edgeBad === 0 && escapes === 0,
    bandHolds: bandViolations === 0, bandViolations, maxErr,
    certified: signMismatch === 0 && edgeBad === 0 && escapes === 0 && bandViolations === 0,
    signMismatch, edges, edgeBad, escapes, f32Flips,
    share: (h.nA + h.nB) / T, shareA: h.nA / T, shareB: h.nB / T, reEvaluated: h.nA + h.nB, total: T,
  };
}

// Plain float32-vs-CPU numbers (no hybrid): max abs difference and sign-change count.
export function compareF32(f32, cpu) {
  let maxDiff = 0, maxAt = -1, flips = 0, nonFinite = 0;
  for (let t = 0; t < cpu.length; t++) {
    const v = f32[t];
    if (!Number.isFinite(v)) { nonFinite++; continue; }
    const d = Math.abs(v - cpu[t]);
    if (d > maxDiff) { maxDiff = d; maxAt = t; }
    if ((v > 0) !== (cpu[t] > 0)) flips++;
  }
  return { maxDiff, maxAt, flips, nonFinite };
}
