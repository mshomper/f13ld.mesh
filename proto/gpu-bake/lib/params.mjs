// proto/gpu-bake/lib/params.mjs
// Turns a recipe into the flat float32 parameter buffer the kernels read. Everything random or
// global is produced HERE, on the CPU, with the real worker code:
//   - spinodoid wave vectors / phases: buildSpinodoidWaves (m11, the real xorshift generator)
//   - spinodoid normalisation (fieldMid, fieldHalfR): recipe._previewFieldMin/Max when the
//     recipe carries them (the app sets them from the preview bake and the export reads them,
//     m30 buildSDF -> m22), otherwise the 16^3 pre-scan over world [-5,5] that m22 does itself
//     (replicated here with the real evalField). Float32 cannot supply these whole-grid numbers.
// No random number is drawn and no min/max is taken on the GPU.

export const TWO_PI = 2 * Math.PI;

// The two recipes the page and selftest use (same shapes as tests/recipes.json).
export const RECIPES = {
  tpms: { // tests/recipes.json "tpms-gyroid-sheet", mode 'sheet' (|phi|-wt, no gradient normalisation)
    family: 'tpms',
    json: { family: 'tpms',
      surface: { type: 'terms', preset: 'gyroid', terms: [
        { on: true, coef: 1, factors: [{ trig: 'sin(x)', fx: 1, fy: 1, fz: 1 }, { trig: 'cos(y)', fx: 1, fy: 1, fz: 1 }] },
        { on: true, coef: 1, factors: [{ trig: 'sin(y)', fx: 1, fy: 1, fz: 1 }, { trig: 'cos(z)', fx: 1, fy: 1, fz: 1 }] },
        { on: true, coef: 1, factors: [{ trig: 'sin(z)', fx: 1, fy: 1, fz: 1 }, { trig: 'cos(x)', fx: 1, fy: 1, fz: 1 }] }] },
      geometry: { mode: 'sheet', offset: 0, wallThickness: 0.3, cell_scale: 1 } },
  },
  tpms4: { // same gyroid at 4 cells per side, so arguments reach 4*pi (exercises the range reduction)
    family: 'tpms',
    json: { family: 'tpms',
      surface: { type: 'terms', preset: 'gyroid', terms: [
        { on: true, coef: 1, factors: [{ trig: 'sin(x)', fx: 1, fy: 1, fz: 1 }, { trig: 'cos(y)', fx: 1, fy: 1, fz: 1 }] },
        { on: true, coef: 1, factors: [{ trig: 'sin(y)', fx: 1, fy: 1, fz: 1 }, { trig: 'cos(z)', fx: 1, fy: 1, fz: 1 }] },
        { on: true, coef: 1, factors: [{ trig: 'sin(z)', fx: 1, fy: 1, fz: 1 }, { trig: 'cos(x)', fx: 1, fy: 1, fz: 1 }] }] },
      geometry: { mode: 'sheet', offset: 0.1, wall_thickness: 0.4, cell_scale: 4 } },
  },
  grain: { // tests/recipes.json "grain-spinodoid"
    family: 'grain',
    json: { family: 'grain',
      field: { type: 'spinodoid', frequency: 0.45, rng_seed: 42, dir_mode: 'single', kappa: 8, principal_direction: [0, 0, 1], n_waves: 48 },
      geometry: { mode: 'grain-sheet', center: 0, half_width: 0.18, half_invert: false, topology: 'sheet' } },
  },
};
export const RECIPE_LABEL = { tpms: 'TPMS gyroid sheet', tpms4: 'TPMS gyroid sheet x4 cells', grain: 'Grain spinodoid' };

const clone = o => JSON.parse(JSON.stringify(o));
export function freshRecipe(key) { return clone(RECIPES[key]); }

// TPMS: terms-list sheet / solid. Layout (float32 array):
//  [0..2] fs x,y,z   [3] offset  [4] wall thickness  [5] mode 0 sheet 1 solid  [6] nterms  [7] reduce
//  terms from 8, stride 16: coef, hasShift, shx, shy, shz, nf, (pad), factors x3 at +6: kind(0 sin,1 cos,2 one), axis(0..2, 3 none), freq
export function tpmsParams(recipe) {
  const json = recipe.json, s = json.surface, g = json.geometry || {};
  if (s.type !== 'terms') throw new Error('GPU kernel handles term-list TPMS only (not raw presets)');
  const mode = g.mode || 'shell';
  if (mode === 'pi-tpms') throw new Error('PI-TPMS pair not built in this prototype');
  const shellNorm = (g.shell_normalize !== undefined) ? !!g.shell_normalize : (mode === 'shell');
  if (shellNorm) throw new Error('gradient-normalised shell not built in this prototype (use mode sheet or shell_normalize:false)');
  if (g.normal_weights || (g.gradient && g.gradient.enabled)) throw new Error('normal_weights / gradient not built');
  const csX = g.cell_scale_x ?? g.cell_scale ?? 1, csY = g.cell_scale_y ?? g.cell_scale ?? 1, csZ = g.cell_scale_z ?? g.cell_scale ?? 1;
  const fs = [(Math.PI * csX) / 5.0, (Math.PI * csY) / 5.0, (Math.PI * csZ) / 5.0];
  const terms = [];
  let maxArg = 0;
  for (const t of s.terms || []) {
    if (!t.on) continue;
    const tps = t.phase_shift;
    const T = { coef: t.coef ?? 1, hasShift: tps ? 1 : 0, sh: tps ? [tps.x || 0, tps.y || 0, tps.z || 0] : [0, 0, 0], f: [] };
    for (const f of t.factors) {
      const tr = f.trig;
      if (typeof tr !== 'string') throw new Error('bad trig');
      let axis = tr.includes('(x)') ? 0 : tr.includes('(y)') ? 1 : tr.includes('(z)') ? 2 : 3;
      const freq = axis === 0 ? (f.fx || 1) : axis === 1 ? (f.fy || 1) : axis === 2 ? (f.fz || 1) : 1;
      const kind = tr.startsWith('sin') ? 0 : tr.startsWith('cos') ? 1 : 2;
      if (axis < 3 && kind < 2) maxArg = Math.max(maxArg, (Math.PI * [csX, csY, csZ][axis] + Math.abs(T.sh[axis])) * Math.abs(freq));
      T.f.push({ kind, axis, freq });
    }
    if (T.f.length > 3) throw new Error('more than 3 factors per term');
    terms.push(T);
  }
  const p = new Float64Array(8 + 16 * terms.length);   // float64 master; f32 copy is what the GPU gets
  p[0] = fs[0]; p[1] = fs[1]; p[2] = fs[2];
  p[3] = g.offset || 0; p[4] = g.wall_thickness || 0.3; p[5] = mode === 'solid' ? 1 : 0; p[6] = terms.length;
  p[7] = maxArg > Math.PI * 1.0000001 ? 1 : 0;
  terms.forEach((T, i) => {
    const b = 8 + 16 * i;
    p[b] = T.coef; p[b + 1] = T.hasShift; p[b + 2] = T.sh[0]; p[b + 3] = T.sh[1]; p[b + 4] = T.sh[2]; p[b + 5] = T.f.length;
    T.f.forEach((f, j) => { p[b + 6 + 3 * j] = f.kind; p[b + 7 + 3 * j] = f.axis; p[b + 8 + 3 * j] = f.freq; });
  });
  return { kind: 'tpms', f64: p, f32: Float32Array.from(p), meta: { terms, fs, maxArg, mode: p[5], off: g.offset || 0, wt: g.wall_thickness || 0.3 } };
}

// Grain spinodoid. Layout (float32 array):
//  [0] PI5  [1] mid  [2] halfR  [3] cN  [4] hN  [5] topo 0 sheet 1 half 2 solid  [6] halfInvert  [7] nWaves  [8] sqrt(nWaves)  [9] reduce
//  waves from 16, stride 4: kx, ky, kz, phase
export function grainParams(worker, recipe) {
  const json = recipe.json, f = json.field, g = json.geometry || {};
  if (f.type !== 'spinodoid') throw new Error('GPU kernel handles spinodoid only (GRF / hyperuniform not built)');
  const params = worker.grainParamsFromField(f);
  const waves = worker.buildSpinodoidWaves(params);          // the real generator, CPU
  const PI5 = Math.PI / 5;
  let mid, halfR, source;
  if (recipe._previewFieldMin !== undefined && recipe._previewFieldMax !== undefined) {
    mid = (recipe._previewFieldMin + recipe._previewFieldMax) * 0.5;
    halfR = Math.max((recipe._previewFieldMax - recipe._previewFieldMin) * 0.5, 1e-6);
    source = 'recipe._previewFieldMin/Max (preview bake range, CPU)';
  } else {
    const PP = 16; let mnF = Infinity, mxF = -Infinity;
    for (let zi = 0; zi < PP; zi++) for (let yi = 0; yi < PP; yi++) for (let xi = 0; xi < PP; xi++) {
      const px = (xi / (PP - 1)) * 10 - 5, py = (yi / (PP - 1)) * 10 - 5, pz = (zi / (PP - 1)) * 10 - 5;
      const v = worker.evalField(waves, px * PI5, py * PI5, pz * PI5, null);
      if (v < mnF) mnF = v; if (v > mxF) mxF = v;
    }
    mid = (mnF + mxF) * 0.5; halfR = Math.max((mxF - mnF) * 0.5, 1e-6);
    source = '16^3 pre-scan over world [-5,5] (CPU, as m22 does)';
  }
  const center = g.center ?? 0, halfW = g.half_width ?? 0.15, topo = g.topology || 'sheet';
  const cN = (center - mid) / halfR, hN = halfW / halfR;
  let maxArg = 0;
  for (const w of waves) maxArg = Math.max(maxArg, (Math.abs(w.kx) + Math.abs(w.ky) + Math.abs(w.kz)) * Math.PI + Math.abs(w.phase));
  const N = waves.length, p = new Float64Array(16 + 4 * N);
  p[0] = PI5; p[1] = mid; p[2] = halfR; p[3] = cN; p[4] = hN; p[5] = topo === 'half' ? 1 : topo === 'solid' ? 2 : 0;
  p[6] = g.half_invert ? 1 : 0; p[7] = N; p[8] = Math.sqrt(N); p[9] = maxArg > Math.PI * 1.0000001 ? 1 : 0;
  waves.forEach((w, i) => { p[16 + 4 * i] = w.kx; p[17 + 4 * i] = w.ky; p[18 + 4 * i] = w.kz; p[19 + 4 * i] = w.phase; });
  return { kind: 'grain', f64: p, f32: Float32Array.from(p), meta: { waves, mid, halfR, cN, hN, N, maxArg, source } };
}

export function kernelParams(worker, key, recipe) {
  return RECIPES[key].family === 'tpms' ? tpmsParams(recipe) : grainParams(worker, recipe);
}
