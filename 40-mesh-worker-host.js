/* ============================================================
   F13LD.mesh · 40-mesh-worker-host.js
   Export quality tables, mesh worker launcher, cancel.
   Worker code: worker/mesh-worker.js (+ worker/m*.js)
   ============================================================ */
'use strict';

// ── Mesh worker ───────────────────────────────────────────────────────────────
// Preview oversample (voxels across feature) — still adaptive for the 3D texture bake.
const PREVIEW_OVERSAMPLE={draft:1,low:2,med:3,high:4,ultra:6};
// Shape SDF resolution for export, scaled to quality tier. Larger N gives finer
// cap-surface precision (≈ max_bbox_axis / N) at O(N³) bake cost. Approximate
// bake time for a typical orthopedic-scale mesh: draft ~1.5s, low ~5s, med ~10s,
// high ~35s, ultra ~80s. Re-baked lazily on first export; cached; replaced if
// a later export requests higher N. Float32 grid size: 1 MB (64³), 3.5 MB (96³),
// 8 MB (128³), 28 MB (192³), 67 MB (256³). Curve shifted down one step in
// rc11 (was 96/128/192/256/384) — 384³ at ultra was 226 MB / ~270 s, too heavy.
const EXPORT_SHAPE_SDF_N_BY_QUAL={draft:64,low:96,med:128,high:192,ultra:256};
// ── Export voxel edge per quality (mm) ───────────────────────────────────────
// Fixed per-tier voxel size. User selects a tier, gets that edge length — no
// per-recipe adaptation. Simpler and more predictable than the rc11 analytic
// estimator (which was buggy for RD: 1.19 mm edge at High from a wavelength-
// based formula unsuited to Gray-Scott regimes). Tradeoff: recipes with very
// thin walls under-resolve at lower tiers unless the user picks High/Ultra
// explicitly. MAX_EXPORT_VOXELS still applies as a safety net for huge bboxes.
const QUAL_EDGE_MM={draft:0.40,low:0.20,med:0.12,high:0.09,ultra:0.075};

let meshWorker=null;
// v0.5.1-rc4.0b: module-level handles for the active export's timers so
// cancelMesh() can clear them. Previously elapsedTimer was a local inside
// triggerExport, so cancel terminated the worker but the elapsed counter kept
// climbing — making a cancelled export look like it was still running.
let _exportElapsedTimer=null;
let _exportTimeoutTimer=null;
let currentOversample=3; // preview oversample factor (2=draft,3=std,4=fine)
let _workerUrl=null;
function getMeshWorkerUrl(){
  // Worker code lives in worker/mesh-worker.js, which importScripts the
  // per-family SDF files (worker/m*.js) in order.
  if(!_workerUrl) _workerUrl=meshAssetUrl('worker/mesh-worker.js');
  return _workerUrl;
}
function showCancelBtn(show){const b=document.getElementById('cancelMeshBtn');if(b)b.style.display=show?'':'none';}
window.cancelMesh=function(){
  if(meshWorker){meshWorker.terminate();meshWorker=null;}
  // v0.5.1-rc4.0b: clear the export timers so the elapsed counter stops and
  // the wall-clock backstop doesn't fire after a manual cancel.
  if(_exportElapsedTimer){clearInterval(_exportElapsedTimer);_exportElapsedTimer=null;}
  if(_exportTimeoutTimer){clearTimeout(_exportTimeoutTimer);_exportTimeoutTimer=null;}
  const ee=document.getElementById('expElapsed');if(ee)ee.style.display='none';
  if(window._cancelSdfBake)window._cancelSdfBake();
  if(window._cancelHuBake)window._cancelHuBake();
  hideComputing();setBtns(true);showCancelBtn(false);
  const eb=document.getElementById('expBtn');if(eb){eb.disabled=false;eb.classList.remove('sweeping');eb.textContent='Export 3MF';}
};
