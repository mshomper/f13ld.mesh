/* ============================================================
   F13LD.mesh · 15-shape-preview-grids.js
   v0.13.0: per-quality preview shape grids.

   A part's shape SDF is baked once at import (64³, body.sdfGrid). Export
   replaces sdfGrid with its own resolution when it needs a finer one, and
   reads it from there — so the preview keeps its finer grids SEPARATELY, in
   body.previewGrids (Map N → grid), and the export grid choice (and so every
   3MF) is exactly as before.

   Each preview quality asks for a shape grid (SHAPE_PREVIEW_N, Matt
   2026-10-16: finer at High / Ultra). The grid is baked in the background on
   the shape-SDF worker pool (computeShapeSDF), one part at a time, newest
   request first; the current picture stays until it lands, then the part
   rebinds (or its weld re-previews). Weld members are refined to at most
   WELD_MEMBER_GRID_MAX (their grids are sent to every preview bake worker).
   All preview grids together stay under PREVIEW_GRID_BYTES (least recently
   used first; the selected part and its weld are kept).
   ============================================================ */
'use strict';

const SHAPE_PREVIEW_N={draft:96,low:128,med:192,high:224,ultra:256};
const WELD_MEMBER_GRID_MAX=160;
const PREVIEW_GRID_BYTES=512*1024*1024;

// Largest 3D texture this GPU takes (WebGL2 guarantees 256).
function _max3DTex(){
  try{ const gl=rm&&rm.gl; if(gl){ const v=gl.getParameter(gl.MAX_3D_TEXTURE_SIZE); if(v>0) return v; } }catch(e){}
  return 256;
}
function shapePreviewN(quality){
  return Math.min(SHAPE_PREVIEW_N[quality]||128, _max3DTex());
}
// The finest grid of this body with N ≤ maxN (sdfGrid at least) for preview use.
function previewShapeGrid(b, maxN){
  if(!b) return null;
  let best=b.sdfGrid||null;   // the import / export grid is always allowed
  const lim=(maxN>0)?maxN:Infinity;
  if(b.previewGrids){
    for(const [N,g] of b.previewGrids){
      if(N<=lim && (!best || N>best.N)) best=g;
    }
    if(best && b.previewGrids.get(best.N)===best) b._pgUsed=performance.now();
  }
  return best;
}
// Every grid object a body owns (for GPU texture pruning).
function bodyShapeGrids(b){
  const out=[]; if(!b) return out;
  if(b.sdfGrid) out.push(b.sdfGrid);
  if(b.sdfGhost) out.push(b.sdfGhost);
  if(b.previewGrids) for(const g of b.previewGrids.values()) out.push(g);
  return out;
}

const _pgWanted=new Map();   // bodyId -> {N, cap} wanted (insertion order = request order)
let _pgRunning=false;
let _pgReadyT=0;
// Ask for preview grids at this quality for these bodies (weld: true caps the
// size for weld members). Nothing happens for a body that already has one.
function requestPreviewShapeGrids(ids, quality, weld){
  let N=shapePreviewN(quality);
  if(weld) N=Math.min(N, WELD_MEMBER_GRID_MAX);
  N=Math.max(4, Math.ceil(N/4)*4);
  for(const id of ids){
    const b=bodies.get(id);
    if(!b || !b.posArr || !b.idxArr || !b.bbox) continue;
    // A finer grid already does (welds: one no finer than the weld cap).
    const have=previewShapeGrid(b, weld?WELD_MEMBER_GRID_MAX:0);
    if(have && have.N>=N) continue;
    _pgWanted.delete(id); _pgWanted.set(id, {N, cap:weld?WELD_MEMBER_GRID_MAX:0});   // newest request last, replaces older
  }
  _pgPump();
}
async function _pgPump(){
  if(_pgRunning) return;
  _pgRunning=true;
  try{
    while(_pgWanted.size){
      // newest request first
      const ids=[..._pgWanted.keys()], id=ids[ids.length-1], req=_pgWanted.get(id), N=req.N;
      _pgWanted.delete(id);
      const b=bodies.get(id); if(!b) continue;
      const have=previewShapeGrid(b, req.cap); if(have && have.N>=N) continue;
      _pgStatus(true, N);
      let g=null;
      try{ g=await computeShapeSDF(b.posArr, b.idxArr, b.bbox, N); }
      catch(e){ if(e && e.message!=='cancelled') console.warn('[preview grid] bake failed', e); continue; }
      if(!bodies.has(id) || !g) continue;
      if(!b.previewGrids) b.previewGrids=new Map();
      b.previewGrids.set(N, g); b._pgUsed=performance.now();
      _pgBudget();
      _pgReady(id);
    }
  } finally {
    _pgRunning=false;
    _pgStatus(false);
  }
}
// Drop the least recently used preview grids past the budget (never the
// selected part's or its weld's).
function _pgBudget(){
  const keep=new Set([activeBodyId]);
  const ag=(typeof activeGroupId==='function')?activeGroupId():null;
  if(ag) for(const id of groupMembers(ag)) keep.add(id);
  const all=[];
  let bytes=0;
  for(const [id,b] of bodies) if(b.previewGrids) for(const [N,g] of b.previewGrids){
    bytes+=g.data.byteLength; all.push({id,b,N,bytes:g.data.byteLength,used:b._pgUsed||0});
  }
  all.sort((u,v)=>u.used-v.used);
  for(const e of all){
    if(bytes<=PREVIEW_GRID_BYTES) break;
    if(keep.has(e.id)) continue;
    e.b.previewGrids.delete(e.N); bytes-=e.bytes;
  }
}
// A finer grid landed: rebind the selected part, or re-preview its weld.
function _pgReady(id){
  if(!rm) return;
  // v0.14.0: every member reads its grid from the scene; the selected part
  // also re-binds its framing.
  if(id===activeBodyId){
    const b=bodies.get(id);
    const cellMm=parseFloat(document.getElementById('shapeCellSizeMm')?.value)||b.cellSizeMm||3;
    rm.setShapeSDF(previewShapeGrid(b), b.bbox, cellMm, computeAssemblyBbox(), /*preserveCamera=*/true);
    if(rm.setStructureTransform) rm.setStructureTransform(structureTransform);
    rm._dirty=true;
  }
  if(typeof syncGhostsToRaymarcher==='function') syncGhostsToRaymarcher();
  if(typeof previewSceneChanged==='function') previewSceneChanged();   // v0.14.0
}
// Small "refining shape" note in the preview pill area while a grid bakes.
function _pgStatus(on, N){
  const el=document.getElementById('triPill'); if(!el) return;
  if(on){ el.dataset.pg='1'; el.style.display='block'; el.textContent='refining shape · '+N+'³'; }
  else if(el.dataset.pg){ delete el.dataset.pg; if(/^refining shape/.test(el.textContent)) el.textContent='preview · shape refined'; }
}
window.F13LD_previewGrids={
  sizes:()=>Object.assign({},SHAPE_PREVIEW_N),
  pending:()=>_pgWanted.size+(_pgRunning?1:0),
  of:id=>{ const b=bodies.get(id); return b?{import:b.sdfGrid&&b.sdfGrid.N, preview:b.previewGrids?[...b.previewGrids.keys()]:[]}:null; }
};
