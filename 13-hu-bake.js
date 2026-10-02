/* ============================================================
   F13LD.mesh · 13-hu-bake.js
   Hyperuniform field pre-bake worker pool (v0.5.0-rc20).
   Worker code: worker/hu-bake-worker.js
   ============================================================ */
'use strict';

// ── HU field bake worker pool (v0.5.0-rc20) ─────────────────────────────────
// Mirrors the shape-SDF Z-slab worker pattern. The HU pre-bake (24k+ kernels
// over an N_hu³ grid) was previously a serial loop inside the export worker
// (bakeGridMM, ~10s for typical orthopedic shapes). Moving to a parallel
// main-thread bake hands a finished grid to the export worker, so the export
// only does composition + levelSet. Each HU worker rebuilds its own kernels
// from a small params object — same RNG seed → bit-identical kernels across
// workers, slabs concatenate to the same grid as the serial path.
let _huBakeAborted=false;
let _activeHuWorkers=[];
let _huBakeWorkerUrl=null;
function getHuBakeWorkerUrl(){
  // Worker code lives in worker/hu-bake-worker.js — pure math, no imports.
  if(!_huBakeWorkerUrl) _huBakeWorkerUrl=meshAssetUrl('worker/hu-bake-worker.js');
  return _huBakeWorkerUrl;
}

// v0.8.1: the old main-thread serial fallback called kernel functions that
// only exist inside the worker files, so it crashed with "buildHUKernelsMM is
// not defined" on machines reporting ≤2 cores. The pool now always runs with at
// least one worker (identical result: each worker rebuilds the same kernels
// from the same seed), and a worker failure is reported as a clear error.
async function computeHUGridMM(params, bbox, cellSizeMm, N, onProgress){
  _huBakeAborted=false;
  _activeHuWorkers=[];
  const hc=navigator.hardwareConcurrency||2;
  const nWorkers=Math.max(1, Math.min(12, hc-1, N));
  // Partition Z-slices into contiguous slabs.
  const perWorker=Math.floor(N/nWorkers);
  const extra=N-perWorker*nWorkers;
  const slabs=[];
  let z=0;
  for(let w=0;w<nWorkers;w++){
    const len=perWorker+(w<extra?1:0);
    slabs.push({workerId:w, zStart:z, zEnd:z+len});
    z+=len;
  }
  const progressByWorker=new Array(nWorkers).fill(0);
  const sliceWeights=slabs.map(s=>(s.zEnd-s.zStart)/N);
  const reportProgress=()=>{
    if(!onProgress) return;
    let pct=0;
    for(let i=0;i<nWorkers;i++) pct+=progressByWorker[i]*sliceWeights[i];
    onProgress(pct);
  };
  const results=new Array(nWorkers);
  let minV=Infinity, maxV=-Infinity;
  try{
    await Promise.all(slabs.map(slab=>new Promise((resolve,reject)=>{
      let worker;
      try{ worker=new Worker(getHuBakeWorkerUrl()); }
      catch(we){ reject(we); return; }
      worker._reject=reject;   // lets _cancelHuBake settle this promise
      _activeHuWorkers.push(worker);
      worker.onmessage=e=>{
        const d=e.data;
        if(d.type==='progress'){
          progressByWorker[d.workerId]=d.pct;
          reportProgress();
        } else if(d.type==='done'){
          results[d.workerId]={slab:new Float32Array(d.slab), zStart:d.zStart, zEnd:d.zEnd};
          if(d.fieldMin<minV) minV=d.fieldMin;
          if(d.fieldMax>maxV) maxV=d.fieldMax;
          progressByWorker[d.workerId]=1;
          reportProgress();
          worker.terminate();
          resolve();
        } else if(d.type==='error'){
          worker.terminate();
          reject(new Error('hu worker '+slab.workerId+': '+d.message));
        }
      };
      worker.onerror=e=>{ worker.terminate(); reject(new Error(e.message||'hu worker error')); };
      worker.postMessage({
        params, bbox, cellSizeMm, N,
        zStart:slab.zStart, zEnd:slab.zEnd,
        workerId:slab.workerId
      });
    })));
  }catch(e){
    _activeHuWorkers.forEach(w=>{ try{ w.terminate(); }catch(_){} });
    _activeHuWorkers=[];
    if(_huBakeAborted||e.message==='cancelled') throw new Error('cancelled');
    throw new Error('Hyperuniform field pre-bake failed — '+(e.message||e));
  }
  _activeHuWorkers=[];
  // Stitch slabs into the final grid.
  const grid=new Float32Array(N*N*N);
  for(const r of results){
    grid.set(r.slab, r.zStart*N*N);
  }
  return {data:grid, N, fieldMin:minV, fieldMax:maxV};
}

window._cancelHuBake=function(){
  _huBakeAborted=true;
  // v0.8.1: a terminated worker never replies, so settle its promise here —
  // otherwise the export waiting on it hangs forever after Cancel.
  _activeHuWorkers.forEach(w=>{ try{ w.terminate(); }catch(_){} try{ w._reject&&w._reject(new Error('cancelled')); }catch(_){} });
  _activeHuWorkers=[];
};
