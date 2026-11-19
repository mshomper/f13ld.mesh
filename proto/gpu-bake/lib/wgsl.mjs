// proto/gpu-bake/lib/wgsl.mjs -- WGSL compute kernels (float32) and the WebGPU runner.
// One thread per grid point of the exporter's grid (main lattice first, then the offset lattice,
// the order of grid.mjs). The kernel writes one f32 per point: the field in Manifold's convention
// (-sdf, positive inside). The operation order is the same as lib/emu.mjs and the real CPU code.
//
// Bindings: 0 meta (u32), 1 coords (f32: the exporter's float64 axis coordinates rounded once to
// float32), 2 prm (f32 kernel parameters from params.mjs, all random / global numbers computed on
// the CPU), 3 out (f32).

const WGSL_PRELUDE = /* wgsl */ `
@group(0) @binding(0) var<storage, read> meta: array<u32>;
@group(0) @binding(1) var<storage, read> coords: array<f32>;
@group(0) @binding(2) var<storage, read> prm: array<f32>;
@group(0) @binding(3) var<storage, read_write> outv: array<f32>;

const TWO_PI: f32 = 6.28318530717958647692;
const INV_TWO_PI: f32 = 0.15915494309189533577;

// range reduction into [-pi, pi] (the range WGSL's sin / cos accuracy is specified for)
fn red(a: f32) -> f32 {
  let n = round(a * INV_TWO_PI);
  return a - TWO_PI * n;
}
`;

const WGSL_MAIN = /* wgsl */ `
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x + gid.y * meta[8];
  if (t >= meta[7]) { return; }
  var px: f32; var py: f32; var pz: f32;
  if (t < meta[6]) {
    let nx = meta[0]; let ny = meta[1];
    let i = t % nx; let j = (t / nx) % ny; let k = t / (nx * ny);
    px = coords[meta[9] + i]; py = coords[meta[10] + j]; pz = coords[meta[11] + k];
  } else {
    let u = t - meta[6];
    let nx = meta[3]; let ny = meta[4];
    let i = u % nx; let j = (u / nx) % ny; let k = u / (nx * ny);
    px = coords[meta[12] + i]; py = coords[meta[13] + j]; pz = coords[meta[14] + k];
  }
  outv[t] = field(px, py, pz);
}
`;

// (a) TPMS term-list sheet / solid (gyroid): phi = sum of coef * trig * trig, then -(|phi - offset| - wall).
export const WGSL_TPMS = WGSL_PRELUDE + /* wgsl */ `
fn phi(x: f32, y: f32, z: f32) -> f32 {
  let nt = u32(prm[6]);
  let reduce = prm[7] > 0.5;
  var s: f32 = 0.0;
  for (var t = 0u; t < nt; t = t + 1u) {
    let b = 8u + 16u * t;
    var prod: f32 = prm[b];
    let hasShift = prm[b + 1u] > 0.5;
    let nf = u32(prm[b + 5u]);
    for (var j = 0u; j < nf; j = j + 1u) {
      let kind = u32(prm[b + 6u + 3u * j]);
      let axis = u32(prm[b + 7u + 3u * j]);
      let freq = prm[b + 8u + 3u * j];
      var tr: f32 = 1.0;
      if (kind < 2u) {
        var arg: f32 = 0.0;
        if (axis < 3u) {
          var c = x;
          if (axis == 1u) { c = y; } else if (axis == 2u) { c = z; }
          if (hasShift) { c = c + prm[b + 2u + axis]; }
          arg = c * freq;
        }
        if (reduce) { arg = red(arg); }
        if (kind == 0u) { tr = sin(arg); } else { tr = cos(arg); }
      }
      prod = prod * tr;
    }
    s = s + prod;
  }
  return s;
}
fn field(px: f32, py: f32, pz: f32) -> f32 {
  let x = px * prm[0]; let y = py * prm[1]; let z = pz * prm[2];
  let d = phi(x, y, z) - prm[3];
  var sdf: f32;
  if (prm[5] > 0.5) { sdf = d; } else { sdf = abs(d) - prm[4]; }
  return -sdf;
}
` + WGSL_MAIN;

// (b) Grain spinodoid: raw = sum cos(k . x + phase) / sqrt(N) with the CPU-generated wave vectors,
// norm = (raw - mid) / halfR with mid / halfR from the CPU, then the topology.
export const WGSL_GRAIN = WGSL_PRELUDE + /* wgsl */ `
fn field(px: f32, py: f32, pz: f32) -> f32 {
  let PI5 = prm[0];
  let x = px * PI5; let y = py * PI5; let z = pz * PI5;
  let n = u32(prm[7]);
  let reduce = prm[9] > 0.5;
  var s: f32 = 0.0;
  for (var i = 0u; i < n; i = i + 1u) {
    let o = 16u + 4u * i;
    var a: f32 = prm[o] * x + prm[o + 1u] * y + prm[o + 2u] * z + prm[o + 3u];
    if (reduce) { a = red(a); }
    s = s + cos(a);
  }
  let raw = s / prm[8];
  let norm = (raw - prm[1]) / prm[2];
  let topo = prm[5];
  var sdf: f32;
  if (topo > 0.5 && topo < 1.5) {
    if (prm[6] > 0.5) { sdf = norm - prm[3]; } else { sdf = prm[3] - norm; }
  } else if (topo > 1.5) {
    sdf = prm[4] - abs(norm - prm[3]);
  } else {
    sdf = abs(norm - prm[3]) - prm[4];
  }
  return -sdf;
}
` + WGSL_MAIN;

function wgslFor(kind) { return kind === 'tpms' ? WGSL_TPMS : WGSL_GRAIN; }

const GPU_USAGE = { STORAGE: 0x80, COPY_SRC: 0x04, COPY_DST: 0x08, MAP_READ: 0x01, QUERY_RESOLVE: 0x200 };

// Adapter, device and the baker. create() throws an Error with .noGpu = true when WebGPU is
// missing; main.mjs then shows the plain "WebGPU not available" message.
export class GpuBaker {
  constructor(device, adapter, info, log) {
    this.device = device; this.adapter = adapter; this.info = info || {}; this.log = log;
    this.limits = device.limits; this.hasTS = device.features.has('timestamp-query');
    this.pipes = {};
  }
  static async create(log) {
    const noGpu = msg => Object.assign(new Error(msg), { noGpu: true });
    if (typeof navigator === 'undefined' || !navigator.gpu) throw noGpu('navigator.gpu is missing');
    let adapter;
    try { adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch (e) { throw noGpu('requestAdapter failed: ' + e.message); }
    if (!adapter) {   // no hardware adapter: try the browser's software (fallback) adapter, marked as such in the log
      try { adapter = await navigator.gpu.requestAdapter({ forceFallbackAdapter: true }); } catch (_) { adapter = null; }
      if (adapter) log('no hardware WebGPU adapter; using the browser software (fallback) adapter. Timings from it mean nothing.', 'warn');
    }
    if (!adapter) throw noGpu('no WebGPU adapter was found');
    const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
    const L = adapter.limits;
    const requiredFeatures = adapter.features.has('timestamp-query') ? ['timestamp-query'] : [];
    let device;
    try {
      device = await adapter.requestDevice({ requiredFeatures, requiredLimits: { maxStorageBufferBindingSize: L.maxStorageBufferBindingSize, maxBufferSize: L.maxBufferSize } });
    } catch (e) { throw noGpu('requestDevice failed: ' + e.message); }
    device.lost.then(l => log('DEVICE LOST: ' + l.reason + ' ' + l.message, 'err'));
    device.addEventListener('uncapturederror', e => log('UNCAPTURED GPU ERROR: ' + e.error.message, 'err'));
    return new GpuBaker(device, adapter, info, log);
  }
  maxPoints() { return Math.floor(Math.min(this.limits.maxStorageBufferBindingSize, this.limits.maxBufferSize) / 4); }
  describe() {
    const i = this.info, L = this.limits;
    return [
      `adapter: ${i.vendor || '?'} / ${i.architecture || '?'} / ${i.device || '?'} / ${i.description || '?'}` + (this.adapter.isFallbackAdapter ? ' (fallback / software adapter)' : ''),
      `timestamp-query: ${this.hasTS ? 'yes' : 'no'}`,
      `limits: maxStorageBufferBindingSize=${L.maxStorageBufferBindingSize} maxBufferSize=${L.maxBufferSize} maxStorageBuffersPerShaderStage=${L.maxStorageBuffersPerShaderStage} maxComputeWorkgroupsPerDimension=${L.maxComputeWorkgroupsPerDimension} maxComputeInvocationsPerWorkgroup=${L.maxComputeInvocationsPerWorkgroup}`,
    ];
  }
  async pipeline(kind) {
    if (this.pipes[kind]) return this.pipes[kind];
    const d = this.device;
    d.pushErrorScope('validation');
    const module = d.createShaderModule({ code: wgslFor(kind) });
    const info = await module.getCompilationInfo();
    for (const m of info.messages) this.log(`WGSL ${kind} ${m.type} line ${m.lineNum}: ${m.message}`, m.type === 'error' ? 'err' : 'warn');
    const pl = d.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const err = await d.popErrorScope();
    if (err) throw new Error(`shader / pipeline error (${kind}): ${err.message}`);
    this.pipes[kind] = pl;
    return pl;
  }
  // Bake the grid. params: params.mjs object; g: grid; tables: {flat, start}.
  // Returns { values: Float32Array (all points), wallMs (submit to data in JS, incl. readback), gpuMs (timestamps or null) }.
  async bake(params, g, tables) {
    const d = this.device, total = g.mainCount + g.offCount, bytes = total * 4;
    if (bytes > Math.min(this.limits.maxStorageBufferBindingSize, this.limits.maxBufferSize)) throw Object.assign(new Error(`grid needs ${bytes} bytes, adapter limit is ${Math.min(this.limits.maxStorageBufferBindingSize, this.limits.maxBufferSize)}`), { tooBig: true });
    const pl = await this.pipeline(params.kind);
    const n = g.n, nx1 = n[0] + 1, ny1 = n[1] + 1, nz1 = n[2] + 1, nx2 = n[0] + 2, ny2 = n[1] + 2, nz2 = n[2] + 2;
    const groups = Math.ceil(total / 256), maxDim = this.limits.maxComputeWorkgroupsPerDimension;
    const dx = Math.min(groups, maxDim), dy = Math.ceil(groups / dx);
    if (dy > maxDim) throw Object.assign(new Error('too many workgroups for this adapter'), { tooBig: true });
    const st = tables.start;
    const meta = new Uint32Array([nx1, ny1, nz1, nx2, ny2, nz2, g.mainCount, total, dx * 256, st[0], st[1], st[2], st[3], st[4], st[5], 0]);
    const mk = (arr, usage) => { const b = d.createBuffer({ size: Math.max(16, arr.byteLength + 3 & ~3), usage: usage | GPU_USAGE.COPY_DST }); d.queue.writeBuffer(b, 0, arr); return b; };
    const bMeta = mk(meta, GPU_USAGE.STORAGE), bCoords = mk(tables.flat, GPU_USAGE.STORAGE), bPrm = mk(params.f32, GPU_USAGE.STORAGE);
    const bOut = d.createBuffer({ size: bytes, usage: GPU_USAGE.STORAGE | GPU_USAGE.COPY_SRC });
    const bRead = d.createBuffer({ size: bytes, usage: GPU_USAGE.MAP_READ | GPU_USAGE.COPY_DST });
    const bind = d.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: [bMeta, bCoords, bPrm, bOut].map((b, i) => ({ binding: i, resource: { buffer: b } })) });
    let qs = null, qResolve = null, qRead = null;
    if (this.hasTS) {
      qs = d.createQuerySet({ type: 'timestamp', count: 2 });
      qResolve = d.createBuffer({ size: 16, usage: GPU_USAGE.QUERY_RESOLVE | GPU_USAGE.COPY_SRC });
      qRead = d.createBuffer({ size: 16, usage: GPU_USAGE.MAP_READ | GPU_USAGE.COPY_DST });
    }
    d.pushErrorScope('validation');
    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass(qs ? { timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {});
    pass.setPipeline(pl); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(dx, dy, 1); pass.end();
    enc.copyBufferToBuffer(bOut, 0, bRead, 0, bytes);
    if (qs) { enc.resolveQuerySet(qs, 0, 2, qResolve, 0); enc.copyBufferToBuffer(qResolve, 0, qRead, 0, 16); }
    const t0 = performance.now();
    d.queue.submit([enc.finish()]);
    await bRead.mapAsync(1);
    const values = new Float32Array(bRead.getMappedRange().slice(0));
    const wallMs = performance.now() - t0;
    bRead.unmap();
    const err = await d.popErrorScope();
    if (err) throw new Error('GPU validation error: ' + err.message);
    let gpuMs = null;
    if (qs) {
      await qRead.mapAsync(1);
      const ts = new BigInt64Array(qRead.getMappedRange().slice(0)); qRead.unmap();
      gpuMs = Number(ts[1] - ts[0]) / 1e6;
      qs.destroy(); qResolve.destroy(); qRead.destroy();
    }
    for (const b of [bMeta, bCoords, bPrm, bOut, bRead]) b.destroy();
    return { values, wallMs, gpuMs };
  }
}
