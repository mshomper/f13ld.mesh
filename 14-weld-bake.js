/* ============================================================
   F13LD.mesh · 14-weld-bake.js
   Weld export planning and parallel field bake (v0.9.3).

   planWeld        decides which solids come straight from their imported
                   mesh and which boxes still need the fine level set
   bakeWeldRegion  evaluates the weld field at Manifold.levelSet's grid
                   points on a pool of workers (worker/weld-bake-worker.js);
                   the mesh worker then reads those values instead of
                   evaluating the field on one thread
   estimateWeldExport  time estimate for the export panel (41-quality-estimate)

   Grid formula: see worker/m31-weld-grid.js (weldGridDims is mirrored here;
   the bake checks the worker's dims against these before using them).
   ============================================================ */
'use strict';

// ── Closed-mesh check ─────────────────────────────────────────────────────
// A solid can be used as-is only if Manifold will accept its mesh: every
// edge shared by exactly two triangles in opposite directions, outward
// facing (positive volume). The mesh worker re-checks with Manifold itself
// and falls back to meshing the whole group if this check was wrong.
function meshIsClosedOutward(posArr, idxArr){
  const nT=idxArr.length/3, nV=posArr.length/3;
  if(!nT || nT!==Math.floor(nT)) return false;
  // key = 2·(min·nV + max) + (a>b): each undirected edge must appear exactly
  // as the pair {2e, 2e+1}, once in each direction. Float64 holds the keys
  // exactly up to ~4.7M vertices (2·nV² < 2^53).
  if(nV>4e6) return false;
  const K=new Float64Array(nT*3);
  let vol=0;
  for(let t=0;t<nT;t++){
    const a=idxArr[3*t], b=idxArr[3*t+1], c=idxArr[3*t+2];
    if(a>=nV||b>=nV||c>=nV||a===b||b===c||a===c) return false;
    K[3*t]  =2*(Math.min(a,b)*nV+Math.max(a,b))+(a>b?1:0);
    K[3*t+1]=2*(Math.min(b,c)*nV+Math.max(b,c))+(b>c?1:0);
    K[3*t+2]=2*(Math.min(c,a)*nV+Math.max(c,a))+(c>a?1:0);
    const ax=posArr[3*a],ay=posArr[3*a+1],az=posArr[3*a+2];
    const bx=posArr[3*b],by=posArr[3*b+1],bz=posArr[3*b+2];
    const cx=posArr[3*c],cy=posArr[3*c+1],cz=posArr[3*c+2];
    vol+=ax*(by*cz-bz*cy)+ay*(bz*cx-bx*cz)+az*(bx*cy-by*cx);
  }
  K.sort();
  for(let i=0;i<K.length;i+=2){
    if(K[i]%2!==0 || K[i+1]!==K[i]+1) return false;
    if(i+2<K.length && K[i+2]===K[i]) return false;    // edge used by >2 triangles
  }
  return vol>0;
}
// Cached on the body record; re-checked if its mesh arrays are replaced.
function bodyMeshClosed(b){
  if(!b || !b.posArr || !b.idxArr) return false;
  const c=b._closedCheck;
  if(c && c.pos===b.posArr && c.idx===b.idxArr) return c.ok;
  let ok=false;
  try{ ok=meshIsClosedOutward(b.posArr, b.idxArr); }catch(_){ ok=false; }
  b._closedCheck={pos:b.posArr, idx:b.idxArr, ok};
  return ok;
}

// Mirror of worker/m31-weld-grid.js weldGridDims.
function weldGridDims(min, max, edge){
  const n=[0,0,0], s=[0,0,0];
  for(let a=0;a<3;a++){ const dim=max[a]-min[a]; n[a]=Math.trunc(dim/edge+1.0)-1; s[a]=n[a]>0?dim/n[a]:0; }
  const ok=n[0]>0&&n[1]>0&&n[2]>0;
  return {n, s, ok,
    mainCount: ok?(n[0]+1)*(n[1]+1)*(n[2]+1):0,
    offCount:  ok?(n[0]+2)*(n[1]+2)*(n[2]+2):0,
    layers:    ok?2*n[2]+3:0};
}

// ── Plan ──────────────────────────────────────────────────────────────────
// specs: gatherGroupSpecs output (each carries bodyId). Returns
//   {hybrid, regions:[{min,max}], solidOk:[bool], insetMm, reachMm}
// hybrid needs at least one lattice member and one solid with a closed mesh.
// An all-solid group keeps the old path so its fillets between solids stay.
// In a hybrid group, solid-to-solid contacts are a plain (sharp) union.
function weldIsLattice(sp){ return !(sp.solid || !sp.recipe); }
function planWeld(specs, blendK, edge, gbb){
  const k=blendK||0;
  // Far-member skip. A member's value is at least its shape distance (lattice
  // gradients up to ~1.8 still leave it > k above the surface value at
  // 2k + 3 voxels), so skipping it there cannot change the fillet.
  const reachMm=2*k+3*edge;
  const fullBox={min:[gbb.mnx,gbb.mny,gbb.mnz], max:[gbb.mxx,gbb.mxy,gbb.mxz]};
  const solidOk=specs.map(sp=>!weldIsLattice(sp) && bodyMeshClosed(bodies.get(sp.bodyId)));
  const hybrid=specs.some(weldIsLattice) && solidOk.some(Boolean);
  if(!hybrid) return {hybrid:false, regions:[fullBox], solidOk:specs.map(()=>false), insetMm:0, reachMm};
  // Fine boxes: every member that is not an exact solid, padded by the fillet
  // + 3 voxels (its bbox already has 6% padding around the mesh), clamped to
  // the group box. Overlapping or touching boxes merge, so no lattice is ever
  // cut by another region's box face.
  const pad=k+3*edge;
  let boxes=[];
  specs.forEach((sp,i)=>{
    if(solidOk[i]) return;
    const b=sp.bbox;
    boxes.push({min:[Math.max(b.mnx-pad,gbb.mnx),Math.max(b.mny-pad,gbb.mny),Math.max(b.mnz-pad,gbb.mnz)],
                max:[Math.min(b.mxx+pad,gbb.mxx),Math.min(b.mxy+pad,gbb.mxy),Math.min(b.mxz+pad,gbb.mxz)]});
  });
  const eps=1e-6;
  let merged=true;
  while(merged && boxes.length>1){
    merged=false;
    outer: for(let i=0;i<boxes.length;i++) for(let j=i+1;j<boxes.length;j++){
      const A=boxes[i], B=boxes[j];
      if([0,1,2].every(a=>A.min[a]<=B.max[a]+eps && B.min[a]<=A.max[a]+eps)){
        boxes[i]={min:[0,1,2].map(a=>Math.min(A.min[a],B.min[a])), max:[0,1,2].map(a=>Math.max(A.max[a],B.max[a]))};
        boxes.splice(j,1); merged=true; break outer;
      }
    }
  }
  return {hybrid:true, regions:boxes, solidOk, insetMm:edge, reachMm};
}

// ── Grid crop ─────────────────────────────────────────────────────────────
// A bake worker only needs the part of each member's shape grid that the
// region (+ margin for the fillet's gradient samples) touches. Indices are
// chosen on the full grid exactly as makeShapeSampler does, so the cropped
// sampler returns the same values bit-for-bit inside that range.
function cropSpecToRegion(sp, region, marginMm){
  const N=sp.shapeN, bb=sp.bbox;
  const org=[bb.mnx,bb.mny,bb.mnz], dim=[bb.mxx-bb.mnx,bb.mxy-bb.mny,bb.mxz-bb.mnz];
  const r=[0,1,2].map(a=>{
    const f=x=>{ let u=(x-org[a])/dim[a]; u=u<0?0:(u>1?1:u); return Math.min(Math.max(u*N-0.5,0),N-1); };
    const i0=Math.max(0, Math.floor(f(region.min[a]-marginMm))-1);
    const i1=Math.min(N-1, Math.floor(f(region.max[a]+marginMm))+2);
    return [i0,i1];
  });
  const nx=r[0][1]-r[0][0]+1, ny=r[1][1]-r[1][0]+1, nz=r[2][1]-r[2][0]+1;
  if(nx*ny*nz > 0.8*N*N*N) return Object.assign({}, sp);
  const src=new Float32Array(sp.shapeSdfData), dst=new Float32Array(nx*ny*nz);
  const i0=r[0][0], j0=r[1][0], k0=r[2][0];
  for(let k=0;k<nz;k++) for(let j=0;j<ny;j++){
    const s0=i0+(j+j0)*N+(k+k0)*N*N;
    dst.set(src.subarray(s0, s0+nx), j*nx+k*nx*ny);
  }
  return Object.assign({}, sp, {shapeSdfData:dst.buffer, shapeCrop:{i0,j0,k0,nx,ny,nz}});
}

// ── Parallel bake ─────────────────────────────────────────────────────────
let _weldBakeWorkers=[];
let _weldBakeAbort=null;
window._cancelWeldBake=function(){
  for(const w of _weldBakeWorkers){ try{ w.terminate(); }catch(_){} }
  _weldBakeWorkers=[];
  if(_weldBakeAbort){ const r=_weldBakeAbort; _weldBakeAbort=null; try{ r(new Error('cancelled')); }catch(_){} }
};
let _weldBakeUrl=null;
function weldBakeWorkerCount(){
  const hc=navigator.hardwareConcurrency||2;
  return Math.max(1, Math.min(12, hc-1));
}
const WELD_BAKE_MIN_POINTS=200000;   // below this the spawn cost outweighs the split
const WELD_BAKE_F32_POINTS=25e6;     // above this store Float32 (memory), else Float64
// bodies: specs as the mesh worker will see them (insetMm already set).
// Resolves {main, off, f32, workers, ms} or null when the bake isn't worth it
// or fails — the mesh worker then evaluates the field itself.
async function bakeWeldRegion(bodySpecs, region, blendK, reachMm, edge, onProgress){
  const g=weldGridDims(region.min, region.max, edge);
  const total=g.mainCount+g.offCount;
  const nW=Math.min(weldBakeWorkerCount(), g.layers);
  if(!g.ok || nW<2 || total<WELD_BAKE_MIN_POINTS) return null;
  if(!_weldBakeUrl) _weldBakeUrl=meshAssetUrl('worker/weld-bake-worker.js');
  const t0=performance.now();
  const f32=total>WELD_BAKE_F32_POINTS;
  const Arr=f32?Float32Array:Float64Array;
  const main=new Arr(g.mainCount), off=new Arr(g.offCount);
  const nx1=g.n[0]+1, ny1=g.n[1]+1, nx2=g.n[0]+2, ny2=g.n[1]+2;
  const k=blendK||0;
  const margin=Math.max(g.s[0],g.s[1],g.s[2])+Math.max(k*0.25,0.05)+1e-3;
  const cropped=bodySpecs.map(sp=>cropSpecToRegion(sp, region, margin));
  // ~6 jobs per worker so a slow (dense) slab doesn't leave the rest idle.
  const per=Math.max(1, Math.ceil(g.layers/(nW*6)));
  const jobs=[]; for(let q=0;q<g.layers;q+=per) jobs.push({id:jobs.length, qa:q, qb:Math.min(g.layers,q+per)});
  let next=0, done=0;
  try{
    await new Promise((resolve,reject)=>{
      _weldBakeAbort=reject;
      const fail=err=>{ for(const w of _weldBakeWorkers){ try{ w.terminate(); }catch(_){} } _weldBakeWorkers=[]; reject(err); };
      const initMsg={type:'init', bodies:cropped, blendK:k, reachMm, grid:{min:region.min, max:region.max, edge}, f32};
      for(let i=0;i<nW;i++){
        let w;
        try{ w=new Worker(_weldBakeUrl); }catch(err){ fail(err); return; }
        _weldBakeWorkers.push(w);
        const dispatch=()=>{ if(next<jobs.length){ const j=jobs[next++]; w.postMessage({type:'job', id:j.id, qa:j.qa, qb:j.qb}); } };
        w.onmessage=e=>{
          const d=e.data;
          if(d.type==='ready'){
            // Main thread and worker must agree on the grid, or the slabs land
            // in the wrong place.
            if(!d.n || d.n.join(',')!==g.n.join(',')){ fail(new Error('grid mismatch '+d.n+' vs '+g.n)); return; }
            dispatch(); return;
          }
          if(d.type==='error'){ fail(new Error('weld bake worker: '+d.message)); return; }
          if(d.type==='slab'){
            if(d.main.byteLength) main.set(new Arr(d.main), d.kmA*nx1*ny1);
            if(d.off.byteLength)  off.set(new Arr(d.off),  d.koA*nx2*ny2);
            done++;
            if(onProgress) onProgress(done/jobs.length, _weldBakeWorkers.length);
            if(done===jobs.length) resolve(); else dispatch();
          }
        };
        w.onerror=e=>fail(new Error(e.message||'weld bake worker error'));
        w.postMessage(initMsg);
      }
    });
  }catch(err){
    if(err && err.message==='cancelled') throw err;
    console.warn('[weld bake] falling back to single-thread evaluation:', err);
    return null;
  }finally{
    for(const w of _weldBakeWorkers){ try{ w.terminate(); }catch(_){} }
    _weldBakeWorkers=[]; _weldBakeAbort=null;
  }
  return {main:main.buffer, off:off.buffer, f32, workers:nW, ms:Math.round(performance.now()-t0), points:total};
}

// ── Estimate ──────────────────────────────────────────────────────────────
// Time for a weld export at the given quality. The main thread has no SDF
// code, so the per-evaluation cost comes from a family table (µs, measured
// in Node: see docs/SESSION_RECAP_2026-10-04.md), then scaled by a factor
// learned from finished weld exports on this machine (recordWeldTiming), so
// it settles on the right number after an export or two.
const WELD_EVAL_US={tpms:4, noise:20, grain:10, beam:3, bundle:100, wave:4, foam:15};
const WELD_EVAL_US_HU=58;                      // grain · hyperuniform
const WELD_METRIC_FAMILIES={foam:true, beam:true, bundle:true};   // mirrors registerSDF(…, metric:true)
const WELD_POINT_US=0.2, WELD_MEMBER_US=0.1;   // per point: wrapper + each member's shape sample
const WELD_MARCH_US=2.0;                       // Manifold level set per grid point in a lattice region
const WELD_CAL_KEY='f13ld.mesh.weldCal.v1';
function weldCal(){
  try{ const v=parseFloat(localStorage.getItem(WELD_CAL_KEY)); return (v>=0.2&&v<=5)?v:1; }catch(_){ return 1; }
}
// est: estimateWeldExport result made when the export started; wallMs: that
// export's wall time up to the finished mesh. The factor moves halfway (in
// log terms) toward this machine's measured/modelled ratio each time.
function recordWeldTiming(est, wallMs){
  if(!est || !(est.rawMs>0) || !(wallMs>0)) return;
  const ratio=Math.min(5,Math.max(0.2,wallMs/est.rawMs));
  const next=Math.exp(0.5*Math.log(est.cal)+0.5*Math.log(ratio));
  try{ localStorage.setItem(WELD_CAL_KEY, String(+next.toFixed(3))); }catch(_){}
  console.log('[export][weld] estimate calibration', {estimatedMs:Math.round(est.rawMs*est.cal), actualMs:Math.round(wallMs), factor:+next.toFixed(3)});
}
function _boxVol(min,max){ return Math.max(0,max[0]-min[0])*Math.max(0,max[1]-min[1])*Math.max(0,max[2]-min[2]); }
function estimateWeldExport(gid, qual){
  const gbb=computeGroupBbox(gid); if(!gbb) return null;
  const mem=[];
  for(const id of groupMembers(gid)){
    const b=bodies.get(id); if(!b||!b.bbox) continue;
    if((b.visibility||VIS_DEFAULT)===VIS_HIDDEN) continue;
    const rid=assignments.get(id);
    const isSolid=isSolidAssignment(rid)||!recipes.has(rid);
    const cellSizeMm=(b.cellSizeMm!=null)?b.cellSizeMm
      :((id===activeBodyId)?(parseFloat(document.getElementById('shapeCellSizeMm')?.value)||3):3);
    mem.push({solid:isSolid, recipe:isSolid?null:recipes.get(rid), bbox:b.bbox, cellSizeMm, bodyId:id, body:b});
  }
  if(mem.length<2) return null;
  const capVox=mem.reduce((m,sp)=>weldIsLattice(sp)?Math.min(m,getMaxExportVoxels(sp.recipe)):m, MAX_EXPORT_VOXELS_DEFAULT);
  const edge=clampEdgeMm(QUAL_EDGE_MM[qual]||0.10, gbb, capVox).safeEdge;
  const k=groupFilletMm(gid);
  const plan=planWeld(mem, k, edge, gbb);
  let points=0, evalUs=0, workers=1;
  for(const r of plan.regions){
    const g=weldGridDims(r.min, r.max, edge), pts=g.mainCount+g.offCount;
    points+=pts;
    const rv=_boxVol(r.min, r.max)||1;
    let us=WELD_POINT_US+WELD_MEMBER_US*mem.length;
    for(const sp of mem){
      if(!weldIsLattice(sp)) continue;
      const fam=sp.recipe.family, d=familyOf(sp.recipe);
      let c=(d && typeof d.hyperuniform==='function' && d.hyperuniform(sp.recipe)) ? WELD_EVAL_US_HU : (WELD_EVAL_US[fam]||10);
      if(k>1e-6 && !WELD_METRIC_FAMILIES[fam]) c*=7;            // fillet gradient normalization
      const R=plan.reachMm, b=sp.bbox;
      const lo=[Math.max(b.mnx-R,r.min[0]),Math.max(b.mny-R,r.min[1]),Math.max(b.mnz-R,r.min[2])];
      const hi=[Math.min(b.mxx+R,r.max[0]),Math.min(b.mxy+R,r.max[1]),Math.min(b.mxz+R,r.max[2])];
      us+=c*_boxVol(lo,hi)/rv;                                  // share of the region near this member
    }
    evalUs+=pts*us;
    if(pts>=WELD_BAKE_MIN_POINTS) workers=Math.max(workers, Math.min(weldBakeWorkerCount(), g.layers));
  }
  const bakeMs=evalUs/1000/(workers>1?workers*0.85:1);
  const marchMs=points*WELD_MARCH_US/1000;
  // Members whose shape SDF is coarser than the export grid are re-baked first
  // (same model as updateExportEstimate: ~4 µs per voxel on the shape pool).
  const targetN=EXPORT_SHAPE_SDF_N_BY_QUAL[qual]||192;
  const hc=navigator.hardwareConcurrency||2;
  let sdfMs=0;
  for(const sp of mem){
    const N=sp.body.sdfGrid?sp.body.sdfGrid.N:0;
    if(N<targetN) sdfMs+=targetN*targetN*targetN*4e-3/Math.max(1,Math.min(12,hc-1,targetN));
  }
  // Triangles: lattice members by the shape-mode surface model, exact solids
  // as imported. Union + simplify ≈ a quarter of the level-set time on top.
  let tris=0;
  mem.forEach((sp,i)=>{
    if(weldIsLattice(sp)) tris+=estimateMeshStats(sp.recipe, edge, sp.bbox, sp.cellSizeMm).estTris;
    else if(plan.solidOk[i]) tris+=sp.body.idxArr.length/3;
  });
  const rawMs=(bakeMs+marchMs)*1.25+sdfMs;
  const cal=weldCal();
  return {gid, edge, points, workers, members:mem.length, hybrid:plan.hybrid,
    exactSolids:plan.solidOk.filter(Boolean).length, tris:Math.round(tris),
    rawMs, cal, sdfSec:Math.round(sdfMs*cal/1000),
    totalSec:Math.max(1, Math.round(rawMs*cal/1000))};
}
