/* ============================================================
   F13LD.mesh · 12-shape-sdf-bake.js
   Shape SDF bake: worker pool orchestrator, narrow band, serial fallback.
   Worker code: worker/shape-sdf-worker.js
   ============================================================ */
'use strict';

// ── Shape SDF generation (three-mesh-bvh, CPU, N³ grid) ─────────────────────
// Returns { data: Float32Array, N, sdfMin, sdfMax } in mm.
// Sign: positive outside shape, negative inside (standard SDF convention).
// Magnitude from bvh.closestPointToPoint; sign from raycast-parity (odd hit
// count = inside). Robust for watertight meshes — avoids the face-normal
// sign-flip that occurs when the closest point lies on a shared edge or vertex.
// Module-level cancellation flag for the SDF bake. Set by window._cancelSdfBake
// (wired into cancelMesh so the existing ✕ cancel button aborts main-thread bakes
// just like it terminates worker jobs).
let _sdfBakeAborted=false;
let _activeSdfWorkers=[];

// ── SDF bake worker source ───────────────────────────────────────────────
// Each worker builds its own BVH from transferred pos/idx and bakes a Z-slab.
// Workers report progress within their slab and post the finished Float32
// slab back to the main thread for stitching into the final grid.
// Worker code lives in worker/shape-sdf-worker.js. It imports three +
// three-mesh-bvh dynamically (browser caches across workers after first load).
let _sdfWorkerUrl=null;
function getSdfWorkerUrl(){
  if(!_sdfWorkerUrl) _sdfWorkerUrl=meshAssetUrl('worker/shape-sdf-worker.js');
  return _sdfWorkerUrl;
}

// ── Narrow-band acceleration (v0.5.0-rc19) ────────────────────────────────
// For shape-SDF bakes at fine N (≥96), most voxels are far from the surface
// and only need a sign + rough magnitude. We pre-compute a coarse SDF (32³
// or 48³) for the "far" voxels via trilinear sampling, and reserve the
// expensive BVH closest-point + raycast for voxels within a narrow band
// around the surface. Triangle-bbox marking identifies the band: every
// voxel within ±bandWidth of any triangle's expanded bbox is "active".
//
// For typical orthopedic shapes (~5% surface coverage), this drops bake
// time from ~30s → ~1-2s for 192³ on a 12-core machine.
//
// Returns a Uint8Array of length N³ with 1 = band voxel (use precise BVH),
// 0 = far voxel (use coarse fallback).
function buildBandMask(posArr, idxArr, bbox, N, bandWidth){
  const mask = new Uint8Array(N*N*N);
  const dx = (bbox.mxx-bbox.mnx)/N;
  const dy = (bbox.mxy-bbox.mny)/N;
  const dz = (bbox.mxz-bbox.mnz)/N;
  const bx = bbox.mnx, by = bbox.mny, bz = bbox.mnz;
  const triCount = idxArr.length / 3;
  for(let t=0; t<triCount; t++){
    const ia = idxArr[t*3]*3, ib = idxArr[t*3+1]*3, ic = idxArr[t*3+2]*3;
    const x0=posArr[ia],   y0=posArr[ia+1], z0=posArr[ia+2];
    const x1=posArr[ib],   y1=posArr[ib+1], z1=posArr[ib+2];
    const x2=posArr[ic],   y2=posArr[ic+1], z2=posArr[ic+2];
    // Triangle bbox in voxel coords, expanded by bandWidth on each side
    const xMin = Math.min(x0,x1,x2), xMax = Math.max(x0,x1,x2);
    const yMin = Math.min(y0,y1,y2), yMax = Math.max(y0,y1,y2);
    const zMin = Math.min(z0,z1,z2), zMax = Math.max(z0,z1,z2);
    const ix0 = Math.max(0,   Math.floor((xMin-bx)/dx) - bandWidth);
    const ix1 = Math.min(N-1, Math.ceil ((xMax-bx)/dx) + bandWidth);
    const iy0 = Math.max(0,   Math.floor((yMin-by)/dy) - bandWidth);
    const iy1 = Math.min(N-1, Math.ceil ((yMax-by)/dy) + bandWidth);
    const iz0 = Math.max(0,   Math.floor((zMin-bz)/dz) - bandWidth);
    const iz1 = Math.min(N-1, Math.ceil ((zMax-bz)/dz) + bandWidth);
    for(let iz=iz0; iz<=iz1; iz++){
      for(let iy=iy0; iy<=iy1; iy++){
        const rowBase = iz*N*N + iy*N;
        for(let ix=ix0; ix<=ix1; ix++){
          mask[rowBase + ix] = 1;
        }
      }
    }
  }
  return mask;
}

// Count active band voxels — for diagnostics in the progress message.
function countBandMask(mask){
  let n=0;
  for(let i=0;i<mask.length;i++) if(mask[i]) n++;
  return n;
}

// ── Main-thread fallback: original serial implementation ──────────────────
// Used when workers are unavailable (very rare) or hardwareConcurrency=1.
async function _computeShapeSDF_serial(posArr, idxArr, bbox, N, onProgress){
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  geo.setIndex(new THREE.BufferAttribute(idxArr, 1));
  geo.computeBoundsTree();
  const bvh = geo.boundsTree;
  const dx=bbox.mxx-bbox.mnx, dy=bbox.mxy-bbox.mny, dz=bbox.mxz-bbox.mnz;
  const grid = new Float32Array(N*N*N);
  let minV=Infinity, maxV=-Infinity;
  const qp = new THREE.Vector3();
  const closest = {point: new THREE.Vector3()};
  const ray = new THREE.Ray();
  ray.direction.set(0.9732, 0.1894, 0.1225).normalize();
  let lastYield=performance.now();
  for(let iz=0; iz<N; iz++){
    for(let iy=0; iy<N; iy++){
      for(let ix=0; ix<N; ix++){
        qp.set(bbox.mnx+(ix+0.5)/N*dx, bbox.mny+(iy+0.5)/N*dy, bbox.mnz+(iz+0.5)/N*dz);
        bvh.closestPointToPoint(qp, closest);
        const dist = qp.distanceTo(closest.point);
        ray.origin.copy(qp);
        const hits = bvh.raycast(ray, THREE.DoubleSide);
        const inside = (hits.length & 1) === 1;
        const val = inside ? -dist : dist;
        grid[ix+iy*N+iz*N*N] = val;
        if(val<minV) minV=val;
        if(val>maxV) maxV=val;
      }
    }
    if(performance.now()-lastYield>16){
      await new Promise(r=>setTimeout(r,0));
      lastYield=performance.now();
      if(_sdfBakeAborted){geo.disposeBoundsTree();geo.dispose();throw new Error('cancelled');}
      if(onProgress) onProgress((iz+1)/N);
    }
  }
  geo.disposeBoundsTree(); geo.dispose();
  return {data:grid, N, sdfMin:minV, sdfMax:maxV};
}

// ── Parallel SDF bake orchestrator ────────────────────────────────────────
// Spawns min(hardwareConcurrency-1, 12) workers, each baking a contiguous
// Z-slab. Progress is aggregated as a weighted average across workers.
// Fallback to serial main-thread implementation if workers fail to spawn.
//
// v0.5.0-rc19: For fine bakes (N >= 96), pre-compute a coarse SDF + band
// mask so workers can skip BVH queries for far-from-surface voxels. Workers
// receive only their slab's portion of the band mask (~600KB at N=192)
// instead of the full grid (~7MB) to keep structured-clone transfer cost
// proportional to bake size, not bake count.
async function computeShapeSDF(posArr, idxArr, bbox, N=128, onProgress){
  _sdfBakeAborted=false;
  _activeSdfWorkers=[];
  const hc=navigator.hardwareConcurrency||2;
  // Matt's choice: cap at 12 so high-core Ryzens/Threadrippers use more cores.
  // Leave 1 core for the UI; don't spawn more workers than slices can feed.
  const nWorkers=Math.max(1, Math.min(12, hc-1, N));
  // Serial fallback — on very-low-core machines or if worker spawn fails later.
  if(nWorkers<=1){
    return _computeShapeSDF_serial(posArr, idxArr, bbox, N, onProgress);
  }
  // ── Narrow-band prep (rc19) ──────────────────────────────────────────────
  // Coarse SDF + triangle-bbox band mask. Skip for small N — the prep
  // overhead (~1.3s serial: 48³ coarse bake + mask construction) only
  // breaks even with the saved BVH work above N=128, and the user
  // perceives the serial freeze as slowness even when total wall time
  // is shorter. Threshold of 160 ensures clear 2×+ speedup before
  // we spend that frozen second. Import default (N=128) skips this
  // path; export at high (N=192) and ultra (N=256) get the full benefit.
  const COARSE_N = 48;
  const BAND_WIDTH = 5;       // ±5 voxels of precise SDF around each triangle
  const NARROW_BAND_MIN_N = 160;
  let bandMask = null, coarseData = null;
  if(N >= NARROW_BAND_MIN_N){
    try{
      // Coarse precise SDF (main thread, ~1s for 48³ on typical mesh).
      // Reuses existing serial code so no separate worker spawn needed.
      const coarse = await _computeShapeSDF_serial(posArr, idxArr, bbox, COARSE_N, null);
      coarseData = coarse.data;
      if(_sdfBakeAborted) throw new Error('cancelled');
      // Triangle-bbox marker (main thread, ~100-300ms).
      bandMask = buildBandMask(posArr, idxArr, bbox, N, BAND_WIDTH);
      if(_sdfBakeAborted) throw new Error('cancelled');
      // Diagnostics — only logged once per bake; not user-facing.
      const bandPct = 100 * countBandMask(bandMask) / (N*N*N);
      console.log('[SDF bake] narrow-band: '+bandPct.toFixed(1)+'% active voxels at N='+N);
    }catch(e){
      if(e.message==='cancelled') throw e;
      // Prep failed for some other reason — fall through to full-precision bake.
      console.warn('[SDF bake] narrow-band prep failed, using full precision:',e);
      bandMask = null; coarseData = null;
    }
  }
  // Partition Z-slices into contiguous slabs (equal-size, last takes remainder).
  const perWorker=Math.floor(N/nWorkers);
  const extra=N-perWorker*nWorkers;
  const slabs=[];
  let z=0;
  for(let w=0;w<nWorkers;w++){
    const len=perWorker+(w<extra?1:0);
    slabs.push({workerId:w, zStart:z, zEnd:z+len});
    z+=len;
  }
  // Per-worker progress (0..1) — aggregated by weighted avg for the overlay.
  const progressByWorker=new Array(nWorkers).fill(0);
  const sliceWeights=slabs.map(s=>(s.zEnd-s.zStart)/N);
  const reportProgress=()=>{
    if(!onProgress)return;
    let pct=0;
    for(let i=0;i<nWorkers;i++)pct+=progressByWorker[i]*sliceWeights[i];
    onProgress(pct);
  };
  // Spawn workers and collect their slabs. Each gets a COPY of pos/idx via
  // structured clone (no transfer) so all workers share the mesh buffers.
  const results=new Array(nWorkers);
  let minV=Infinity, maxV=-Infinity;
  let completed=0;
  try{
    await Promise.all(slabs.map(slab=>new Promise((resolve,reject)=>{
      let worker;
      try{worker=new Worker(getSdfWorkerUrl());}
      catch(we){reject(we);return;}
      _activeSdfWorkers.push(worker);
      worker.onmessage=e=>{
        const d=e.data;
        if(d.type==='progress'){
          progressByWorker[d.workerId]=d.pct;
          reportProgress();
        } else if(d.type==='done'){
          results[d.workerId]={slab:new Float32Array(d.slab), zStart:d.zStart, zEnd:d.zEnd};
          if(d.sdfMin<minV)minV=d.sdfMin;
          if(d.sdfMax>maxV)maxV=d.sdfMax;
          progressByWorker[d.workerId]=1;
          reportProgress();
          completed++;
          worker.terminate();
          resolve();
        } else if(d.type==='error'){
          worker.terminate();
          reject(new Error('worker '+slab.workerId+': '+d.message));
        }
      };
      worker.onerror=e=>{worker.terminate();reject(new Error(e.message||'worker error'));};
      // Slab-local band mask: only the portion this worker needs. Halves
      // structured-clone time and memory peak vs sending the full grid.
      const slabMask = bandMask
        ? bandMask.slice(slab.zStart*N*N, slab.zEnd*N*N)
        : null;
      // Structured-clone copies the buffers — each worker gets its own copy.
      // For a typical 50k-tri orthopedic shape, ~1.2 MB per copy × 12 workers =
      // ~14 MB extra RAM during bake. Acceptable; avoids transfer-ownership mess.
      worker.postMessage({
        posArr,idxArr,
        bbox,N,
        zStart:slab.zStart, zEnd:slab.zEnd,
        workerId:slab.workerId,
        bandMask: slabMask,
        coarseData: coarseData,
        coarseN: coarseData ? COARSE_N : 0
      });
    })));
  }catch(e){
    // Terminate any still-running workers then propagate.
    _activeSdfWorkers.forEach(w=>{try{w.terminate();}catch(_){}});
    _activeSdfWorkers=[];
    if(_sdfBakeAborted||e.message==='cancelled')throw new Error('cancelled');
    // Fallback to serial if worker-based failed (spawn error, etc).
    console.warn('[SDF bake] parallel workers failed, falling back to serial:',e);
    return _computeShapeSDF_serial(posArr, idxArr, bbox, N, onProgress);
  }
  _activeSdfWorkers=[];
  // Stitch slabs into the final grid.
  const grid=new Float32Array(N*N*N);
  for(const r of results){
    grid.set(r.slab, r.zStart*N*N);
  }
  return {data:grid, N, sdfMin:minV, sdfMax:maxV};
}
window._cancelSdfBake=function(){
  _sdfBakeAborted=true;
  // Terminate all active SDF workers so the cancel takes effect immediately
  // rather than waiting for the next yield-cadence check.
  _activeSdfWorkers.forEach(w=>{try{w.terminate();}catch(_){}});
  _activeSdfWorkers=[];
};
