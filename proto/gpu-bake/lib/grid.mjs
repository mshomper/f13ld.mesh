// proto/gpu-bake/lib/grid.mjs
// The exporter's grid, written out again with the same coordinate arithmetic as
// worker/m31-weld-grid.js (weldGridDims / weldBakeLayers). selftest.mjs checks that this file
// and the real m31 produce identical dims and identical coordinates; it is the page's
// "CPU reference" grid walker.
//
// Open-cube export (m90): levelSet over [-5,5]^3 world units with edge d.edgeWorld.
//   n[a]   = trunc(dim/edge + 1) - 1             cells per axis
//   s[a]   = dim / n[a]
//   main   points  min + s*i        i = 0..n        (n+1)^3 points, index i + nx1*(j + ny1*k)
//   offset points  min + s*(j-0.5)  j = 0..n+1      (n+2)^3 points, index i + nx2*(j + ny2*k)
// "All points" array used everywhere in this prototype: main points first, then offset points.
//
// SIGN CONVENTION (both sides, everywhere in proto/gpu-bake): the value that is stored, compared
// and judged is the field in MANIFOLD's convention = what m90 hands levelSet for an open cube
// = -sdf (POSITIVE INSIDE the solid). "Inside" means value > 0, exactly like the slab mesher
// (m34: `v>0`). A sign change on an edge means (a>0) !== (b>0).

export const QUALITY_EDGE_MM = { draft: 0.40, low: 0.20, med: 0.12, high: 0.09, ultra: 0.075 }; // mesh-worker-host.js QUAL_EDGE_MM

export function gridDims(min, max, edge) {
  const n = [0, 0, 0], s = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const dim = max[a] - min[a];
    n[a] = Math.trunc(dim / edge + 1.0) - 1;
    s[a] = n[a] > 0 ? dim / n[a] : 0;
  }
  const ok = n[0] > 0 && n[1] > 0 && n[2] > 0;
  return { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]], edge, n, s, ok,
    mainCount: ok ? (n[0] + 1) * (n[1] + 1) * (n[2] + 1) : 0,
    offCount: ok ? (n[0] + 2) * (n[1] + 2) * (n[2] + 2) : 0 };
}
// Open cube [-5,5]^3 with n cells per axis: edge = 10/n gives n exactly (checked in selftest).
export function cubeGrid(nCells) { return gridDims([-5, -5, -5], [5, 5, 5], 10 / nCells); }
export function cubeGridForEdge(edgeWorld) { return gridDims([-5, -5, -5], [5, 5, 5], edgeWorld); }

// f64 coordinate tables, computed exactly as weldBakeLayers computes x, y, z.
export function axisTables(g) {
  const mn = g.min, s = g.s, n = g.n;
  const mk = (len, f) => { const a = new Float64Array(len); for (let i = 0; i < len; i++) a[i] = f(i); return a; };
  return {
    mx: mk(n[0] + 1, i => mn[0] + s[0] * i), my: mk(n[1] + 1, i => mn[1] + s[1] * i), mz: mk(n[2] + 1, i => mn[2] + s[2] * i),
    ox: mk(n[0] + 2, i => mn[0] + s[0] * (i - 0.5)), oy: mk(n[1] + 2, i => mn[1] + s[1] * (i - 0.5)), oz: mk(n[2] + 2, i => mn[2] + s[2] * (i - 0.5)),
  };
}
export function totalPoints(g) { return g.mainCount + g.offCount; }

// CPU bake: fn([x,y,z]) in Manifold's convention -> Float64Array(all points), main first.
// A fresh point array per call, as levelSet passes. onProgress(frac) optional.
export function bakeCpu(fn, g, zRange, outArr) {
  const T = axisTables(g), n = g.n;
  const nx1 = n[0] + 1, ny1 = n[1] + 1, nz1 = n[2] + 1, nx2 = n[0] + 2, ny2 = n[1] + 2, nz2 = n[2] + 2;
  const out = outArr || new Float64Array(totalPoints(g));
  let o, i, j, k;
  const [ka, kb] = zRange ? zRange.main : [0, nz1];
  const [la, lb] = zRange ? zRange.off : [0, nz2];
  for (k = ka; k < kb; k++) { const z = T.mz[k];
    for (j = 0; j < ny1; j++) { const y = T.my[j]; o = nx1 * (j + ny1 * k);
      for (i = 0; i < nx1; i++) out[o++] = fn([T.mx[i], y, z]); } }
  const base = g.mainCount;
  for (k = la; k < lb; k++) { const z = T.oz[k];
    for (j = 0; j < ny2; j++) { const y = T.oy[j]; o = base + nx2 * (j + ny2 * k);
      for (i = 0; i < nx2; i++) out[o++] = fn([T.ox[i], y, z]); } }
  return out;
}

// Coordinates of one point of the all-points array (same arithmetic as the bake).
export function pointCoords(g, t, out) {
  const n = g.n, mn = g.min, s = g.s;
  if (t < g.mainCount) {
    const nx1 = n[0] + 1, ny1 = n[1] + 1;
    const i = t % nx1, j = ((t / nx1) | 0) % ny1, k = (t / (nx1 * ny1)) | 0;
    out[0] = mn[0] + s[0] * i; out[1] = mn[1] + s[1] * j; out[2] = mn[2] + s[2] * k;
  } else {
    const u = t - g.mainCount, nx2 = n[0] + 2, ny2 = n[1] + 2;
    const i = u % nx2, j = ((u / nx2) | 0) % ny2, k = (u / (nx2 * ny2)) | 0;
    out[0] = mn[0] + s[0] * (i - 0.5); out[1] = mn[1] + s[1] * (j - 0.5); out[2] = mn[2] + s[2] * (k - 0.5);
  }
  return out;
}

// The lattice edges the slab mesher (worker/m34-slab-mesher.js) and Manifold's levelSet read:
// the BCC tetrahedralisation = two neighbouring cell centres (offset-offset axis edge) plus one
// edge of the face they share (main-main axis edge), and the four main-to-offset diagonals
// between them. Over the whole grid that is every axis edge of both lattices and every
// main(i,j,k) - offset(i+dx,j+dy,k+dz), dx,dy,dz in {0,1} diagonal. forEachEdge(g, cb(a,b)).
export function forEachEdge(g, cb) {
  const n = g.n, nx1 = n[0] + 1, ny1 = n[1] + 1, nz1 = n[2] + 1, nx2 = n[0] + 2, ny2 = n[1] + 2, nz2 = n[2] + 2;
  const M = (i, j, k) => i + nx1 * (j + ny1 * k), O = (i, j, k) => g.mainCount + i + nx2 * (j + ny2 * k);
  let i, j, k;
  for (k = 0; k < nz1; k++) for (j = 0; j < ny1; j++) for (i = 0; i < nx1; i++) {
    const a = M(i, j, k);
    if (i + 1 < nx1) cb(a, M(i + 1, j, k));
    if (j + 1 < ny1) cb(a, M(i, j + 1, k));
    if (k + 1 < nz1) cb(a, M(i, j, k + 1));
    for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) cb(a, O(i + dx, j + dy, k + dz));
  }
  for (k = 0; k < nz2; k++) for (j = 0; j < ny2; j++) for (i = 0; i < nx2; i++) {
    const a = O(i, j, k);
    if (i + 1 < nx2) cb(a, O(i + 1, j, k));
    if (j + 1 < ny2) cb(a, O(i, j + 1, k));
    if (k + 1 < nz2) cb(a, O(i, j, k + 1));
  }
}
export function edgeCount(g) {
  const n = g.n, nx1 = n[0] + 1, ny1 = n[1] + 1, nz1 = n[2] + 1, nx2 = n[0] + 2, ny2 = n[1] + 2, nz2 = n[2] + 2;
  return (nx1 - 1) * ny1 * nz1 + nx1 * (ny1 - 1) * nz1 + nx1 * ny1 * (nz1 - 1) + 8 * nx1 * ny1 * nz1
    + (nx2 - 1) * ny2 * nz2 + nx2 * (ny2 - 1) * nz2 + nx2 * ny2 * (nz2 - 1);
}
