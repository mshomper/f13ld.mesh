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

// Serial fallback — used when worker spawn fails or hardwareConcurrency≤2.
// Mirrors the in-export-worker bakeGridMM (line ~2526) so the result is
// numerically identical to the legacy path.
function _computeHUGridMM_serial(params, bbox, cellSizeMm, N, onProgress){
  const kernels=buildHUKernelsMM(params, bbox, cellSizeMm);
  const ddx=bbox.mxx-bbox.mnx, ddy=bbox.mxy-bbox.mny, ddz=bbox.mxz-bbox.mnz;
  const grid=new Float32Array(N*N*N);
  let minV=Infinity, maxV=-Infinity;
  for(let iz=0;iz<N;iz++){
    if(_huBakeAborted) throw new Error('cancelled');
    for(let iy=0;iy<N;iy++)for(let ix=0;ix<N;ix++){
      const v=evalHUFieldMM(kernels,
        bbox.mnx+(ix+0.5)/N*ddx,
        bbox.mny+(iy+0.5)/N*ddy,
        bbox.mnz+(iz+0.5)/N*ddz);
      grid[ix+iy*N+iz*N*N]=v;
      if(v<minV)minV=v; if(v>maxV)maxV=v;
    }
    if(onProgress) onProgress((iz+1)/N);
  }
  return {data:grid, N, fieldMin:minV, fieldMax:maxV};
}

async function computeHUGridMM(params, bbox, cellSizeMm, N, onProgress){
  _huBakeAborted=false;
  _activeHuWorkers=[];
  const hc=navigator.hardwareConcurrency||2;
  const nWorkers=Math.max(1, Math.min(12, hc-1, N));
  if(nWorkers<=1){
    return _computeHUGridMM_serial(params, bbox, cellSizeMm, N, onProgress);
  }
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
    console.warn('[HU bake] parallel workers failed, falling back to serial:',e);
    return _computeHUGridMM_serial(params, bbox, cellSizeMm, N, onProgress);
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
  _activeHuWorkers.forEach(w=>{ try{ w.terminate(); }catch(_){} });
  _activeHuWorkers=[];
};
