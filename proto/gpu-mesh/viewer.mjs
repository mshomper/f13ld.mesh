// WebGPU render view: orthographic camera, wheel = zoom (forward = in), right-drag = orbit,
// middle-drag or shift+right-drag = pan, left-drag does nothing, two-finger pinch = zoom. Flat shading from derivatives.
// WRITTEN BUT NOT EXECUTED by the expedition.

const SHADER = `
struct U { view: mat4x4<f32>, cam: vec4<f32> }
@group(0) @binding(0) var<uniform> u: U;
struct VO { @builtin(position) pos: vec4<f32>, @location(0) v: vec3<f32> }
@vertex fn vs(@location(0) p: vec3<f32>) -> VO {
  let v = (u.view * vec4<f32>(p - vec3<f32>(0.5, 0.5, 0.5), 1.0)).xyz;
  var o: VO;
  o.pos = vec4<f32>(v.x * u.cam.x + u.cam.z, v.y * u.cam.y + u.cam.w, 0.5 - v.z * 0.5, 1.0);
  o.v = v;
  return o;
}
@fragment fn fs(in: VO) -> @location(0) vec4<f32> {
  var n = normalize(cross(dpdx(in.v), dpdy(in.v)));
  if (n.z < 0.0) { n = -n; }
  let l = normalize(vec3<f32>(0.35, 0.55, 0.75));
  let d = max(dot(n, l), 0.0);
  let rim = pow(1.0 - clamp(n.z, 0.0, 1.0), 3.0);
  let jade = vec3<f32>(0.114, 0.620, 0.459);
  let lime = vec3<f32>(0.784, 0.961, 0.259);
  return vec4<f32>(jade * (0.22 + 0.85 * d) + lime * rim * 0.22, 1.0);
}`;

export class Viewer {
  constructor(canvas, device, log) {
    this.canvas = canvas; this.device = device; this.log = log;
    this.yaw = 0.6; this.pitch = 0.5; this.zoom = 1.1; this.pan = [0, 0];
    this.mesh = null; this.ptrs = new Map(); this.pinch = 0;
    this.ctx = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device, format: this.format, alphaMode: 'opaque' });
    this.ubuf = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.build();
    this.bind();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  async build() {
    const d = this.device;
    const mod = d.createShaderModule({ label: 'render', code: SHADER });
    const ci = await mod.getCompilationInfo();
    for (const m of ci.messages) this.log(`shader render ${m.type} line ${m.lineNum}:${m.linePos}: ${m.message}`, m.type === 'error' ? 'err' : 'warn');
    d.pushErrorScope('validation');
    this.pipe = d.createRenderPipeline({
      layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs', buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
      fragment: { module: mod, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });
    const err = await d.popErrorScope();
    if (err) this.log('render pipeline error: ' + err.message, 'err');
    this.bg = d.createBindGroup({ layout: this.pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.ubuf } }] });
    this.draw();
  }

  setMesh(verts, idx, nIdx) { this.mesh = { verts, idx, nIdx }; this.draw(); }

  resize() {
    const c = this.canvas, r = c.parentElement.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.max(1, Math.floor(r.width * dpr)); c.height = Math.max(1, Math.floor(r.height * dpr));
    if (this.depth) this.depth.destroy();
    this.depth = this.device.createTexture({ size: [c.width, c.height], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.draw();
  }

  bind() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('wheel', e => { e.preventDefault(); this.zoom *= e.deltaY < 0 ? 1.12 : 1 / 1.12; this.zoom = Math.min(Math.max(this.zoom, 0.2), 40); this.draw(); }, { passive: false });
    c.addEventListener('pointerdown', e => { c.setPointerCapture(e.pointerId); this.ptrs.set(e.pointerId, [e.clientX, e.clientY]); if (this.ptrs.size === 2) this.pinch = this.pinchDist(); });
    c.addEventListener('pointerup', e => { this.ptrs.delete(e.pointerId); });
    c.addEventListener('pointercancel', e => { this.ptrs.delete(e.pointerId); });
    c.addEventListener('pointermove', e => {
      const prev = this.ptrs.get(e.pointerId); if (!prev) return;
      const dx = e.clientX - prev[0], dy = e.clientY - prev[1];
      this.ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (this.ptrs.size === 2) { const dist = this.pinchDist(); if (this.pinch > 0) { this.zoom = Math.min(Math.max(this.zoom * dist / this.pinch, 0.2), 40); } this.pinch = dist; this.draw(); return; }
      if (e.pointerType === 'mouse') {
        if ((e.buttons & 4) || ((e.buttons & 2) && e.shiftKey)) { this.pan[0] += 2 * dx / this.canvas.clientWidth; this.pan[1] -= 2 * dy / this.canvas.clientHeight; this.draw(); }
        else if (e.buttons & 2) { this.yaw += dx * 0.01; this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch + dy * 0.01)); this.draw(); }
        // left button: intentionally nothing (CAD style, orbit is on right-drag)
      }
    });
  }
  pinchDist() { const p = [...this.ptrs.values()]; return Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]); }
  aspect() { return this.canvas.width / this.canvas.height; }

  viewMatrix() { // column-major R = Rx(pitch) * Ry(yaw)
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    // Ry = [[cy,0,sy],[0,1,0],[-sy,0,cy]], Rx = [[1,0,0],[0,cp,-sp],[0,sp,cp]]
    const r = [[cy, 0, sy], [sp * sy, cp, -sp * cy], [-cp * sy, sp, cp * cy]];
    return new Float32Array([r[0][0], r[1][0], r[2][0], 0, r[0][1], r[1][1], r[2][1], 0, r[0][2], r[1][2], r[2][2], 0, 0, 0, 0, 1]);
  }

  draw() {
    if (!this.pipe || !this.bg) return;
    const d = this.device, a = this.aspect(), s = this.zoom * 1.1;
    d.queue.writeBuffer(this.ubuf, 0, this.viewMatrix());
    d.queue.writeBuffer(this.ubuf, 64, new Float32Array([s / a, s, this.pan[0], this.pan[1]]));
    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), clearValue: { r: 0.0235, g: 0.0314, b: 0.0471, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    if (this.mesh) {
      pass.setPipeline(this.pipe); pass.setBindGroup(0, this.bg);
      pass.setVertexBuffer(0, this.mesh.verts); pass.setIndexBuffer(this.mesh.idx, 'uint32'); pass.drawIndexed(this.mesh.nIdx);
    }
    pass.end(); d.queue.submit([enc.finish()]);
  }
}

// Binary STL from an indexed mesh (unit box scaled to `scale` mm).
export function toBinaryStl(positions, indices, scale = 20) {
  const nT = indices.length / 3, buf = new ArrayBuffer(84 + nT * 50), dv = new DataView(buf);
  dv.setUint32(80, nT, true);
  let o = 84;
  for (let t = 0; t < nT; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1;
    for (const q of [nx / l, ny / l, nz / l]) { dv.setFloat32(o, q, true); o += 4; }
    for (const i of [a, b, c]) for (let q = 0; q < 3; q++) { dv.setFloat32(o, positions[i + q] * scale, true); o += 4; }
    o += 2;
  }
  return buf;
}
