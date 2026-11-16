// WebGPU marching-tetrahedra mesher. WRITTEN BUT NOT EXECUTED by the expedition (no GPU there): expect to fix
// small things on first run. All constant tables come from tables.mjs through wgslTables().
//
// Pipeline (every phase is its own submit so each can be timed):
//   field   : (N+1)^3 f32 field into a storage buffer, outer layer forced to -1 (closed part)
//   count   : per grid POINT: mask of crossed owned edges (7 bits) + its popcount; per CELL: triangle count
//   scan    : multi-level work-efficient (Blelloch) exclusive scan of both count buffers, in place; the top
//             level's single sum is the total, copied to the CPU to size the output buffers
//   emit    : one vertex per crossed owned edge (index = vertex scan + rank inside the owner's mask),
//             indexed triangles (neighbour-owned edge indices found through the same scan + mask)
import { wgslTables, KINDS } from './tables.mjs';

const MAXX = 16384; // workgroups per dispatch x; the rest goes to y, so N=256 stays under 65535 per dimension
function dims(wgCount) { const w = Math.max(1, wgCount), x = Math.min(w, MAXX), y = Math.ceil(w / x); return { x, y }; }
const U = GPUBufferUsage;

const PRELUDE = () => `
struct P { n: u32, kind: u32, nx: u32, count: u32, cells: f32, thick: f32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<uniform> p: P;
${wgslTables()}
fn lin(wid: vec3<u32>, li: u32) -> u32 { return (wid.y * p.nx + wid.x) * 64u + li; }
`;

const SRC = {
  field: () => PRELUDE() + `
@group(0) @binding(1) var<storage, read_write> field: array<f32>;
const TAU: f32 = 6.283185307179586;
fn fieldAt(u: vec3<f32>) -> f32 {
  if (p.kind == 3u) { return p.thick - length(u - vec3<f32>(0.5, 0.5, 0.5)); }
  let q = u * (TAU * p.cells);
  let s = sin(q);
  let c = cos(q);
  var g: f32;
  if (p.kind == 0u) { g = s.x * c.y + s.y * c.z + s.z * c.x; }
  else if (p.kind == 1u) { g = c.x + c.y + c.z; }
  else { g = s.x * s.y * s.z + s.x * c.y * c.z + c.x * s.y * c.z + c.x * c.y * s.z; }
  return p.thick - abs(g);
}
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let id = lin(wid, li);
  if (id >= p.count) { return; }
  let m = p.n + 1u;
  let i = id % m;
  let j = (id / m) % m;
  let k = id / (m * m);
  var v: f32 = -1.0;
  if (i != 0u && j != 0u && k != 0u && i != p.n && j != p.n && k != p.n) {
    v = fieldAt(vec3<f32>(f32(i), f32(j), f32(k)) / f32(p.n));
  }
  field[id] = v;
}`,

  countVerts: () => PRELUDE() + `
@group(0) @binding(1) var<storage, read> field: array<f32>;
@group(0) @binding(2) var<storage, read_write> masks: array<u32>;
@group(0) @binding(3) var<storage, read_write> vcount: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let id = lin(wid, li);
  if (id >= p.count) { return; }
  let m = p.n + 1u;
  let i = id % m;
  let j = (id / m) % m;
  let k = id / (m * m);
  let f0 = field[id];
  var mask = 0u;
  for (var t = 0u; t < 7u; t = t + 1u) {
    let ii = i + EDGE_DIR[t * 3u];
    let jj = j + EDGE_DIR[t * 3u + 1u];
    let kk = k + EDGE_DIR[t * 3u + 2u];
    if (ii > p.n || jj > p.n || kk > p.n) { continue; }
    let f1 = field[ii + m * (jj + m * kk)];
    if ((f0 > 0.0) != (f1 > 0.0)) { mask = mask | (1u << t); }
  }
  masks[id] = mask;
  vcount[id] = countOneBits(mask);
}`,

  cellCommon: `
fn cornerMask(i: u32, j: u32, k: u32) -> u32 {
  let m = p.n + 1u;
  var cm = 0u;
  for (var c = 0u; c < 8u; c = c + 1u) {
    let ii = i + CORNER_OFF[c * 3u];
    let jj = j + CORNER_OFF[c * 3u + 1u];
    let kk = k + CORNER_OFF[c * 3u + 2u];
    if (field[ii + m * (jj + m * kk)] > 0.0) { cm = cm | (1u << c); }
  }
  return cm;
}
fn tetCase(cm: u32, t: u32) -> u32 {
  var cs = 0u;
  for (var v = 0u; v < 4u; v = v + 1u) { cs = cs | (((cm >> TET_CORNER[t * 4u + v]) & 1u) << v); }
  return cs;
}`,

  countTris() { return PRELUDE() + `
@group(0) @binding(1) var<storage, read> field: array<f32>;
@group(0) @binding(2) var<storage, read_write> tcount: array<u32>;
` + this.cellCommon + `
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let id = lin(wid, li);
  if (id >= p.count) { return; }
  let n = p.n;
  let i = id % n;
  let j = (id / n) % n;
  let k = id / (n * n);
  let cm = cornerMask(i, j, k);
  var cnt = 0u;
  if (cm != 0u && cm != 255u) {
    for (var t = 0u; t < 6u; t = t + 1u) { cnt = cnt + TRI_COUNT[tetCase(cm, t)]; }
  }
  tcount[id] = cnt;
}`; },

  emitVerts: () => PRELUDE() + `
@group(0) @binding(1) var<storage, read> field: array<f32>;
@group(0) @binding(2) var<storage, read> masks: array<u32>;
@group(0) @binding(3) var<storage, read> vstart: array<u32>;
@group(0) @binding(4) var<storage, read_write> verts: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let id = lin(wid, li);
  if (id >= p.count) { return; }
  let mask = masks[id];
  if (mask == 0u) { return; }
  let m = p.n + 1u;
  let i = id % m;
  let j = (id / m) % m;
  let k = id / (m * m);
  let f0 = field[id];
  let fn_ = f32(p.n);
  var o = vstart[id];
  for (var t = 0u; t < 7u; t = t + 1u) {
    if (((mask >> t) & 1u) == 0u) { continue; }
    let dx = EDGE_DIR[t * 3u];
    let dy = EDGE_DIR[t * 3u + 1u];
    let dz = EDGE_DIR[t * 3u + 2u];
    let f1 = field[(i + dx) + m * ((j + dy) + m * (k + dz))];
    let a = clamp(f0 / (f0 - f1), CROSS_EPS, 1.0 - CROSS_EPS);
    verts[o * 3u] = (f32(i) + a * f32(dx)) / fn_;
    verts[o * 3u + 1u] = (f32(j) + a * f32(dy)) / fn_;
    verts[o * 3u + 2u] = (f32(k) + a * f32(dz)) / fn_;
    o = o + 1u;
  }
}`,

  emitTris() { return PRELUDE() + `
@group(0) @binding(1) var<storage, read> field: array<f32>;
@group(0) @binding(2) var<storage, read> masks: array<u32>;
@group(0) @binding(3) var<storage, read> vstart: array<u32>;
@group(0) @binding(4) var<storage, read> tstart: array<u32>;
@group(0) @binding(5) var<storage, read_write> idx: array<u32>;
` + this.cellCommon + `
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let id = lin(wid, li);
  if (id >= p.count) { return; }
  let n = p.n;
  let m = n + 1u;
  let i = id % n;
  let j = (id / n) % n;
  let k = id / (n * n);
  let cm = cornerMask(i, j, k);
  if (cm == 0u || cm == 255u) { return; }
  var o = tstart[id] * 3u;
  for (var t = 0u; t < 6u; t = t + 1u) {
    let cs = tetCase(cm, t);
    let nt = TRI_COUNT[cs];
    let base = (t * 16u + cs) * 6u;
    for (var q = 0u; q < nt * 3u; q = q + 1u) {
      let code = EDGE_CODE[base + q];
      let a = code & 7u;
      let ty = code >> 3u;
      let pid = (i + CORNER_OFF[a * 3u]) + m * ((j + CORNER_OFF[a * 3u + 1u]) + m * (k + CORNER_OFF[a * 3u + 2u]));
      idx[o] = vstart[pid] + countOneBits(masks[pid] & ((1u << ty) - 1u));
      o = o + 1u;
    }
  }
}`; },

  scanHead: `
struct S { n: u32, nx: u32, nb: u32, pad: u32 }
@group(0) @binding(0) var<uniform> s: S;
`,
  scan: () => SRC.scanHead + `
@group(0) @binding(1) var<storage, read_write> data: array<u32>;
@group(0) @binding(2) var<storage, read_write> sums: array<u32>;
var<workgroup> tmp: array<u32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let wg = wid.y * s.nx + wid.x;
  if (wg >= s.nb) { return; }
  let gi = wg * 256u + li;
  var v = 0u;
  if (gi < s.n) { v = data[gi]; }
  tmp[li] = v;
  workgroupBarrier();
  var off = 1u;
  for (var d = 128u; d > 0u; d = d >> 1u) {
    if (li < d) {
      let ai = off * (2u * li + 1u) - 1u;
      let bi = off * (2u * li + 2u) - 1u;
      tmp[bi] = tmp[bi] + tmp[ai];
    }
    workgroupBarrier();
    off = off << 1u;
  }
  if (li == 0u) { sums[wg] = tmp[255]; tmp[255] = 0u; }
  workgroupBarrier();
  for (var d = 1u; d < 256u; d = d << 1u) {
    off = off >> 1u;
    if (li < d) {
      let ai = off * (2u * li + 1u) - 1u;
      let bi = off * (2u * li + 2u) - 1u;
      let t = tmp[ai];
      tmp[ai] = tmp[bi];
      tmp[bi] = tmp[bi] + t;
    }
    workgroupBarrier();
  }
  if (gi < s.n) { data[gi] = tmp[li]; }
}`,
  add: () => SRC.scanHead + `
@group(0) @binding(1) var<storage, read_write> data: array<u32>;
@group(0) @binding(2) var<storage, read> sums: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let wg = wid.y * s.nx + wid.x;
  if (wg >= s.nb) { return; }
  let gi = wg * 256u + li;
  if (gi < s.n) { data[gi] = data[gi] + sums[wg]; }
}`,
};

const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

export class GpuMesher {
  constructor(device, adapter, info, log) {
    this.device = device; this.adapter = adapter; this.info = info; this.log = log;
    this.limits = device.limits; this.hasTS = device.features.has('timestamp-query');
    this.res = null; this.out = null; this.pl = {};
  }

  static async create(log) {
    if (!navigator.gpu) throw new Error('navigator.gpu is missing');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('no WebGPU adapter');
    const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
    const L = adapter.limits;
    const requiredFeatures = adapter.features.has('timestamp-query') ? ['timestamp-query'] : [];
    const device = await adapter.requestDevice({
      requiredFeatures,
      requiredLimits: { maxStorageBufferBindingSize: L.maxStorageBufferBindingSize, maxBufferSize: L.maxBufferSize },
    });
    device.lost.then(l => log('DEVICE LOST: ' + l.reason + ' ' + l.message, 'err'));
    device.addEventListener('uncapturederror', e => log('UNCAPTURED GPU ERROR: ' + e.error.message, 'err'));
    const g = new GpuMesher(device, adapter, info, log);
    await g.buildPipelines();
    return g;
  }

  async module(label, code) {
    const mod = this.device.createShaderModule({ label, code });
    const ci = await mod.getCompilationInfo();
    let errs = 0;
    for (const m of ci.messages) {
      if (m.type === 'error') errs++;
      this.log(`shader ${label} ${m.type} line ${m.lineNum}:${m.linePos}: ${m.message}`, m.type === 'error' ? 'err' : 'warn');
    }
    if (errs) throw new Error(`shader ${label} failed to compile (${errs} errors, listed above)`);
    this.log(`shader ${label}: compiled, ${ci.messages.length} messages`);
    return mod;
  }

  async pipeline(label, code) {
    const mod = await this.module(label, code);
    this.device.pushErrorScope('validation');
    const pl = this.device.createComputePipeline({ label, layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
    const err = await this.device.popErrorScope();
    if (err) throw new Error(`pipeline ${label}: ${err.message}`);
    return pl;
  }

  async buildPipelines() {
    const d = this.device;
    this.pl.field = await this.pipeline('field', SRC.field());
    this.pl.countVerts = await this.pipeline('countVerts', SRC.countVerts());
    this.pl.countTris = await this.pipeline('countTris', SRC.countTris());
    this.pl.scan = await this.pipeline('scan', SRC.scan());
    this.pl.add = await this.pipeline('add', SRC.add());
    this.pl.emitVerts = await this.pipeline('emitVerts', SRC.emitVerts());
    this.pl.emitTris = await this.pipeline('emitTris', SRC.emitTris());
    if (this.hasTS) {
      this.qs = d.createQuerySet({ type: 'timestamp', count: 8 });
      this.qResolve = d.createBuffer({ size: 64, usage: U.QUERY_RESOLVE | U.COPY_SRC });
      this.qRead = d.createBuffer({ size: 64, usage: U.MAP_READ | U.COPY_DST });
    }
    this.totalsRead = d.createBuffer({ size: 8, usage: U.MAP_READ | U.COPY_DST });
  }

  buf(size, usage, label) { return this.device.createBuffer({ size: Math.max(4, Math.ceil(size / 4) * 4), usage, label }); }

  // Buffers that depend only on N.
  ensure(N) {
    if (this.res && this.res.N === N) return this.res;
    if (this.res) for (const b of this.res.all) b.destroy();
    const d = this.device, np = (N + 1) ** 3, nc = N ** 3, SB = U.STORAGE | U.COPY_SRC | U.COPY_DST;
    const all = [];
    const mk = (size, usage, label) => { const b = this.buf(size, usage, label); all.push(b); return b; };
    const r = { N, np, nc, all };
    r.field = mk(np * 4, SB, 'field'); r.masks = mk(np * 4, SB, 'masks');
    r.vcount = mk(np * 4, SB, 'vcount'); r.tcount = mk(nc * 4, SB, 'tcount');
    r.uPoints = mk(32, U.UNIFORM | U.COPY_DST, 'uPoints'); r.uCells = mk(32, U.UNIFORM | U.COPY_DST, 'uCells');
    const levels = (data, n, tag) => {
      const out = []; let cur = data, cn = n;
      for (;;) {
        const nb = Math.ceil(cn / 256), sums = mk(nb * 4, SB, `${tag}Sums${out.length}`);
        const u = mk(16, U.UNIFORM | U.COPY_DST, `${tag}ScanU${out.length}`);
        const dm = dims(nb);
        this.device.queue.writeBuffer(u, 0, new Uint32Array([cn, dm.x, nb, 0]));
        out.push({ data: cur, n: cn, nb, sums, u, dm });
        if (nb === 1) break;
        cur = sums; cn = nb;
      }
      return out;
    };
    r.vLevels = levels(r.vcount, np, 'v'); r.tLevels = levels(r.tcount, nc, 't');
    const bg = (pl, entries) => d.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: entries.map((buffer, binding) => ({ binding, resource: { buffer } })) });
    r.bgField = bg(this.pl.field, [r.uPoints, r.field]);
    r.bgCountV = bg(this.pl.countVerts, [r.uPoints, r.field, r.masks, r.vcount]);
    r.bgCountT = bg(this.pl.countTris, [r.uCells, r.field, r.tcount]);
    const scanBGs = ls => ls.map(l => ({ scan: bg(this.pl.scan, [l.u, l.data, l.sums]), add: bg(this.pl.add, [l.u, l.data, l.sums]) }));
    r.vBG = scanBGs(r.vLevels); r.tBG = scanBGs(r.tLevels);
    this.res = r;
    return r;
  }

  setParams(N, kind, cells, thick) {
    const r = this.res, w = (count) => {
      const dm = dims(Math.ceil(count / 64)), ab = new ArrayBuffer(32), dv = new DataView(ab);
      dv.setUint32(0, N, true); dv.setUint32(4, kind, true); dv.setUint32(8, dm.x, true); dv.setUint32(12, count, true);
      dv.setFloat32(16, cells, true); dv.setFloat32(20, thick, true);
      return { ab, dm };
    };
    const a = w(r.np), b = w(r.nc);
    this.device.queue.writeBuffer(r.uPoints, 0, a.ab); this.device.queue.writeBuffer(r.uCells, 0, b.ab);
    return { dmP: a.dm, dmC: b.dm };
  }

  // Run the whole pipeline. Returns { N, nV, nT, verts, idx, times }.
  async mesh(N, kind, cells, thick) {
    const d = this.device, L = this.limits, maxB = Math.min(L.maxStorageBufferBindingSize, L.maxBufferSize);
    if ((N + 1) ** 3 * 4 > maxB) throw new Error(`skipped: buffer limits (field needs ${(N + 1) ** 3 * 4} bytes, limit ${maxB})`);
    d.pushErrorScope('validation'); d.pushErrorScope('out-of-memory');
    const times = {};
    let r, dm;
    const run = async (name, encode, qi, after) => {
      const enc = d.createCommandEncoder();
      const pass = enc.beginComputePass(this.hasTS ? { timestampWrites: { querySet: this.qs, beginningOfPassWriteIndex: qi * 2, endOfPassWriteIndex: qi * 2 + 1 } } : {});
      encode(pass); pass.end(); if (after) after(enc);
      const t0 = performance.now(); d.queue.submit([enc.finish()]); await d.queue.onSubmittedWorkDone();
      times[name] = performance.now() - t0;
    };
    let result;
    try {
      r = this.ensure(N); dm = this.setParams(N, kind, cells, thick);
      await run('field', p => { p.setPipeline(this.pl.field); p.setBindGroup(0, r.bgField); p.dispatchWorkgroups(dm.dmP.x, dm.dmP.y); }, 0);
      await run('count', p => {
        p.setPipeline(this.pl.countVerts); p.setBindGroup(0, r.bgCountV); p.dispatchWorkgroups(dm.dmP.x, dm.dmP.y);
        p.setPipeline(this.pl.countTris); p.setBindGroup(0, r.bgCountT); p.dispatchWorkgroups(dm.dmC.x, dm.dmC.y);
      }, 1);
      const scanLevels = (p, ls, bgs) => {
        for (let l = 0; l < ls.length; l++) { p.setPipeline(this.pl.scan); p.setBindGroup(0, bgs[l].scan); p.dispatchWorkgroups(ls[l].dm.x, ls[l].dm.y); }
        for (let l = ls.length - 2; l >= 0; l--) { p.setPipeline(this.pl.add); p.setBindGroup(0, bgs[l].add); p.dispatchWorkgroups(ls[l].dm.x, ls[l].dm.y); }
      };
      const vTop = r.vLevels[r.vLevels.length - 1].sums, tTop = r.tLevels[r.tLevels.length - 1].sums;
      // Each scan level is its own dispatch inside one pass; storage writes between dispatches are ordered by WebGPU.
      await run('scan', p => { scanLevels(p, r.vLevels, r.vBG); scanLevels(p, r.tLevels, r.tBG); }, 2,
        enc => { enc.copyBufferToBuffer(vTop, 0, this.totalsRead, 0, 4); enc.copyBufferToBuffer(tTop, 0, this.totalsRead, 4, 4); });
      let t0 = performance.now();
      await this.totalsRead.mapAsync(GPUMapMode.READ);
      const tot = new Uint32Array(this.totalsRead.getMappedRange().slice(0)); this.totalsRead.unmap();
      times.readback = performance.now() - t0;
      const nV = tot[0], nT = tot[1];
      if (nV === 0 || nT === 0) throw new Error(`empty mesh (verts ${nV}, tris ${nT}): check thickness / cells`);
      if (nV * 12 > maxB || nT * 12 > maxB) throw new Error(`skipped: buffer limits (output ${nV * 12} / ${nT * 12} bytes, limit ${maxB})`);
      if (this.out) { this.out.verts.destroy(); this.out.idx.destroy(); }
      const verts = this.buf(nV * 12, U.VERTEX | U.STORAGE | U.COPY_SRC, 'verts'), idx = this.buf(nT * 12, U.INDEX | U.STORAGE | U.COPY_SRC, 'idx');
      this.out = { verts, idx };
      const bg = (pl, entries) => d.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: entries.map((buffer, binding) => ({ binding, resource: { buffer } })) });
      const bgV = bg(this.pl.emitVerts, [r.uPoints, r.field, r.masks, r.vcount, verts]);
      const bgT = bg(this.pl.emitTris, [r.uCells, r.field, r.masks, r.vcount, r.tcount, idx]);
      await run('emit', p => {
        p.setPipeline(this.pl.emitVerts); p.setBindGroup(0, bgV); p.dispatchWorkgroups(dm.dmP.x, dm.dmP.y);
        p.setPipeline(this.pl.emitTris); p.setBindGroup(0, bgT); p.dispatchWorkgroups(dm.dmC.x, dm.dmC.y);
      }, 3);
      times.total = times.field + times.count + times.scan + times.readback + times.emit;
      if (this.hasTS) {
        const enc = d.createCommandEncoder();
        enc.resolveQuerySet(this.qs, 0, 8, this.qResolve, 0); enc.copyBufferToBuffer(this.qResolve, 0, this.qRead, 0, 64);
        d.queue.submit([enc.finish()]); await this.qRead.mapAsync(GPUMapMode.READ);
        const ts = new BigUint64Array(this.qRead.getMappedRange().slice(0)); this.qRead.unmap();
        const ms = i => Number(ts[i * 2 + 1] - ts[i * 2]) / 1e6;
        times.gpu = { field: ms(0), count: ms(1), scan: ms(2), emit: ms(3) };
      }
      result = { N, nV, nT, verts, idx, times, kind, cells, thick };
    } finally {
      const oom = await d.popErrorScope(), val = await d.popErrorScope();
      if (oom) this.log('GPU out-of-memory: ' + oom.message, 'err');
      if (val) this.log('GPU validation error: ' + val.message, 'err');
      if (oom || val) throw new Error('GPU error during mesh (see log)');
    }
    return result;
  }

  async readBuffer(buffer, bytes) {
    const d = this.device, st = this.buf(bytes, U.MAP_READ | U.COPY_DST, 'staging');
    const enc = d.createCommandEncoder(); enc.copyBufferToBuffer(buffer, 0, st, 0, bytes); d.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const out = st.getMappedRange().slice(0, bytes); st.unmap(); st.destroy();
    return out;
  }
  async readMesh(res) {
    const positions = new Float32Array(await this.readBuffer(res.verts, res.nV * 12));
    const indices = new Uint32Array(await this.readBuffer(res.idx, res.nT * 12));
    return { positions, indices, nV: res.nV, nT: res.nT, N: res.N };
  }

  // Bench: warm-up + repeats per N, median per phase. N=256 only when the buffers fit the adapter limits.
  async bench(sizes, kind, cells, thick, repeats) {
    const rows = [], L = this.limits, maxB = Math.min(L.maxStorageBufferBindingSize, L.maxBufferSize);
    for (const N of sizes) {
      if ((N + 1) ** 3 * 4 > maxB) { this.log(`bench N=${N}: skipped: buffer limits`, 'warn'); rows.push({ N, skipped: 'buffer limits' }); continue; }
      try {
        await this.mesh(N, kind, cells, thick); // warm-up
        const acc = { field: [], count: [], scan: [], readback: [], emit: [], total: [] }, gacc = { field: [], count: [], scan: [], emit: [] };
        let last;
        for (let i = 0; i < repeats; i++) {
          last = await this.mesh(N, kind, cells, thick);
          for (const k in acc) acc[k].push(last.times[k]);
          if (last.times.gpu) for (const k in gacc) gacc[k].push(last.times.gpu[k]);
        }
        const row = { N, nV: last.nV, nT: last.nT, wall: {}, gpu: null };
        for (const k in acc) row.wall[k] = median(acc[k]);
        if (this.hasTS) { row.gpu = {}; for (const k in gacc) row.gpu[k] = median(gacc[k]); }
        rows.push(row);
        this.log(`bench N=${N}: done`);
      } catch (e) {
        const msg = String(e.message || e); this.log(`bench N=${N}: ${msg}`, 'warn');
        rows.push({ N, skipped: msg.includes('buffer limits') ? 'buffer limits' : msg });
      }
    }
    return rows;
  }

  describe() {
    const L = this.limits, i = this.info || {};
    return [
      `adapter: ${i.vendor || '?'} / ${i.architecture || '?'} / ${i.device || '?'} / ${i.description || '?'}`,
      `user agent: ${navigator.userAgent}`,
      `timestamp-query: ${this.hasTS ? 'yes' : 'no'}`,
      `limits: maxStorageBufferBindingSize=${L.maxStorageBufferBindingSize} maxBufferSize=${L.maxBufferSize} maxStorageBuffersPerShaderStage=${L.maxStorageBuffersPerShaderStage} maxComputeWorkgroupsPerDimension=${L.maxComputeWorkgroupsPerDimension} maxComputeInvocationsPerWorkgroup=${L.maxComputeInvocationsPerWorkgroup}`,
    ].join('\n');
  }
}

export { KINDS };
