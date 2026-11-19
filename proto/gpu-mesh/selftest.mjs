// Run from the worktree root: node proto/gpu-mesh/selftest.mjs [--break]
import { TETS, TET_SIGN, TRI_COUNT, KINDS, CORNER_OFF, wgslTables } from './tables.mjs';
import { meshCpu } from './cpu-mesher.mjs';
import { closedCheck, signedVolume, zeroAreaCount, nonManifoldVertexCount } from './meshcheck.mjs';

const BREAK = process.argv.includes('--break');
let fail = false;
const bad = (msg) => { fail = true; console.log('FAIL ' + msg); };

// table sanity: six tets fill the cube
let vol = 0;
for (let t = 0; t < 6; t++) {
  const P = TETS[t].map(c => CORNER_OFF[c]);
  const u = [1, 2, 3].map(q => P[q].map((v, a) => v - P[0][a]));
  vol += Math.abs(u[0][0] * (u[1][1] * u[2][2] - u[1][2] * u[2][1]) - u[0][1] * (u[1][0] * u[2][2] - u[1][2] * u[2][0]) + u[0][2] * (u[1][0] * u[2][1] - u[1][1] * u[2][0])) / 6;
}
console.log(`tables: 6 tets, volume sum ${vol.toFixed(6)} (want 1), tri counts per case ${Array.from(TRI_COUNT).join('')}, tet handedness ${TET_SIGN.join(',')}`);
if (Math.abs(vol - 1) > 1e-12) bad('tet volumes do not sum to 1');

// generated WGSL text: every declaration on its own line, every table name declared outside a comment, sizes match
{
  const lines = wgslTables().split('\n').filter(l => l.trim() !== '');
  const want = { CORNER_OFF: 24, EDGE_DIR: 21, TET_CORNER: 24, TRI_COUNT: 16, EDGE_CODE: 576 };
  const seen = new Set(); let ok = true;
  for (const l of lines) {
    if (l.startsWith('//')) { if (/\bconst\b/.test(l)) { ok = false; bad('WGSL tables: declaration inside a comment line: ' + l.slice(0, 60)); } continue; }
    const m = /^const (\w+): (array<u32, (\d+)>|f32) = (.*);$/.exec(l);
    if (!m || (l.match(/\bconst\b/g) || []).length !== 1) { ok = false; bad('WGSL tables: line is not exactly one declaration: ' + l.slice(0, 60)); continue; }
    seen.add(m[1]);
    if (m[3] !== undefined) {
      const n = m[4].replace(/^array<u32, \d+>\(/, '').replace(/\)$/, '').split(',').length;
      if (n !== +m[3] || want[m[1]] !== n) { ok = false; bad(`WGSL tables: ${m[1]} has ${n} entries, declared ${m[3]}, expected ${want[m[1]]}`); }
    }
  }
  for (const k of [...Object.keys(want), 'CROSS_EPS']) if (!seen.has(k)) { ok = false; bad('WGSL tables: ' + k + ' not declared outside a comment'); }
  console.log(`wgslTables(): ${lines.length} lines, declarations ${[...seen].join(', ')}: ${ok ? 'ok' : 'PROBLEM'}`);
}

const cases = [
  ['gyroid', KINDS.gyroid, 2, 0.4, 32], ['gyroid', KINDS.gyroid, 2, 0.4, 64],
  ['schwarzP', KINDS.schwarzP, 2, 0.6, 32], ['schwarzP', KINDS.schwarzP, 2, 0.6, 64],
  ['diamond', KINDS.diamond, 2, 0.3, 64],
  ['sphere r=0.35', KINDS.sphere, 1, 0.35, 32], ['sphere r=0.35', KINDS.sphere, 1, 0.35, 64],
];
for (const [name, kind, cells, thick, N] of cases) {
  const t0 = Date.now();
  const m = meshCpu(N, kind, cells, thick);
  let idx = m.indices;
  if (BREAK) idx = idx.slice(0, idx.length - 3); // drop one triangle
  const c = closedCheck(idx, m.nV);
  const v = signedVolume(m.positions, idx);
  const z = zeroAreaCount(m.positions, idx, 1 / N);
  console.log(`${name} N=${N}: tris=${idx.length / 3} verts=${m.nV} OPEN_EDGES=${c.openEdges} nonmanifold=${c.nonManifold} orientBad=${c.badOrient} closed=${c.closed} volume=${v.toFixed(6)} zeroArea=${z} nonManifoldVerts=${nonManifoldVertexCount(idx, m.nV)} (${Date.now() - t0} ms)`);
  if (!(idx.length > 0)) bad(`${name} N=${N}: no triangles`);
  if (!c.closed) bad(`${name} N=${N}: not closed (OPEN_EDGES=${c.openEdges}, nonmanifold=${c.nonManifold}, orientBad=${c.badOrient})`);
  if (!(v > 0)) bad(`${name} N=${N}: signed volume not positive`);
  if (kind === KINDS.sphere && N === 64) {
    const exact = 4 / 3 * Math.PI * thick ** 3, err = (v - exact) / exact;
    console.log(`  sphere volume ${v.toFixed(6)} vs exact ${exact.toFixed(6)}: error ${(err * 100).toFixed(3)} %`);
    if (Math.abs(err) > 0.01) bad('sphere volume off by more than 1 %');
  }
}
console.log(fail ? 'SELFTEST FAIL' : 'SELFTEST PASS');
process.exit(fail ? 1 : 0);
