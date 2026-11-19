// proto/simplify-bench/page.mjs - the bench in the browser: same libraries and same candidate scripts as bench.mjs
// (lib/pipeline.mjs benchMesh), on a bundled Draft mesh or a dropped .slb / STL / OBJ file.
// Dev: served over http (node proto/gpu-mesh/serve.mjs style server, or any static server at the repo root) the page
// fetches the worker scripts from ../../worker. Single file: build-single.mjs inlines everything and strips the
// DEV blocks below. One thread, on the page's main thread (the page freezes while a bench runs, a few seconds).
import { buildCtx } from './lib/ctxbuild.mjs';
import { benchMesh } from './lib/pipeline.mjs';
import { parseSlabs, parseMeshFile } from './lib/slabparse.mjs';
import { selfTest } from './lib/selftest.mjs';

const SRC = (typeof window !== 'undefined' && window.__F13LD_BENCH_SRC__) || null;
const WORKER_FILES = ['worker/m31-weld-grid.js', 'worker/m34-slab-mesher.js', 'worker/m35-slab-cleanup.js', 'worker/m36-slab-pool.js'];
const CAND_FILES = ['cand/a.js', 'cand/fast.js', 'cand/lazy.js', 'cand/window.js', 'cand/rings.js'];
const METHODS = {
  today: { label: 'today (m35 / m36)', patches: [] },
  A: { label: 'A: Regularize flag', patches: ['cand/a.js'] },
  B1a: { label: 'B1a: same output, fast checks', patches: ['cand/fast.js'] },
  B1lazy: { label: 'B1a-lazy', patches: ['cand/fast.js', 'cand/lazy.js'] },
  B1b: { label: 'B1b: window tear repair', patches: ['cand/fast.js', 'cand/window.js'] },
  rings: { label: 'today with a 3-ring start', patches: ['cand/rings.js'] },
};
const BUNDLED = ['tpms-gyroid-sheet', 'noise-simplex-sheet', 'grain-hyperuniform', 'grain-spinodoid', 'foam2-open-lloyd', 'foam2-closed-kelvin-1cube'];

/*DEV*/
const DEV_URL = k => (k.startsWith('worker/') ? '../../' : './') + k;
/*END DEV*/
async function getText(key) {
  if (SRC) return SRC.files[key];
  /*DEV*/ return await (await fetch(DEV_URL(key))).text(); /*END DEV*/
  throw new Error('missing source ' + key);
}
async function getMeshopt() {
  if (SRC) return window.MeshoptSimplifier;
  /*DEV*/ { const m = await import('./vendor/meshopt_simplifier.js'); return m.MeshoptSimplifier; } /*END DEV*/
  throw new Error('meshoptimizer missing');
}
async function gunzip(bytes) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()); }
async function getBundled(name) {
  let gz;
  if (SRC) { const b = atob(SRC.meshes[name]); gz = Uint8Array.from(b, c => c.charCodeAt(0)); }
  /*DEV*/ else gz = new Uint8Array(await (await fetch('./data/' + name + '.draft.slb')).arrayBuffer()); /*END DEV*/
  return parseSlabs(await gunzip(gz));
}

// ---------- tiny DOM helpers ----------
const $ = id => document.getElementById(id);
const fmt = (x, d = 2) => (typeof x === 'number' && isFinite(x)) ? x.toFixed(d) : String(x);
const state = { mesh: null, texts: null, meshopt: null, busy: false };

async function ensureSources() {
  if (state.texts) return;
  state.texts = {}; for (const k of [...WORKER_FILES, ...CAND_FILES]) state.texts[k] = await getText(k);
  state.meshopt = await getMeshopt(); await state.meshopt.ready;
}
const makeCtx = async patches => buildCtx(WORKER_FILES.map(k => state.texts[k]), patches.map(k => state.texts[k]), state.meshopt);

function log(msg) { const el = $('log'); el.textContent += msg + '\n'; el.scrollTop = el.scrollHeight; }
function setBusy(b) { state.busy = b; document.body.classList.toggle('busy', b); }

function card(row, today) {
  const same = today && row.hash === today.hash;
  const rows = [
    ['time', `${fmt(row.totalMs, 0)} ms (${fmt(row.slabMs, 0)} slabs + ${fmt(row.finalMs, 0)} final)`],
    ['spread', `best of ${row.reps}, spread ${fmt(row.spreadMs, 0)} ms`],
    ['triangles', row.tris + (today && row !== today ? ` (${fmt(100 * (row.tris / today.tris - 1), 1)} % vs today)` : '')],
    ['open / non-manifold edges', `${row.open} / ${row.nonManifold}`],
    ['self-intersecting pairs', `${row.selfX} <small>${row.selfXNote}</small>`],
    ['deviation max', `${fmt(row.devMaxMm, 4)} mm (${fmt(row.devMaxCells, 3)} cells)`],
    ['deviation mean', `${fmt(row.devMeanMm, 4)} mm (${fmt(row.devMeanCells, 3)} cells)`],
    ['needles / min angle P5', `${fmt(row.needlePct, 2)} % / ${fmt(row.minAngleP5, 1)}°`],
    ['slab seam edges exactly kept', row.seamSlabsIdentical ? 'yes' : 'NO'],
    ['same output as today', today === row ? '(reference)' : (same ? 'yes, byte for byte' : 'no')],
  ];
  const d = document.createElement('div'); d.className = 'card' + (row.open || row.nonManifold || !row.seamSlabsIdentical ? ' bad' : '');
  d.innerHTML = `<h3>${row.label}</h3>` + rows.map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`).join('');
  return d;
}

async function run() {
  if (state.busy || !state.mesh) return;
  setBusy(true); $('cards').textContent = '';
  try {
    await ensureSources();
    const names = [...document.querySelectorAll('#methods input:checked')].map(i => i.value);
    if (!names.includes('today')) names.unshift('today');
    const full = $('full').checked, opts = full ? { siSample: 0, devSamples: 5000, reps: 2 } : { siSample: 6000, devSamples: 1500, reps: 1 };
    const { meta, slabs } = state.mesh;
    log(`${meta.family} (${meta.qual}, ${meta.slabs} slab${meta.slabs === 1 ? '' : 's'}, ${meta.rawTris} raw triangles); checks ${full ? 'on every triangle, 5000 deviation points per side' : 'sampled: 6000 triangles for self-intersections, 1500 deviation points per side'}`);
    const rows = [];
    await new Promise(r => setTimeout(r, 20));
    const res = await benchMesh(makeCtx, meta, slabs, names, METHODS, opts, row => { rows.push(row); $('cards').appendChild(card(row, rows[0])); log(`${row.label}: ${fmt(row.totalMs, 0)} ms, ${row.tris} triangles`); });
    log('done');
    void res;
  } catch (e) { log('error: ' + e.message); console.error(e); }
  setBusy(false);
}

async function runSelfTest() {
  if (state.busy) return;
  setBusy(true); await new Promise(r => setTimeout(r, 20));
  for (const t of selfTest()) log((t.ok ? 'PASS ' : 'FAIL ') + t.name + ' - ' + t.detail);
  setBusy(false);
}

async function loadFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    if (/\.slb$/i.test(file.name)) state.mesh = parseSlabs(bytes[0] === 0x1f ? await gunzip(bytes) : bytes);
    else state.mesh = parseMeshFile(bytes, file.name, +$('edge').value || 0.1);
    const m = state.mesh.meta; log(`loaded ${file.name}: ${m.rawTris} triangles, ${m.slabs} slab(s)`); $('meshName').textContent = file.name; $('run').disabled = false;
  } catch (e) { log('could not read ' + file.name + ': ' + e.message); }
}

async function init() {
  $('meshes').innerHTML = BUNDLED.map(n => `<option value="${n}">${n} (Draft)</option>`).join('');
  $('methods').innerHTML = Object.entries(METHODS).map(([k, v]) => `<label class="chip"><input type="checkbox" value="${k}" ${['today', 'B1a'].includes(k) ? 'checked' : ''}><span>${v.label}</span></label>`).join('');
  $('meshes').addEventListener('change', async () => { state.mesh = await getBundled($('meshes').value); $('meshName').textContent = $('meshes').value; $('run').disabled = false; });
  $('run').addEventListener('click', run); $('test').addEventListener('click', runSelfTest);
  $('open').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', e => { if (e.target.files[0]) loadFile(e.target.files[0]); });
  addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('drop'); });
  addEventListener('dragleave', () => document.body.classList.remove('drop'));
  addEventListener('drop', e => { e.preventDefault(); document.body.classList.remove('drop'); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
  state.mesh = await getBundled(BUNDLED[0]); $('meshName').textContent = BUNDLED[0]; $('run').disabled = false;
}
init().catch(e => log('start-up error: ' + e.message));
