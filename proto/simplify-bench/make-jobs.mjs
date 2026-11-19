// proto/simplify-bench/make-jobs.mjs - "Node-built jobs": build raw slab meshes for the tests/recipes.json
// open-cube cases through the real code (buildSDF from the family scripts, slabMeshLayers = m34) in Node,
// one thread, and save them to data/<case>.<quality>.slb (gzip, see lib/slabio.mjs).
//
//   node proto/simplify-bench/make-jobs.mjs [--only name,name] [--quals draft,med] [--slabs 8]
//
// This is the substitute for DUMPJOB jobs (harness needs a Chromium that is not installed here). Edge and
// simplify tolerance follow 61-export.js for the open cube: edgeWorld = QUAL_EDGE_MM * 10 / domainMm,
// tol = min(0.15 * edge, 0.05 * thinnest feature in world units); the slab split follows m36 slabJobs for
// --slabs workers (default 8, i.e. what an 8-core machine would use).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadWorker, SLAB_FILES, FIELD_FILES } from './lib/env.mjs';
import { writeSlabs } from './lib/slabio.mjs';

export const QUAL_EDGE_MM = { draft: 0.40, low: 0.20, med: 0.12, high: 0.09, ultra: 0.075 };
export const DOMAIN_MM = 10;
export const FAMILY_OF = {   // case -> family label for the report
  'tpms-gyroid-sheet': 'TPMS gyroid sheet', 'noise-simplex-sheet': 'noise simplex sheet', 'grain-hyperuniform': 'hyperuniform',
  'grain-spinodoid': 'spinodoid', 'foam2-open-lloyd': 'foam (open, Lloyd)', 'foam2-closed-kelvin-1cube': 'foam (closed Kelvin)',
};
export const CASES = Object.keys(FAMILY_OF);

// the same rules as getThinnestFeatureMm (60-export-ui.js) and fam-foam.js / fam-grain.js / fam-noise.js
export function thinnestFeatureMm(r, cellMm) {
  const j = r.json, g = j.geometry || {}, s = j.surface || {}, w2mm = cellMm / 10;
  if (r.family === 'foam') {
    if (g.mode === 'wet' && typeof g.border === 'number' && g.border > 0) return 0.3 * g.border * w2mm;
    return (typeof g.thickness === 'number' && g.thickness > 0) ? g.thickness * w2mm : null;
  }
  if (r.family === 'grain' || r.family === 'noise') return null;
  if (g.wall_thickness > 0) return g.wall_thickness * w2mm;
  if (g.pipe_radius > 0) return g.pipe_radius * w2mm;
  if (g.half_width > 0) return g.half_width * w2mm;
  if (s.half_width > 0) return s.half_width * w2mm;
  return null;
}

export function jobParams(recipe, qual) {
  const edgeWorld = QUAL_EDGE_MM[qual] * 10 / DOMAIN_MM;
  const featMm = thinnestFeatureMm(recipe, DOMAIN_MM);
  const featWorld = featMm != null && featMm > 0 ? featMm * 10 / DOMAIN_MM : null;
  const tol = Math.min(edgeWorld * 0.15, featWorld != null ? featWorld * 0.05 : Infinity);
  return { edgeWorld, tol, featWorld };
}

export function slabSplit(ctx, g, nW) {   // m36 slabJobs (SLAB_JOB_LAYERS 24, 3 jobs per worker)
  const Lmax = g.layers - 2, want = Math.max(1, Math.min(nW * 3, Math.floor(Lmax / 24))), jobs = [];
  for (let s = 0; s < want; s++) { const a = Math.round(Lmax * s / want), b = Math.round(Lmax * (s + 1) / want); if (b > a) jobs.push({ La: a, Lb: b }); }
  return jobs;
}

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
export const DATA = path.join(ROOT, 'proto', 'simplify-bench', 'data');

export async function buildCase(name, qual, nW = 8, opts = {}) {
  const R = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'recipes.json'), 'utf8'))[name];
  const recipe = { family: R.recipe.family, json: R.recipe };
  const ctx = await loadWorker({ files: [...new Set([...FIELD_FILES, ...SLAB_FILES])] });
  const { edgeWorld, tol, featWorld } = jobParams(recipe, qual);
  const tS = performance.now();
  const sdf = ctx.buildSDF(recipe, null), setupMs = performance.now() - tS;
  const field = p => -sdf(p);
  const g = ctx.weldGridDims([-5, -5, -5], [5, 5, 5], edgeWorld);
  const jobs = slabSplit(ctx, g, nW), slabs = [];
  for (const j of jobs) {
    const t = performance.now();
    const r = ctx.slabMeshLayers(field, g, j.La, j.Lb);
    const total = performance.now() - t;
    slabs.push({ La: j.La, Lb: j.Lb, pos: r.pos, idx: r.idx, seamV: r.seamV, seamK: r.seamK, nbrA: r.nbrA, nbrB: r.nbrB,
      evals: r.evals, fieldMs: r.fieldMs || 0, marchMs: total - (r.fieldMs || 0) });
  }
  const meta = { case: name, family: FAMILY_OF[name] || name, qual, edgeWorld, edgeMm: edgeWorld * DOMAIN_MM / 10, domainMm: DOMAIN_MM, tol, featWorld, grid: g.n, layers: g.layers,
    gridMin: g.min, gridMax: g.max, gridS: g.s, slabs: slabs.length, workersAssumed: nW, setupMs: Math.round(setupMs), built: 'Node-built job (one thread, m34 slabMeshLayers, no DUMPJOB)',
    rawTris: slabs.reduce((a, s) => a + s.idx.length / 3, 0) };
  return { meta, slabs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const only = arg('only', '') ? arg('only').split(',') : CASES, quals = arg('quals', 'draft,med').split(','), nW = +arg('slabs', 8);
  fs.mkdirSync(DATA, { recursive: true });
  for (const name of only) for (const q of quals) {
    const t = performance.now();
    const { meta, slabs } = await buildCase(name, q, nW);
    const file = path.join(DATA, name + '.' + q + '.slb');
    writeSlabs(file, meta, slabs);
    console.log(name.padEnd(28), q.padEnd(6), 'grid', meta.grid.join('x'), 'slabs', meta.slabs, 'raw tris', meta.rawTris, 'tol', meta.tol.toFixed(4), 'build', Math.round(performance.now() - t) + ' ms', 'file', (fs.statSync(file).size / 1e6).toFixed(2) + ' MB');
  }
}
