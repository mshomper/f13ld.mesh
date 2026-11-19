// proto/simplify-bench/lib/selftest.mjs - checks the checkers (browser-safe). Returns [{name, ok, detail}].
import { BVH, edgeStats, selfIntersections, deviation } from './geom.mjs';

// icosphere, `level` subdivisions, radius r; closed, consistently outward oriented
export function icosphere(level = 2, r = 1) {
  const t = (1 + Math.sqrt(5)) / 2;
  let P = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(v => { const l = Math.hypot(...v); return v.map(x => x / l); });
  let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let l = 0; l < level; l++) {
    const cache = new Map(), mid = (a, b) => { const k = a < b ? a + '_' + b : b + '_' + a; if (cache.has(k)) return cache.get(k); const m = P[a].map((x, i) => (x + P[b][i]) / 2), n = Math.hypot(...m); P.push(m.map(x => x / n)); cache.set(k, P.length - 1); return P.length - 1; };
    const NF = []; for (const [a, b, c] of F) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); NF.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); } F = NF;
  }
  return { pos: Float32Array.from(P.flat().map(x => x * r)), idx: Uint32Array.from(F.flat()) };
}
export function gridPlane(n, size, z) {
  const pos = [], idx = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.push(i / n * size, j / n * size, z);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i; idx.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1); }
  return { pos: Float32Array.from(pos), idx: Uint32Array.from(idx) };
}

export function selfTest() {
  const out = [], push = (name, ok, detail) => out.push({ name, ok: !!ok, detail });
  // 1. open edge: a closed sphere has none; with one triangle removed, 3 edges are open
  const sp = icosphere(2), nV = sp.pos.length / 3, closed = edgeStats(sp.idx, nV);
  const cut = { pos: sp.pos, idx: sp.idx.slice(3) }, holed = edgeStats(cut.idx, nV);
  push('open edge found on a mesh with one triangle removed', closed.open === 0 && closed.nonManifold === 0 && holed.open === 3, `closed sphere open ${closed.open}, with one triangle removed open ${holed.open} (expected 3)`);
  // non-manifold: a third triangle on one edge
  const nm = { pos: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1]), idx: Uint32Array.from([0, 1, 2, 1, 0, 3, 0, 1, 4]) };
  push('non-manifold edge found (three triangles on one edge)', edgeStats(nm.idx, 5).nonManifold >= 1, `non-manifold ${edgeStats(nm.idx, 5).nonManifold}`);
  // 2. self-intersection: two crossing triangles; separated ones and a clean sphere report none
  const X = { pos: Float32Array.from([-1, -1, 0, 1, -1, 0, 0, 1, 0, 0, -0.2, -1, 0, -0.2, 1, 0.8, 0.3, 0]), idx: Uint32Array.from([0, 1, 2, 3, 4, 5]) };
  const X2 = { pos: Float32Array.from([0, 0, 0, 2, 0, 0, 0, 2, 0, 0.5, 0.5, -1, 0.5, 0.5, 1, 1.5, 1.5, 1]), idx: Uint32Array.from([0, 1, 2, 3, 4, 5]) };
  const sep = { pos: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 5, 1, 0, 5, 0, 1, 5]), idx: Uint32Array.from([0, 1, 2, 3, 4, 5]) };
  const a = selfIntersections(X2.pos, X2.idx).pairs, b = selfIntersections(sep.pos, sep.idx).pairs, c = selfIntersections(sp.pos, sp.idx).pairs;
  void X;
  push('self-intersecting pair found on two crossing triangles', a === 1 && b === 0 && c === 0, `crossing pair ${a} (expected 1), separated ${b}, sphere ${c} (expected 0)`);
  // 3. deviation: offset by a known distance
  const P0 = gridPlane(20, 10, 0), dd = 0.05, P1 = gridPlane(20, 10, dd);
  const d1 = deviation(P0, P1, 3000), S0 = icosphere(3, 1), S1 = icosphere(3, 1.25), d2 = deviation(S0, S1, 3000);
  const e1 = Math.abs(d1.max / dd - 1), e2 = Math.abs(d2.max / 0.25 - 1);
  push('deviation within 10 % of the true value on an offset mesh', e1 < 0.1 && e2 < 0.1, `plane offset ${dd}: max ${d1.max.toFixed(4)} mean ${d1.mean.toFixed(4)} (${(e1 * 100).toFixed(1)} % off); sphere radius +0.25: max ${d2.max.toFixed(4)} (${(e2 * 100).toFixed(1)} % off)`);
  // BVH nearest against brute force
  const bv = new BVH(S0.pos, S0.idx); let worst = 0;
  for (let i = 0; i < 50; i++) { const p = [Math.sin(i) * 2, Math.cos(i * 1.7) * 2, Math.sin(i * 2.3) * 2], r = Math.sqrt(bv.nearest2(...p)), tr = Math.abs(Math.hypot(...p) - 1); worst = Math.max(worst, Math.abs(r - tr)); }
  push('BVH nearest distance matches the analytic sphere distance', worst < 0.02, `worst difference ${worst.toFixed(4)} (tessellation of a level-3 icosphere)`);
  return out;
}
