// proto/gpu-bake/main.mjs -- the bench page. Compare (GPU vs CPU, hybrid pass), Bench (GPU vs CPU
// time), Copy log. The CPU side is the real worker field code (worker/m05 .. m32) loaded in the
// browser; the GPU side is lib/wgsl.mjs. Every GPU speed shown here comes from the machine the
// page runs on; the expedition itself ran none.
import { loadWorkerCode, WORKER_FILES } from './lib/loader.mjs';
import { cubeGrid, cubeGridForEdge, bakeCpu, pointCoords, totalPoints, QUALITY_EDGE_MM } from './lib/grid.mjs';
import { cpuField, flatTables, setPreviewRange } from './lib/field.mjs';
import { RECIPE_LABEL, RECIPES, freshRecipe, kernelParams } from './lib/params.mjs';
import { ESC, K_COVER, bandFor, lipschitzBound, trigArgInfo } from './lib/bands.mjs';
import { hybridPass, judgeHybrid, compareF32 } from './lib/hybrid.mjs';
import { GpuBaker } from './lib/wgsl.mjs';

const $ = id => document.getElementById(id);
const FAMILIES = ['tpms', 'tpms4', 'grain'];
const lines = [];           // the log (header + one entry per finished step)
const results = [];         // finished Compare / Bench result lines
let worker = null, baker = null, gpuNote = '', busy = false;
const setup = {};           // adapter + device ms, shader compile ms per kernel

function log(msg, cls) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = msg;
  $('out').appendChild(d);
  d.scrollIntoView({ block: 'nearest' });
}
const sci = v => v.toExponential(3);
const pct = v => (100 * v).toFixed(3) + '%';
const mb = b => (b / 1048576).toFixed(1) + ' MB';
const tick = () => new Promise(r => setTimeout(r, 0));

async function loadSources() {
  if (window.__WORKER_SRC__) return window.__WORKER_SRC__;
  const out = {};
  for (const f of WORKER_FILES) {
    const r = await fetch(new URL('../../worker/' + f, location.href));
    if (!r.ok) throw new Error('cannot fetch worker/' + f + ' (' + r.status + '); serve the repo root with proto/gpu-bake/serve.mjs');
    out[f] = await r.text();
  }
  return out;
}

function setBusy(b, label) {
  busy = b;
  for (const id of ['btnCompare', 'btnBench']) $(id).disabled = b || !baker;
  $('status').textContent = label || '';
}

// CPU bake on the main thread in z chunks, so the page stays responsive.
async function bakeCpuAsync(fn, g, label) {
  const out = new Float64Array(totalPoints(g)), S = 16, nz1 = g.n[2] + 1, nz2 = g.n[2] + 2;
  const at = (len, t) => Math.round(len * t / S);
  const t0 = performance.now();
  for (let c = 0; c < S; c++) {
    bakeCpu(fn, g, { main: [at(nz1, c), at(nz1, c + 1)], off: [at(nz2, c), at(nz2, c + 1)] }, out);
    $('status').textContent = `${label}: CPU bake ${Math.round(100 * (c + 1) / S)}%`;
    await tick();
  }
  return { cpu: out, ms: performance.now() - t0 };
}

function recipeFor(key) {
  const r = freshRecipe(key);
  if (RECIPES[key].family === 'grain') setPreviewRange(worker, r);   // as the app: export reads the preview bake's range
  return r;
}

async function compareOne(key, n) {
  const label = `${RECIPE_LABEL[key]} ${n}^3`;
  const recipe = recipeFor(key), g = cubeGrid(n), total = totalPoints(g);
  const params = kernelParams(worker, key, recipe), tables = flatTables(g);
  $('status').textContent = `${label}: GPU bake`;
  let gpu;
  try { gpu = await baker.bake(params, g, tables); }
  catch (e) { const m = `[${label}] SKIPPED GPU bake: ${e.message}`; log(m, 'warn'); results.push(m); return; }
  const fn = cpuField(worker, recipe, g.edge);
  const { cpu, ms: cpuMs } = await bakeCpuAsync(fn, g, label);
  const c = compareF32(gpu.values, cpu);
  const xyz = [0, 0, 0];
  const evalAt = t => { pointCoords(g, t, xyz); return fn([xyz[0], xyz[1], xyz[2]]); };
  const bandGpu = bandFor(params, ESC.gpu), bandSpec = bandFor(params, ESC.spec);
  $('status').textContent = `${label}: hybrid pass`; await tick();
  const h1 = hybridPass(gpu.values, g, bandGpu, evalAt), j1 = judgeHybrid(h1, gpu.values, cpu, g, bandGpu);
  await tick();
  const h2 = hybridPass(gpu.values, g, bandSpec, evalAt), j2 = judgeHybrid(h2, gpu.values, cpu, g, bandSpec);
  const yn = v => v ? 'yes' : 'NO';
  const row = j => `(i) signs equal CPU: ${yn(j.i)} | (ii) edge ends bit-exact: ${yn(j.ii)}${j.ii ? '' : ' (' + j.edgeBad + ' edges)'} | (iii) escapes: ${j.escapes} | (iv) band holds: ${yn(j.bandHolds)} (max err ${sci(j.maxErr)})`;
  const head = `[${label}] ${total} points | GPU vs CPU: max abs diff ${sci(c.maxDiff)}, sign changes ${c.flips}, non-finite ${c.nonFinite}`;
  const l1 = `   assumed-GPU band ${sci(bandGpu)}: re-evaluated ${j1.reEvaluated} = ${pct(j1.share)} (band ${pct(j1.shareA)} + edge ends ${pct(j1.shareB)}) | ${row(j1)} -> ${j1.certified ? 'PASS' : 'FAIL'}`;
  const l2 = `   WGSL-spec band ${sci(bandSpec)}: re-evaluated ${j2.reEvaluated} = ${pct(j2.share)} (band ${pct(j2.shareA)} + edge ends ${pct(j2.shareB)}) | ${row(j2)} -> ${j2.certified ? 'PASS' : 'FAIL'}`;
  const l3 = `   GPU ${gpu.gpuMs != null ? gpu.gpuMs.toFixed(2) + ' ms (timestamps)' : 'no timestamps'}, ${gpu.wallMs.toFixed(1)} ms wall incl. readback | CPU 1 thread (main thread, chunked) ${cpuMs.toFixed(0)} ms`;
  const ta = trigArgInfo(params), Lb = lipschitzBound(params), eNb = Math.max(g.s[0], g.s[1], g.s[2]);
  let skip = 0; for (let t = 0; t < total; t++) if (Math.abs(cpu[t]) > Lb * eNb) skip++;
  const l4 = `   max |argument| reaching sin/cos ${ta.maxArg.toFixed(2)} rad (${ta.reduced ? 'range-reduced to [-pi, pi] first' : 'no reduction needed'}) | CPU skip share (rigorous Lipschitz bound L=${Lb.toFixed(3)}, e=${eNb.toFixed(4)}): ${pct(skip / total)}`;
  for (const [t, ok] of [[head, true], [l4, true], [l1, j1.certified], [l2, j2.certified], [l3, true]]) { log(t, ok ? '' : 'fail'); results.push(t); }
  if (RECIPES[key].family === 'grain') results.push(`   normalisation range from CPU: ${params.meta.source}`);
}

async function runCompare(sizes = [64, 128]) {
  setBusy(true);
  results.push('--- Compare ---');
  log('--- Compare: GPU vs CPU, hybrid pass ---', 'h');
  try {
    for (const n of sizes) for (const key of FAMILIES) await compareOne(key, n);
  } catch (e) { log('Compare stopped: ' + e.message, 'fail'); results.push('Compare stopped: ' + e.message); }
  setBusy(false, 'Compare done'); showReport();
}

// ---- Bench -------------------------------------------------------------------------------
// CPU one-thread time: a sample of the grid's points through the real field, scaled to the grid.
function cpuMsSampled(fn, g, sample = 150000) {
  const total = totalPoints(g), stride = Math.max(1, Math.floor(total / sample)), xyz = [0, 0, 0];
  let cnt = 0; const t0 = performance.now();
  let sink = 0;
  for (let t = 0; t < total; t += stride) { pointCoords(g, t, xyz); sink += fn([xyz[0], xyz[1], xyz[2]]); cnt++; }
  const ms = performance.now() - t0;
  if (sink === 12345.678) log('');   // keep the loop live
  return { ms: ms * total / cnt, usPerPt: ms * 1000 / cnt, sampled: cnt };
}

async function runBench() {
  setBusy(true);
  results.push('--- Bench ---');
  log('--- Bench: GPU bake (incl. readback) vs CPU one thread ---', 'h');
  const sizes = [];
  for (const n of [128, 256]) sizes.push({ name: `${n}^3`, g: cubeGrid(n) });
  for (const q of Object.keys(QUALITY_EDGE_MM)) { const g = cubeGridForEdge(QUALITY_EDGE_MM[q]); sizes.push({ name: `export ${q} (edge ${QUALITY_EDGE_MM[q]} mm, 10 mm domain: ${g.n[0]}^3)`, g }); }
  try {
    for (const key of ['tpms', 'grain']) {
      const recipe = recipeFor(key), params = kernelParams(worker, key, recipe), fn = cpuField(worker, recipe, 0.1);
      for (const s of sizes) {
        const g = s.g, total = totalPoints(g), bytes = total * 4, label = `${RECIPE_LABEL[key]} ${s.name}`;
        $('status').textContent = label;
        const head = `[${label}] ${total} points, ${mb(bytes)} float32`;
        if (bytes > Math.min(baker.limits.maxStorageBufferBindingSize, baker.limits.maxBufferSize)) {
          const m = `${head}: skipped, does not fit the adapter limits (maxStorageBufferBindingSize ${mb(baker.limits.maxStorageBufferBindingSize)}); would be split into z slabs`;
          log(m, 'warn'); results.push(m); continue;
        }
        const tables = flatTables(g);
        let wall = [], gp = [], vals = null;
        try {
          await baker.bake(params, g, tables);                       // warm-up (first dispatch; pipelines are already compiled)
          for (let r = 0; r < 5; r++) { const o = await baker.bake(params, g, tables); wall.push(o.wallMs); if (o.gpuMs != null) gp.push(o.gpuMs); vals = o.values; await tick(); }
        } catch (e) { const m = `${head}: GPU bake failed: ${e.message}`; log(m, 'warn'); results.push(m); continue; }
        const med = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
        const cp = cpuMsSampled(cpuField(worker, recipe, g.edge), g);
        const m = `${head}: GPU dispatch + readback ${med(wall).toFixed(1)} ms (median of 5)` + (gp.length ? `, GPU timestamps ${med(gp).toFixed(2)} ms` : ', no timestamp-query') +
          ` | CPU 1 thread bake ${cp.ms.toFixed(0)} ms (${cp.usPerPt.toFixed(2)} us/pt, sampled ${cp.sampled} pts, scaled)`;
        log(m); results.push(m); await tick();
        // hybrid pass on the GPU values: CPU scan and CPU float64 re-evaluation timed separately
        $('status').textContent = label + ': hybrid pass';
        const fn = cpuField(worker, recipe, g.edge), xyz2 = [0, 0, 0], bandG = bandFor(params, ESC.gpu);
        const h = hybridPass(vals, g, bandG, t => { pointCoords(g, t, xyz2); return fn([xyz2[0], xyz2[1], xyz2[2]]); });
        const hm = `   hybrid (assumed-GPU band ${sci(bandG)}): CPU scan ${h.msScan.toFixed(0)} ms (band test + sign / edge scan), CPU re-evaluation ${h.msEval.toFixed(0)} ms for ${h.nA + h.nB} points = ${pct((h.nA + h.nB) / total)} (band ${pct(h.nA / total)} + edge ends ${pct(h.nB / total)}); ` +
          `total hybrid wall = ${(med(wall) + h.msTotal).toFixed(0)} ms (GPU ${med(wall).toFixed(0)} + CPU ${h.msTotal.toFixed(0)}) vs CPU one-thread bake ${cp.ms.toFixed(0)} ms`;
        log(hm); results.push(hm); await tick();
      }
    }
  } catch (e) { log('Bench stopped: ' + e.message, 'fail'); results.push('Bench stopped: ' + e.message); }
  setBusy(false, 'Bench done'); showReport();
}

function reportText() {
  const head = ['=== F13LD.mesh GPU bake bench', ...(gpuNote ? [gpuNote] : []),
    `user agent: ${navigator.userAgent}`,
    `sign convention: field = -sdf (Manifold, positive inside); inside = value > 0`,
    `bands: K=${K_COVER} x quadrature budget; ESC assumed-GPU 2^-16, WGSL-spec 2^-11 (see README)`,
    ''];
  return head.concat(results, ['', '=== end ===']).join('\n');
}
function showReport() { $('report').value = reportText(); }
async function copyLog() {
  showReport();
  const t = $('report').value;
  try { await navigator.clipboard.writeText(t); $('status').textContent = 'Log copied'; }
  catch (_) { $('report').select(); document.execCommand('copy'); $('status').textContent = 'Log selected and copied'; }
}

async function init() {
  $('btnCompare').addEventListener('click', () => { if (!busy) runCompare(); });
  $('btnBench').addEventListener('click', () => { if (!busy) runBench(); });
  $('btnCopy').addEventListener('click', copyLog);
  try { worker = loadWorkerCode(await loadSources()); log('Real worker field code loaded (' + WORKER_FILES.length + ' files).'); }
  catch (e) { log('Could not load the worker code: ' + e.message, 'fail'); return; }
  try {
    const tCreate = performance.now();
    baker = await GpuBaker.create((m, c) => log(m, c === 'err' ? 'fail' : c));
    setup.createMs = performance.now() - tCreate;
    const d = baker.describe();
    $('adapter').textContent = d[0].replace('adapter: ', '');
    $('limits').textContent = d.slice(1).join('\n');
    gpuNote = d.join('\n');
    for (const l of d) log(l);
    // compile both kernels now so shader errors show up immediately
    for (const k of ['tpms', 'grain']) { const tp = performance.now(); await baker.pipeline(k); setup[k] = performance.now() - tp; log(`WGSL kernel "${k}" compiled in ${setup[k].toFixed(0)} ms`); }
    const sline = `setup: requestAdapter + requestDevice ${setup.createMs.toFixed(0)} ms; createComputePipeline (shader compile) tpms ${setup.tpms.toFixed(0)} ms, grain ${setup.grain.toFixed(0)} ms`;
    log(sline); results.push(sline);
  } catch (e) {
    baker = null;
    $('adapter').textContent = 'none';
    const m = e.noGpu ? 'WebGPU is not available here: ' + e.message + '. The page needs a browser with WebGPU and a GPU adapter.' : 'GPU setup failed: ' + e.message;
    $('noGpu').textContent = m; $('noGpu').hidden = false;
    gpuNote = 'adapter: none (' + m + ')';
    log(m, 'fail');
  }
  setBusy(false, baker ? 'Ready' : 'No WebGPU');
  showReport();
  window.__ready = true;
  window.__gpuBake = { runCompare, runBench, results, reportText, hasGpu: () => !!baker };
  // ?auto=compare64 runs Compare at 64^3 only and then sets the page title to DONE (headless smoke test)
  if (baker && new URLSearchParams(location.search).get('auto') === 'compare64') { await runCompare([64]); document.title = 'DONE'; }
  else if (!baker && new URLSearchParams(location.search).get('auto')) document.title = 'DONE no webgpu';
}
init();
