// proto/simplify-bench/measure.mjs - where does simplify time go? Runs today's real slab pipeline
// (m35 simplifySlab per slab, then m36 _slabFinish with runBands = null, i.e. one thread) over the saved raw
// slab meshes and writes results/breakdown.json and results/breakdown.md from the timing counters
// that the branch added to m35 / m36 (timing only).
//
//   node proto/simplify-bench/measure.mjs [--quals draft,med] [--only a,b] [--reps 1]
//
// Everything runs on ONE thread: the sum of per-slab times is CPU time, not wall time. The real export spreads
// slabs, band rounds and rows jobs over the pool; the flips on the joined mesh stay single-threaded.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadWorker, SLAB_FILES } from './lib/env.mjs';
import { readSlabs } from './lib/slabio.mjs';
import { DATA, CASES } from './make-jobs.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const RESULTS = path.join(ROOT, 'proto', 'simplify-bench', 'results');
const z = () => ({ ring: 0, closed0: 0, seam0: 0, first: 0, retryMeshopt: 0, closedChk: 0, seamChk: 0, lockRings: 0, calls: 0 });
const add = (a, b) => { if (b) for (const k in a) a[k] += b[k] || 0; return a; };
const r1 = x => Math.round(x * 10) / 10;

export async function measureCase(ctx, file) {
  const { meta, slabs } = readSlabs(file);
  const g = ctx.weldGridDims(meta.gridMin, meta.gridMax, meta.edgeWorld);
  const tol = meta.tol;
  const results = [];
  const S = { simplifyWall: 0, safe: z(), flip: 0, flips: 0, compact: 0, retries: 0, locked: 0, outTris: 0, rawTris: 0, gaveUp: 0, flipRejected: 0 };
  for (const s of slabs) {
    const r = { pos: s.pos, idx: s.idx, seamV: s.seamV, seamK: s.seamK, nbrA: s.nbrA.length ? s.nbrA : null, nbrB: s.nbrB.length ? s.nbrB : null, evals: s.evals, fieldMs: s.fieldMs };
    const t = performance.now();
    const o = ctx.simplifySlab(r, tol);
    const ms = performance.now() - t;
    o._La = s.La; o._ms = ms; o.simpMs = ms;
    S.simplifyWall += ms; add(S.safe, o.simpT); S.flip += o.flipMs || 0; S.flips += o.flips || 0; S.compact += o.compactMs || 0;
    S.retries += o.retries || 0; S.locked += o.locked || 0; S.outTris += o.idx.length / 3; S.rawTris += o.rawTris; if (o.gaveUp) S.gaveUp++; if (o.flipRejected) S.flipRejected++;
    results.push(o);
  }
  const tF = performance.now();
  const out = await ctx._slabFinish(g, results, tol, null, tF, null, 8, false);
  const finalMs = performance.now() - tF;
  const fs_ = out.finalSimp || {}, rounds = {};
  for (const r of fs_.rounds || []) rounds[r.round] = { ms: r.ms, bands: r.bands, bandTris: r.bandTris, after: r.after, retries: r.retries, flips: r.flips, flipMs: r1(r.flipMs || 0), safe: r.simpT };
  const rows = fs_.rows ? { ms: fs_.rows.ms, free: fs_.rows.free, pieces: fs_.rows.pieces, jobs: fs_.rows.jobs, tris: fs_.rows.tris, retries: fs_.rows.retries, flipMs: r1(fs_.rows.flipMs || 0), safe: fs_.rows.simpT } : null;
  const sm = S.simplifyWall;
  return {
    case: meta.case, family: meta.family, qual: meta.qual, edgeMm: meta.edgeMm, tol, grid: meta.grid, slabs: slabs.length, built: meta.built,
    rawTris: S.rawTris, slabOutTris: S.outTris, finalTris: out.idx.length / 3,
    slabPhase: { simplifyMs: r1(sm), meshoptFirstMs: r1(S.safe.first), meshoptRetryMs: r1(S.safe.retryMeshopt), meshoptCalls: S.safe.calls,
      closedChecksMs: r1(S.safe.closed0 + S.safe.closedChk), seamChecksMs: r1(S.safe.seam0 + S.safe.seamChk), lockMs: r1(S.safe.ring + S.safe.lockRings),
      flipMs: r1(S.flip), compactMs: r1(S.compact), retries: S.retries, locked: S.locked, gaveUp: S.gaveUp, flips: S.flips, flipRejected: S.flipRejected,
      detail: Object.fromEntries(Object.entries(S.safe).map(([k, v]) => [k, r1(v)])) },
    finalPhase: { totalMs: r1(finalMs), joinMs: fs_.joinMs, roundA: rounds.A || null, roundB: rounds.B || null, rows, compactMs: fs_.compactMs, finalFlipMs: out.finalFlipMs, finalFlips: out.finalFlips, finalSimpMs: fs_.ms },
    fieldMsSum: r1(slabs.reduce((a, s) => a + s.fieldMs, 0)), marchMsSum: r1(slabs.reduce((a, s) => a + s.marchMs, 0)),
    // share rule (ADVISOR 8): retries + closed/seam checks as a part of slab simplify time
    retrySharePct: r1(100 * (S.safe.retryMeshopt + S.safe.closed0 + S.safe.closedChk + S.safe.seam0 + S.safe.seamChk + S.safe.lockRings) / Math.max(1e-9, sm)),
  };
}

function tableMd(all, machine) {
  const L = [];
  L.push('# Simplify time breakdown (today\'s pipeline, branch m35 / m36 with timing counters)', '');
  L.push(`Machine: ${machine.cpu}, ${machine.cores} logical cores, Node ${machine.node}. **Everything here ran on one thread** (Node-built jobs, m36 \`runBands = null\`): the numbers are CPU ms summed over slabs / bands, not wall time on the pool. Meshes: ${all[0] ? all[0].built : ''}. Slabs per mesh follow m36's job split for 8 workers.`, '');
  for (const qual of [...new Set(all.map(a => a.qual))]) {
    const rows = all.filter(a => a.qual === qual);
    L.push(`## ${qual} (edge ${rows[0].edgeMm} mm)`, '');
    L.push('### Per-slab phase (sum over slabs, ms)', '');
    L.push('| family | slabs | raw tris | slab out tris | simplify | meshopt 1st | meshopt retries | closed chk | seam chk | lock | flip | compact | retries | gave up |');
    L.push('|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
    for (const a of rows) { const p = a.slabPhase; L.push(`| ${a.family} | ${a.slabs} | ${a.rawTris} | ${a.slabOutTris} | ${p.simplifyMs} | ${p.meshoptFirstMs} | ${p.meshoptRetryMs} | ${p.closedChecksMs} | ${p.seamChecksMs} | ${p.lockMs} | ${p.flipMs} | ${p.compactMs} | ${p.retries} | ${p.gaveUp} |`); }
    L.push('', '### Final pass (ms) and result', '');
    L.push('| family | join | round A | round B | rows | compact | final flip | final pass total | A/B/rows retries | out tris | retries + checks + lock as % of slab simplify |');
    L.push('|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
    for (const a of rows) { const f = a.finalPhase; L.push(`| ${a.family} | ${f.joinMs} | ${f.roundA ? f.roundA.ms : '-'} | ${f.roundB ? f.roundB.ms : '-'} | ${f.rows ? f.rows.ms : '-'} | ${f.compactMs} | ${f.finalFlipMs} | ${f.totalMs} | ${[f.roundA, f.roundB, f.rows].map(x => x ? x.retries : '-').join('/')} | ${a.finalTris} | ${a.retrySharePct} |`); }
    L.push('', '### Final pass per round: triangles removed and cost (CPU ms, one thread)', '');
    L.push('| family | round A ms / tris in -> out / ms per 1000 removed | round B | rows pass (tris in) | final flip ms |', '|---|---|---|---|---|');
    const per = (x, key) => x ? `${x.ms} ms / ${x.bandTris} -> ${x.after} / ${x.bandTris > x.after ? ((x.ms / (x.bandTris - x.after)) * 1000).toFixed(1) : 'n/a'}` : '-';
    for (const a of rows) { const f = a.finalPhase; L.push(`| ${a.family} | ${per(f.roundA)} | ${per(f.roundB)} | ${f.rows ? f.rows.ms + ' ms / ' + f.rows.tris + ' tris' : '-'} | ${f.finalFlipMs} |`); }
    L.push('', '### Slab simplify as a share (%), slabs : final pass', '');
    L.push('| family | slab simplify ms | final pass ms (CPU, incl. flip) | ratio slab : final | field ms (sum) | marching ms (sum) |', '|---|--:|--:|--:|--:|--:|');
    for (const a of rows) { const f = a.finalPhase, fp = f.totalMs; L.push(`| ${a.family} | ${a.slabPhase.simplifyMs} | ${fp} | ${(a.slabPhase.simplifyMs / fp).toFixed(2)} : 1 | ${a.fieldMsSum} | ${a.marchMsSum} |`); }
    L.push('');
  }
  return L.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const quals = arg('quals', 'draft,med').split(','), only = arg('only', '') ? arg('only').split(',') : CASES, reps = +arg('reps', 1);
  const all = [];
  for (const q of quals) for (const name of only) {
    const file = path.join(DATA, name + '.' + q + '.slb');
    if (!fs.existsSync(file)) { console.log('missing', file); continue; }
    let best = null;
    for (let i = 0; i < reps; i++) {
      const ctx = await loadWorker({ files: SLAB_FILES });
      const m = await measureCase(ctx, file);
      if (!best || m.slabPhase.simplifyMs < best.slabPhase.simplifyMs) best = m;
    }
    all.push(best);
    const p = best.slabPhase, f = best.finalPhase;
    console.log(best.family.padEnd(24), q.padEnd(5), 'raw', best.rawTris, 'out', best.finalTris, '| slab simp', p.simplifyMs, '(1st', p.meshoptFirstMs, 'retry', p.meshoptRetryMs, 'chk', (p.closedChecksMs + p.seamChecksMs).toFixed(0), 'lock', p.lockMs, 'flip', p.flipMs, 'cmp', p.compactMs, 'retries', p.retries + ')', '| final', f.totalMs, '(A', f.roundA && f.roundA.ms, 'B', f.roundB && f.roundB.ms, 'rows', f.rows && f.rows.ms, 'flip', f.finalFlipMs + ')');
  }
  fs.mkdirSync(RESULTS, { recursive: true });
  const machine = { cpu: os.cpus()[0].model.trim(), cores: os.cpus().length, node: process.version, threads: 1 };
  fs.writeFileSync(path.join(RESULTS, 'breakdown.json'), JSON.stringify({ machine, note: 'single thread, Node-built jobs; ms are CPU sums', results: all }, null, 1));
  fs.writeFileSync(path.join(RESULTS, 'breakdown.md'), tableMd(all, machine));
  console.log('wrote results/breakdown.json and breakdown.md');
}
