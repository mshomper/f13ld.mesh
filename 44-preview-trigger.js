/* ============================================================
   F13LD.mesh · 44-preview-trigger.js
   triggerPreview + cell-size / trim-to-nodes handlers.
   ============================================================ */
'use strict';

// v0.8.3: preview generation counter. Body cards and the recipe library stay
// clickable during a bake, so an older bake can finish after a newer one. Each
// run captures its sequence number and recipe; a superseded run drops its
// result instead of overwriting the view, and the field range it measured is
// written to the recipe it actually baked (never to whatever is current now —
// that cached range feeds export normalization).
// v0.13.0: a new preview cancels every bake still running (its workers are
// terminated). The view is held on the last correct frame from the start of a
// preview until its field lands, and the world box, assembly mode and field
// change together in one commit, so no frame shows a field through the wrong
// box. Baked fields are cached (42-preview-bake.js): a cache hit commits in the
// same tick, with no overlay and no bake. opts.hold=false skips the hold (the
// aperiodic rotation / shift re-bake keeps the live uniform preview instead).
let _previewSeq=0;
async function triggerPreview(quality, opts){
  const seq=++_previewSeq;
  const isCurrent=()=>seq===_previewSeq;
  if(typeof cancelPreviewBakes==='function') cancelPreviewBakes();
  if(!rm) return;
  if(!(opts&&opts.hold===false) && rm.holdView) rm.holdView();
  try{ await _triggerPreviewRun(quality, isCurrent); }
  finally{ if(isCurrent() && rm.releaseView) rm.releaseView(); }
}
// Stop whatever preview is running and show the current state as it is (used
// when a change needs no bake, e.g. selecting a solid part).
function previewSettle(){
  ++_previewSeq;
  if(typeof cancelPreviewBakes==='function') cancelPreviewBakes();
  if(rm && rm.releaseView) rm.releaseView();
  hideComputing(); setBtns(true);
}
window.previewSettle=previewSettle;
// Cached result for these bake inputs, or null.
function _previewHit(recipe, N, bakeOpts){
  return (typeof previewBakeLookup==='function') ? previewBakeLookup(recipe, N, bakeOpts) : null;
}
function _previewPill(result){
  triPill.style.display='block';
  triPill.textContent=result.cached?'preview · cached':('preview · '+result.ms+'ms');
}
// ── v0.13.0 · weld preview helpers ──────────────────────────────────────────
// Members of a weld drawn solid in the preview (not hidden, not ghosted).
function _weldPreviewMembers(gid){
  return groupMembers(gid).filter(id=>{ const b=bodies.get(id); const v=b&&(b.visibility||VIS_DEFAULT); return b && v!==VIS_HIDDEN && v!==VIS_GHOST; });
}
// mm box around the given bodies, or null.
function _weldBoxMm(ids){
  let mnx=Infinity,mny=Infinity,mnz=Infinity,mxx=-Infinity,mxy=-Infinity,mxz=-Infinity;
  for(const id of ids){ const b=bodies.get(id); if(!b||!b.bbox) continue;
    mnx=Math.min(mnx,b.bbox.mnx); mny=Math.min(mny,b.bbox.mny); mnz=Math.min(mnz,b.bbox.mnz);
    mxx=Math.max(mxx,b.bbox.mxx); mxy=Math.max(mxy,b.bbox.mxy); mxz=Math.max(mxz,b.bbox.mxz); }
  return isFinite(mnx)?{mnx,mny,mnz,mxx,mxy,mxz}:null;
}
// Weld preview grid size: about WELD_VOX_PER_CELL voxels across the finest
// lattice cell in the weld, never below the quality's single-cell size and
// capped per quality (Matt, 2026-10-16). A multiple of 4.
const WELD_PREVIEW_CAP={draft:96,low:128,med:160,high:192,ultra:256};
const WELD_VOX_PER_CELL=8;
function weldPreviewN(quality, boxMm, specs){
  const base=PREVIEW_BAKE_N[quality]||64, cap=WELD_PREVIEW_CAP[quality]||128;
  let cell=Infinity;
  for(const sp of specs) if(!sp.solid && sp.cellSizeMm>0) cell=Math.min(cell, sp.cellSizeMm);
  if(!isFinite(cell) || !boxMm) return base;   // all solid: shapes only, the base grid is enough
  const span=Math.max(boxMm.mxx-boxMm.mnx, boxMm.mxy-boxMm.mny, boxMm.mxz-boxMm.mnz);
  const want=Math.ceil(span/cell*WELD_VOX_PER_CELL);
  const n=Math.min(cap, Math.max(base, want));
  return Math.max(4, Math.ceil(n/4)*4);
}
async function _triggerPreviewRun(quality, isCurrent){
  // -- Weld-group preview: bake the active group merged over its bbox ----------
  const _agid=activeGroupId();
  if(_agid && groupMembers(_agid).length>=2){
    currentOversample=PREVIEW_OVERSAMPLE[quality]||2;
    rm.setQuality(quality);
    const refCell=(bodies.get(activeBodyId)&&bodies.get(activeBodyId).cellSizeMm)||parseFloat(document.getElementById('shapeCellSizeMm')?.value)||3;
    const s=10/refCell;
    // v0.13.0: the preview union holds only the members drawn solid. Hidden
    // members drop out (as in export); ghosted members drop out of the PREVIEW
    // union and draw as translucent shells (syncGhostsToRaymarcher), so a
    // ghosted part — the selected one included — can be seen through. Export
    // still includes ghosted members (gatherGroupSpecs is unchanged).
    const shown=_weldPreviewMembers(_agid);
    // Commit for a weld with nothing solid to show: empty field over the
    // weld's own box, shells / nothing on top.
    const commitEmpty=()=>{
      const fb=_weldBoxMm(groupMembers(_agid));
      rm.setAssemblyMode(true);
      if(fb) rm.setWorldBounds([fb.mnx*s,fb.mny*s,fb.mnz*s],[fb.mxx*s,fb.mxy*s,fb.mxz*s],false);
      rm.setScaffoldField(new Float32Array(8).fill(1),2,0,1,1,null);   // all outside
      syncGhostsToRaymarcher();
      if(rm.setBaseColor) rm.setBaseColor(_hexToRGB(weldGroupColor(_agid)));
      if(window.viewStripSync) viewStripSync();
      hideComputing(); setBtns(true);
    };
    // v0.12.0: every member hidden → show an empty view (nothing would export).
    if(typeof groupVisibleMembers==='function' && groupVisibleMembers(_agid).length===0){
      commitEmpty();
      if(typeof meshToast==='function') meshToast('Every part in this weld is hidden');
      return;
    }
    if(!shown.length){ commitEmpty(); return; }   // every visible member ghosted
    try{
      const gbb=_weldBoxMm(shown);
      const {specs:allSpecs}=await gatherGroupSpecs(_agid, 0, false);
      if(!isCurrent()) return;
      const shownSet=new Set(shown);
      const specs=allSpecs.filter(sp=>shownSet.has(sp.bodyId));
      const N=weldPreviewN(quality, gbb, specs);
      const wMin=[gbb.mnx*s,gbb.mny*s,gbb.mnz*s], wMax=[gbb.mxx*s,gbb.mxy*s,gbb.mxz*s];
      const bakeOpts={isPeriodic:false,bakeRaw:false,worldMin:wMin,worldMax:wMax,mmScale:s,bodies:specs,blendK:groupFilletMm(_agid)};
      let result=_previewHit(currentRecipe, N, bakeOpts);
      if(!result){
        setBtns(false);showCancelBtn(false);
        showComputing('building weld preview…','baking field…');
        result=await bakeField(currentRecipe, N, bakeOpts);
      }
      if(!isCurrent()) return;   // superseded by a newer preview
      // Commit: box, mode and field together.
      rm.setAssemblyMode(true);   // render the baked union field directly (no active-body clip)
      rm.setWorldBounds(wMin,wMax,false);
      // Size the view cube to the WHOLE assembly (not just the group) so bodies
      // outside the weld still fit; the field itself only spans the group bbox.
      const _asm=computeAssemblyBbox();
      const _rMin = _asm?[_asm.mnx*s,_asm.mny*s,_asm.mnz*s]:wMin;
      const _rMax = _asm?[_asm.mxx*s,_asm.mxy*s,_asm.mxz*s]:wMax;
      if(rm.fitReachBounds) rm.fitReachBounds(_rMin,_rMax);
      // v0.13.0: weld fields are stored at 16-bit (thin walls over a big box).
      const r16=Object.assign({},result,{hi16:true});
      if(rm.useField) rm.useField(result.key+'.16',r16);
      else rm.setScaffoldField(result.data,result.N,result.fieldMin,result.fieldMax,result.lipschitz,result.topology);
      // Bodies outside the group render as ghosts (syncGhosts skips group members);
      // then set the lattice base color to the GROUP rail color so the welded mass
      // reads as one part (overriding the active body's own color from selection).
      syncGhostsToRaymarcher();
      if(rm.setBaseColor) rm.setBaseColor(_hexToRGB(weldGroupColor(_agid)));
      clearStale(); _previewPill(result);
      if(window.viewStripSync) viewStripSync();   // v0.12.0: show-joins tint + section readout
    }catch(e){ if(!isCurrent()) return; console.error('weld preview',e); if(e.message!=='cancelled') showError('Weld preview: '+(e.message||e)); }
    hideComputing(); setBtns(true);
    return;
  }
  // v0.13.0: a standalone solid part needs no lattice field — leave the last
  // one bound (the solid shader ignores it) instead of baking a recipe it
  // doesn't use. Only once some field exists, so the view can draw at all.
  if(importedShape && activeBodyId!=null && rm.fieldTex
     && typeof isSolidAssignment==='function' && isSolidAssignment(assignments.get(activeBodyId))){
    rm.setAssemblyMode(false);
    rm.setWorldBounds([-5,-5,-5],[5,5,5],true);   // the solid shader ignores the field; keep a neutral box
    if(window.viewStripSync) viewStripSync();
    hideComputing(); setBtns(true);
    return;
  }
  if(!currentRecipe)return;
  const bakedRecipe=currentRecipe;
  currentOversample=PREVIEW_OVERSAMPLE[quality]||2;
  rm.setQuality(quality);
  const periodic=recipeIsPeriodic(currentRecipe);
  let N=PREVIEW_BAKE_N[quality]||64;
  // v0.8.1: only stochastic fields (noise, grain) get the raw normalized bake.
  // A warped bundle is non-periodic but is a true SDF; routing it here made the
  // slab-parallel bake wait forever for slabs the worker never sends.
  // v0.9.0: "stochastic" is a family descriptor flag.
  const famDesc=familyOf(currentRecipe);
  const isStochastic=!!(famDesc && famDesc.stochastic);
  const needsRawBake=!periodic && isStochastic;
  let bakeOpts={isPeriodic:periodic,bakeRaw:needsRawBake};
  // The box this field is baked over, committed together with it.
  let box=null, fitCube=false, shapeMode=false;
  if(!periodic&&importedShape){
    shapeMode=true;
    // Stochastic field + shape: bake strategy depends on field type.
    const cellSizeMm=parseFloat(document.getElementById('shapeCellSizeMm')?.value)||3;
    const s=10/cellSizeMm;
    const b=importedShape.bbox;
    const isHUField=!!(famDesc && typeof famDesc.hyperuniform==='function' && famDesc.hyperuniform(currentRecipe));
    if(isHUField){
      // HU fields: bake ONE periodic design cell, shader tiles via GL_REPEAT.
      // Orders of magnitude faster than baking the full bbox — cost is fixed
      // at N³ regardless of shape size. Rotation/translation handled by
      // texture wrapping, no clamp artifacts possible.
      bakeOpts={isPeriodic:true,bakeRaw:true,
        shapeCtx:{cellSizeMm,bbox:{mnx:b.mnx,mny:b.mny,mnz:b.mnz,mxx:b.mxx,mxy:b.mxy,mxz:b.mxz}}};
      box={min:[-5,-5,-5],max:[5,5,5],periodic:true};
    }else{
      // Other stochastic fields (spinodoid/GRF/noise): bake over the AABB of
      // the structure-transformed shape bbox in world coords. The shader
      // queries the bake at xform(p) = R^T·(p - pivot - offset) + pivot for
      // p in shape_bbox (world coords). Sizing the bake to the un-transformed
      // shape bbox produced clamp-to-edge artifacts (extruded columnar
      // features) when rotation or offset pushed queries outside the bake —
      // the boundary slice of the texture got repeated along the now-long
      // axis. Fix: bake over the AABB of {xform(corner) : corner ∈ shape_bbox}
      // so every query the shader will make lands strictly inside the bake.
      // Identity transform reduces to the original shape_bbox bake exactly.
      const pX=(b.mnx+b.mxx)*0.5*s, pY=(b.mny+b.mxy)*0.5*s, pZ=(b.mnz+b.mxz)*0.5*s;
      const oX=structureTransform.spatialOffsetMmX*s;
      const oY=structureTransform.spatialOffsetMmY*s;
      const oZ=structureTransform.spatialOffsetMmZ*s;
      const R=structureTransform.rotMat; // column-major R^T (inverse rotation)
      let aMnX=Infinity,aMnY=Infinity,aMnZ=Infinity;
      let aMxX=-Infinity,aMxY=-Infinity,aMxZ=-Infinity;
      for(let cx=0;cx<2;cx++)for(let cy=0;cy<2;cy++)for(let cz=0;cz<2;cz++){
        const wx=(cx?b.mxx:b.mnx)*s, wy=(cy?b.mxy:b.mny)*s, wz=(cz?b.mxz:b.mnz)*s;
        const qx=wx-pX-oX, qy=wy-pY-oY, qz=wz-pZ-oZ;
        // R^T · q  (column-major: R[col*3 + row])
        const rx=R[0]*qx+R[3]*qy+R[6]*qz;
        const ry=R[1]*qx+R[4]*qy+R[7]*qz;
        const rz=R[2]*qx+R[5]*qy+R[8]*qz;
        const tx=rx+pX, ty=ry+pY, tz=rz+pZ;
        if(tx<aMnX)aMnX=tx; if(ty<aMnY)aMnY=ty; if(tz<aMnZ)aMnZ=tz;
        if(tx>aMxX)aMxX=tx; if(ty>aMxY)aMxY=ty; if(tz>aMxZ)aMxZ=tz;
      }
      const wMin=[aMnX,aMnY,aMnZ];
      const wMax=[aMxX,aMxY,aMxZ];
      // v0.6.5: bundle is a true SDF (not a stochastic field), so bake it raw —
      // no [0,1] normalization — continuously over the shape AABB. twist/warp
      // accumulate up the shape exactly as in the export; no tiling, no mirror.
      bakeOpts={isPeriodic:false,bakeRaw:isStochastic,worldMin:wMin,worldMax:wMax};
      if(isStochastic) bakeOpts.shapeCtx={cellSizeMm,bbox:{mnx:b.mnx,mny:b.mny,mnz:b.mnz,mxx:b.mxx,mxy:b.mxy,mxz:b.mxz}};
      box={min:wMin,max:wMax,periodic:false};
    }
  }else{
    // Periodic or no shape: bake one cell with tiling
    // For TPMS and beam: use integer-period bake bounds per axis when the
    // cell is anisotropic. Eliminates GL_REPEAT seam artifacts that appear in
    // shape-mode preview when bake span isn't an integer multiple of the cell
    // period along an axis. Noise and grain don't have a periodic cell with a
    // well-defined period, so they keep [-5,5]³.
    let pMin=[-5,-5,-5], pMax=[5,5,5];
    // v0.9.0: the family's bakeBounds gives the tile (integer cell periods per
    // axis for anisotropic TPMS/beam, the bundle twist period, the wave
    // supercell). A supercell (S > 1) scales the bake grid by S, capped at the
    // ultra tier (192), so each sub-cell keeps its preview voxel density.
    if(famDesc && typeof famDesc.bakeBounds==='function'){
      const b=famDesc.bakeBounds(currentRecipe);
      if(b){
        pMin=b.wMin; pMax=b.wMax;
        bakeOpts.worldMin=pMin; bakeOpts.worldMax=pMax;
        if(b.S>1) N=Math.min(192, N*b.S);
      }
    }
    box={min:pMin,max:pMax,periodic};
    fitCube=!importedShape;   // frame the full cell on import; preserves zoom on re-preview
  }
  // v0.8.1: errors here used to leave the overlay up and the quality
  // buttons disabled; both paths handle them the same way.
  try{
    let result=_previewHit(bakedRecipe, N, bakeOpts);
    if(!result){
      setBtns(false);showCancelBtn(false);
      showComputing('building preview…','baking field…');
      if(shapeMode) await new Promise(r=>setTimeout(r,0));
      result=await bakeField(bakedRecipe, N, bakeOpts);
    }
    // v0.5.0-rc14: cache preview's true fieldMin/Max on recipe so export can
    // reuse the same normalization instead of doing a sparser 16³ pre-scan.
    // Only applies to raw-bake paths (noise + grain non-RD) — TPMS and RD
    // don't need normalization since their fields are in known unit systems.
    // v0.8.3: written to the recipe that was baked, even if superseded.
    if(bakeOpts.bakeRaw){
      bakedRecipe._previewFieldMin=result.fieldMin;
      bakedRecipe._previewFieldMax=result.fieldMax;
    }
    if(!isCurrent()) return;   // superseded by a newer preview
    // Commit: mode, box and field together.
    rm.setAssemblyMode(false);   // single-body path: the active-body clip is restored
    rm.setWorldBounds(box.min,box.max,box.periodic);
    if(fitCube) rm.fitPeriodicBounds(box.min,box.max);
    if(rm.useField) rm.useField(result.key,result);
    else rm.setScaffoldField(result.data,result.N,result.fieldMin,result.fieldMax,result.lipschitz,result.topology);
    clearStale();
    _previewPill(result);
    if(shapeMode) seamPill.style.display='none'; else updateSeamPill(currentRecipe);
    if(window.viewStripSync) viewStripSync();   // joins are weld-only
    hideComputing();
  }catch(e){
    if(!isCurrent()) return;
    hideComputing();
    if(e.message!=='cancelled')showError('Preview: '+(e.message||e));
  }finally{
    if(isCurrent()) setBtns(true);
  }
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
  if(!recipeIsPeriodic(currentRecipe))setStale();
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
