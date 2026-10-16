// v0.12.0 weld member settings, skin fill and join rules, in Node (no browser, no Manifold).
// Loads the worker SDF files into VM contexts and compares fields point by point.
//
//   node tests/weldfill.js [baseline worker dir]
//
// Baseline = the build before v0.12.0: m30 / m31 / m32 are read from `git show 562a005:` (v0.11.0 + docs, the last commit before v0.12.0 work)
// (BASE_REF=<rev> to change it) or from <dir>/worker when a folder is given; every
// other worker file is taken from this checkout.
//
//  a. Nothing asked for -> nothing changes, bit for bit: single-body field (m32)
//     with a rotation / offset / iso / trim, and the weld field with absent,
//     identity or union extras, against the baseline.
//  b. A weld member with rotation, offset, iso, trim-to-nodes and skin gives the
//     single-body shape field for that member, exactly, away from other members.
//  c. Skin only changes the field within skinMm of the shape surface.
//  d. Anchor changes the field only inside the solid member, reaching anchorMm
//     past the lattice's own shape; the hybrid solid inset does not move it.
//  e. Graded thickens walls by gradeMaxMm at the solid, 0 at gradeMm (smoothstep).
//  f. Main-thread side (14-weld-bake.js): spec decoration, planWeld pad, no crop
//     for trimmed members.
const fs = require('fs'), vm = require('vm'), path = require('path'), cp = require('child_process');
const REPO = path.resolve(__dirname, '..');
const BASE = process.argv[2] || null;

function ctxFor(baselineFiles) {
  const ctx = { self: { postMessage() {} }, console, Math, Float32Array, Float64Array, Uint32Array, Int32Array, Uint8Array,
    Array, Object, JSON, Error, WeakMap, Map, Set, Number, isFinite, performance };
  vm.createContext(ctx);
  const files = fs.readdirSync(path.join(REPO, 'worker')).filter(f => /^m(05|1\d|2\d|3[012])-.*\.js$/.test(f)).sort();
  for (const f of files) {
    let src;
    if (baselineFiles && /^m3[012]-/.test(f)) src = baselineFiles[f.slice(0, 3)];
    else src = fs.readFileSync(path.join(REPO, 'worker', f), 'utf8');
    if (src == null) continue;
    vm.runInContext(src, ctx, { filename: f });
  }
  return ctx;
}
function baselineSources() {
  const out = {};
  for (const f of fs.readdirSync(path.join(REPO, 'worker')).filter(f => /^m3[012]-.*\.js$/.test(f))) {
    out[f.slice(0, 3)] = BASE ? fs.readFileSync(path.join(BASE, 'worker', f), 'utf8')
      : cp.execSync(`git -C ${REPO} show ${process.env.BASE_REF || "562a005"}:worker/${f}`, { encoding: 'utf8', maxBuffer: 1 << 26 });
  }
  return out;
}
const NEW = ctxFor(null), OLD = ctxFor(baselineSources());
const call = (ctx, src, vars) => { Object.assign(ctx, vars || {}); return vm.runInContext(src, ctx); };

// ---- scene helpers --------------------------------------------------------
const N = 32;
function boxSpec(lo, hi, recipe, cell, extra) {
  const md = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), pad = md * 0.06;
  const bb = { mnx: lo[0] - pad, mny: lo[1] - pad, mnz: lo[2] - pad, mxx: hi[0] + pad, mxy: hi[1] + pad, mxz: hi[2] + pad };
  const a = new Float32Array(N * N * N);
  for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = bb.mnx + (i + 0.5) / N * (bb.mxx - bb.mnx), y = bb.mny + (j + 0.5) / N * (bb.mxy - bb.mny), z = bb.mnz + (k + 0.5) / N * (bb.mxz - bb.mnz);
    const dx = Math.max(lo[0] - x, x - hi[0]), dy = Math.max(lo[1] - y, y - hi[1]), dz = Math.max(lo[2] - z, z - hi[2]);
    const o = Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0));
    a[i + j * N + k * N * N] = o > 0 ? o : Math.max(dx, dy, dz);
  }
  return Object.assign({ solid: !recipe, recipe, shapeSdfData: a.buffer, shapeN: N, bbox: bb, cellSizeMm: cell }, extra || {});
}
// fresh copy of a spec (each context gets its own typed-array views)
const clone = (sp, extra) => Object.assign({}, sp, extra || {});
const cases = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'recipes.json'), 'utf8'));
const asRecipe = rc => rc.json ? rc : { family: rc.family, json: rc };
const GYR = asRecipe(cases['tpms-gyroid-sheet'].recipe);
const BEAM = asRecipe(cases['beam-bcc'].recipe);
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const pts = (bb, n, grow = 0) => Array.from({ length: n }, () => [bb.mnx - grow + rnd() * (bb.mxx - bb.mnx + 2 * grow), bb.mny - grow + rnd() * (bb.mxy - bb.mny + 2 * grow), bb.mnz - grow + rnd() * (bb.mxz - bb.mnz + 2 * grow)]);
// orthonormal matrix (column-major), a z turn then an x turn
function rotMat(zDeg, xDeg) {
  const c = Math.cos(zDeg * Math.PI / 180), s = Math.sin(zDeg * Math.PI / 180), cx = Math.cos(xDeg * Math.PI / 180), sx = Math.sin(xDeg * Math.PI / 180);
  const Rz = [[c, -s, 0], [s, c, 0], [0, 0, 1]], Rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
  const M = [0, 1, 2].map(i => [0, 1, 2].map(j => Rx[i][0] * Rz[0][j] + Rx[i][1] * Rz[1][j] + Rx[i][2] * Rz[2][j]));
  return [M[0][0], M[1][0], M[2][0], M[0][1], M[1][1], M[2][1], M[0][2], M[1][2], M[2][2]];
}
const XF = { rotMat: rotMat(33, 21), spatialOffsetMm: [0.7, -0.4, 0.9], isoOffsetMm: 0.12 };

let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
const maxDiff = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

// ---- a1. single-body field (m32): new vs baseline -------------------------
function singleField(ctx, d) {
  const dd = Object.assign({ mode: 'export', relEdgeMm: 0.1, shapeN: N }, d);
  const sdf = call(ctx, 'buildSDF(__d.recipe, exportShapeCtx(__d))', { __d: dd });
  const sf = call(ctx, 'buildShapeExportField(__d, __s, function(){})', { __d: dd, __s: sdf });
  sf.setEdge(Infinity);            // no far-outside short-circuit
  return sf.fn;
}
{
  const L = boxSpec([0, 0, 0], [20, 16, 12], GYR, 4), B = boxSpec([0, 0, 0], [20, 16, 12], BEAM, 3);
  const P = pts(L.bbox, 400, 3);
  for (const [name, sp, xf, trim] of [['gyroid, no transform', L, undefined, false], ['gyroid, rotation+offset+iso', L, XF, false],
    ['gyroid, iso only', L, { rotMat: [1, 0, 0, 0, 1, 0, 0, 0, 1], spatialOffsetMm: [0, 0, 0], isoOffsetMm: 0.2 }, false],
    ['beam, trim, rotated', B, XF, true], ['beam, trim, identity', B, undefined, true]]) {
    const d = { recipe: sp.recipe, bbox: sp.bbox, shapeSdfData: sp.shapeSdfData, shapeN: N, cellSizeMm: sp.cellSizeMm, structXform: xf, pruneToNodes: trim, pruneInsetMult: 1 };
    const fo = singleField(OLD, clone(d, { shapeSdfData: sp.shapeSdfData.slice(0) })), fn = singleField(NEW, clone(d, { shapeSdfData: sp.shapeSdfData.slice(0) }));
    const a = P.map(p => fo(p.slice())), b = P.map(p => fn(p.slice()));
    check(maxDiff(a, b) === 0, `a1 single-body ${name}: new == baseline on ${P.length} points`);
  }
}

// ---- a2. weld field: new vs baseline --------------------------------------
{
  const L = boxSpec([0, 0, 0], [20, 16, 12], GYR, 4, { bodyId: 'L' });
  const S = boxSpec([20, 0, 0], [32, 16, 12], null, 4, { bodyId: 'S', insetMm: 0.1 });
  const T = boxSpec([0, 18, 0], [20, 30, 12], BEAM, 3, { bodyId: 'T' });
  const gb = { mnx: -2, mny: -2, mnz: -2, mxx: 34, mxy: 32, mxz: 14 };
  const P = pts(gb, 500);
  const extras = {
    'no extras': {},
    'identity xform, lattice fill, union': { structXform: { rotMat: [1, 0, 0, 0, 1, 0, 0, 0, 1], spatialOffsetMm: [0, 0, 0], isoOffsetMm: 0 }, fill: 'lattice', joinRule: 'union', pruneToNodes: false },
    'skinMm without skin fill': { skinMm: 1.5, anchorMm: 2, gradeMm: 3 }
  };
  for (const [k, reach] of [[0, 0], [0.4, 0], [0.4, 1.6]]) {
    const fo = call(OLD, 'makeWeldField(__b,__k,__r)', { __b: [L, S, T].map(s => clone(s)), __k: k, __r: reach });
    const a = P.map(p => fo(p.slice()));
    for (const [name, ex] of Object.entries(extras)) {
      const fn = call(NEW, 'makeWeldField(__b,__k,__r)', { __b: [L, S, T].map(s => clone(s, ex)), __k: k, __r: reach });
      check(maxDiff(a, P.map(p => fn(p.slice()))) === 0, `a2 weld fillet ${k} reach ${reach}, ${name}: new == baseline on ${P.length} points`);
    }
  }
}

// ---- b. rotated / offset / iso / trim / skin member == single-body field -----
{
  const S = boxSpec([40, 0, 0], [52, 16, 12], null, 4, { bodyId: 'S' });             // far from the lattice
  for (const [name, recipe, cell, xf, trim, fill] of [
    ['gyroid, rotation+offset+iso', GYR, 4, XF, false, null],
    ['gyroid, iso only', GYR, 4, { rotMat: [1, 0, 0, 0, 1, 0, 0, 0, 1], spatialOffsetMm: [0, 0, 0], isoOffsetMm: 0.3 }, false, null],
    ['gyroid, rotated + skin 1.2 mm', GYR, 4, XF, false, 1.2],
    ['gyroid, skin 1.2 mm', GYR, 4, undefined, false, 1.2],
    ['beam, rotated, trim to nodes', BEAM, 3, XF, true, null],
    ['beam, trim to nodes + skin', BEAM, 3, { rotMat: rotMat(15, 0), spatialOffsetMm: [0.3, 0, 0], isoOffsetMm: 0 }, true, 0.8]]) {
    const L = boxSpec([0, 0, 0], [20, 16, 12], recipe, cell, { bodyId: 'L' });
    const ex = {}; if (xf) ex.structXform = xf; if (trim) { ex.pruneToNodes = true; ex.pruneInsetMult = 1; } if (fill) { ex.fill = 'skin'; ex.skinMm = fill; }
    const wf = call(NEW, 'makeWeldField(__b,0,0)', { __b: [clone(L, ex), clone(S)] });
    const d = { recipe, bbox: L.bbox, shapeSdfData: L.shapeSdfData.slice(0), shapeN: N, cellSizeMm: cell, structXform: xf, pruneToNodes: trim, pruneInsetMult: 1, fill: fill ? 'skin' : undefined, skinMm: fill || undefined };
    const sf = singleField(NEW, d);
    const P = pts(L.bbox, 600);
    const a = P.map(p => sf(p.slice())), b = P.map(p => wf(p.slice()));
    const nIn = a.filter(v => v > 0).length;
    // A trimmed beam field is +Infinity where no beam is left; the single-body field maps that to -1e6 and the
    // weld to -1e3 (both firmly outside). Everywhere else the two are equal bit for bit.
    let diff = 0, sentinel = 0;
    a.forEach((v, i) => { if (v <= -1e5 && b[i] < 0) sentinel++; else diff = Math.max(diff, Math.abs(v - b[i])); });
    check(diff === 0 && nIn > 20 && nIn < 580, `b weld member == single-body field: ${name} (${nIn}/600 points inside, max diff ${diff}${sentinel ? ', ' + sentinel + ' empty-tile points outside in both' : ''})`);
  }
}

// ---- c. skin changes the field only near the shape surface -------------------
{
  const SK = 1.2;
  const L = boxSpec([0, 0, 0], [20, 16, 12], GYR, 4, { bodyId: 'L' });
  const plain = call(NEW, 'makeWeldField([__s],0,0)', { __s: clone(L) });
  const skin = call(NEW, 'makeWeldField([__s],0,0)', { __s: clone(L, { fill: 'skin', skinMm: SK }) });
  const shape = call(NEW, 'makeShapeSampler(__b,__n,__bb,null)', { __b: L.shapeSdfData.slice(0), __n: N, __bb: L.bbox });
  const P = pts(L.bbox, 4000);
  let wall = 0, wallOk = 0, deep = 0, deepOk = 0, out = 0, outOk = 0;
  for (const p of P) {
    const depth = -shape(p[0], p[1], p[2]), a = plain(p.slice()), b = skin(p.slice());
    if (depth > 0 && depth < SK - 0.05) { wall++; if (b > 0) wallOk++; }       // inside the wall: solid
    else if (depth >= SK + 0.05) { deep++; if ((a > 0) === (b > 0)) deepOk++; }  // past it: same material
    else if (depth <= -0.05) { out++; if (b <= 0 && a <= 0) outOk++; }
  }
  check(wall > 50 && wallOk === wall, `c skin: ${wallOk}/${wall} points within the wall are solid`);
  check(deep > 500 && deepOk === deep, `c skin: ${deepOk}/${deep} points deeper than skinMm keep the lattice's inside/outside`);
  check(out > 50 && outOk === out, `c skin: ${outOk}/${out} points outside the shape stay outside`);
  const none = call(NEW, 'makeWeldField([__s],0,0)', { __s: clone(L, { fill: 'skin', skinMm: 0 }) });
  check(maxDiff(P.map(p => plain(p.slice())), P.map(p => none(p.slice()))) === 0, 'c skin with skinMm 0 == lattice fill');
}

// ---- d / e. anchor and graded -------------------------------------------------
{
  const ANCH = 2, GRADE = 3, GMAX = 0.25, K = 0.3;
  const L = boxSpec([0, 0, 0], [20, 16, 12], GYR, 4, { bodyId: 'L' });
  const S = boxSpec([20, 0, 0], [32, 16, 12], null, 4, { bodyId: 'S' });
  const Sin = clone(S, { insetMm: 0.1 });       // hybrid: solid pulled one voxel inside its exact mesh
  const mk = (ex, solid) => [clone(L, ex), clone(solid || S, ex)];
  const solidShape = call(NEW, 'makeShapeSampler(__b,__n,__bb,null)', { __b: S.shapeSdfData.slice(0), __n: N, __bb: S.bbox });
  const lat = call(NEW, 'buildSDF(__r,null,{periodic:true})', { __r: GYR });
  const w2m = 4 / 10;
  const latMm = p => lat([p[0] * 10 / 4, p[1] * 10 / 4, p[2] * 10 / 4]) * w2m;
  const field = (specs, k, reach) => call(NEW, 'makeWeldField(__b,__k,__r)', { __b: specs, __k: k, __r: reach || 0 });
  const P = pts({ mnx: 8, mny: -1, mnz: -1, mxx: 30, mxy: 17, mxz: 13 }, 3000);

  // d. anchor: identical outside the solid; only lowers the field inside it
  const base = field(mk({}), K), anc = field(mk({ joinRule: 'anchor', anchorMm: ANCH }), K);
  const base0 = field(mk({}), 0), anc0 = field(mk({ joinRule: 'anchor', anchorMm: ANCH }), 0);
  let outSame = 0, outN = 0, outSame0 = 0, inLower = 0, inN = 0, inChanged = 0, signSame = 0;
  for (const p of P) {
    const ds = solidShape(p[0], p[1], p[2]), a = base(p.slice()), b = anc(p.slice()), a0 = base0(p.slice()), b0 = anc0(p.slice());
    if (ds >= 0) { outN++; if (a === b) outSame++; if (a0 === b0) outSame0++; }
    else { inN++; if (b0 <= a0 + 1e-12) inLower++; if (b0 !== a0) inChanged++; if ((a > 0) === (b > 0)) signSame++; }
  }
  check(outN > 300 && outSame === outN && outSame0 === outN, `d anchor: ${outSame}/${outN} points outside the solid are unchanged, with fillet ${K} and without`);
  check(inN > 300 && inLower === inN && signSame === inN, `d anchor: inside the solid the union field only drops (${inChanged}/${inN} points changed, signs all equal: the unioned surface cannot change)`);
  // member level: the lattice reaches anchorMm into the solid, not further
  const sdist = (x, y, z) => solidShape(x, y, z);
  const Lm = call(NEW, 'composeMember(__s,null,null)', { __s: clone(L) }).full;
  const La = call(NEW, 'composeMember(__s,null,__j)', { __s: clone(L), __j: { anchorMm: ANCH, gradeMm: 0, solidDist: sdist } }).full;
  let reachIn = 0, reachInN = 0, beyondOut = 0, beyondN = 0, plainOut = 0, shallowSame = 0, shallowN = 0;
  for (let i = 0; i < 8000; i++) {
    const p = [20 + 0.05 + rnd() * 5, 3 + rnd() * 10, 3 + rnd() * 6];   // >= 3 mm from the solid's side faces, so depth = x - 20
    if (latMm(p) > -0.05) continue;            // lattice material only
    const t = p[0] - 20;                      // depth into the solid (it starts at x = 20, flush with the lattice body)
    if (t <= 0.25 * ANCH) { shallowN++; if (La(p) === Lm(p)) shallowSame++; }
    else if (t >= 0.5 * ANCH + 0.05 && t < ANCH - 0.2) { reachInN++; if (La(p) < 0) reachIn++; if (Lm(p) > 0) plainOut++; }
    else if (t > ANCH + 0.5) { beyondN++; if (La(p) > 0) beyondOut++; }
  }
  check(shallowN > 10 && shallowSame === shallowN, `d anchor: nothing changes within anchorMm/4 of the solid's surface (${shallowSame}/${shallowN} points)`);
  check(reachInN > 20 && reachIn === reachInN && plainOut === reachInN, `d anchor: lattice continues into the solid (${reachIn}/${reachInN} points deeper than anchorMm/2, none there without anchor)`);
  check(beyondN > 5 && beyondOut === beyondN, `d anchor: and stops past anchorMm (${beyondOut}/${beyondN} points)`);
  // hybrid inset: the lattice's anchor does not depend on the solid's inset
  const ancIn = field(mk({ joinRule: 'anchor', anchorMm: ANCH }, Sin), 0), manual = (() => {
    const lj = call(NEW, 'composeMember(__s,null,__j)', { __s: clone(L), __j: { anchorMm: ANCH, gradeMm: 0, solidDist: sdist } }).full;
    const sj = call(NEW, 'composeMember(__s,null,null)', { __s: clone(Sin) }).full;
    return p => -Math.min(lj(p), sj(p));
  })();
  check(maxDiff(P.map(p => ancIn(p.slice())), P.map(p => manual(p.slice()))) === 0, 'd anchor: hybrid inset solid -> lattice continuation uses the solid\'s raw shape; field = min(anchored lattice, inset solid)');
  // reach skip: far-member skip stays correct (reach grows by anchorMm inside the worker)
  const ancR = field(mk({ joinRule: 'anchor', anchorMm: ANCH }), K, 0.8), ancN = field(mk({ joinRule: 'anchor', anchorMm: ANCH }), K, 0);
  const Q = pts({ mnx: 20, mny: 0, mnz: 0, mxx: 22.5, mxy: 16, mxz: 12 }, 800);
  check(maxDiff(Q.map(p => ancR(p.slice())), Q.map(p => ancN(p.slice()))) === 0, 'd anchor: reachMm skip gives the same field in the anchor zone');

  // e. graded
  const gr = field(mk({ joinRule: 'graded', gradeMm: GRADE, gradeMaxMm: GMAX }), 0), un = field(mk({}), 0);
  const member = j => call(NEW, 'composeMember(__s,null,__j)', { __s: clone(L), __j: j }).full;
  const Lg = member({ anchorMm: 0, gradeMm: GRADE, gradeMaxMm: GMAX, solidDist: sdist });
  const Lgdef = member({ anchorMm: 0, gradeMm: GRADE, solidDist: sdist });          // default gradeMax = 0.15 x 4 mm
  const ownShape = call(NEW, 'makeShapeSampler(__b,__n,__bb,null)', { __b: L.shapeSdfData.slice(0), __n: N, __bb: L.bbox });
  const ss = t => t * t * (3 - 2 * t);
  let farSame = 0, farN = 0, ssOk = 0, ssN = 0, defOk = 0, defN = 0;
  for (let i = 0; i < 6000; i++) {
    const p = [0.5 + rnd() * 19, 0.5 + rnd() * 15, 0.5 + rnd() * 11];     // inside the lattice body
    const ds = solidShape(p[0], p[1], p[2]), m = Lm(p), g = Lg(p), lm = latMm(p), sh = ownShape(p[0], p[1], p[2]);
    if (ds >= GRADE) { farN++; if (m === g) farSame++; continue; }
    if (lm > sh + 0.7 && m === lm) {            // the lattice term (not the shape) sets the value here
      ssN++; if (Math.abs((m - g) - GMAX * ss(1 - Math.max(ds, 0) / GRADE)) < 1e-9) ssOk++;
      defN++; if (Math.abs((m - Lgdef(p)) - 0.6 * ss(1 - Math.max(ds, 0) / GRADE)) < 1e-9) defOk++;
    }
  }
  check(farN > 200 && farSame === farN, `e graded: ${farSame}/${farN} points farther than gradeMm from the solid are unchanged`);
  check(ssN > 50 && ssOk === ssN, `e graded: wall thickening = gradeMaxMm x smoothstep(1 - distance/gradeMm) (${ssOk}/${ssN} points)`);
  check(defN > 50 && defOk === defN, `e graded: default gradeMaxMm = 0.15 x cell size (${defOk}/${defN} points)`);
  check(P.every(p => gr(p.slice()) >= un(p.slice()) - 1e-12) && P.some(p => gr(p.slice()) > un(p.slice()) + 1e-6), 'e graded: weld field (positive inside) only rises, and does rise');
}

// ---- f. main-thread side (14-weld-bake.js) -------------------------------------
{
  const bodies = new Map();
  const mkBody = (id, extra) => bodies.set(id, Object.assign({ bbox: { mnx: 0, mny: 0, mnz: 0, mxx: 10, mxy: 10, mxz: 10 }, trimToNodes: true, trimInsetMult: 1 }, extra));
  mkBody('L', { structureTransform: { rotMat: XF.rotMat, spatialOffsetMmX: 0.7, spatialOffsetMmY: -0.4, spatialOffsetMmZ: 0.9, isoOffsetMm: 0.12 }, fill: 'skin', skinMm: 1.5 });
  mkBody('B', { structureTransform: { rotMat: [1, 0, 0, 0, 1, 0, 0, 0, 1], spatialOffsetMmX: 0, spatialOffsetMmY: 0, spatialOffsetMmZ: 0, isoOffsetMm: 0 }, trimToNodes: true, trimInsetMult: 1.5 });
  mkBody('S', {});
  const weldGroups = new Map([['g', { filletMm: 0.4, joinRule: 'anchor', anchorMm: 2 }]]);
  const ctx = { window: {}, navigator: { hardwareConcurrency: 8 }, bodies, weldGroups, activeBodyId: null, console, Math, Float32Array, Float64Array, Uint32Array,
    Array, Object, Map, Number, Error, Promise, performance, meshAssetUrl: p => p, isFinite, document: undefined,
    familyOf: r => ({ options: { trimToNodes: r.family === 'beam' } }) };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(REPO, '14-weld-bake.js'), 'utf8'), ctx, { filename: '14-weld-bake.js' });
  const specs = [{ bodyId: 'L', solid: false, recipe: GYR, bbox: bodies.get('L').bbox }, { bodyId: 'B', solid: false, recipe: BEAM, bbox: bodies.get('B').bbox },
    { bodyId: 'S', solid: true, recipe: null, bbox: bodies.get('S').bbox }];
  call(ctx, 'decorateWeldSpecs(__s,"g")', { __s: specs });
  check(specs[0].structXform && specs[0].structXform.isoOffsetMm === 0.12 && specs[0].structXform.spatialOffsetMm.join() === '0.7,-0.4,0.9' &&
    specs[0].fill === 'skin' && specs[0].skinMm === 1.5 && !specs[0].pruneToNodes, 'f decorate: lattice member gets transform + skin, no trim for a non-beam family');
  check(!specs[1].structXform && specs[1].pruneToNodes === true && specs[1].pruneInsetMult === 1.5 && !specs[1].fill, 'f decorate: identity transform is omitted; beam gets trim + inset multiplier');
  check(specs.every(s => s.joinRule === 'anchor' && s.anchorMm === 2) && !specs[2].structXform && !specs[2].fill, 'f decorate: join rule on every spec, per-body settings only on lattice members');
  const sp0 = { solid: false, recipe: BEAM, shapeSdfData: new Float32Array(N * N * N).buffer, shapeN: N, bbox: { mnx: 0, mny: 0, mnz: 0, mxx: 10, mxy: 10, mxz: 10 }, pruneToNodes: true };
  const cr = call(ctx, 'cropSpecToRegion(__s,{min:[0,0,0],max:[2,2,2]},0.1)', { __s: sp0 });
  check(!cr.shapeCrop, 'f crop: a trimmed beam member keeps its whole grid');
  const cr2 = call(ctx, 'cropSpecToRegion(__s,{min:[0,0,0],max:[2,2,2]},0.1)', { __s: Object.assign({}, sp0, { pruneToNodes: false }) });
  check(!!cr2.shapeCrop, 'f crop: an untrimmed member is still cropped');
  const gbb = { mnx: -5, mny: -5, mnz: -5, mxx: 60, mxy: 20, mxz: 20 };
  const lat = { solid: false, recipe: GYR, bbox: { mnx: 20, mny: 0, mnz: 0, mxx: 30, mxy: 10, mxz: 10 }, bodyId: 'L' };
  const sol = { solid: true, recipe: null, bbox: { mnx: 0, mny: 0, mnz: 0, mxx: 20, mxy: 10, mxz: 10 }, bodyId: 'S' };
  bodies.set('S', { posArr: new Float32Array([0,0,0, 20,0,0, 0,10,0, 20,10,0, 0,0,10, 20,0,10, 0,10,10, 20,10,10]), idxArr: new Uint32Array([0,2,1, 1,2,3, 4,5,6, 5,7,6, 0,1,4, 1,5,4, 2,6,3, 3,6,7, 0,4,2, 2,4,6, 1,3,5, 3,7,5]), bbox: sol.bbox });
  bodies.set('L', { bbox: lat.bbox });
  const p0 = call(ctx, 'planWeld(__s,0.4,0.2,__g)', { __s: [clone(lat), clone(sol)], __g: gbb });
  const p1 = call(ctx, 'planWeld(__s,0.4,0.2,__g)', { __s: [clone(lat, { joinRule: 'anchor', anchorMm: 2 }), clone(sol)], __g: gbb });
  check(p0.hybrid && p1.hybrid && Math.abs((p0.regions[0].min[0] - p1.regions[0].min[0]) - 2) < 1e-9 && p0.reachMm === p1.reachMm,
    `f plan: anchor widens the fine region by anchorMm (x min ${p0.regions[0].min[0].toFixed(2)} -> ${p1.regions[0].min[0].toFixed(2)}); union plan unchanged`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall weldfill checks passed');
process.exit(fails ? 1 : 0);
