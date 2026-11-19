// proto/simplify-bench/lib/pipeline.mjs - run a simplify method over saved raw slab meshes and measure it.
// Browser-safe (no node imports): `ctx` is a global scope holding the m34 / m35 / m36 functions (a Node vm
// context, or the page's). Methods differ only in which candidate scripts were evaluated into their ctx.
import { BVH, edgeStats, openEdgeKeys, sameSet, selfIntersections, deviation, hashArrays } from './geom.mjs';

const now = () => performance.now();

export function slabInput(s) {
  return { pos: s.pos, idx: s.idx, seamV: s.seamV, seamK: s.seamK, nbrA: s.nbrA.length ? s.nbrA : null, nbrB: s.nbrB.length ? s.nbrB : null, evals: s.evals, fieldMs: s.fieldMs };
}

// today's export order on one thread: simplifySlab per slab, then _slabFinish (join, band rounds A / B, rows pass,
// compact, final flip). tolScale multiplies the tolerance (used to tune a candidate to a matched output).
// Time includes every check and flip the stages run. Returns the slab outputs and the final mesh.
export async function runPipeline(ctx, meta, slabs, tolScale = 1) {
  const g = ctx.weldGridDims(meta.gridMin, meta.gridMax, meta.edgeWorld), tol = meta.tol * tolScale, outs = [];
  const t0 = now();
  for (const s of slabs) {
    const t = now();
    const o = ctx.simplifySlab(slabInput(s), tol);
    o._La = s.La; o._ms = now() - t; o.simpMs = o._ms; outs.push(o);
  }
  const t1 = now();
  const fin = await ctx._slabFinish(g, outs, tol, null, t1, null, meta.workersAssumed || 8, false);
  const t2 = now();
  return { outs, final: { pos: fin.pos, idx: fin.idx }, slabMs: t1 - t0, finalMs: t2 - t1, totalMs: t2 - t0, info: fin };
}

export function hashRun(run) {
  const parts = [];
  for (const o of run.outs) parts.push(o.pos, o.idx);
  parts.push(run.final.pos, run.final.idx);
  return hashArrays(...parts);
}

// raw slabs joined by the same code the export uses (m34 joinSlabs)
export function rawJoined(ctx, slabs) { const J = ctx.joinSlabs(slabs.map(slabInput)); return { pos: J.pos, idx: J.idx }; }

// The shared bench loop (Node bench and page): for each method name, build its ctx (makeCtx(patches) -> ctx),
// warm up once, take the best of opts.reps timed runs, measure. defs[name] = {label, patches}.
// Returns { raw: {tris}, rows }. onRow(row) is called as each method finishes.
export async function benchMesh(makeCtx, meta, slabs, names, defs, opts = {}, onRow = null) {
  const base = await makeCtx([]), raw = rawJoined(base, slabs), rawBvh = new BVH(raw.pos, raw.idx), rows = [];
  for (const name of names) {
    const ctx = await makeCtx(defs[name].patches);
    await runPipeline(ctx, meta, slabs);
    let best = null, lo = Infinity, hi = 0;
    for (let i = 0; i < (opts.reps || 2); i++) { const r = await runPipeline(ctx, meta, slabs); lo = Math.min(lo, r.totalMs); hi = Math.max(hi, r.totalMs); if (!best || r.totalMs < best.totalMs) best = r; }
    const row = { method: name, label: defs[name].label, ...measureRun(ctx, meta, slabs, best, raw, rawBvh, opts), reps: opts.reps || 2, spreadMs: hi - lo };
    if (ctx.B1B_STATS) row.patch = { tried: ctx.B1B_STATS.tried, ok: ctx.B1B_STATS.ok };
    rows.push(row); if (onRow) onRow(row);
  }
  return { raw: { tris: raw.idx.length / 3 }, rows, rawJ: raw };
}

// Metrics of one run. raw = joined raw mesh; rawBvh optional shared BVH. opts: {siSample, devSamples}
export function measureRun(ctx, meta, slabs, run, raw, rawBvh, opts = {}) {
  const out = run.final, nV = out.pos.length / 3, res = {};
  const es = edgeStats(out.idx, nV), rawEs = edgeStats(raw.idx, raw.pos.length / 3);
  res.tris = out.idx.length / 3; res.open = es.open; res.nonManifold = es.nonManifold;
  const bvh = new BVH(out.pos, out.idx);
  const si = selfIntersections(out.pos, out.idx, { sample: opts.siSample || 0, bvh });
  res.selfX = si.pairs; res.selfXNote = si.sampled ? `sampled ${si.testedTris} of ${si.totalTris} triangles (pairs involving a sampled triangle)` : `all ${si.totalTris} triangles`;
  const dv = deviation(raw, out, opts.devSamples || 5000, rawBvh, bvh), mmPerWorld = (meta.domainMm || 10) / 10;
  res.devMaxMm = dv.max * mmPerWorld; res.devMeanMm = dv.mean * mmPerWorld; res.devMaxCells = dv.max / meta.edgeWorld; res.devMeanCells = dv.mean / meta.edgeWorld; res.devSamples = dv.samples;
  const q = ctx.triQuality(out.pos, out.idx);
  res.needlePct = 100 * q.needles / Math.max(1, res.tris); res.minAngleP5 = q.minAngleP5; res.meanMinAngle = q.meanMinAngle;
  // seam check: every slab's open edges (as coordinates) equal the raw slab's; and the joined result's open edges equal the raw join's
  let seamOk = true; const bad = [];
  slabs.forEach((s, i) => {
    const o = run.outs[i], a = openEdgeKeys(s.pos, s.idx, s.pos.length / 3), b = openEdgeKeys(o.pos, o.idx, o.pos.length / 3);
    if (!sameSet(a, b)) { seamOk = false; bad.push(i); }
  });
  res.seamSlabsIdentical = seamOk; res.seamBadSlabs = bad;
  res.finalOpenEqualsRaw = rawEs.open === es.open;
  res.slabMs = run.slabMs; res.finalMs = run.finalMs; res.totalMs = run.totalMs; res.slabTris = run.outs.reduce((a, o) => a + o.idx.length / 3, 0);
  res.retries = run.outs.reduce((a, o) => a + (o.retries || 0), 0);
  res.hash = hashRun(run);
  return res;
}
