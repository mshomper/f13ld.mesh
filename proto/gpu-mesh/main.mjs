// Page glue. WRITTEN BUT NOT EXECUTED by the expedition.
import { GpuMesher } from './gpu-mesher.mjs';
import { Viewer, toBinaryStl } from './viewer.mjs';
import { meshCpu } from './cpu-mesher.mjs';
import { closedCheck, signedVolume, nonManifoldVertexCount } from './meshcheck.mjs';
import { KIND_NAMES } from './tables.mjs';

const $ = id => document.getElementById(id);
const logEl = $('log');
function log(msg, cls) {
  const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = msg;
  logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight;
  (cls === 'err' ? console.error : console.log)(msg);
}
window.addEventListener('error', e => log('JS error: ' + e.message, 'err'));
window.addEventListener('unhandledrejection', e => log('Unhandled promise rejection: ' + (e.reason && e.reason.message || e.reason), 'err'));

const DEFAULT_THICK = [0.4, 0.6, 0.3];
const st = { kind: 0, N: 64, last: null };
const cells = () => Math.max(1, +$('iCells').value || 1);
const thick = () => Math.max(0.01, +$('iThick').value || 0.4);

function seg(id, fn) {
  $(id).addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    for (const x of $(id).children) x.classList.toggle('on', x === b);
    fn(+b.dataset.v);
  });
}

async function start() {
  log('F13LD.mesh GPU mesh prototype. Requesting adapter...');
  const gm = await GpuMesher.create(log);
  log(gm.describe());
  const view = new Viewer($('cv'), gm.device, log);
  const busy = on => { for (const id of ['bMesh', 'bCmp', 'bBench', 'bStl']) $(id).disabled = on; };

  seg('sKind', v => { st.kind = v; $('iThick').value = DEFAULT_THICK[v]; });
  seg('sRes', v => { st.N = v; });

  async function doMesh() {
    const res = await gm.mesh(st.N, st.kind, cells(), thick());
    st.last = res;
    view.setMesh(res.verts, res.idx, res.nT * 3);
    const t = res.times;
    log(`MESH ${KIND_NAMES[st.kind]} N=${st.N} cells=${cells()} wall=${thick()}: ${res.nT} triangles, ${res.nV} vertices. wall ms: field ${t.field.toFixed(1)}, count ${t.count.toFixed(1)}, scan ${t.scan.toFixed(1)}, readback ${t.readback.toFixed(1)}, emit ${t.emit.toFixed(1)}, total ${t.total.toFixed(1)}` +
      (t.gpu ? `. gpu timestamps ms: field ${t.gpu.field.toFixed(2)}, count ${t.gpu.count.toFixed(2)}, scan ${t.gpu.scan.toFixed(2)}, emit ${t.gpu.emit.toFixed(2)}` : ' (no timestamp-query on this adapter)'));
    return res;
  }

  async function compare() {
    const res = await doMesh();
    const gpu = await gm.readMesh(res);
    log('Comparing with the CPU reference (same tables, same tet split). Note: the GPU field is float32, the CPU reference computes the field in float64 (then stores float32), so tiny position differences are expected.');
    const t0 = performance.now();
    const cpu = meshCpu(st.N, st.kind, cells(), thick());
    log(`CPU reference: ${cpu.nT} triangles, ${cpu.nV} vertices (${(performance.now() - t0).toFixed(0)} ms)`);
    const tol = 1e-3 / st.N; // 1e-3 of a cell edge, in unit-box coordinates
    const line = (ok, s) => log((ok ? 'PASS ' : 'FAIL ') + s, ok ? 'pass' : 'fail');
    line(gpu.nT === cpu.nT, `triangle count GPU ${gpu.nT} vs CPU ${cpu.nT}`);
    line(gpu.nV === cpu.nV, `vertex count GPU ${gpu.nV} vs CPU ${cpu.nV}`);
    if (gpu.nV === cpu.nV) {
      let maxd = 0; for (let i = 0; i < gpu.positions.length; i++) maxd = Math.max(maxd, Math.abs(gpu.positions[i] - cpu.positions[i]));
      line(maxd <= tol, `vertex positions matched by edge id (same ordering): max difference ${maxd.toExponential(2)} box units = ${(maxd * st.N).toFixed(5)} cell; tolerance 1e-3 cell (${tol.toExponential(2)})`);
    } else log('SKIP vertex position compare: counts differ (a few float32 vs float64 sign flips near zero field are the usual cause)', 'warn');
    if (gpu.nT === cpu.nT) {
      let diff = 0; for (let i = 0; i < gpu.indices.length; i++) if (gpu.indices[i] !== cpu.indices[i]) diff++;
      line(diff === 0, `triangle index lists identical: ${diff} differing entries of ${gpu.indices.length}`);
    }
    const c = closedCheck(gpu.indices, gpu.nV), v = signedVolume(gpu.positions, gpu.indices);
    line(c.closed, `GPU mesh closed: edges ${c.edges}, OPEN_EDGES ${c.openEdges}, non-manifold edges ${c.nonManifold}, bad orientation ${c.badOrient}`);
    line(v > 0, `GPU mesh signed volume ${v.toFixed(6)} (CPU ${signedVolume(cpu.positions, cpu.indices).toFixed(6)})`);
    log(`info: non-manifold vertices GPU ${nonManifoldVertexCount(gpu.indices, gpu.nV)}`);
  }

  async function bench() {
    const rows = await gm.bench([64, 128, 256], st.kind, cells(), thick(), 5);
    const out = ['=== F13LD.mesh GPU mesh bench (paste this block back) ===', gm.describe(), `settings: ${KIND_NAMES[st.kind]} cells=${cells()} wall=${thick()}, 1 warm-up + 5 repeats, median ms`];
    for (const r of rows) {
      if (r.skipped) { out.push(`N=${r.N}: ${r.skipped.startsWith('buffer') ? 'skipped: buffer limits' : 'skipped: ' + r.skipped}`); continue; }
      const w = r.wall;
      out.push(`N=${r.N}: ${r.nT} tris, ${r.nV} verts | wall: field ${w.field.toFixed(2)} count ${w.count.toFixed(2)} scan ${w.scan.toFixed(2)} readback ${w.readback.toFixed(2)} emit ${w.emit.toFixed(2)} total ${w.total.toFixed(2)}` +
        (r.gpu ? ` | timestamps: field ${r.gpu.field.toFixed(2)} count ${r.gpu.count.toFixed(2)} scan ${r.gpu.scan.toFixed(2)} emit ${r.gpu.emit.toFixed(2)}` : ' | timestamps: n/a'));
    }
    out.push('=== end ===');
    log(out.join('\n'), 'pass');
  }

  async function stl() {
    if (!st.last) await doMesh();
    const m = await gm.readMesh(st.last);
    const blob = new Blob([toBinaryStl(m.positions, m.indices)], { type: 'model/stl' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `gpu-mesh-${KIND_NAMES[st.kind]}-${st.N}.stl`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    log(`STL: ${m.nT} triangles written`);
  }

  const guard = fn => async () => { busy(true); try { await fn(); } catch (e) { log('ERROR: ' + (e.message || e), 'err'); } finally { busy(false); } };
  $('bMesh').onclick = guard(doMesh);
  $('bCmp').onclick = guard(compare);
  $('bBench').onclick = guard(bench);
  $('bStl').onclick = guard(stl);
  $('bCopy').onclick = async () => { try { await navigator.clipboard.writeText(logEl.innerText); log('log copied'); } catch (e) { log('copy failed: ' + e.message, 'warn'); } };
  guard(doMesh)();
}

if (!navigator.gpu) {
  document.body.classList.add('nogpu');
} else {
  start().catch(e => log('START FAILED: ' + (e.message || e), 'err'));
}
