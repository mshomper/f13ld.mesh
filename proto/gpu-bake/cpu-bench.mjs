// proto/gpu-bake/cpu-bench.mjs -- ONE-CORE microseconds per point, from the real worker code
// (worker/m05 .. m32 via buildExportField for an open-cube job: the exact function the exporter
// bakes), using the repo's recipe fixtures (tests/recipes.json, tests/grainrng.js for GRF).
//   node proto/gpu-bake/cpu-bench.mjs
// Each family is timed on points spread over the open cube [-5,5]^3 for ~1.2 s (single thread, this
// machine, this run: expect run-to-run noise of a few percent). Prints "skipped: <reason>" for any
// family Node cannot build. Also prints the open-cube grid point counts per export quality and the
// float32 bytes. Exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { loadWorkerCode } from './lib/loader.mjs';
import { readWorkerSources, REPO_ROOT } from './lib/node-sources.mjs';
import { cubeGridForEdge, QUALITY_EDGE_MM, pointCoords, totalPoints, cubeGrid } from './lib/grid.mjs';
import { cpuField } from './lib/field.mjs';

const worker = loadWorkerCode(readWorkerSources());
const R = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests', 'recipes.json'), 'utf8'));
const clone = o => JSON.parse(JSON.stringify(o));
const wrap = rc => (rc.json ? rc : { family: rc.family, json: rc });
const fix = key => { if (!R[key]) throw new Error('fixture ' + key + ' missing in tests/recipes.json'); return clone(R[key].recipe); };

// Matt's one-core figures, 2026-10-15b recap (2.09 M points): gyroid 1.15 us/pt, PI pair 10.5,
// beam 2.90 s, foam 8.87 s, spinodoid 11.32 s, noise 10.80 s  ->  us/pt = seconds / 2.09.
const REF = { 'TPMS gyroid sheet': 1.15, 'TPMS PI-TPMS field pair': 10.5, 'beam (bcc)': 2.90 / 2.09, foam: 8.87 / 2.09, 'Grain spinodoid': 11.32 / 2.09, 'noise rev 1': 10.80 / 2.09 };

const cases = [
  ['TPMS gyroid sheet', () => wrap(fix('tpms-gyroid-sheet'))],
  ['TPMS PI-TPMS field pair', () => wrap(fix('tpms-pi-fieldpair'))],
  ['Grain spinodoid', () => wrap(fix('grain-spinodoid'))],
  ['Grain GRF', () => wrap({ family: 'grain', field: { type: 'gaussian', frequency: 0.3, rng_seed: 42, dir_mode: 'single', kappa: 6, n_waves: 48, grf_sigma: 0.45, principal_direction: [0, 0, 1] }, geometry: { center: -0.05, half_width: 0.15, half_invert: true, topology: 'half' } })],
  ['Grain hyperuniform', () => wrap(fix('grain-hyperuniform'))],
  ['noise rev 1', () => { const r = fix('noise-simplex-sheet'); r.surface.noise_rev = 1; return wrap(r); }],
  ['noise rev 2', () => { const r = fix('noise-simplex-sheet'); r.surface.noise_rev = 2; return wrap(r); }],
  ['foam (open Lloyd)', () => wrap(fix('foam2-open-lloyd'))],
  ['foam (plateau Poisson)', () => wrap(fix('foam-plateau-poisson'))],
  ['wave (cubic)', () => wrap(fix('wave-cubic'))],
  ['beam (bcc)', () => wrap(fix('beam-bcc'))],
  ['bundle (twist)', () => wrap(fix('bundle-twist'))],
  ['bundle (helicoid)', () => { const r = fix('bundle-twist'); r.surface.structure = 'helicoid'; return wrap(r); }],
];

const g64 = cubeGrid(64), total64 = totalPoints(g64);
const xyz = [0, 0, 0];
function timeField(fn, budgetMs) {
  // points spread over the cube: a fixed stride through the 64^3 grid's point list
  const stride = 7919;     // prime, coprime with the point count
  let idx = 0, n = 0, sink = 0;
  for (let w = 0; w < 300; w++) { pointCoords(g64, idx, xyz); sink += fn([xyz[0], xyz[1], xyz[2]]); idx = (idx + stride) % total64; }   // warm-up
  const t0 = performance.now(); let now = t0;
  while (now - t0 < budgetMs) {
    for (let b = 0; b < 400; b++) { pointCoords(g64, idx, xyz); sink += fn([xyz[0], xyz[1], xyz[2]]); idx = (idx + stride) % total64; n++; }
    now = performance.now();
  }
  return { us: (now - t0) * 1000 / n, n, sink };
}

console.log('=== F13LD.mesh CPU bench: one core, real worker code (buildExportField, open cube), microseconds per point ===');
console.log(`node ${process.version}, ${process.platform} ${process.arch}; each family timed ~1.2 s on points spread over [-5,5]^3 (point cost varies with position for foam / beam / bundle)`);
const tAll = performance.now();
for (const [name, mk] of cases) {
  let recipe;
  try {
    recipe = mk();
    const tb = performance.now();
    const fn = cpuField(worker, recipe, 0.1);
    const buildMs = performance.now() - tb;
    const v = fn([0.3, -0.7, 1.1]);
    if (typeof v !== 'number' || Number.isNaN(v)) throw new Error('field returned ' + v);
    const r = timeField(fn, 1200);
    const ref = REF[name] != null ? `  [Matt's one-core figure ${REF[name].toFixed(2)} us/pt]` : '';
    console.log(`${name.padEnd(26)} ${r.us.toFixed(2).padStart(9)} us/pt   (build ${buildMs.toFixed(0)} ms, ${r.n} points timed)${ref}`);
  } catch (e) {
    console.log(`skipped: ${name}: ${(e && e.message) || e}`);
  }
}
console.log(`(timing total ${((performance.now() - tAll) / 1000).toFixed(1)} s)`);

// ---- grid sizes per export quality, open cube ----
// 61-export.js: edgeWorld = clampEdgeWorld(QUAL_EDGE_MM[q]*10/domainMm, cap): world cube is 10 units for any domain,
// so the edge in world units = edgeMm * 10 / domainMm, never below (1000/cap)^(1/3) (cap 50 M voxels for TPMS, 40 M
// for noise / grain, 30 M beam: 41-quality-estimate.js).
console.log('\n=== open-cube export grids (n cells per axis; main (n+1)^3 + offset (n+2)^3 points; float32 = 4 bytes per point) ===');
console.log('quality edges (40-mesh-worker-host.js QUAL_EDGE_MM): ' + Object.entries(QUALITY_EDGE_MM).map(([k, v]) => k + ' ' + v + ' mm').join(', '));
for (const domainMm of [10, 20, 50]) for (const cap of [50e6]) {
  const minSafe = Math.pow(1000 / cap, 1 / 3);
  console.log(`domain ${domainMm} mm, voxel cap ${cap / 1e6} M (TPMS; noise / grain 40 M, beam 30 M clamp earlier):`);
  for (const q of Object.keys(QUALITY_EDGE_MM)) {
    let e = QUALITY_EDGE_MM[q] * 10 / domainMm, clamped = '';
    if (e < minSafe) { e = minSafe; clamped = ' (clamped)'; }
    const g = cubeGridForEdge(e), pts = totalPoints(g);
    console.log(`  ${q.padEnd(5)} edge ${e.toFixed(4)} world: n=${g.n[0]}  ${pts} points  ${(pts * 4 / 1048576).toFixed(1)} MB float32${clamped}`);
  }
}
for (const n of [64, 128, 256]) { const g = cubeGrid(n), pts = totalPoints(g); console.log(`benchmark grid ${n}^3: ${pts} points  ${(pts * 4 / 1048576).toFixed(1)} MB float32`); }
console.log('WebGPU default limits: maxStorageBufferBindingSize 134217728 (128 MiB = 33.5 M float32), maxBufferSize 268435456 (256 MiB)');
process.exit(0);
