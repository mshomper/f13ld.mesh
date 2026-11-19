// proto/simplify-bench/bench.mjs - compare slab simplify methods on saved raw slab meshes.
//
//   node proto/simplify-bench/bench.mjs [--quick] [--check] [--quals draft,med] [--only a,b] [--methods today,A,B1a,B1b] [--tune] [--out file.json]
//
// Methods (each = today's m35 / m36 code from this branch plus candidate scripts evaluated after it):
//   today  the real m35 simplifySlab path, m36 _slabFinish          A    + Regularize flag (meshoptimizer 1.1.1)
//   B1a    same output, faster checks (cand/b1a.js)                 B1b  B1a + windowed tear repair (cand/b1b.js), output changes
// For every mesh x method: time (single thread; includes the closed / seam checks and flips the stages run),
// triangles, open and non-manifold edges, self-intersecting triangle pairs, two-sided sampled deviation from the raw
// mesh, needles % and min-angle P5, and whether every slab's open (seam) edges are exactly the raw slab's.
// --quick: Draft meshes only; self-intersections tested for a seeded sample of triangles, deviation from 1500 sample
// points per side (the output says so). Without --quick: all triangles, 5000 points per side.
// --check: fails (exit 1) unless the checker self-test passes, the 'today' run hashes the same as m35 / m36 run
// directly, the branch hashes the same as main on every mesh (byte-identity proof of the timing counters), B1a hashes
// the same as today, and every metric was computed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadWorker, SLAB_FILES } from './lib/env.mjs';
import { readSlabs } from './lib/slabio.mjs';
import { BVH, hashArrays } from './lib/geom.mjs';
import { runPipeline, measureRun, rawJoined, hashRun, benchMesh } from './lib/pipeline.mjs';
import { selfTest, icosphere } from './lib/selftest.mjs';
import { DATA, CASES } from './make-jobs.mjs';

export const METHODS = {
  today: { label: 'today', patches: [] },
  A: { label: 'A Regularize', patches: ['cand/a.js'] },
  B1a: { label: 'B1a fast checks', patches: ['cand/fast.js'] },
  B1lazy: { label: 'B1a-lazy', patches: ['cand/fast.js', 'cand/lazy.js'] },
  B1b: { label: 'B1b window repair', patches: ['cand/fast.js', 'cand/window.js'] },
  rings: { label: 'today, rings 3,3,4..', patches: ['cand/rings.js'] },
};
const DEFAULT_METHODS = 'today,A,B1a,B1lazy,B1b';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const has = k => process.argv.includes('--' + k);
let quick = false, check = false, tune = false;   // set from the arguments when main() starts
const f = (x, d = 2) => (typeof x === 'number' && isFinite(x)) ? x.toFixed(d) : String(x);

// metrics that must be finite numbers / booleans for "all metrics were computed"
const NUMERIC = ['totalMs', 'slabMs', 'finalMs', 'tris', 'open', 'nonManifold', 'selfX', 'devMaxMm', 'devMeanMm', 'devMaxCells', 'devMeanCells', 'needlePct', 'minAngleP5'];
const allComputed = m => NUMERIC.every(k => typeof m[k] === 'number' && isFinite(m[k])) && typeof m.seamSlabsIdentical === 'boolean';

// m35 / m36 run directly, written out independently of lib/pipeline.mjs (for the baseline check)
async function directRun(ctx, meta, slabs) {
  const g = ctx.weldGridDims(meta.gridMin, meta.gridMax, meta.edgeWorld), outs = [];
  for (const s of slabs) { const o = ctx.simplifySlab({ pos: s.pos, idx: s.idx, seamV: s.seamV, seamK: s.seamK, nbrA: s.nbrA.length ? s.nbrA : null, nbrB: s.nbrB.length ? s.nbrB : null, evals: s.evals, fieldMs: s.fieldMs }, meta.tol); o._La = s.La; outs.push(o); }
  const fin = await ctx._slabFinish(g, outs, meta.tol, null, performance.now(), null, meta.workersAssumed || 8, false);
  return { outs, final: { pos: fin.pos, idx: fin.idx } };
}

async function benchCase(file, methods, opts) {
  const { meta, slabs } = readSlabs(file);
  const r = await benchMesh(patches => loadWorker({ files: SLAB_FILES, patches }), meta, slabs, methods, METHODS, opts);
  return { meta, raw: r.raw, rows: r.rows, slabs, rawJ: r.rawJ };
}

function printRows(meta, rawTris, rows) {
  console.log(`\n${meta.family} @ ${meta.qual} (edge ${meta.edgeMm} mm, ${meta.slabs} slabs, raw ${rawTris} tris, tol ${f(meta.tol, 4)})`);
  console.log('  method              time ms (slabs+final)   tris    open nm  selfX   dev max / mean mm (cells)       needles%  minAng P5  seam ok  retries');
  for (const r of rows) console.log('  ' + r.label.padEnd(19), `${f(r.totalMs, 0).padStart(6)} (${f(r.slabMs, 0)}+${f(r.finalMs, 0)})`.padEnd(22), String(r.tris).padStart(6), String(r.open).padStart(5), String(r.nonManifold).padStart(2), String(r.selfX).padStart(6),
    `  ${f(r.devMaxMm, 4)} / ${f(r.devMeanMm, 4)} (${f(r.devMaxCells, 3)} / ${f(r.devMeanCells, 3)})`.padEnd(34), f(r.needlePct, 2).padStart(7), f(r.minAngleP5, 1).padStart(10), String(r.seamSlabsIdentical).padStart(8), String(r.retries).padStart(6), ` (best of ${r.reps}, spread ${f(r.spreadMs, 0)} ms)` + (r.patch ? ` patch ${r.patch.ok}/${r.patch.tried} accepted` : ''));
}

// tune a method's tolerance scale until its triangle count is within 5 % of today's (or max deviation within 10 %)
async function tuneMethod(name, file, todayRow, opts) {
  const { meta, slabs } = readSlabs(file), ctx = await loadWorker({ files: SLAB_FILES, patches: METHODS[name].patches });
  const raw = rawJoined(ctx, slabs), rawBvh = new BVH(raw.pos, raw.idx);
  let lo = 0.3, hi = 3, best = null;
  for (let it = 0; it < 7; it++) {
    const s = it === 0 ? 1 : Math.sqrt(lo * hi), run = await runPipeline(ctx, meta, slabs, s), m = measureRun(ctx, meta, slabs, run, raw, rawBvh, opts);
    const triErr = m.tris / todayRow.tris - 1, devErr = m.devMaxMm / todayRow.devMaxMm - 1;
    best = { scale: s, ...m, triErr, devErr, matchedBy: Math.abs(triErr) <= 0.05 ? 'triangles' : (Math.abs(devErr) <= 0.1 ? 'max deviation' : null) };
    if (best.matchedBy) break;
    if (triErr > 0) lo = s; else hi = s;           // more triangles than today -> raise tol
  }
  return best;
}

// --check extras: paths the real meshes may not reach. (1) an OPEN input (sphere with a triangle removed) -> unsafe path;
// (2) a stress run with a much larger tolerance until some slab or band gives up (gaveUp) or tears and retries.
// Main, branch, B1a and B1a-lazy must give identical results (hash) on both.
async function extraChecks(fails) {
  console.log('\nextra checks (unsafe / gave-up paths):');
  const sets = { main: await loadWorker({ files: SLAB_FILES, source: 'main' }), branch: await loadWorker({ files: SLAB_FILES }),
    B1a: await loadWorker({ files: SLAB_FILES, patches: METHODS.B1a.patches }), B1lazy: await loadWorker({ files: SLAB_FILES, patches: METHODS.B1lazy.patches }) };
  const sp = icosphere(3, 1), openIdx = sp.idx.slice(3), res = {};
  for (const [n, c] of Object.entries(sets)) { const r = c.safeSimplify(sp.pos, openIdx, 0.05, null, null, null); res[n] = hashArrays(r.idx) + ':' + !!r.unsafe + ':' + r.retries; }
  const okOpen = new Set(Object.values(res)).size === 1 && res.main.includes(':true:');
  console.log(`  open input (sphere minus one triangle): unsafe path, same result in main / branch / B1a / B1a-lazy: ${okOpen ? 'PASS' : 'FAIL'} (${res.main})`);
  if (!okOpen) fails.push('open-input path differs');
  const files = ['grain-spinodoid', 'foam2-open-lloyd'].map(n => path.join(DATA, n + '.draft.slb')).filter(fs.existsSync);
  let sawGaveUp = false, sawRetry = false;
  for (const file of files) for (const scale of [25, 100]) {
    const { meta, slabs } = readSlabs(file), h = {}, info = {};
    for (const [n, c] of Object.entries(sets)) { const run = await runPipeline(c, meta, slabs, scale); h[n] = hashRun(run); if (n === 'branch') info.o = run.outs; }
    const gave = info.o.filter(o => o.gaveUp).length, unsafe = info.o.filter(o => o.unsafe).length, retries = info.o.reduce((a, o) => a + (o.retries || 0), 0);
    if (gave) sawGaveUp = true; if (retries) sawRetry = true;
    const ok = new Set(Object.values(h)).size === 1;
    console.log(`  ${meta.case} tol x${scale}: slab retries ${retries}, gave up ${gave}, unsafe ${unsafe}; main / branch / B1a / B1a-lazy identical: ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) fails.push(`stress ${meta.case} x${scale}: outputs differ`);
  }
  console.log(`  coverage: retries seen ${sawRetry}, gave-up seen ${sawGaveUp}`);
}

export async function main() {
  quick = has('quick'); check = has('check'); tune = has('tune');
  const quals = (arg('quals', quick ? 'draft' : 'draft,med')).split(','), only = arg('only', '') ? arg('only').split(',') : CASES, methods = arg('methods', DEFAULT_METHODS).split(',');
  const sampled = quick || has('sample');   // --sample: the quick sampling on any quality (Med meshes have 600k+ triangles)
  const reps = +arg('reps', quick ? 1 : (sampled ? 2 : 3));
  const opts = sampled ? { siSample: 6000, devSamples: 1500, reps } : { siSample: 0, devSamples: 5000, reps };
  const t0 = performance.now(), fails = [], report = { quick, opts, cases: [] };
  console.log(`simplify bench (${sampled ? 'quick: self-intersections on a seeded sample of 6000 triangles per mesh, deviation from 1500 points per side' : 'full: all triangles, 5000 deviation points per side'}); one thread; Node-built jobs`);

  if (check) {
    const st = selfTest();
    console.log('\nchecker self-test:');
    for (const t of st) { console.log('  ' + (t.ok ? 'PASS' : 'FAIL'), t.name, '-', t.detail); if (!t.ok) fails.push('self-test: ' + t.name); }
    await extraChecks(fails);
  }
  // one-line experiments: --tolx 4,10 prints today's output size and time at a scaled tolerance (no other metrics)
  if (arg('tolx', '')) for (const q of quals) for (const name of only) {
    const file = path.join(DATA, name + '.' + q + '.slb'); if (!fs.existsSync(file)) continue;
    const { meta, slabs } = readSlabs(file), ctx = await loadWorker({ files: SLAB_FILES });
    report.tolx = report.tolx || [];
    for (const s of [1, ...arg('tolx').split(',').map(Number)]) { const run = await runPipeline(ctx, meta, slabs, s); report.tolx.push({ case: name, qual: q, tolScale: s, tris: run.final.idx.length / 3, totalMs: run.totalMs }); console.log(`tol x${s}: ${meta.family} @ ${q}: ${run.final.idx.length / 3} tris (x1: see table), ${f(run.totalMs, 0)} ms`); }
  }
  for (const q of quals) for (const name of only) {
    const file = path.join(DATA, name + '.' + q + '.slb');
    if (!fs.existsSync(file)) { console.log('missing', path.relative(ROOT, file), '(run make-jobs.mjs)'); if (check) fails.push('missing mesh ' + file); continue; }
    const r = await benchCase(file, methods, opts);
    printRows(r.meta, r.raw.tris, r.rows);
    const entry = { case: name, meta: r.meta, rawTris: r.raw.tris, rows: r.rows, tuned: [] };
    const today = r.rows.find(x => x.method === 'today');
    if (tune && today) for (const m of methods.filter(x => x !== 'today' && x !== 'B1a')) {
      const t = await tuneMethod(m, file, today, opts); entry.tuned.push({ method: m, ...t });
      console.log(`  tuned ${METHODS[m].label}: tol x${f(t.scale, 3)} -> ${t.tris} tris (${f(t.triErr * 100, 1)} % vs today), max dev ${f(t.devMaxMm, 4)} mm (${f(t.devErr * 100, 1)} %), time ${f(t.totalMs, 0)} ms, closed ${t.open === 0 && t.nonManifold === 0}, selfX ${t.selfX}, matched by ${t.matchedBy || 'NOT MATCHED'}`);
    }
    report.cases.push(entry);
    if (check) {
      const ctxD = await loadWorker({ files: SLAB_FILES }), ctxM = await loadWorker({ files: SLAB_FILES, source: 'main' });
      const { meta, slabs } = readSlabs(file);
      const hDirect = hashRun(await directRun(ctxD, meta, slabs)), hMain = hashRun(await directRun(ctxM, meta, slabs));
      const hToday = today.hash, same = n => { const x = r.rows.find(y => y.method === n); return !x || x.hash === hToday; };
      const ok1 = hDirect === hToday, ok2 = hMain === hDirect, ok3 = same('B1a') && same('B1lazy');
      console.log(`  check: baseline == m35/m36 run directly ${ok1 ? 'PASS' : 'FAIL'} (${hToday}); branch == main ${ok2 ? 'PASS' : 'FAIL'} (${hMain}); B1a and B1a-lazy bit-identical to today ${ok3 ? 'PASS' : 'FAIL'}`);
      if (!ok1) fails.push(`${name}.${q}: baseline differs from m35 run directly`);
      if (!ok2) fails.push(`${name}.${q}: branch output differs from main`);
      if (!ok3) fails.push(`${name}.${q}: B1a or B1a-lazy differs from today`);
      for (const row of r.rows) if (!allComputed(row)) fails.push(`${name}.${q}.${row.method}: a metric was not computed`);
      for (const row of r.rows) if (row.open !== 0 || row.nonManifold !== 0) console.log(`  note: ${row.label} output has open ${row.open} / non-manifold ${row.nonManifold} edges`);
    }
  }
  const out = arg('out', quick ? '' : path.join(ROOT, 'proto', 'simplify-bench', 'results', 'bench.json'));
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 1)); console.log('\nwrote', path.relative(ROOT, out)); }
  console.log(`\n${((performance.now() - t0) / 1000).toFixed(1)} s`);
  if (check) { if (fails.length) { console.log('CHECK FAILED:\n  ' + fails.join('\n  ')); process.exit(1); } console.log('CHECK OK'); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
