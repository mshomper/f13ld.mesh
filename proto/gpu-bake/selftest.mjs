// proto/gpu-bake/selftest.mjs -- runs without a GPU.
//   node proto/gpu-bake/selftest.mjs               real field vs page CPU reference, float32 emulation,
//                                                  hybrid pass (i)-(iii) at 64^3 and 128^3
//   node proto/gpu-bake/selftest.mjs --expect-break  negative control: perturbs one kernel constant
//                                                  (the coordinate scale) by 1e-6 relative in the
//                                                  EMULATED kernel; exits 0 only if the compare shows a
//                                                  non-zero max difference AND the hybrid FAILs.
// The "float32 emulation" is Math.fround after every operation: NOT a GPU.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadWorkerCode, WORKER_FILES } from './lib/loader.mjs';
import { readWorkerSources, REPO_ROOT } from './lib/node-sources.mjs';
import { gridDims, cubeGrid, bakeCpu, axisTables, forEachEdge, edgeCount, pointCoords, QUALITY_EDGE_MM } from './lib/grid.mjs';
import { cpuField, f32Tables, setPreviewRange } from './lib/field.mjs';
import { RECIPES, RECIPE_LABEL, freshRecipe, kernelParams } from './lib/params.mjs';
import { emuBake, mirrorBake } from './lib/emu.mjs';
import { ESC, K_COVER, bandFor } from './lib/bands.mjs';
import { hybridPass, judgeHybrid, compareF32 } from './lib/hybrid.mjs';
import { BakePool } from './lib/parallel.mjs';

const EXPECT_BREAK = process.argv.includes('--expect-break');
const PERTURB = { name: 'fs', rel: 1e-6 };      // coordinate scale: pi/5 (and the TPMS cell scale constants) * (1 + 1e-6)
const t0 = Date.now();
const sec = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
const sci = v => v.toExponential(3);
const pct = v => (100 * v).toFixed(4) + '%';

const sources = readWorkerSources();
const page = loadWorkerCode(sources);              // the page's loader (new Function)

// The independent "real" side: the tests/ way (vm context, as tests/previewparity.js and slabbake.js).
function loadReal() {
  const wk = { self: { postMessage() {} }, console, Math, Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int32Array,
    Int16Array, Int8Array, Array, Object, JSON, Error, WeakMap, Map, Set, Number, String, Boolean, isFinite, isNaN, parseFloat, parseInt,
    Infinity, NaN, ArrayBuffer, performance: { now: () => 0 } };
  vm.createContext(wk);
  for (const f of WORKER_FILES) vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, 'worker', f), 'utf8'), wk, { filename: f });
  const get = n => vm.runInContext(n, wk);
  return { buildExportField: get('buildExportField'), weldGridDims: get('weldGridDims'), weldBakeLayers: get('weldBakeLayers') };
}
const real = loadReal();

function recipeFor(key) {
  const r = freshRecipe(key);
  if (RECIPES[key].family === 'grain') setPreviewRange(page, r);   // as the app: export reads the preview bake's range
  return r;
}
const sameBits = (a, b) => { for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return i; return -1; };

async function main() {
  const pool = new BakePool();
  console.log('=== F13LD.mesh GPU bake selftest (Node, no GPU; float32 emulation is Math.fround, NOT a GPU) ===');
  console.log('sign convention: field = -sdf = Manifold convention, positive inside; inside means value > 0');
  console.log(`threads: ${pool.count}; band = K(${K_COVER}) x quadrature error budget, ESC(emulation) = 2^-24`);

  // ---- grid: page grid walker vs real m31 ----
  if (!EXPECT_BREAK) {
    let gridOk = true;
    for (const n of [16, 64, 128, 256]) {
      const a = cubeGrid(n), b = real.weldGridDims([-5, -5, -5], [5, 5, 5], 10 / n);
      if (a.n.join() !== String(Array.from(b.n)) || a.n[0] !== n || a.mainCount !== b.mainCount || a.offCount !== b.offCount) gridOk = false;
    }
    for (const q of Object.keys(QUALITY_EDGE_MM)) {
      const e = QUALITY_EDGE_MM[q], a = gridDims([-5, -5, -5], [5, 5, 5], e), b = real.weldGridDims([-5, -5, -5], [5, 5, 5], e);
      if (a.n.join() !== String(Array.from(b.n)) || a.s.join() !== String(Array.from(b.s))) gridOk = false;
    }
    check(gridOk, 'grid dims equal real weldGridDims (n=16/64/128/256 and every export quality edge)');
    const g8 = cubeGrid(8); let ec = 0; forEachEdge(g8, () => ec++);
    check(ec === edgeCount(g8), `edge enumeration count matches closed form (n=8: ${ec})`);
  }

  // ---- per recipe at 64^3: real vs page reference, kernel mirror, emulation ----
  const keys64 = EXPECT_BREAK ? [] : ['tpms', 'tpms4', 'grain'];
  const cache = {};      // key -> { recipe, params, cpu64, emu64 }
  for (const key of keys64) {
    const recipe = recipeFor(key), g = cubeGrid(64), total = g.mainCount + g.offCount;
    console.log(`\n--- ${RECIPE_LABEL[key]} at 64^3 (${g.n.join('x')} cells, ${g.mainCount} main + ${g.offCount} offset = ${total} points) ---`);
    const params = kernelParams(page, key, recipe);
    if (params.meta.source) console.log('normalisation range from CPU: ' + params.meta.source + `  mid=${params.meta.mid} halfR=${params.meta.halfR}`);
    // real: buildExportField + weldBakeLayers, loaded the tests/ way
    const fnReal = real.buildExportField({ mode: 'export', recipe, edgeWorld: g.edge }, g.edge, null);
    const gr = real.weldGridDims(g.min, g.max, g.edge);
    const L = real.weldBakeLayers(fnReal, gr, 0, gr.layers, false);
    const realAll = new Float64Array(total); realAll.set(L.main, 0); realAll.set(L.off, g.mainCount);
    const cpu = await pool.cpu(key, recipe, 64);          // page CPU reference (page loader + own grid walker)
    const bad = sameBits(realAll, cpu);
    check(bad < 0, `page CPU reference == real buildExportField + weldBakeLayers, bit for bit at all ${total} points` + (bad >= 0 ? ` (first diff at ${bad})` : ''));
    // kernel formulas in float64 (no rounding): must equal the real field bit for bit
    const mir = mirrorBake(params, axisTables(g), g);
    const badM = sameBits(mir, cpu);
    check(badM < 0, `kernel mirror in float64 == real field, bit for bit (kernel formulas and operation order)` + (badM >= 0 ? ` (first diff at ${badM}: ${mir[badM]} vs ${cpu[badM]})` : ''));
    const emu = await pool.emu(key, recipe, 64);
    const c = compareF32(emu, cpu);
    const band = bandFor(params, ESC.emu);
    console.log(`float32 emulation (not a GPU): max abs diff ${sci(c.maxDiff)}, sign changes vs CPU ${c.flips}, non-finite ${c.nonFinite}`);
    check(c.maxDiff < band && c.nonFinite === 0, `observed emulation error ${sci(c.maxDiff)} < BAND ${sci(band)} (ratio ${(band / Math.max(c.maxDiff, 1e-300)).toFixed(1)}x)`);
    cache[key] = { recipe, params, cpu, emu, g, band, c };
  }

  // ---- hybrid at 64^3 and 128^3 ----
  const hyb = EXPECT_BREAK ? [['tpms', 128], ['tpms4', 128], ['grain', 128], ['grain', 64]] : [['tpms', 64], ['tpms4', 64], ['grain', 64], ['tpms', 128], ['grain', 128]];
  let breakFail = 0, breakMaxDiff = 0, breakRuns = 0;
  for (const [key, n] of hyb) {
    const g = cubeGrid(n), total = g.mainCount + g.offCount;
    let ent = (n === 64 && cache[key]) ? cache[key] : null;
    const recipe = ent ? ent.recipe : recipeFor(key);
    const params = ent ? ent.params : kernelParams(page, key, recipe);
    const cpu = ent ? ent.cpu : await pool.cpu(key, recipe, n);
    const emu = (ent && !EXPECT_BREAK) ? ent.emu : await pool.emu(key, recipe, n, EXPECT_BREAK ? PERTURB : undefined);
    const band = bandFor(params, ESC.emu);                // fixed from the kernel parameters; the CPU bake is not consulted
    const fn = cpuField(page, recipe, g.edge), xyz = [0, 0, 0];
    const evalAt = t => { pointCoords(g, t, xyz); return fn([xyz[0], xyz[1], xyz[2]]); };
    const c = compareF32(emu, cpu);
    const h = hybridPass(emu, g, band, evalAt);
    const j = judgeHybrid(h, emu, cpu, g, band);
    console.log(`\n--- hybrid: ${RECIPE_LABEL[key]} at ${n}^3 (${total} points)${EXPECT_BREAK ? ' [PERTURBED kernel: coordinate scale x (1+1e-6)]' : ''} ---`);
    console.log(`emulation vs CPU: max abs diff ${sci(c.maxDiff)}, sign changes ${c.flips}`);
    console.log(`BAND ${sci(band)}; re-evaluated ${j.reEvaluated} of ${total} = ${pct(j.share)} (band ${pct(j.shareA)} + sign-changing-edge ends ${pct(j.shareB)}); sign-changing edges ${j.edges}`);
    console.log(`(i) signs equal CPU: ${j.i ? 'yes' : 'NO, ' + j.signMismatch + ' differ'}   (ii) edge ends bit-exact: ${j.ii ? 'yes' : 'NO, ' + j.edgeBad + ' edges'}   (iii) escapes = ${j.escapes}   -> ${j.pass ? 'PASS' : 'FAIL'}`);
    console.log(`(iv) band holds (max |f32-CPU| ${sci(j.maxErr)} <= BAND ${sci(band)}): ${j.bandHolds ? 'yes' : 'NO, ' + j.bandViolations + ' points over'}   -> hybrid ${j.certified ? 'PASS' : 'FAIL'}`);
    if (EXPECT_BREAK) { breakRuns++; if (!j.certified) breakFail++; breakMaxDiff = Math.max(breakMaxDiff, c.maxDiff); console.log(`  [${sec()}]`); continue; }
    check(j.certified, `hybrid (i)(ii)(iii)(iv) ${RECIPE_LABEL[key]} ${n}^3, escapes ${j.escapes}, re-evaluated ${pct(j.share)}`);
    console.log(`  [${sec()}]`);
  }
  pool.close();

  if (EXPECT_BREAK) {
    console.log(`\nnegative control: max abs diff ${sci(breakMaxDiff)} (must be > 0), hybrid FAIL in ${breakFail} of ${breakRuns} runs (must be all)`);
    const ok = breakMaxDiff > 0 && breakFail === breakRuns && breakRuns > 0;
    console.log(ok ? 'PASS the break was noticed (exit 0)' : 'FAIL the break went unnoticed (exit 1)');
    process.exit(ok ? 0 : 1);
  }
  console.log(`\n${failures ? 'SELFTEST FAILED: ' + failures + ' check(s)' : 'SELFTEST PASSED'} in ${sec()}`);
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
