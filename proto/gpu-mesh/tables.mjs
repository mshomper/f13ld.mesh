// Single source of truth for the GPU mesh prototype.
// The CPU reference mesher, the Node selftest and the WebGPU page all import this file.
// The WGSL constant tables are GENERATED from it (wgslTables()); nothing is retyped in a shader.
//
// Grid: (N+1)^3 points, point index = i + m*(j + m*k), m = N+1. Cells: N^3, cell index = i + N*(j + N*k).
// Unit box [0,1]^3: point (i,j,k) sits at (i,j,k)/N.
// Convention: positive-inside. A point is solid when field > 0. Outermost layer of points is forced to -1
// (padded negative) so every part is closed.

export const CROSS_EPS = 1e-4; // crossings stay this fraction of an edge off a grid point (cf. SLAB_TCLAMP in worker/m34-slab-mesher.js)

// Cube corner c has offset (c&1, (c>>1)&1, (c>>2)&1).
export const CORNER_OFF = [];
for (let c = 0; c < 8; c++) CORNER_OFF.push([c & 1, (c >> 1) & 1, (c >> 2) & 1]);

// Grid edges. Every grid edge is (point p, type t) and runs from p to p + EDGE_DIRS[t].
// It is OWNED by point p. 3 axis edges, 3 face diagonals, 1 body diagonal = exactly the edges the tet split uses.
export const EDGE_DIRS = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1]];

// Kuhn / Freudenthal split of a cube into 6 tets along the main diagonal corner0 -> corner7.
// Tet for axis permutation (p0,p1,p2) = corners 0, e_p0, e_p0+e_p1, 7. Every cube uses the same split,
// so the diagonals on shared faces always agree between neighbouring cubes (faces match by construction).
const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
export const TETS = PERMS.map(p => { const a = 1 << p[0], b = a | (1 << p[1]); return [0, a, b, 7]; });

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const popc = v => { let n = 0; while (v) { n += v & 1; v >>= 1; } return n; };
export const POPCOUNT7 = Array.from({ length: 128 }, (_, i) => popc(i));

// Edge code = lowCorner | (edgeType << 3): which owned grid edge, relative to the cell origin.
function edgeCode(cA, cB) {
  let lo = cA, hi = cB;
  if (popc(cA) > popc(cB)) { lo = cB; hi = cA; }
  if ((lo & hi) !== lo) throw new Error('tet edge corners not nested');
  const d = sub(CORNER_OFF[hi], CORNER_OFF[lo]);
  const t = EDGE_DIRS.findIndex(e => e[0] === d[0] && e[1] === d[1] && e[2] === d[2]);
  if (t < 0) throw new Error('edge direction not in EDGE_DIRS');
  return lo | (t << 3);
}

// Marching-tet case table. Local vertex v of tet t is cube corner TETS[t][v]; case bit v is set when that
// vertex is inside (field > 0). TRI_COUNT[case] = 0, 1 or 2. EDGE_CODE[(t*16+case)*6 + tri*3 + vert].
// Orientation is derived from the reference geometry so that every normal points from solid to empty
// (counter-clockwise seen from outside, giving positive signed volume).
export const TRI_COUNT = new Uint8Array(16);
export const EDGE_CODE = new Uint8Array(6 * 16 * 6);
export const TET_SIGN = []; // handedness of each tet (+1 / -1), informational

(function build() {
  for (let t = 0; t < 6; t++) {
    const cs = TETS[t];
    const P = cs.map(c => CORNER_OFF[c]);
    TET_SIGN.push(Math.sign(dot(cross(sub(P[1], P[0]), sub(P[2], P[0])), sub(P[3], P[0]))));
    for (let cas = 0; cas < 16; cas++) {
      const ins = [], out = [];
      for (let v = 0; v < 4; v++) (cas >> v & 1 ? ins : out).push(v);
      let tris = [];
      const mid = (u, v) => [(P[u][0] + P[v][0]) / 2, (P[u][1] + P[v][1]) / 2, (P[u][2] + P[v][2]) / 2];
      if (ins.length === 1 || ins.length === 3) {
        const single = ins.length === 1 ? ins[0] : out[0];
        const others = [0, 1, 2, 3].filter(v => v !== single);
        tris = [others.map(o => [single, o])];
      } else if (ins.length === 2) {
        const [a, b] = ins, [c, d] = out;
        const ac = [a, c], ad = [a, d], bd = [b, d], bc = [b, c];
        tris = [[ac, ad, bd], [ac, bd, bc]];
      }
      const cen = vs => { const s = [0, 0, 0]; for (const v of vs) for (let q = 0; q < 3; q++) s[q] += P[v][q] / vs.length; return s; };
      const dir = ins.length && out.length ? sub(cen(out), cen(ins)) : [0, 0, 0];
      TRI_COUNT[cas] = tris.length;
      tris.forEach((tri, ti) => {
        const m = tri.map(e => mid(e[0], e[1]));
        const n = cross(sub(m[1], m[0]), sub(m[2], m[0]));
        if (dot(n, dir) < 0) tri = [tri[0], tri[2], tri[1]];
        tri.forEach((e, vi) => { EDGE_CODE[(t * 16 + cas) * 6 + ti * 3 + vi] = edgeCode(cs[e[0]], cs[e[1]]); });
      });
    }
  }
})();

// ---- Fields (positive-inside, solid where f > 0) -------------------------------------------------------------
// TPMS "sheet" (wall) form: f = thick - |g(x)|, so the solid is a wall of half-thickness ~thick around the g=0 surface.
// x = 2*pi*cells*u, u in [0,1]^3 across the box. Sphere: f = radius - |u - (0.5,0.5,0.5)| (thick is the radius).
export const KINDS = { gyroid: 0, schwarzP: 1, diamond: 2, sphere: 3 };
export const KIND_NAMES = ['gyroid', 'schwarzP', 'diamond', 'sphere'];
const TAU = Math.PI * 2;
export function fieldAt(kind, cells, thick, ux, uy, uz) {
  if (kind === 3) { const dx = ux - 0.5, dy = uy - 0.5, dz = uz - 0.5; return thick - Math.sqrt(dx * dx + dy * dy + dz * dz); }
  const x = TAU * cells * ux, y = TAU * cells * uy, z = TAU * cells * uz;
  const sx = Math.sin(x), cx = Math.cos(x), sy = Math.sin(y), cy = Math.cos(y), sz = Math.sin(z), cz = Math.cos(z);
  let g;
  if (kind === 0) g = sx * cy + sy * cz + sz * cx;
  else if (kind === 1) g = cx + cy + cz;
  else g = sx * sy * sz + sx * cy * cz + cx * sy * cz + cx * cy * sz;
  return thick - Math.abs(g);
}

// ---- WGSL generation -----------------------------------------------------------------------------------------
function arr(name, type, vals, suffix) {
  return `var<private> ${name}: array<${type}, ${vals.length}> = array<${type}, ${vals.length}>(${Array.from(vals).map(v => v + suffix).join(', ')});\n`;
}
export function wgslTables() {
  const flat = a => a.flat();
  return [
    '// generated from tables.mjs by wgslTables(); do not edit',
    arr('CORNER_OFF', 'u32', flat(CORNER_OFF), 'u'),
    arr('EDGE_DIR', 'u32', flat(EDGE_DIRS), 'u'),
    arr('TET_CORNER', 'u32', flat(TETS), 'u'),
    arr('TRI_COUNT', 'u32', TRI_COUNT, 'u'),
    arr('EDGE_CODE', 'u32', EDGE_CODE, 'u'),
    `const CROSS_EPS: f32 = ${CROSS_EPS.toExponential()};\n`,
  ].join('');
}
