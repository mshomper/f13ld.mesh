// proto/simplify-bench/lib/geom.mjs - mesh checkers for the bench: a triangle BVH, closest point,
// triangle-triangle intersection, edge statistics, sampled two-sided deviation, seam-edge identity.
// Plain ES module on typed arrays, no dependencies, so the page can load it too. MIT, written for this bench.
// Meshes are { pos: Float32Array|Float64Array (xyz), idx: Uint32Array }.

// ---------- seeded random ----------
export function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---------- BVH over triangles ----------
export class BVH {
  constructor(pos, idx, leaf = 4) {
    this.pos = pos; this.idx = idx; const nT = this.nT = idx.length / 3;
    const bx = this.tb = new Float64Array(nT * 6), cen = new Float64Array(nT * 3);
    for (let t = 0; t < nT; t++) {
      const a = 3 * idx[3 * t], b = 3 * idx[3 * t + 1], c = 3 * idx[3 * t + 2];
      for (let k = 0; k < 3; k++) {
        const x = pos[a + k], y = pos[b + k], z = pos[c + k];
        const lo = Math.min(x, y, z), hi = Math.max(x, y, z);
        bx[6 * t + k] = lo; bx[6 * t + 3 + k] = hi; cen[3 * t + k] = (lo + hi) / 2;
      }
    }
    this.order = new Uint32Array(nT); for (let i = 0; i < nT; i++) this.order[i] = i;
    const maxNodes = Math.max(1, 2 * Math.ceil(nT / Math.max(1, leaf / 2)) + 1);
    this.nb = new Float64Array(maxNodes * 6); this.left = new Int32Array(maxNodes); this.right = new Int32Array(maxNodes);
    this.start = new Int32Array(maxNodes); this.count = new Int32Array(maxNodes); this.nNodes = 0;
    if (nT) this._build(0, nT, leaf, cen);
  }
  _build(lo, hi, leaf, cen) {
    const id = this.nNodes++, o = this.order, tb = this.tb, nb = this.nb;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
    for (let i = lo; i < hi; i++) {
      const t = o[i];
      if (tb[6 * t] < x0) x0 = tb[6 * t]; if (tb[6 * t + 1] < y0) y0 = tb[6 * t + 1]; if (tb[6 * t + 2] < z0) z0 = tb[6 * t + 2];
      if (tb[6 * t + 3] > x1) x1 = tb[6 * t + 3]; if (tb[6 * t + 4] > y1) y1 = tb[6 * t + 4]; if (tb[6 * t + 5] > z1) z1 = tb[6 * t + 5];
      const cx = cen[3 * t], cy = cen[3 * t + 1], cz = cen[3 * t + 2];
      if (cx < cx0) cx0 = cx; if (cx > cx1) cx1 = cx; if (cy < cy0) cy0 = cy; if (cy > cy1) cy1 = cy; if (cz < cz0) cz0 = cz; if (cz > cz1) cz1 = cz;
    }
    nb[6 * id] = x0; nb[6 * id + 1] = y0; nb[6 * id + 2] = z0; nb[6 * id + 3] = x1; nb[6 * id + 4] = y1; nb[6 * id + 5] = z1;
    if (hi - lo <= leaf) { this.left[id] = -1; this.start[id] = lo; this.count[id] = hi - lo; return id; }
    const ex = cx1 - cx0, ey = cy1 - cy0, ez = cz1 - cz0, ax = ex >= ey && ex >= ez ? 0 : (ey >= ez ? 1 : 2);
    // median split by nth_element-free sort of the range (fine for bench sizes)
    const sub = Array.prototype.slice.call(o, lo, hi).sort((p, q) => cen[3 * p + ax] - cen[3 * q + ax] || p - q);
    for (let i = 0; i < sub.length; i++) o[lo + i] = sub[i];
    const mid = (lo + hi) >> 1;
    this.left[id] = this._build(lo, mid, leaf, cen); this.right[id] = this._build(mid, hi, leaf, cen);
    this.count[id] = 0; return id;
  }
  // closest point distance (squared) from p to the mesh
  nearest2(px, py, pz) {
    let best = Infinity; const stack = [0], nb = this.nb, pos = this.pos, idx = this.idx;
    if (!this.nT) return Infinity;
    while (stack.length) {
      const n = stack.pop();
      if (boxDist2(nb, n, px, py, pz) >= best) continue;
      if (this.left[n] < 0) {
        for (let i = this.start[n], e = i + this.count[n]; i < e; i++) {
          const t = this.order[i], d = ptTri2(px, py, pz, pos, 3 * idx[3 * t], 3 * idx[3 * t + 1], 3 * idx[3 * t + 2]);
          if (d < best) best = d;
        }
      } else {
        const l = this.left[n], r = this.right[n], dl = boxDist2(nb, l, px, py, pz), dr = boxDist2(nb, r, px, py, pz);
        if (dl < dr) { stack.push(r, l); } else { stack.push(l, r); }
      }
    }
    return best;
  }
}
function boxDist2(nb, n, px, py, pz) {
  const o = 6 * n; let d = 0, v;
  v = nb[o] - px; if (v > 0) d += v * v; else { v = px - nb[o + 3]; if (v > 0) d += v * v; }
  v = nb[o + 1] - py; if (v > 0) d += v * v; else { v = py - nb[o + 4]; if (v > 0) d += v * v; }
  v = nb[o + 2] - pz; if (v > 0) d += v * v; else { v = pz - nb[o + 5]; if (v > 0) d += v * v; }
  return d;
}
// squared distance from point to triangle (Ericson, Real-Time Collision Detection 5.1.5)
function ptTri2(px, py, pz, P, a, b, c) {
  const ax = P[a], ay = P[a + 1], az = P[a + 2], bx = P[b], by = P[b + 1], bz = P[b + 2], cx = P[c], cy = P[c + 1], cz = P[c + 2];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz, d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); qx = ax + v * abx; qy = ay + v * aby; qz = az + v * abz; }
      else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz, d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); qx = bx + w * (cx - bx); qy = by + w * (cy - by); qz = bz + w * (cz - bz); }
            else { const den = 1 / (va + vb + vc), v = vb * den, w = vc * den; qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w; }
          }
        }
      }
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz; return dx * dx + dy * dy + dz * dz;
}

// ---------- edge statistics ----------
// open: directed edges with no reverse partner (counted once per directed edge, so a hole of k edges counts k).
// nonManifold: undirected edges used by more than 2 triangles, plus directed edges used twice in the same direction.
export function edgeStats(idx, nV) {
  const dir = new Map(); let t;
  for (t = 0; t < idx.length; t += 3) for (let q = 0; q < 3; q++) { const a = idx[t + q], b = idx[t + (q === 2 ? 0 : q + 1)], k = a * nV + b; dir.set(k, (dir.get(k) || 0) + 1); }
  let open = 0, nonManifold = 0; const und = new Map();
  dir.forEach((c, k) => {
    const a = Math.floor(k / nV), b = k - a * nV;
    if (c > 1) nonManifold++;
    if (!dir.has(b * nV + a)) open++;
    const u = a < b ? k : b * nV + a; und.set(u, (und.get(u) || 0) + c);
  });
  und.forEach(c => { if (c > 2) nonManifold++; });
  return { open, nonManifold };
}
// open edges as a set of coordinate keys "x,y,z>x,y,z" (so they compare across different vertex numbering)
export function openEdgeKeys(pos, idx, nV) {
  const dir = new Set(), out = new Set();
  for (let t = 0; t < idx.length; t += 3) for (let q = 0; q < 3; q++) dir.add(idx[t + q] * nV + idx[t + (q === 2 ? 0 : q + 1)]);
  const pk = v => pos[3 * v] + ',' + pos[3 * v + 1] + ',' + pos[3 * v + 2];
  dir.forEach(k => { const a = Math.floor(k / nV), b = k - a * nV; if (!dir.has(b * nV + a)) out.add(pk(a) + '>' + pk(b)); });
  return out;
}
export function sameSet(a, b) { if (a.size !== b.size) return false; for (const x of a) if (!b.has(x)) return false; return true; }

// ---------- triangle-triangle intersection ----------
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
// segment p->q crosses triangle (a,b,c) properly (interior of both), non-coplanar
function segTri(p, q, a, b, c, eps) {
  const n = cross(sub(b, a), sub(c, a)), dp = dot(n, sub(p, a)), dq = dot(n, sub(q, a));
  const nn = Math.sqrt(dot(n, n)) || 1;
  if (Math.abs(dp) / nn <= eps && Math.abs(dq) / nn <= eps) return 0;       // coplanar: handled apart
  if ((dp > 0 && dq > 0) || (dp < 0 && dq < 0)) return 0;
  const t = dp / (dp - dq); if (!(t > 1e-9 && t < 1 - 1e-9)) return 0;
  const x = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])];
  const v0 = sub(b, a), v1 = sub(c, a), v2 = sub(x, a), d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1), d20 = dot(v2, v0), d21 = dot(v2, v1);
  const den = d00 * d11 - d01 * d01; if (!den) return 0;
  const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den, u = 1 - v - w, e = 1e-9;
  return (u > e && v > e && w > e) ? 1 : 0;
}
// coplanar triangles overlap in area (proper edge crossings; containment of a vertex)
function coplanarOverlap(A, B, n, eps) {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]), d = ax >= ay && ax >= az ? 0 : (ay >= az ? 1 : 2), i = (d + 1) % 3, j = (d + 2) % 3;
  const P = A.map(v => [v[i], v[j]]), Q = B.map(v => [v[i], v[j]]);
  const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let e = 0; e < 3; e++) for (let f = 0; f < 3; f++) {
    const p = P[e], q = P[(e + 1) % 3], r = Q[f], s = Q[(f + 1) % 3];
    const o1 = orient(p, q, r), o2 = orient(p, q, s), o3 = orient(r, s, p), o4 = orient(r, s, q);
    if (o1 * o2 < -eps * eps && o3 * o4 < -eps * eps) return true;
  }
  const inside = (T, p) => { const s1 = orient(T[0], T[1], p), s2 = orient(T[1], T[2], p), s3 = orient(T[2], T[0], p); return (s1 > eps * eps && s2 > eps * eps && s3 > eps * eps) || (s1 < -eps * eps && s2 < -eps * eps && s3 < -eps * eps); };
  for (let e = 0; e < 3; e++) { if (inside(Q, P[e]) || inside(P, Q[e])) return true; }
  return false;
}
export function triTriIntersect(A, B, eps = 1e-9) {
  const edges = [[0, 1], [1, 2], [2, 0]];
  for (const [i, j] of edges) { if (segTri(A[i], A[j], B[0], B[1], B[2], eps)) return true; if (segTri(B[i], B[j], A[0], A[1], A[2], eps)) return true; }
  const nA = cross(sub(A[1], A[0]), sub(A[2], A[0])), nl = Math.sqrt(dot(nA, nA)) || 1;
  if (nl > 0 && B.every(v => Math.abs(dot(nA, sub(v, A[0]))) / nl <= eps)) return coplanarOverlap(A, B, nA, eps);
  return false;
}

// Pairs of triangles that intersect and share no vertex index. With sample < nT only that many triangles
// (evenly strided, seeded) are tested against all others; the count is then pairs involving a sampled triangle.
export function selfIntersections(pos, idx, opts = {}) {
  const nT = idx.length / 3, bvh = opts.bvh || new BVH(pos, idx), maxT = opts.sample > 0 && opts.sample < nT ? opts.sample : nT;
  const sampled = maxT < nT, rnd = rng(12345), pick = [];
  if (sampled) { const seen = new Set(); while (pick.length < maxT) { const t = Math.floor(rnd() * nT); if (!seen.has(t)) { seen.add(t); pick.push(t); } } pick.sort((a, b) => a - b); }
  else for (let t = 0; t < nT; t++) pick.push(t);
  const tri = t => [0, 1, 2].map(k => { const v = 3 * idx[3 * t + k]; return [pos[v], pos[v + 1], pos[v + 2]]; });
  let pairs = 0; const first = [], tb = bvh.tb;
  for (const t of pick) {
    const t0 = idx[3 * t], t1 = idx[3 * t + 1], t2 = idx[3 * t + 2];
    const stack = [0]; let A = null;
    const lo0 = tb[6 * t], lo1 = tb[6 * t + 1], lo2 = tb[6 * t + 2], hi0 = tb[6 * t + 3], hi1 = tb[6 * t + 4], hi2 = tb[6 * t + 5];
    while (stack.length) {
      const n = stack.pop(), o = 6 * n, nb = bvh.nb;
      if (nb[o] > hi0 || nb[o + 3] < lo0 || nb[o + 1] > hi1 || nb[o + 4] < lo1 || nb[o + 2] > hi2 || nb[o + 5] < lo2) continue;
      if (bvh.left[n] >= 0) { stack.push(bvh.left[n], bvh.right[n]); continue; }
      for (let i = bvh.start[n], e = i + bvh.count[n]; i < e; i++) {
        const u = bvh.order[i]; if (u === t || (!sampled && u < t)) continue;
        const u0 = idx[3 * u], u1 = idx[3 * u + 1], u2 = idx[3 * u + 2];
        if (u0 === t0 || u0 === t1 || u0 === t2 || u1 === t0 || u1 === t1 || u1 === t2 || u2 === t0 || u2 === t1 || u2 === t2) continue;
        if (tb[6 * u] > hi0 || tb[6 * u + 3] < lo0 || tb[6 * u + 1] > hi1 || tb[6 * u + 4] < lo1 || tb[6 * u + 2] > hi2 || tb[6 * u + 5] < lo2) continue;
        if (!A) A = tri(t);
        if (triTriIntersect(A, tri(u))) { pairs++; if (first.length < 3) first.push([t, u]); }
      }
    }
  }
  return { pairs, testedTris: maxT, totalTris: nT, sampled, first };
}

// ---------- sampled two-sided deviation ----------
function areaSampler(pos, idx, rnd) {
  const nT = idx.length / 3, cum = new Float64Array(nT); let tot = 0;
  for (let t = 0; t < nT; t++) {
    const a = 3 * idx[3 * t], b = 3 * idx[3 * t + 1], c = 3 * idx[3 * t + 2];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    tot += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2; cum[t] = tot;
  }
  return () => {
    const r = rnd() * tot; let lo = 0, hi = nT - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < r) lo = m + 1; else hi = m; }
    const a = 3 * idx[3 * lo], b = 3 * idx[3 * lo + 1], c = 3 * idx[3 * lo + 2]; let s = rnd(), u = rnd(); if (s + u > 1) { s = 1 - s; u = 1 - u; }
    return [pos[a] + s * (pos[b] - pos[a]) + u * (pos[c] - pos[a]), pos[a + 1] + s * (pos[b + 1] - pos[a + 1]) + u * (pos[c + 1] - pos[a + 1]), pos[a + 2] + s * (pos[b + 2] - pos[a + 2]) + u * (pos[c + 2] - pos[a + 2])];
  };
}
// Two-sided: n points on each mesh, distance to the other mesh. Returns {max, mean, maxAB, maxBA, samples}.
// Sampling only (not exact Hausdorff): the max is a lower bound that tightens with n.
export function deviation(A, B, n = 5000, bvhA = null, bvhB = null) {
  if (!A.idx.length || !B.idx.length) return { max: NaN, mean: NaN, maxAB: NaN, maxBA: NaN, samples: 0 };
  const ba = bvhA || new BVH(A.pos, A.idx), bb = bvhB || new BVH(B.pos, B.idx), rnd = rng(777);
  const sa = areaSampler(A.pos, A.idx, rnd), sb = areaSampler(B.pos, B.idx, rnd);
  let m1 = 0, m2 = 0, sum = 0;
  for (let i = 0; i < n; i++) { const p = sa(), d = Math.sqrt(bb.nearest2(p[0], p[1], p[2])); if (d > m1) m1 = d; sum += d; }
  for (let i = 0; i < n; i++) { const p = sb(), d = Math.sqrt(ba.nearest2(p[0], p[1], p[2])); if (d > m2) m2 = d; sum += d; }
  return { max: Math.max(m1, m2), mean: sum / (2 * n), maxAB: m1, maxBA: m2, samples: 2 * n };
}

// FNV-1a style hash of typed arrays (byte-wise), for the byte-identity checks
export function hashArrays(...arrs) {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0xabcdef;
  for (const a of arrs) { const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); h2 = (h2 + a.byteLength) >>> 0; for (let i = 0; i < u.length; i++) { h1 = Math.imul(h1 ^ u[i], 0x01000193); h2 = Math.imul(h2 ^ u[i], 0x85ebca6b) + i | 0; } }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
