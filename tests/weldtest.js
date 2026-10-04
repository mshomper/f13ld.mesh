// v0.9.3 weld export checks, in Node (no browser): the worker SDF files and
// the main-thread planner (14-weld-bake.js) are loaded into VM contexts.
//
//   node weldtest.js <old build> <new build> [draft|low|med] [family case]
//
// Scene: a lattice block (default foam2-open-lloyd) welded between two solid
// blocks, fillet 0.4 mm — the case that took minutes at Med in v0.9.2.
//  1. Grid: levelSet asks for exactly the points m31-weld-grid.js predicts
//     (bit-for-bit), and the main-thread mirror of weldGridDims agrees.
//  2. Plan: hybrid, one fine region around the lattice.
//  3. New build, one thread: hybrid weld (fine region + exact solid meshes).
//  4. New build, pre-baked: the field baked in slabs from cropped grids (as
//     the worker pool does) — every levelSet point comes from the cache and
//     the mesh is byte-identical to (3).
//  5. Old build: the v0.9.2 weld (whole group box, every member everywhere)
//     for timing and volume. Skipped above Draft unless OLD=1 (it's slow).
//  6. The mesh worker's weld branch (m90, Manifold stubbed in): the hybrid
//     message gives the same mesh as (3); a solid mesh Manifold rejects falls
//     back to meshing the whole group; the main-thread plan spots an open mesh.
const fs = require('fs'), vm = require('vm'), path = require('path');
const [OLD, NEW, QUAL = 'draft', FAM = 'foam2-open-lloyd'] = process.argv.slice(2);
const EDGE = { draft: 0.40, low: 0.20, med: 0.12, high: 0.09 }[QUAL];
const SHAPE_N = { draft: 64, low: 96, med: 128, high: 192 }[QUAL];
const FILLET = +(process.env.FILLET || 0.4);

function workerCtx(root) {
  const ctx = { self: { postMessage() {} }, console, Math, Float32Array, Float64Array, Uint32Array, Int32Array, Uint8Array,
    Uint16Array, Int16Array, Array, Object, JSON, Error, WeakMap, Map, Set, Number, isFinite, performance };
  vm.createContext(ctx);
  const files = fs.readdirSync(path.join(root, 'worker')).filter(f => /^m(05|1\d|2\d|3\d)-.*\.js$/.test(f)).sort();
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(root, 'worker', f), 'utf8'), ctx, { filename: f });
  return ctx;
}
function hostCtx(root, bodies) {
  const ctx = { window: {}, navigator: { hardwareConcurrency: 8 }, bodies, console, Math, Float32Array, Float64Array,
    Uint32Array, Array, Object, Map, Number, Error, Promise, performance, meshAssetUrl: p => p };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, '14-weld-bake.js'), 'utf8'), ctx, { filename: '14-weld-bake.js' });
  return ctx;
}
const call = (ctx, src, vars) => { Object.assign(ctx, vars || {}); return vm.runInContext(src, ctx); };

// ---- scene: boxes with a welded 12-triangle mesh and an analytic shape grid
function boxBody(id, lo, hi, N, recipe, cell) {
  const md = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), pad = md * 0.06;   // 12-shape-sdf-bake.js convention
  const bb = { mnx: lo[0] - pad, mny: lo[1] - pad, mnz: lo[2] - pad, mxx: hi[0] + pad, mxy: hi[1] + pad, mxz: hi[2] + pad };
  const a = new Float32Array(N * N * N);
  for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = bb.mnx + (i + 0.5) / N * (bb.mxx - bb.mnx), y = bb.mny + (j + 0.5) / N * (bb.mxy - bb.mny), z = bb.mnz + (k + 0.5) / N * (bb.mxz - bb.mnz);
    const dx = Math.max(lo[0] - x, x - hi[0]), dy = Math.max(lo[1] - y, y - hi[1]), dz = Math.max(lo[2] - z, z - hi[2]);
    const o = Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0));
    a[i + j * N + k * N * N] = o > 0 ? o : Math.max(dx, dy, dz);
  }
  const P = []; for (let c = 0; c < 8; c++) P.push(c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]);
  const T = [0,2,1, 1,2,3, 4,5,6, 5,7,6, 0,1,4, 1,5,4, 2,6,3, 3,6,7, 0,4,2, 2,4,6, 1,3,5, 3,7,5];
  const body = { posArr: new Float32Array(P), idxArr: new Uint32Array(T), bbox: bb };
  const spec = { solid: !recipe, recipe, shapeSdfData: a.buffer, shapeN: N, bbox: bb, cellSizeMm: cell, name: id, recipeLabel: '', bodyId: id };
  return { body, spec };
}
const cases = JSON.parse(fs.readFileSync(path.join(NEW, 'tests', 'recipes.json'), 'utf8'));
const rc = cases[FAM].recipe, recipe = rc.json ? rc : { family: rc.family, json: rc };
const scene = [boxBody('A', [0, 0, 0], [25, 20, 10], SHAPE_N, null, 8),
               boxBody('B', [23, 0, 0], [43, 20, 10], SHAPE_N, recipe, 8),
               boxBody('C', [41, 0, 0], [66, 20, 10], SHAPE_N, null, 8)];
const bodies = new Map(scene.map(s => [s.spec.bodyId, s.body]));
const specs = scene.map(s => s.spec);
const gbb = { mnx: Infinity, mny: Infinity, mnz: Infinity, mxx: -Infinity, mxy: -Infinity, mxz: -Infinity };
for (const s of specs) for (const k of ['mnx', 'mny', 'mnz']) gbb[k] = Math.min(gbb[k], s.bbox[k]);
for (const s of specs) for (const k of ['mxx', 'mxy', 'mxz']) gbb[k] = Math.max(gbb[k], s.bbox[k]);

(async () => {
  const { default: Module } = await import('manifold-3d');
  const wasm = await Module(); wasm.setup(); const { Manifold, Mesh } = wasm;
  const W = workerCtx(NEW), H = hostCtx(NEW, bodies);
  let fails = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };

  // 1. grid
  for (const [mn, mx, e] of [[[0, 0, 0], [1, 0.7, 0.5], 0.1], [[-3.17, 2.2, 0.9], [5.3, 7.7, 4.1], 0.37], [[gbb.mnx, gbb.mny, gbb.mnz], [gbb.mxx, gbb.mxy, gbb.mxz], EDGE]]) {
    const g = call(W, 'weldGridDims(__a,__b,__e)', { __a: mn, __b: mx, __e: e });
    const gh = call(H, 'weldGridDims(__a,__b,__e)', { __a: mn, __b: mx, __e: e });
    const f = p => Math.sin(p[0] * 3.1) + Math.cos(p[1] * 2.3) * Math.sin(p[2] * 1.7);
    const all = []; for (let q = 0; q < g.layers; q += 7) all.push(call(W, 'weldBakeLayers(__f,__g,__qa,__qb,false)', { __f: f, __g: g, __qa: q, __qb: Math.min(g.layers, q + 7) }));
    const M = new Float64Array(g.mainCount), O = new Float64Array(g.offCount);
    for (const r of all) { M.set(r.main, r.kmA * (g.n[0] + 1) * (g.n[1] + 1)); O.set(r.off, r.koA * (g.n[0] + 2) * (g.n[1] + 2)); }
    const stats = {}; let calls = 0;
    const look = call(W, 'makeWeldLookup(__g,__M,__O,__f,__s)', { __g: g, __M: M, __O: O, __f: f, __s: stats });
    let same = true;
    Manifold.levelSet(p => { calls++; const v = look(p); if (v !== f(p)) same = false; return v; }, { min: mn, max: mx }, e).delete();
    check(stats.miss === 0 && stats.hit === calls && calls === g.mainCount + g.offCount && same && gh.n.join() === g.n.join(),
      `grid ${g.n.join('×')} cells: levelSet asked ${calls} points, ${stats.hit} from cache, ${stats.miss} direct, values ${same ? 'match' : 'DIFFER'}, main-thread dims ${gh.n.join('×')}`);
  }

  // 2. plan
  const plan = call(H, 'planWeld(__s,__k,__e,__g)', { __s: specs, __k: FILLET, __e: EDGE, __g: gbb });
  const fmtBox = b => b.min.map(v => v.toFixed(2)).join(',') + ' → ' + b.max.map(v => v.toFixed(2)).join(',');
  check(plan.hybrid && plan.regions.length === 1 && plan.solidOk.join() === 'true,false,true',
    `plan: hybrid ${plan.hybrid}, exact solids ${plan.solidOk}, regions ${plan.regions.map(fmtBox).join(' | ')}, inset ${plan.insetMm}, reach ${plan.reachMm.toFixed(2)} mm`);
  const bodiesW = specs.map((s, i) => plan.solidOk[i] ? Object.assign({}, s, { insetMm: plan.insetMm }) : s);
  const solidMf = () => specs.map((s, i) => {
    if (!plan.solidOk[i]) return null;
    const b = bodies.get(s.bodyId), mesh = new Mesh({ numProp: 3, vertProperties: new Float32Array(b.posArr), triVerts: new Uint32Array(b.idxArr) });
    mesh.merge(); return new Manifold(mesh);
  }).filter(Boolean);
  const finish = (pieces) => { const parts = pieces.concat(solidMf()); const u = Manifold.union(parts); parts.forEach(m => m.delete()); return u; };
  const meshInfo = m => { const g = m.getMesh(); return { tris: m.numTri(), vol: m.volume(), genus: m.genus(), vp: Buffer.from(g.vertProperties.buffer, g.vertProperties.byteOffset, g.vertProperties.byteLength), tv: Buffer.from(g.triVerts.buffer, g.triVerts.byteOffset, g.triVerts.byteLength) }; };

  // 3. new, one thread
  const field = call(W, 'makeWeldField(__b,__k,__r)', { __b: bodiesW, __k: FILLET, __r: plan.reachMm });
  let n3 = 0; const t3 = performance.now();
  const pieces3 = plan.regions.map(r => Manifold.levelSet(p => { n3++; return field(p); }, { min: r.min, max: r.max }, EDGE));
  const ms3ls = performance.now() - t3; const u3 = finish(pieces3); const ms3 = performance.now() - t3;
  const r3 = meshInfo(u3); u3.delete();
  console.log(`new, 1 thread: ${(ms3 / 1000).toFixed(1)} s (level set ${(ms3ls / 1000).toFixed(1)} s, ${(n3 / 1e6).toFixed(2)}M points, ${(ms3ls * 1000 / n3).toFixed(1)} µs/point), ${r3.tris} tris, volume ${r3.vol.toFixed(1)} mm³, genus ${r3.genus}`);

  // 4. new, pre-baked from cropped grids
  const t4 = performance.now(); let bakeMs = 0, lookMs = 0, miss = 0, hit = 0, cropBytes = 0, fullBytes = 0;
  const pieces4 = plan.regions.map(r => {
    const g = call(H, 'weldGridDims(__a,__b,__e)', { __a: r.min, __b: r.max, __e: EDGE });
    const margin = Math.max(...g.s) + Math.max(FILLET * 0.25, 0.05) + 1e-3;
    const cropped = bodiesW.map(s => call(H, 'cropSpecToRegion(__s,__r,__m)', { __s: s, __r: r, __m: margin }));
    cropBytes += cropped.reduce((a, s) => a + s.shapeSdfData.byteLength, 0); fullBytes += bodiesW.reduce((a, s) => a + s.shapeSdfData.byteLength, 0);
    const f2 = call(W, 'makeWeldField(__b,__k,__r)', { __b: cropped, __k: FILLET, __r: plan.reachMm });
    const tb = performance.now();
    const M = new Float64Array(g.mainCount), O = new Float64Array(g.offCount), per = Math.ceil(g.layers / 48);
    for (let q = 0; q < g.layers; q += per) {
      const s = call(W, 'weldBakeLayers(__f,__g,__qa,__qb,false)', { __f: f2, __g: call(W, 'weldGridDims(__a,__b,__e)', { __a: r.min, __b: r.max, __e: EDGE }), __qa: q, __qb: Math.min(g.layers, q + per) });
      M.set(s.main, s.kmA * (g.n[0] + 1) * (g.n[1] + 1)); O.set(s.off, s.koA * (g.n[0] + 2) * (g.n[1] + 2));
    }
    bakeMs += performance.now() - tb;
    const stats = {}; const look = call(W, 'makeWeldLookup(__g,__M,__O,__f,__s)', { __g: call(W, 'weldGridDims(__a,__b,__e)', { __a: r.min, __b: r.max, __e: EDGE }), __M: M, __O: O, __f: field, __s: stats });
    const tl = performance.now(); const m = Manifold.levelSet(look, { min: r.min, max: r.max }, EDGE); lookMs += performance.now() - tl;
    hit += stats.hit; miss += stats.miss; return m;
  });
  const u4 = finish(pieces4); const ms4 = performance.now() - t4; const r4 = meshInfo(u4); u4.delete();
  console.log(`new, pre-baked: bake ${(bakeMs / 1000).toFixed(1)} s on one thread (÷ workers in the app), level set from cache ${(lookMs / 1000).toFixed(2)} s, cropped grids ${(cropBytes / 1e6).toFixed(1)} of ${(fullBytes / 1e6).toFixed(1)} MB`);
  check(miss === 0 && r4.vp.equals(r3.vp) && r4.tv.equals(r3.tv), `pre-baked mesh byte-identical to one-thread mesh (${hit} cached points, ${miss} direct)`);

  // 6. the mesh worker's weld branch (m90), with Manifold stubbed in: the
  //    hybrid message, and a solid whose mesh Manifold rejects (falls back to
  //    meshing the whole group).
  {
    const M = workerCtx(NEW);
    Object.assign(M, { ManifoldAPI: wasm, manifoldReady: Promise.resolve(), meshoptReady: Promise.resolve(), meshoptSimplify: () => null });
    vm.runInContext(fs.readFileSync(path.join(NEW, 'worker', 'm90-onmessage.js'), 'utf8'), M, { filename: 'm90-onmessage.js' });
    const runMsg = async (weld) => {
      const out = []; M.self.postMessage = (m) => out.push(m);
      await M.self.onmessage({ data: { mode: 'export', bodies: bodiesW, blendK: FILLET, bbox: gbb, relEdgeMm: EDGE, simplifyTol: 0, scale: 1, weld } });
      return out;
    };
    const solidMeshes = specs.map((s, i) => plan.solidOk[i] ? { pos: bodies.get(s.bodyId).posArr.slice().buffer, idx: bodies.get(s.bodyId).idxArr.slice().buffer } : null);
    const volOf = (out) => { const d = out.find(m => m.type === 'done'); if (!d) return null; const V = new Float32Array(d.vertProperties), T = new Uint32Array(d.triVerts); let v = 0;
      for (let t = 0; t < T.length; t += 3) { const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3; v += (V[a] * (V[b + 1] * V[c + 2] - V[b + 2] * V[c + 1]) + V[a + 1] * (V[b + 2] * V[c] - V[b] * V[c + 2]) + V[a + 2] * (V[b] * V[c + 1] - V[b + 1] * V[c])) / 6; } return v; };
    const o1 = await runMsg({ hybrid: true, reachMm: plan.reachMm, regions: plan.regions.map(r => ({ min: r.min, max: r.max })), solidMeshes });
    const v1 = volOf(o1), e1 = o1.find(m => m.type === 'error');
    check(v1 != null && Math.abs(v1 - r3.vol) / r3.vol < 1e-6, `mesh worker, hybrid message: ${e1 ? 'ERROR ' + e1.message : 'volume ' + v1.toFixed(1) + ' mm³ (one-thread run ' + r3.vol.toFixed(1) + ')'}`);
    const bad = solidMeshes.slice(); bad[0] = { pos: bad[0].pos, idx: new Uint32Array(new Uint32Array(bad[0].idx).slice(3)).buffer };   // drop a triangle
    const t6 = performance.now();
    const o2 = await runMsg({ hybrid: true, reachMm: plan.reachMm, regions: plan.regions.map(r => ({ min: r.min, max: r.max })), solidMeshes: bad });
    const v2 = volOf(o2), e2 = o2.find(m => m.type === 'error'), note = o2.find(m => m.type === 'progress' && /rejected/.test(m.stage));
    check(v2 != null && !!note && Math.abs(v2 - r3.vol) / r3.vol < 0.015, `mesh worker, open solid mesh: ${e2 ? 'ERROR ' + e2.message : (note ? '"' + note.stage + '", ' : 'no fallback note, ') + 'volume ' + (v2 || 0).toFixed(1) + ' mm³, ' + ((performance.now() - t6) / 1000).toFixed(1) + ' s'}`);
    // main-thread check catches the same open mesh, so the plan sends that body to the fine region
    const openBodies = new Map(bodies); openBodies.set('A', Object.assign({}, bodies.get('A'), { idxArr: new Uint32Array(bodies.get('A').idxArr).slice(3), _closedCheck: null }));
    const H2 = hostCtx(NEW, openBodies);
    const plan2 = call(H2, 'planWeld(__s,__k,__e,__g)', { __s: specs, __k: FILLET, __e: EDGE, __g: gbb });
    check(plan2.hybrid && plan2.solidOk.join() === 'false,false,true' && plan2.regions.length === 1 && plan2.regions[0].min[0] <= gbb.mnx + 1e-9,
      `plan with an open solid mesh: exact solids ${plan2.solidOk}, region ${plan2.regions.map(fmtBox).join(' | ')}`);
  }

  // 5. old build
  if (QUAL === 'draft' || process.env.OLD === '1') {
    const WO = workerCtx(OLD);
    const asm = call(WO, 'buildAssemblySDF(__s,__k,false)', { __s: specs, __k: FILLET });
    let n5 = 0; const t5 = performance.now();
    const m5 = Manifold.levelSet(p => { n5++; const v = -asm(p); return (v > -1e20 && v < 1e20) ? v : -1e3; }, { min: [gbb.mnx, gbb.mny, gbb.mnz], max: [gbb.mxx, gbb.mxy, gbb.mxz] }, EDGE);
    const ms5 = performance.now() - t5; const v5 = m5.volume();
    console.log(`old (v0.9.2): ${(ms5 / 1000).toFixed(1)} s, ${(n5 / 1e6).toFixed(2)}M points, ${m5.numTri()} tris, volume ${v5.toFixed(1)} mm³, genus ${m5.genus()}`);
    const dv = (r3.vol - v5) / v5 * 100;
    check(Math.abs(dv) < 1.5, `volume new vs old ${dv >= 0 ? '+' : ''}${dv.toFixed(2)}% (fillet ${FILLET} mm loses ≈ one voxel where the lattice meets a solid)`);
    console.log(`speed: one thread ${(ms5 / ms3).toFixed(1)}× faster than v0.9.2; field evaluation is then split across the worker pool`);
    m5.delete();
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
