// Field-level checks for A2-A4: load the mesh worker's SDF files into a VM
// context and compare preview-side vs export-side evaluation directly.
// Usage: node fieldtest.js <siteDir> <label>
const fs = require('fs'), vm = require('vm'), path = require('path');
const [ROOT, LABEL] = process.argv.slice(2);
const ctx = { self: { postMessage() {} }, console, Math, Float32Array, Uint32Array, Int32Array, Array, Object, JSON, Error, WeakMap, Map, Set, Number, isFinite, performance: { now: () => 0 } };
vm.createContext(ctx);
for (const f of ['m10-noise.js', 'm11-grain-fields.js', 'm12-reaction-diffusion.js', 'm20-sdf-noise-tpms.js', 'm21-sdf-beam.js', 'm22-sdf-grain.js', 'm23-sdf-bundle.js', 'm24-sdf-wave.js', 'm30-sdf-assembly.js'])
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'worker', f), 'utf8'), ctx, { filename: f });
const R = s => { let x = s; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; };
const corr = (a, b) => { const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n; let c = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; } return c / Math.sqrt(va * vb); };
const huParams = { fieldType: 'hyperuniform', rngSeed: 7, dirMode: 'single', kappa: 4, dirTheta: 0, dirPhi: 0, wX: .33, wY: .33, wZ: .34, huN: 100, huAspect: 3, huWidth: 0.08, huCross: 2, huSharp: 1, huBlend: 1, huEll: 1 };

// ---- A3 hyperuniform: export kernel field vs preview periodic cell, same mm points
{
  const cell = 3, bbox = { mnx: 3.7, mny: -8.2, mnz: 0.4, mxx: 21.9, mxy: 4.1, mxz: 14.6 };
  vm.runInContext('globalThis.__k=buildHUKernels(' + JSON.stringify(huParams) + ');globalThis.__km=buildHUKernelsMM(' + JSON.stringify(huParams) + ',' + JSON.stringify(bbox) + ',' + cell + ');', ctx);
  const rnd = R(1); const a = [], b = [];
  for (let i = 0; i < 3000; i++) {
    const x = bbox.mnx + rnd() * (bbox.mxx - bbox.mnx), y = bbox.mny + rnd() * (bbox.mxy - bbox.mny), z = bbox.mnz + rnd() * (bbox.mxz - bbox.mnz);
    a.push(ctx.evalHUFieldPeriodic(ctx.__k, 0.5 + x / cell, 0.5 + y / cell, 0.5 + z / cell));
    b.push(ctx.evalHUFieldMM(ctx.__km, x, y, z));
  }
  console.log(`${LABEL}  A3 hyperuniform  preview-vs-export field correlation (shape mode, 3 mm cell): ${corr(a, b).toFixed(3)}`);
}
// ---- A3 reaction-diffusion: shape-mode export vs cube/preview mapping
{
  const rec = { field: { type: 'reactiondiffusion', rng_seed: 5, rd_steps: 400 }, geometry: { topology: 'half', center: 0.3 } };
  vm.runInContext(`globalThis.__rdS=buildGrainSDF(${JSON.stringify(rec)},{cellSizeMm:3,bbox:{mnx:3.7,mny:-8.2,mnz:0.4,mxx:21.9,mxy:4.1,mxz:14.6}},null);globalThis.__rdC=buildGrainSDF(${JSON.stringify(rec)},null,null);`, ctx);
  const rnd = R(2); const a = [], b = [];
  for (let i = 0; i < 3000; i++) { const p = [rnd() * 60 - 10, rnd() * 40 - 27, rnd() * 50]; a.push(ctx.__rdC(p)); b.push(ctx.__rdS(p)); }
  console.log(`${LABEL}  A3 reaction-diff preview-vs-export field correlation (shape mode): ${corr(a, b).toFixed(3)}`);
  // ---- A2 seam: walk across a tile face; compare the largest step at the face to typical steps
  let maxFace = 0, typical = 0, n = 0;
  for (let j = 0; j < 200; j++) {
    const y = rnd() * 10 - 5, z = rnd() * 10 - 5, h = 0.02;
    const f = x => ctx.__rdC([x, y, z]);
    maxFace = Math.max(maxFace, Math.abs(f(5 + h / 2) - f(5 - h / 2)));
    for (const xi of [-3.7, -1.1, 1.3, 2.9, 4.1]) typical = Math.max(typical, Math.abs(f(xi + h / 2) - f(xi - h / 2))); n++;
  }
  console.log(`${LABEL}  A2 reaction-diff largest step across a tile face: ${maxFace.toFixed(4)}  (largest step at 5 planes inside the cell: ${typical.toFixed(4)})`);
}
// ---- A4 weld member hyperuniform: field far outside the first cell vs the same point one period back
{
  const rec = { field: { type: 'hyperuniform', rng_seed: 7, dir_mode: 'single', kappa: 4, principal_direction: [0, 0, 1], hu_n: 100, hu_aspect: 3, hu_width: 0.08 }, geometry: { topology: 'half', center: -0.12 } };
  vm.runInContext(`globalThis.__w=buildGrainSDF(${JSON.stringify(rec)},null,null,{periodic:true});`, ctx);
  const rnd = R(3); let same = 0, distinct = new Set();
  for (let i = 0; i < 500; i++) {
    const p = [rnd() * 10 - 5, rnd() * 10 - 5, rnd() * 10 - 5];
    const far = [p[0] + 20, p[1] - 30, p[2] + 10];
    const v0 = ctx.__w(p), v1 = ctx.__w(far);
    if (Math.abs(v0 - v1) < 1e-6) same++; distinct.add(v1.toFixed(4));
  }
  console.log(`${LABEL}  A4 weld hyperuniform  points 2-3 cells away matching their in-cell twin: ${same}/500  (distinct far values: ${distinct.size})`);
}
