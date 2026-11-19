// proto/simplify-bench/microcheck.test.mjs - (1) planted-case equality of today's checks with the CSR functions of
// cand/fast.js (and lazy.js); (2) per-slab timing of the closed check: today's Float64 sort, the CSR check, and the
// first attempt (open-addressing hash, recovered from git history, commit 1162fe9) -> results/microbench.json.
//   node --test proto/simplify-bench/microcheck.test.mjs        (arguments: MICRO_ARGS="med" optional quality)
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { ROOT, loadWorker, SLAB_FILES } from './lib/env.mjs';
import { readSlabs } from './lib/slabio.mjs';
import { icosphere } from './lib/selftest.mjs';
import { hashArrays } from './lib/geom.mjs';
import { DATA, CASES } from './make-jobs.mjs';

const sortedSet = a => a ? Array.from(a).sort((x, y) => x - y).join(',') : '';
const mapStr = m => JSON.stringify(Array.from(m.entries()).sort((a, b) => a[0] - b[0]));

test('planted cases: CSR checks equal today\'s', async () => {
  const T = await loadWorker({ files: SLAB_FILES }), B = await loadWorker({ files: SLAB_FILES, patches: ['cand/fast.js'] }), L = await loadWorker({ files: SLAB_FILES, patches: ['cand/fast.js', 'cand/lazy.js'] });
  const sp = icosphere(3, 1), nV = sp.pos.length / 3, idx = sp.idx, nT = idx.length / 3;
  const dup = Uint32Array.from([...idx, idx[0], idx[1], idx[2]]);
  const flipped = idx.slice(); { const t = flipped[4]; flipped[4] = flipped[5]; flipped[5] = t; }
  // seam sub-mesh: the lower half; open = vertices that also belong to a removed triangle
  const keepTri = [], inKept = new Uint8Array(nV), inGone = new Uint8Array(nV);
  for (let t = 0; t < nT; t++) { const z = (sp.pos[3 * idx[3 * t] + 2] + sp.pos[3 * idx[3 * t + 1] + 2] + sp.pos[3 * idx[3 * t + 2] + 2]) / 3; for (let k = 0; k < 3; k++) { if (z < 0.1) inKept[idx[3 * t + k]] = 1; else inGone[idx[3 * t + k]] = 1; } if (z < 0.1) keepTri.push(idx[3 * t], idx[3 * t + 1], idx[3 * t + 2]); }
  const half = Uint32Array.from(keepTri), open = new Uint8Array(nV); for (let v = 0; v < nV; v++) open[v] = inKept[v] && inGone[v] ? 1 : 0;
  const shared = (a, b) => open[a] === 1 && open[b] === 1;
  const cases = [['closed sphere', idx, null], ['one triangle removed', idx.slice(3), null], ['duplicate triangle', dup, null], ['flipped triangle', flipped, null],
    ['seam sub-mesh, ignore as array', half, open], ['seam sub-mesh, ignore as function', half, shared], ['seam sub-mesh, no ignore (open edges count)', half, null]];
  const log = [];
  for (const [name, ix, ign] of cases) {
    const a = T.meshClosedReport(sp.pos, ix, true, ign), b = B.closedEdgesFast(sp.pos, ix, true, ign);
    assert.strictEqual(b.ok, a.ok, name + ': ok');
    assert.strictEqual(sortedSet(b.verts), sortedSet(a.verts), name + ': failing-edge vertices');
    const a0 = T.meshClosedReport(sp.pos, ix, false, ign).ok, b0 = B.closedEdgesFast(sp.pos, ix, false, ign).ok;
    assert.strictEqual(b0, a0, name + ': ok without verts');
    log.push(`${name}: ok ${a.ok}, failing vertices ${a.verts ? a.verts.length : 0}, bad (today ${a.bad}, fast ${b.bad})`);
  }
  console.log(log.join('\n'));
  // seam-edge counts and ring lock on the seam sub-mesh
  const c0 = T.openEdgeCounts(half, nV, shared), c1 = B.openEdgeCountsFast(half, nV, shared, open);
  assert.strictEqual(mapStr(c1), mapStr(c0), 'openEdgeCounts');
  const ch0 = T.openEdgeChanges(c0, half.slice(3), nV, shared), ch1 = B.openEdgeChangesFast(c1, half.slice(3), nV, shared, open);
  assert.strictEqual(sortedSet(new Set(ch1)), sortedSet(new Set(ch0)), 'openEdgeChanges after removing a triangle');
  const lk0 = new Uint8Array(open), lk1 = new Uint8Array(open); T.ringLock(half, nV, shared, lk0); B.ringLockFast(half, nV, shared, lk1, open);
  assert.strictEqual(hashArrays(lk1), hashArrays(lk0), 'ring lock');
  // ring growth: CSR frontier against the original full-scan growth, 1..6 rings
  const csr = B.vertexTriCSR(idx, nV);
  for (const rings of [1, 2, 4, 6]) {
    let hit = new Uint8Array(nV); hit[0] = 1; hit[700] = 1;
    const start = hit.slice();
    for (let r = 0; r < rings; r++) { const nxt = hit.slice(); for (let t = 0; t < nT; t++) { const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2]; if (hit[a] || hit[b] || hit[c]) { nxt[a] = 1; nxt[b] = 1; nxt[c] = 1; } } hit = nxt; }
    assert.strictEqual(hashArrays(B.growRings(idx, csr, nV, [0, 700], rings)), hashArrays(hit), 'growRings ' + rings);
    void start;
  }
  // whole safeSimplify on the seam sub-mesh: today, B1a, B1a-lazy give the same indices and flags
  const res = {};
  for (const [n, c] of [['today', T], ['B1a', B], ['lazy', L]]) { const r = c.safeSimplify(sp.pos, half, 0.02, open, null, null); res[n] = hashArrays(r.idx) + ':' + r.retries + ':' + !!r.unsafe + ':' + !!r.gaveUp; }
  assert.deepStrictEqual([res.B1a, res.lazy], [res.today, res.today], 'safeSimplify on the seam sub-mesh');
  console.log('safeSimplify on the seam sub-mesh (today = B1a = B1a-lazy):', res.today);
});

test('closed check timing per Med slab: sort vs CSR vs the first hash attempt -> results/microbench.json', { timeout: 300000 }, async () => {
  const qual = (process.env.MICRO_ARGS || 'med').split(/\s+/)[0];
  const T = await loadWorker({ files: SLAB_FILES }), B = await loadWorker({ files: SLAB_FILES, patches: ['cand/fast.js'] }), H = await loadWorker({ files: SLAB_FILES });
  let hashText = null;
  try { hashText = execFileSync('git', ['show', '1162fe9:proto/simplify-bench/cand/b1a.js'], { cwd: ROOT, maxBuffer: 1 << 24 }).toString('utf8'); vm.runInContext(hashText, H, { filename: 'b1a-hash-version.js' }); } catch (e) { hashText = null; }
  const med = (fn, n) => { fn(); const t = []; for (let i = 0; i < n; i++) { const s = performance.now(); fn(); t.push(performance.now() - s); } t.sort((a, b) => a - b); return t[n >> 1]; };
  const out = { note: 'ms per call, median of 5, one thread (Ryzen 7 7700X, shared machine); the call is meshClosedReport(pos, idx, false, openVertexFlags) on a raw Med slab; hash = first attempt (open-addressing hash of directed edges), recovered from commit 1162fe9', quality: qual, hashRecovered: !!hashText, cases: [] };
  for (const name of CASES) {
    const { slabs } = readSlabs(path.join(DATA, name + '.' + qual + '.slb')), rows = [];
    slabs.forEach((s, i) => {
      const nV = s.pos.length / 3, open = new Uint8Array(nV); for (const v of s.seamV) open[v] = 1;
      const r = { slab: i, tris: s.idx.length / 3, sortMs: med(() => T.meshClosedReport(s.pos, s.idx, false, open), 5), csrMs: med(() => B.closedEdgesFast(s.pos, s.idx, false, open), 5) };
      if (hashText) r.hashMs = med(() => H.meshClosedReport(s.pos, s.idx, false, open), 5);
      assert.strictEqual(B.closedEdgesFast(s.pos, s.idx, false, open).ok, T.meshClosedReport(s.pos, s.idx, false, open).ok);
      rows.push(r);
    });
    const sum = k => rows.reduce((a, r) => a + (r[k] || 0), 0);
    out.cases.push({ case: name, slabs: rows, sumSortMs: sum('sortMs'), sumCsrMs: sum('csrMs'), sumHashMs: hashText ? sum('hashMs') : null });
    console.log(name.padEnd(28), 'per slab sort', Math.min(...rows.map(r => r.sortMs)).toFixed(0) + '-' + Math.max(...rows.map(r => r.sortMs)).toFixed(0), 'ms, csr', Math.min(...rows.map(r => r.csrMs)).toFixed(0) + '-' + Math.max(...rows.map(r => r.csrMs)).toFixed(0), 'ms' + (hashText ? ', hash ' + Math.min(...rows.map(r => r.hashMs)).toFixed(0) + '-' + Math.max(...rows.map(r => r.hashMs)).toFixed(0) + ' ms' : ''));
  }
  fs.mkdirSync(path.join(ROOT, 'proto', 'simplify-bench', 'results'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'proto', 'simplify-bench', 'results', 'microbench.json'), JSON.stringify(out, null, 1));
});
