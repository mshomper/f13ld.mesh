// v0.9.7 grain PRNG parity: mesh must seed grain fields with F13LD.grain's
// exact generator (an xorshift32 that grain names mulberry32), and its grain
// SDF must then agree voxel for voxel with F13LD.lab's grain rasterizer.
// Usage: node grainrng.js <meshBuild> [F13LD.grain index.html] [F13LD.lab dir]
const fs = require('fs'), vm = require('vm'), path = require('path');
const [ROOT, GRAIN = '/home/claude/mshomper/f13ld.grain/index.html', LAB = '/home/claude/f13ld.lab'] = process.argv.slice(2);
let fail = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fail++; };
const mkCtx = () => vm.createContext({ self: { postMessage() {} }, console, Math, Float32Array, Float64Array, Uint8Array, Uint32Array, Int32Array, Array, Object, JSON, Error, WeakMap, Map, Set, Number, isFinite, performance: { now: () => 0 } });
const load = (ctx, file) => vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });

// ---- 1. Generator: grain's source vs mesh's (text and sequences)
const html = fs.readFileSync(GRAIN, 'utf8');
const grainSrc = html.split('\n').filter(l => l.startsWith('function mulberry32(')).map(l => l.trim());
const grainWorkerSrc = (html.match(/'(function mulberry32\(seed\)\{[^']*)'/) || [])[1];
check(grainSrc.length === 1, `F13LD.grain has one main-thread mulberry32 (found ${grainSrc.length})`);
check(grainWorkerSrc === grainSrc[0], 'F13LD.grain worker-string copy is identical to its main-thread copy');
const grainCtx = mkCtx(); vm.runInContext(grainSrc[0], grainCtx);
const meshCtx = mkCtx();
for (const f of [...(fs.existsSync(path.join(ROOT, 'worker', 'm05-sdf-registry.js')) ? ['m05-sdf-registry.js'] : []), 'm10-noise.js', 'm11-grain-fields.js', 'm12-reaction-diffusion.js', 'm22-sdf-grain.js'])
  load(meshCtx, path.join(ROOT, 'worker', f));
const huCtx = mkCtx(); load(huCtx, path.join(ROOT, 'worker', 'hu-bake-worker.js'));
for (const [name, ctx, file] of [['m11-grain-fields.js', meshCtx, 'm11-grain-fields.js'], ['hu-bake-worker.js', huCtx, 'hu-bake-worker.js']]) {
  const line = fs.readFileSync(path.join(ROOT, 'worker', file), 'utf8').split('\n').find(l => l.startsWith('function mulberry32('));
  check(line && line.trim() === grainSrc[0], `${name}: mulberry32 source is byte-identical to F13LD.grain's`);
  for (const seed of [0, 1, 42, 12345, 2147483647]) {
    const a = grainCtx.mulberry32(seed), b = ctx.mulberry32(seed);
    let same = true; const first = [];
    for (let i = 0; i < 10000; i++) { const x = a(), y = b(); if (i < 1) first.push(y.toFixed(6)); if (x !== y) { same = false; break; } }
    check(same, `${name}: seed ${seed} first 10000 draws identical (first draw ${first[0]})`);
  }
}
// hu-bake-worker.js and m11 must build the same kernels (main-thread shape-mode HU bake vs worker)
{
  const p = { fieldType: 'hyperuniform', rngSeed: 7, dirMode: 'single', kappa: 4, dirTheta: 0, dirPhi: 0, wX: .33, wY: .33, wZ: .34, huN: 100, huAspect: 3, huWidth: 0.08, huCross: 2, huSharp: 1, huBlend: 1, huEll: 1 };
  const a = JSON.stringify(meshCtx.buildHUKernels(p)), b = JSON.stringify(huCtx.buildHUKernels(p));
  check(a === b, 'hu-bake-worker.js and m11-grain-fields.js build identical HU kernels (seed 7)');
}

// Reaction-diffusion (not built by F13LD.lab): mesh's grids vs F13LD.grain's worker builders, 24^3
{
  const g = mkCtx(); vm.runInContext(grainSrc[0], g);
  for (const l of html.split('\n')) if (/^'function build(GrayScott|Brusselator|Schnakenberg)\(/.test(l.trim())) vm.runInContext(vm.runInNewContext(l.trim().replace(/,$/, '')), g);
  for (const [fn, p] of [['buildGrayScott', { rngSeed: 5, rdF: 0.030, rdK: 0.057, rdDu: 0.14, rdSteps: 400 }], ['buildBrusselator', { rngSeed: 5, rdF: 1.0, rdK: 3.0, rdDu: 0.14, rdDv: 0.7, rdSteps: 300 }], ['buildSchnakenberg', { rngSeed: 5, rdF: 0.1, rdK: 0.9, rdDu: 0.05, rdDv: 1.0, rdSteps: 300 }]]) {
    if (typeof g[fn] !== 'function') { check(false, `F13LD.grain worker ${fn} not found`); continue; }
    const a = g[fn](p, 24, null).u, b = meshCtx[fn](p, 24);
    let mx = 0; for (let i = 0; i < a.length; i++) mx = Math.max(mx, Math.abs(a[i] - b[i]));
    check(a.length === b.length && mx === 0, `${fn}: mesh grid matches F13LD.grain's (max |diff| ${mx})`);
  }
}

// ---- 2. Mesh grain SDF vs F13LD.lab grain rasterizer, 32^3 voxel centres over world [-5,5]^3
const labCtx = mkCtx();
for (const f of ['13-kernels.js', '14-rasterizer.js']) load(labCtx, path.join(LAB, f));
vm.runInContext('globalThis.__labVox=function(r){var p=KERNELS.grain.parseRecipe(r);return buildVoxels("grain",p,0,32,"grain-"+((r.geometry&&r.geometry.topology)||"sheet"));}', labCtx);
const N = 32, L = Math.PI, step = 2 * L / N;
const dirs = { principal_direction: [0, 0, 1], ortho_weights: [0.33, 0.33, 0.34] };
const cases = [
  ['spinodoid single, sheet', { field: { type: 'spinodoid', frequency: 0.45, rng_seed: 42, dir_mode: 'single', kappa: 8, n_waves: 48, ...dirs }, geometry: { center: 0, half_width: 0.18, half_invert: false, topology: 'sheet' } }],
  ['spinodoid ortho, half', { field: { type: 'spinodoid', frequency: 0.35, rng_seed: 123, dir_mode: 'ortho', kappa: 6, n_waves: 64, ...dirs }, geometry: { center: 0.1, half_width: 0.15, half_invert: false, topology: 'half' } }],
  ['GRF iso, solid', { field: { type: 'gaussian', frequency: 0.3, rng_seed: 9, dir_mode: 'iso', kappa: 6, n_waves: 64, grf_sigma: 0.45, ...dirs }, geometry: { center: 0, half_width: 0.2, half_invert: false, topology: 'solid' } }],
  ['GRF single, half inv', { field: { type: 'gaussian', frequency: 0.3, rng_seed: 42, dir_mode: 'single', kappa: 6, n_waves: 48, grf_sigma: 0.45, ...dirs }, geometry: { center: -0.05, half_width: 0.15, half_invert: true, topology: 'half' } }],
  ['hyperuniform, cube (lab hu_wrap:false)', { field: { type: 'hyperuniform', rng_seed: 7, dir_mode: 'single', kappa: 4, hu_n: 100, hu_aspect: 3, hu_width: 0.08, hu_wrap: false, ...dirs }, geometry: { center: -0.12, half_width: 0, half_invert: false, topology: 'half' } }],
  ['hyperuniform, tiled (lab wrap / mesh periodic)', { field: { type: 'hyperuniform', rng_seed: 7, dir_mode: 'single', kappa: 4, hu_n: 100, hu_aspect: 3, hu_width: 0.08, ...dirs }, geometry: { center: -0.12, half_width: 0, half_invert: false, topology: 'half' } }, { periodic: true }, true],
];
console.log('\ncase                                          mismatch   solid% mesh / lab');
for (const [name, rec, opts, infoOnly] of cases) {
  const lab = labCtx.__labVox(JSON.parse(JSON.stringify(rec)));
  vm.runInContext(`globalThis.__sdf=buildGrainSDF(${JSON.stringify(rec)},null,null${opts ? ',' + JSON.stringify(opts) : ''});`, meshCtx);
  let diff = 0, sm = 0, sl = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) {
    const w = c => (-L + (c + 0.5) * step) * 5 / Math.PI;
    const m = meshCtx.__sdf([w(i), w(j), w(k)]) < 0 ? 1 : 0, l = lab[i * N * N + j * N + k];
    sm += m; sl += l; if (m !== l) diff++;
  }
  const pct = 100 * diff / (N * N * N);
  const row = `${name.padEnd(46)}${pct.toFixed(3).padStart(7)}%   ${(100 * sm / N ** 3).toFixed(1)} / ${(100 * sl / N ** 3).toFixed(1)}`;
  if (infoOnly) console.log('info ' + row); else check(pct < 0.05, row);
}
console.log(fail ? `\n${fail} check(s) failed` : '\nall checks passed');
process.exit(fail ? 1 : 0);
