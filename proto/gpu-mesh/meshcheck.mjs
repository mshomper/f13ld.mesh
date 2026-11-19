// Mesh checks shared by selftest.mjs (CPU mesh) and the page ("Compare with CPU" runs them on the GPU mesh).

// Closed-mesh check: every undirected edge used by exactly two triangles, once in each direction.
export function closedCheck(indices, nV) {
  const nT = (indices.length / 3) | 0;
  const keys = new Float64Array(nT * 3);
  const M = nV + 1;
  for (let t = 0; t < nT; t++) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t * 3 + e], b = indices[t * 3 + (e + 1) % 3];
      const lo = a < b ? a : b, hi = a < b ? b : a;
      keys[t * 3 + e] = (lo * M + hi) * 2 + (a < b ? 0 : 1);
    }
  }
  keys.sort();
  let openEdges = 0, nonManifold = 0, badOrient = 0, edges = 0;
  for (let i = 0; i < keys.length;) {
    const g = Math.floor(keys[i] / 2);
    let j = i, d0 = 0, d1 = 0;
    while (j < keys.length && Math.floor(keys[j] / 2) === g) { if (keys[j] % 2 === 0) d0++; else d1++; j++; }
    const n = j - i; edges++;
    if (n === 1) openEdges++;
    else if (n > 2) nonManifold++;
    else if (d0 !== 1 || d1 !== 1) badOrient++;
    i = j;
  }
  return { edges, openEdges, nonManifold, badOrient, closed: nT > 0 && openEdges === 0 && nonManifold === 0 && badOrient === 0 };
}

export function signedVolume(pos, idx) {
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2], bx = pos[b], by = pos[b + 1], bz = pos[b + 2], cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

// Non-manifold vertices: a vertex whose incident triangles form more than one fan (link is not a single cycle).
export function nonManifoldVertexCount(indices, nV) {
  const nT = (indices.length / 3) | 0, start = new Uint32Array(nV + 1);
  for (let i = 0; i < indices.length; i++) start[indices[i] + 1]++;
  for (let v = 0; v < nV; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nV), list = new Uint32Array(indices.length);
  for (let t = 0; t < nT; t++) for (let e = 0; e < 3; e++) list[fill[indices[t * 3 + e]]++] = t;
  let bad = 0;
  for (let v = 0; v < nV; v++) {
    const s = start[v], k = start[v + 1] - s; if (k < 2) continue;
    const par = []; for (let i = 0; i < k; i++) par.push(i);
    const find = x => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
    for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) {
      const ta = list[s + a] * 3, tb = list[s + b] * 3;
      let shared = 0;
      for (let i = 0; i < 3; i++) { const x = indices[ta + i]; if (x === v) continue; for (let j = 0; j < 3; j++) if (indices[tb + j] === x) shared++; }
      if (shared) par[find(a)] = find(b);
    }
    let comps = 0; for (let i = 0; i < k; i++) if (find(i) === i) comps++;
    if (comps > 1) bad++;
  }
  return bad;
}

// Triangles whose area is below 1e-9 of a cell face (h^2).
export function zeroAreaCount(pos, idx, h) {
  let n = 0; const lim = 1e-9 * h * h;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz) <= lim) n++;
  }
  return n;
}
