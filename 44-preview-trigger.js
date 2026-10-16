/* ============================================================
   F13LD.mesh · 44-preview-trigger.js
   triggerPreview + cell-size / trim-to-nodes handlers.
   ============================================================ */
'use strict';

// v0.14.0 (P2): the preview is one scene of every visible part
// (16-preview-scene.js). triggerPreview sets the quality, asks for the shape
// grids of that quality, and lets the scene sync ensure its sources (the
// per-recipe bakes, P1 cache) and commit; it resolves once the scene is drawn
// with every source in place. Welds are no longer baked for the preview (the
// union bake stays for export, 14-weld-bake.js). The view holds the last frame
// only while a part's source is missing the first time it shows.
let _previewSeq=0;
async function triggerPreview(quality, opts){
  ++_previewSeq;
  if(!rm) return;
  quality=quality||rm._quality||'draft';
  currentOversample=PREVIEW_OVERSAMPLE[quality]||2;
  rm.setQuality(quality);
  if(importedShape && typeof requestPreviewShapeGrids==='function'){
    const sel=activeBodyId!=null?[activeBodyId]:[];
    const others=bodyOrder.filter(id=>id!==activeBodyId && bodies.has(id) && (bodies.get(id).visibility||VIS_DEFAULT)!==VIS_HIDDEN);
    if(sel.length) requestPreviewShapeGrids(sel, quality, false);
    if(others.length) requestPreviewShapeGrids(others, quality, true);
  }
  if(typeof previewSceneSettled==='function') await previewSceneSettled();
}
// Stop whatever preview is running and show the current state as it is.
function previewSettle(){
  ++_previewSeq;
  if(typeof cancelPreviewBakes==='function') cancelPreviewBakes();
  if(rm && rm.releaseView) rm.releaseView();
  if(typeof previewSceneChanged==='function') previewSceneChanged();
  hideComputing(); setBtns(true);
}
window.previewSettle=previewSettle;
// Weld preview grid caps per quality (P1). v0.14.0: kept for the tests and as
// the intent for region sizes; the preview no longer bakes welds.
const WELD_PREVIEW_CAP={draft:96,low:128,med:160,high:192,ultra:256};
const WELD_VOX_PER_CELL=8;
function weldPreviewN(quality, boxMm, specs){
  const base=PREVIEW_BAKE_N[quality]||64, cap=WELD_PREVIEW_CAP[quality]||128;
  let cell=Infinity;
  for(const sp of specs) if(!sp.solid && sp.cellSizeMm>0) cell=Math.min(cell, sp.cellSizeMm);
  if(!isFinite(cell) || !boxMm) return base;
  const span=Math.max(boxMm.mxx-boxMm.mnx, boxMm.mxy-boxMm.mny, boxMm.mxz-boxMm.mnz);
  const want=Math.ceil(span/cell*WELD_VOX_PER_CELL);
  const n=Math.min(cap, Math.max(base, want));
  return Math.max(4, Math.ceil(n/4)*4);
}
window.triggerPreview=triggerPreview;
// Temporary hook to exercise weld groups before the drag-to-group card UI lands.
// F13LD_weld.group([bodyId,...], filletMm) -- make sure the active body is one of
// the members so the preview shows the merged result.
window.F13LD_weld={
  group:function(ids, filletMm){ const gid=newWeldGroup(filletMm); for(const id of ids) bodyGroup.set(id,gid); renderBodyCards(); triggerPreview(rm&&rm._quality||'draft'); return gid; },
  all:function(filletMm){ return this.group([...bodies.keys()], filletMm); },
  bodyIds:function(){ return [...bodies.keys()]; },
  setFillet:function(gid,mm){ weldSetFillet(gid, +mm||0); renderBodyCards(); },
  clear:function(){ bodyGroup.clear(); weldGroups.clear(); renderBodyCards(); triggerPreview(rm&&rm._quality||'draft'); },
  list:function(){ return {groups:[...weldGroups.entries()], members:[...bodyGroup.entries()]}; }
};
// (v0.5.0-rc7) triggerMesh removed — was only invoked by clearImportedShape
// to redraw the cube via Manifold.levelSet + Three.js. The raymarcher
// preview, which is already running, handles the post-clear cube view.
window.onCellSizeInput=function(){
  if(!importedShape)return;
  // v0.12.0: no longer locked while welded — the left rail edits cell size
  // per part (railSetCellMm) and the weld preview re-bakes for the change.
  var cellSizeMm=parseFloat(document.getElementById('shapeCellSizeMm')?.value)||3;
  // v0.13.0: same as the rail's cell size (railSetCellMm): a weld or an
  // aperiodic field re-bakes by itself a moment later, the view holding the
  // last frame meanwhile. Periodic scaffolds still update live via setCellSize
  // (hardware REPEAT wrap handles the retiling).
  if(typeof railSetCellMm==='function'){ railSetCellMm(cellSizeMm); return; }
  if(rm)rm.setCellSize(cellSizeMm);
  updateExportEstimate();
  // rc2: persist cell-size change to active body record.
  snapshotActiveBodyState();
};

// v0.5.0-rc17: trim-to-nodes is an export-only operation (preview shows the
// un-trimmed lattice for performance — bake stays one-cell). Toggling it
// only refreshes the export estimate; no re-preview required.
// v0.5.0-rc18: multiplier visibility follows the toggle state.
window.onTrimToNodesChange=function(){
  const tg=document.getElementById('trimToNodes');
  const im=document.getElementById('trimInsetWrap');
  if(im) im.style.display=(tg&&tg.checked)?'inline-flex':'none';
  updateExportEstimate();
  // rc2: persist trim toggle to active body record.
  snapshotActiveBodyState();
};
window.onTrimInsetMultChange=function(){
  // Pure export-time setting; no re-preview, just refresh the size estimate.
  updateExportEstimate();
  // rc2: persist trim inset to active body record.
  snapshotActiveBodyState();
};
