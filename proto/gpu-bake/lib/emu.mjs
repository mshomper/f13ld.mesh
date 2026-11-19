// proto/gpu-bake/lib/emu.mjs
// FLOAT32 EMULATION OF THE WGSL KERNELS -- NOT A GPU.
// Same operations in the same order as the kernels in wgsl.mjs, with Math.fround after every
// operation. sin / cos are Math.sin / Math.cos of the rounded argument, rounded to float32:
// that is a correctly-rounded float32 sin / cos, better than any GPU's. So the emulation shows
// what plain float32 arithmetic does to these fields; it cannot show what a GPU's sin / cos or
// fused multiply-add do. Only a GPU run (the page) can.
//
// makeKernel(params, round, opts) -> f(px32, py32, pz32) -> field value in Manifold's
// convention (-sdf, positive inside). With round = identity and no reduction it is the float64
// mirror of the kernel: selftest checks that equals the real worker field bit for bit, which
// proves the kernel's formulas and operation order, separate from any float32 effect.
//
// opts.perturb = { name, rel } multiplies one kernel constant by (1+rel) (negative control).

const f32 = Math.fround;
const TWO_PI_32 = f32(2 * Math.PI), INV_TWO_PI_32 = f32(1 / (2 * Math.PI));

export function makeKernel(params, round, opts = {}) {
  const r = round, p = (round === f32) ? params.f32 : params.f64, pert = opts.perturb || null;
  const constant = (name, v) => (pert && pert.name === name) ? r(v * (1 + pert.rel)) : r(v);
  const reduce = !!opts.reduce;
  const red = a => { const n = Math.round(r(a * INV_TWO_PI_32)); return r(a - r(TWO_PI_32 * n)); };
  const trigS = reduce ? a => r(Math.sin(red(a))) : a => r(Math.sin(a));
  const trigC = reduce ? a => r(Math.cos(red(a))) : a => r(Math.cos(a));

  if (params.kind === 'tpms') {
    const fsx = constant('fs', p[0]), fsy = constant('fs', p[1]), fsz = constant('fs', p[2]);
    const off = r(p[3]), wt = r(p[4]), solid = p[5] === 1, nt = p[6];
    const terms = [];
    for (let t = 0; t < nt; t++) {
      const b = 8 + 16 * t, nf = p[b + 5], fa = [];
      for (let j = 0; j < nf; j++) fa.push({ kind: p[b + 6 + 3 * j], axis: p[b + 7 + 3 * j], freq: r(p[b + 8 + 3 * j]) });
      terms.push({ coef: r(p[b]), hasShift: p[b + 1] === 1, sh: [r(p[b + 2]), r(p[b + 3]), r(p[b + 4])], f: fa });
    }
    const c = [0, 0, 0, 0];
    return (px, py, pz) => {
      c[0] = r(px * fsx); c[1] = r(py * fsy); c[2] = r(pz * fsz);
      let s = 0;
      for (let t = 0; t < terms.length; t++) {
        const T = terms[t];
        let prod = T.coef;
        for (let j = 0; j < T.f.length; j++) {
          const F = T.f[j];
          let tr;
          if (F.kind === 2) tr = 1;
          else {
            let arg;
            if (F.axis === 3) arg = 0;
            else { const v = T.hasShift ? r(c[F.axis] + T.sh[F.axis]) : c[F.axis]; arg = r(v * F.freq); }
            tr = F.kind === 0 ? trigS(arg) : trigC(arg);
          }
          prod = r(prod * tr);
        }
        s = r(s + prod);
      }
      const d = r(s - off);
      const sdf = solid ? d : r(Math.abs(d) - wt);
      return -sdf;
    };
  }
  // grain spinodoid
  const PI5 = constant('fs', p[0]), mid = r(p[1]), halfR = r(p[2]), cN = r(p[3]), hN = r(p[4]);
  const topo = p[5], hi = p[6] === 1, N = p[7], sqrtN = r(p[8]);
  const W = new Float64Array(4 * N);
  for (let i = 0; i < 4 * N; i++) W[i] = r(p[16 + i]);
  return (px, py, pz) => {
    const x = r(px * PI5), y = r(py * PI5), z = r(pz * PI5);
    let s = 0;
    for (let i = 0; i < N; i++) {
      const o = 4 * i;
      const a = r(r(r(r(W[o] * x) + r(W[o + 1] * y)) + r(W[o + 2] * z)) + W[o + 3]);
      s = r(s + trigC(a));
    }
    const raw = r(s / sqrtN);
    const norm = r(r(raw - mid) / halfR);
    let sdf;
    if (topo === 1) sdf = hi ? r(norm - cN) : r(cN - norm);
    else if (topo === 2) sdf = r(hN - Math.abs(r(norm - cN)));
    else sdf = r(Math.abs(r(norm - cN)) - hN);
    return -sdf;
  };
}

const ident = x => x;
// Emulated float32 bake (NOT a GPU): Float32Array over all points (main first), reading the same
// float32 coordinate tables the GPU reads.
export function emuBake(params, tables, g, opts = {}) {
  const k = makeKernel(params, f32, { reduce: params.f32[params.kind === 'tpms' ? 7 : 9] === 1, ...opts });
  return runKernel(k, tables, g, Float32Array, false, opts.zRange, opts.out);
}
// Float64 mirror of the kernel (no rounding, no reduction): must equal the real field exactly.
export function mirrorBake(params, tables, g, zRange) {
  const k = makeKernel(params, ident, { reduce: false });
  return runKernel(k, tables, g, Float64Array, true, zRange);
}
function runKernel(k, T, g, Arr, f64coords, zRange, outArr) {
  const n = g.n, nx1 = n[0] + 1, ny1 = n[1] + 1, nz1 = n[2] + 1, nx2 = n[0] + 2, ny2 = n[1] + 2, nz2 = n[2] + 2;
  const out = outArr || new Arr(g.mainCount + g.offCount);
  const c = f64coords ? (v => v) : f32;
  let o, i, j, kk;
  const [ka, kb] = zRange ? zRange.main : [0, nz1], [la, lb] = zRange ? zRange.off : [0, nz2];
  for (kk = ka; kk < kb; kk++) { const z = c(T.mz[kk]);
    for (j = 0; j < ny1; j++) { const y = c(T.my[j]); o = nx1 * (j + ny1 * kk);
      for (i = 0; i < nx1; i++) out[o++] = k(c(T.mx[i]), y, z); } }
  for (kk = la; kk < lb; kk++) { const z = c(T.oz[kk]);
    for (j = 0; j < ny2; j++) { const y = c(T.oy[j]); o = g.mainCount + nx2 * (j + ny2 * kk);
      for (i = 0; i < nx2; i++) out[o++] = k(c(T.ox[i]), y, z); } }
  return out;
}
