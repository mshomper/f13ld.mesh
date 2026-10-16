/* ============================================================
   F13LD.mesh · 45-structure-handlers.js
   Structure transform input handlers.
   ============================================================ */
'use strict';

// ── Structure transform handlers (v0.5.0 Phase B) ─────────────────────────
// Input handler: read all 7 numeric inputs into structureTransform state,
// recompute the inverse-rotation matrix, push as uniforms to the raymarcher,
// and mark dirty for re-render. Iso-only changes are uniform-only (no rebake);
// rotation or spatial-offset changes alter the required bake region (see the
// shape-mode bake bbox path) so they schedule a debounced re-bake.
function readStructureTransformFromUI(){
  const v=id=>{const el=document.getElementById(id);return el?(parseFloat(el.value)||0):0;};
  structureTransform.rotXDeg=v('sxRotX');
  structureTransform.rotYDeg=v('sxRotY');
  structureTransform.rotZDeg=v('sxRotZ');
  structureTransform.spatialOffsetMmX=v('sxOffX');
  structureTransform.spatialOffsetMmY=v('sxOffY');
  structureTransform.spatialOffsetMmZ=v('sxOffZ');
  structureTransform.isoOffsetMm=v('sxIso');
  recomputeStructureRotMat();
}

// Debounced rebake scheduling. Inputs use `oninput` so they fire per
// keystroke; coalesce rapid changes into a single rebake ~300 ms after the
// user stops typing/clicking. Skipped when no shape is loaded or the recipe
// is periodic (bake region is fixed at one cell — rotation handled by
// shader sampling, no rebake needed).
let _structXformRebakeTimer=null;
// v0.13.0: in a weld the union is baked with every member's own rotation,
// shift and wall offset, so any of them re-bakes (the view holds the last
// frame meanwhile). A standalone aperiodic part keeps its live uniform preview
// while the re-bake runs (no hold).
function _weldedActive(){
  return (typeof activeGroupId==='function') && activeGroupId() && groupMembers(activeGroupId()).length>=2;
}
function _scheduleStructXformRebake(){
  if(!importedShape) return;
  const welded=_weldedActive();
  if(!welded && (!currentRecipe||recipeIsPeriodic(currentRecipe))) return;
  if(welded && rm && rm.holdView) rm.holdView();
  if(_structXformRebakeTimer) clearTimeout(_structXformRebakeTimer);
  _structXformRebakeTimer=setTimeout(()=>{
    _structXformRebakeTimer=null;
    // v0.8.3: keep the user's selected preview quality (was: no argument → fallback quality).
    if(typeof triggerPreview==='function') triggerPreview(rm&&rm._quality||'low', welded?undefined:{hold:false});
  },300);
}

window.onStructXformInput=function(){
  if(!importedShape) return;
  // Snapshot rotation/offset before re-reading UI so we can detect whether
  // an iso-only change happened (no rebake) vs. a rotation/offset change
  // (debounced rebake).
  const before={
    rx:structureTransform.rotXDeg, ry:structureTransform.rotYDeg, rz:structureTransform.rotZDeg,
    ox:structureTransform.spatialOffsetMmX, oy:structureTransform.spatialOffsetMmY, oz:structureTransform.spatialOffsetMmZ
  };
  const isoBefore=structureTransform.isoOffsetMm;
  readStructureTransformFromUI();
  // Push transform uniforms to raymarcher and trigger redraw.
  if(rm && rm.setStructureTransform){
    rm.setStructureTransform(structureTransform);
    rm._dirty=true;
  }
  // Re-estimate triangle count (iso offset can change geometry density).
  updateExportEstimate();
  // Rotation or spatial offset change → debounced rebake. Iso-only → skip.
  const xformChanged=
    structureTransform.rotXDeg!==before.rx ||
    structureTransform.rotYDeg!==before.ry ||
    structureTransform.rotZDeg!==before.rz ||
    structureTransform.spatialOffsetMmX!==before.ox ||
    structureTransform.spatialOffsetMmY!==before.oy ||
    structureTransform.spatialOffsetMmZ!==before.oz;
  // rc2: persist transform state to active body record so it survives switches.
  // v0.13.0: before the re-bake is scheduled (a weld re-bake reads the record).
  snapshotActiveBodyState();
  if(xformChanged || (structureTransform.isoOffsetMm!==isoBefore && _weldedActive())) _scheduleStructXformRebake();
};

window.onStructXformReset=function(){
  if(!importedShape) return;
  // If rotation or offset was non-identity before reset, the bake region was
  // expanded — reset back to identity needs a rebake to tighten it again.
  const wasNonIdentity=
    structureTransform.rotXDeg!==0 || structureTransform.rotYDeg!==0 || structureTransform.rotZDeg!==0 ||
    structureTransform.spatialOffsetMmX!==0 || structureTransform.spatialOffsetMmY!==0 || structureTransform.spatialOffsetMmZ!==0;
  resetStructureTransform();
  refreshStructureTransformUI();
  if(rm && rm.setStructureTransform){
    rm.setStructureTransform(structureTransform);
    rm._dirty=true;
  }
  updateExportEstimate();
  snapshotActiveBodyState();
  if(wasNonIdentity || _weldedActive()) _scheduleStructXformRebake();
  // rc2: persist reset state to active body record.
  snapshotActiveBodyState();
  if(typeof renderRailEditor==='function') renderRailEditor();   // v0.12.0: sliders follow the reset
};

// Pushes current structureTransform values into the UI inputs. Called on
// shape import (after resetStructureTransform) and on user reset.
function refreshStructureTransformUI(){
  const set=(id,v)=>{const el=document.getElementById(id);if(el)el.value=v;};
  set('sxRotX',structureTransform.rotXDeg);
  set('sxRotY',structureTransform.rotYDeg);
  set('sxRotZ',structureTransform.rotZDeg);
  set('sxOffX',structureTransform.spatialOffsetMmX);
  set('sxOffY',structureTransform.spatialOffsetMmY);
  set('sxOffZ',structureTransform.spatialOffsetMmZ);
  set('sxIso', structureTransform.isoOffsetMm);
}

// ── Rail editor drivers (v0.12.0) ─────────────────────────────────────────
// The rail editor (55-rail.js) edits the ACTIVE body. Its sliders write the
// value into the hidden legacy input and run the same handler an edit of that
// input always ran, so per-body state saving (snapshotActiveBodyState) and the
// preview rebakes behave exactly as before. Rapid slider moves are coalesced.
const _RAIL_XFORM_INPUT={rotXDeg:'sxRotX',rotYDeg:'sxRotY',rotZDeg:'sxRotZ',
  spatialOffsetMmX:'sxOffX',spatialOffsetMmY:'sxOffY',spatialOffsetMmZ:'sxOffZ',isoOffsetMm:'sxIso'};
function railSetXform(key, val){
  const id=_RAIL_XFORM_INPUT[key]; if(!id) return;
  const el=document.getElementById(id); if(!el) return;
  el.value=val;
  window.onStructXformInput && window.onStructXformInput();
}
// Cell size. Same as typing in the cell-size input, except that it is NOT
// locked while the part is welded (each member bakes at its own cell size), and
// that aperiodic recipes (which need a re-bake over the new extent) refresh the
// preview by themselves a moment after the slider stops instead of showing the
// "preview outdated" banner.
let _railCellTimer=null;
function railSetCellMm(mm){
  if(!importedShape) return;
  mm=Math.max(0.05, +mm||3);
  const welded0=(typeof activeGroupId==='function') && activeGroupId() && groupMembers(activeGroupId()).length>=2;
  // v0.13.0: a weld or an aperiodic field is baked at the old scale — hold
  // the last frame until the re-bake lands instead of showing it rescaled.
  if((welded0 || (currentRecipe && !recipeIsPeriodic(currentRecipe))) && rm && rm.holdView) rm.holdView();
  const inp=document.getElementById('shapeCellSizeMm'); if(inp) inp.value=mm;
  if(rm && rm.setCellSize) rm.setCellSize(mm);
  snapshotActiveBodyState();                      // body.cellSizeMm
  if(typeof updateExportEstimate==='function') updateExportEstimate();
  const welded=(typeof activeGroupId==='function') && activeGroupId() && groupMembers(activeGroupId()).length>=2;
  if(welded || (currentRecipe && !recipeIsPeriodic(currentRecipe))){
    clearTimeout(_railCellTimer);
    _railCellTimer=setTimeout(()=>{ _railCellTimer=null; if(typeof triggerPreview==='function') triggerPreview(rm&&rm._quality||'low'); },300);
  }
}
// One structural period per axis in mm, for the rail's shift sliders (v0.12.0).
// Same math the export uses: TPMS cellSizeMm / cell_scale_axis; beam the
// per-axis pitch of the trim-to-nodes mask (worker/m30 buildTrimmedBeamSDF: new
// schema cellSizeMm * scale_xyz[i] / cell, old schema cellSizeMm / cell_scale);
// wave cellSizeMm * field.stretch[i]; foam / noise / grain / bundle one tile
// (cellSizeMm).
function structurePeriodMm(recipe, cellMm){
  const c=(+cellMm>0)?+cellMm:3;
  const j=(recipe&&recipe.json)||{}, g=j.geometry||{}, pos=v=>(typeof v==='number'&&isFinite(v)&&v>0);
  const fam=recipe&&recipe.family;
  if(fam==='tpms'){
    const cs=a=>{ const v=(g['cell_scale_'+a]!=null)?g['cell_scale_'+a]:g.cell_scale; return pos(v)?v:1; };
    return [c/cs('x'), c/cs('y'), c/cs('z')];
  }
  if(fam==='beam'){
    let sx=null;
    if(Array.isArray(g.scale_xyz)&&g.scale_xyz.length===3&&g.scale_xyz.every(pos)) sx=g.scale_xyz;
    else if(pos(g.cell_scale_x)&&pos(g.cell_scale_y)&&pos(g.cell_scale_z)) sx=[g.cell_scale_x,g.cell_scale_y,g.cell_scale_z];
    if(sx&&pos(g.cell)) return sx.map(v=>c*v/g.cell);
    const k=pos(g.cell_scale)?g.cell_scale:1;
    return [c/k,c/k,c/k];
  }
  if(fam==='wave'){
    const st=j.field&&j.field.stretch;
    const ok=Array.isArray(st)&&st.length===3&&st.every(pos);
    return ok ? st.map(v=>c*v) : [c,c,c];
  }
  return [c,c,c];
}
function railSetTrim(on){
  const tg=document.getElementById('trimToNodes'); if(!tg) return;
  tg.checked=!!on;
  window.onTrimToNodesChange && window.onTrimToNodesChange();
}
function railSetTrimInset(mult){
  const el=document.getElementById('trimInsetMult'); if(!el) return;
  el.value=Math.max(1, Math.min(2, +mult||1));
  window.onTrimInsetMultChange && window.onTrimInsetMultChange();
}
Object.defineProperty(window,'currentOversample',{get:()=>currentOversample});
