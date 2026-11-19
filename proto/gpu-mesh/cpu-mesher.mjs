// CPU reference mesher. Same tables, same tet split, same ownership and ordering as the GPU kernels, so the
// two can be compared index by index: vertices ordered by (owner point index, edge type), triangles ordered by
// (cell index, tet, triangle in case table).
import { CORNER_OFF, EDGE_DIRS, TETS, TRI_COUNT, EDGE_CODE, POPCOUNT7, CROSS_EPS, fieldAt } from './tables.mjs';

export function buildField(N, kind, cells, thick) {
  const m = N + 1, f = new Float32Array(m * m * m);
  for (let k = 0; k <= N; k++) for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const id = i + m * (j + m * k);
    f[id] = (i === 0 || j === 0 || k === 0 || i === N || j === N || k === N) ? -1 : fieldAt(kind, cells, thick, i / N, j / N, k / N);
  }
  return f;
}

function cornerMask(f, i, j, k, m) {
  let cm = 0;
  for (let c = 0; c < 8; c++) { const o = CORNER_OFF[c]; if (f[(i + o[0]) + m * ((j + o[1]) + m * (k + o[2]))] > 0) cm |= 1 << c; }
  return cm;
}

export function meshField(f, N, eps = CROSS_EPS) {
  const m = N + 1, np = m * m * m;
  const masks = new Uint8Array(np), vstart = new Uint32Array(np + 1);
  for (let k = 0; k <= N; k++) for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const id = i + m * (j + m * k), f0 = f[id]; let mask = 0;
    for (let t = 0; t < 7; t++) {
      const d = EDGE_DIRS[t];
      if (i + d[0] > N || j + d[1] > N || k + d[2] > N) continue;
      if ((f0 > 0) !== (f[id + d[0] + m * (d[1] + m * d[2])] > 0)) mask |= 1 << t;
    }
    masks[id] = mask; vstart[id + 1] = vstart[id] + POPCOUNT7[mask];
  }
  const nV = vstart[np], pos = new Float32Array(nV * 3);
  for (let k = 0; k <= N; k++) for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const id = i + m * (j + m * k), mask = masks[id]; if (!mask) continue;
    let o = vstart[id]; const f0 = f[id];
    for (let t = 0; t < 7; t++) {
      if (!(mask >> t & 1)) continue;
      const d = EDGE_DIRS[t], f1 = f[id + d[0] + m * (d[1] + m * d[2])];
      let a = f0 / (f0 - f1); a = a < eps ? eps : a > 1 - eps ? 1 - eps : a;
      pos[o * 3] = (i + a * d[0]) / N; pos[o * 3 + 1] = (j + a * d[1]) / N; pos[o * 3 + 2] = (k + a * d[2]) / N; o++;
    }
  }
  const tcase = (cm, t) => { const c = TETS[t]; return (cm >> c[0] & 1) | (cm >> c[1] & 1) << 1 | (cm >> c[2] & 1) << 2 | (cm >> c[3] & 1) << 3; };
  let nT = 0;
  for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const cm = cornerMask(f, i, j, k, m); if (cm === 0 || cm === 255) continue;
    for (let t = 0; t < 6; t++) nT += TRI_COUNT[tcase(cm, t)];
  }
  const idx = new Uint32Array(nT * 3); let o = 0;
  for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const cm = cornerMask(f, i, j, k, m); if (cm === 0 || cm === 255) continue;
    for (let t = 0; t < 6; t++) {
      const cs = tcase(cm, t), n = TRI_COUNT[cs];
      for (let q = 0; q < n * 3; q++) {
        const code = EDGE_CODE[(t * 16 + cs) * 6 + q], A = CORNER_OFF[code & 7], type = code >> 3;
        const pid = (i + A[0]) + m * ((j + A[1]) + m * (k + A[2]));
        idx[o++] = vstart[pid] + POPCOUNT7[masks[pid] & ((1 << type) - 1)];
      }
    }
  }
  return { positions: pos, indices: idx, nV, nT, N };
}

export function meshCpu(N, kind, cells, thick) { return meshField(buildField(N, kind, cells, thick), N); }
