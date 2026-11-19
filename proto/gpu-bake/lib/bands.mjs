// proto/gpu-bake/lib/bands.mjs
// BAND = the half-width, in field units, inside which a float32 value is not trusted for its sign.
// It is computed ONLY from the recipe's kernel parameters (term count, coefficients, wave
// vectors, normalisation range) and the per-operation error model below -- never from the CPU
// bake of the grid being judged. It is fixed in code (the constants below) before any compare.
//
// Error model (all in float32, u = 2^-24 the unit round-off):
//   * every arithmetic operation is off by <= u of its result; counted along the real data flow
//     and added in quadrature (independent rounding) -- the coordinate table rounding, the
//     coordinate * scale product, the frequency / shift products, the sums.
//   * the argument error is 3*u*A for the plain kernel (A = largest argument magnitude) and
//     5*u*A when the kernel range-reduces the argument into [-pi, pi] first (reduce flag).
//   * every sin / cos evaluation adds an absolute error ESC. Three values:
//       emu   2^-24  Math.fround(Math.sin(x)): the float32 emulation (NOT a GPU).
//       gpu   2^-16  ASSUMPTION for a real GPU's sin / cos (hardware approximations are usually
//                    within ~2^-20 in [-pi, pi]; 2^-16 leaves headroom). NOT proven: the page
//                    reports the observed GPU error and escape count so it is MEASURED.
//       spec  2^-11  WGSL's published bound for sin / cos, valid only for arguments in [-pi, pi]
//                    (hence the kernels' range reduction). This is the only PROVEN band, and only
//                    as far as a driver honours the spec; it is wide.
//   * K = 6 coverage factor on the quadrature sum.
// A band is a statistical bound for the emulation (quadrature x K), a worst-case-per-op bound for
// the spec; neither makes files identical across GPUs by itself -- the float64 re-evaluation does.

const u = 2 ** -24;
export const ESC = { emu: 2 ** -24, gpu: 2 ** -16, spec: 2 ** -11 };
export const K_COVER = 2;

// Rigorous Lipschitz bound L of the field (field units per world unit), from the kernel parameters.
//  TPMS: |grad phi| <= sum over terms |coef| * sum over factors |freq| * fs_max (every other factor <= 1);
//        f = -(|phi - off| - wt) or -(phi - off) keeps that constant.
//  grain: |grad raw| <= PI5 * sum |k_i| / sqrt(N);  f has constant 1/halfR on top.
export function lipschitzBound(params) {
  if (params.kind === 'tpms') {
    const { terms, fs } = params.meta, fmax = Math.max(...fs);
    let L = 0;
    for (const T of terms) { let s = 0; for (const F of T.f) if (F.kind < 2 && F.axis < 3) s += Math.abs(F.freq); L += Math.abs(T.coef) * s; }
    return L * fmax;
  }
  const { waves, halfR, N } = params.meta;
  let s = 0; for (const w of waves) s += Math.hypot(w.kx, w.ky, w.kz);
  return (Math.PI / 5) * s / Math.sqrt(N) / halfR;
}
// What reaches sin / cos (WGSL promises 2^-11 absolute only inside [-pi, pi]): the largest |argument|
// before the kernel's range reduction (a bound over the whole cube), and whether the kernel reduces it.
export function trigArgInfo(params) {
  const reduce = params.f32[params.kind === 'tpms' ? 7 : 9] === 1;
  return { maxArg: params.meta.maxArg, reduced: reduce, maxArgAtTrig: reduce ? Math.PI : params.meta.maxArg };
}

export function bandFor(params, esc) {
  return K_COVER * sigmaField(params, esc);
}

function sigmaField(params, esc) {
  const reduce = params.f32[params.kind === 'tpms' ? 7 : 9] === 1;
  const cArg = reduce ? 5 : 3;
  if (params.kind === 'tpms') {
    const { terms, fs, mode, off, wt } = params.meta;
    const cs = fs.map(v => v * 5 / Math.PI);
    let s2 = 0, S = 0;
    for (const T of terms) {
      S += Math.abs(T.coef);
      let e2 = 0;
      for (const F of T.f) {
        if (F.kind === 2) continue;
        let A = 0;
        if (F.axis < 3) A = (Math.PI * cs[F.axis] + Math.abs(T.sh[F.axis])) * Math.abs(F.freq);
        e2 += esc * esc + (cArg * u * A) ** 2 + u * u;
      }
      s2 += T.coef * T.coef * e2 + (3 * u * Math.abs(T.coef)) ** 2;
    }
    s2 += (Math.sqrt(terms.length) * u * S) ** 2;
    const final = (mode === 1 ? 2 : 3) * u * (S + Math.abs(off) + wt);
    return Math.sqrt(s2 + final * final);
  }
  const { waves, halfR, cN, hN, N } = params.meta;
  let s2 = 0;
  for (const w of waves) {
    const M = (Math.abs(w.kx) + Math.abs(w.ky) + Math.abs(w.kz)) * Math.PI + Math.abs(w.phase);
    s2 += esc * esc + (cArg * u * M) ** 2 + u * u;
  }
  s2 += (N * u) ** 2;
  const sRaw = Math.sqrt(s2) / Math.sqrt(N);
  const fin = 4 * u * (1.5 + Math.abs(cN) + hN);
  return Math.sqrt((sRaw / halfR) ** 2 + fin * fin);
}
