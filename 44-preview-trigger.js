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
let _previewSeq=0;
async function triggerPreview(quality){
  const seq=++_previewSeq;
  const isCurrent=()=>seq===_previewSeq;
  if(!rm)return;
  // -- Weld-group preview: bake the active group merged over its bbox ----------
  const _agid=activeGroupId();
  if(_agid && groupMembers(_agid).length>=2){
    currentOversample=PREVIEW_OVERSAMPLE[quality]||2;
    setBtns(false);showCancelBtn(false);
    showComputing('building weld preview…','baking field…');
    rm.setQuality(quality);
    rm.setAssemblyMode(true);   // render the baked union field directly (no active-body clip)
    try{
      const gbb=computeGroupBbox(_agid);
      const {specs}=await gatherGroupSpecs(_agid, 0, false);
      const refCell=(bodies.get(activeBodyId)&&bodies.get(activeBodyId).cellSizeMm)||parseFloat(document.getElementById('shapeCellSizeMm')?.value)||3;
      const s=10/refCell;
      const N=PREVIEW_BAKE_N[quality]||64;
      const wMin=[gbb.mnx*s,gbb.mny*s,gbb.mnz*s], wMax=[gbb.mxx*s,gbb.mxy*s,gbb.mxz*s];
      rm.setWorldBounds(wMin,wMax,false);
      // Size the view cube to the WHOLE assembly (not just the group) so bodies
      // outside the weld still fit; the field itself only spans the group bbox.
      const _asm=computeAssemblyBbox();
      const _rMin = _asm?[_asm.mnx*s,_asm.mny*s,_asm.mnz*s]:wMin;
      const _rMax = _asm?[_asm.mxx*s,_asm.mxy*s,_asm.mxz*s]:wMax;
      if(rm.fitReachBounds) rm.fitReachBounds(_rMin,_rMax);
      const result=await bakeField(currentRecipe, N,
        {isPeriodic:false,bakeRaw:false,worldMin:wMin,worldMax:wMax,mmScale:s,bodies:specs,blendK:groupFilletMm(_agid)});
      if(!isCurrent()) return;   // superseded by a newer preview
      rm.setScaffoldField(result.data,result.N,result.fieldMin,result.fieldMax,result.lipschitz,result.topology);
      // Bodies outside the group render as ghosts (syncGhosts skips group members);
      // then set the lattice base color to the GROUP rail color so the welded mass
      // reads as one part (overriding the active body's own color from selection).
      syncGhostsToRaymarcher();
      if(rm.setBaseColor) rm.setBaseColor(_hexToRGB(weldGroupColor(_agid)));
      clearStale(); triPill.style.display='block'; triPill.textContent='preview · '+result.ms+'ms';
    }catch(e){ if(!isCurrent()) return; console.error('weld preview',e); if(e.message!=='cancelled') showError('Weld preview: '+(e.message||e)); }
    hideComputing(); setBtns(true);
    return;
  }
  if(!currentRecipe)return;
  const bakedRecipe=currentRecipe;
  rm.setAssemblyMode(false);   // single-body path: ensure the active-body clip is restored
  currentOversample=PREVIEW_OVERSAMPLE[quality]||2;
  setBtns(false);showCancelBtn(false);
  showComputing('building preview…','baking field…');
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
  if(!periodic&&importedShape){
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
      rm.setWorldBounds([-5,-5,-5],[5,5,5],true);
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
      rm.setWorldBounds(wMin,wMax,false);
    }
    await new Promise(r=>setTimeout(r,0));
    // v0.8.1: errors here used to leave the overlay up and the quality
    // buttons disabled; handled the same way as the periodic path below.
    try{
      const result=await bakeField(bakedRecipe, N, bakeOpts);
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
      rm.setScaffoldField(result.data,result.N,result.fieldMin,result.fieldMax,result.lipschitz,result.topology);
      clearStale();
      triPill.style.display='block';
      triPill.textContent='preview · '+result.ms+'ms';
      seamPill.style.display='none';
      hideComputing();
    }catch(e){
      if(!isCurrent()) return;
      hideComputing();
      if(e.message!=='cancelled')showError('Preview: '+(e.message||e));
    }finally{
      if(isCurrent()) setBtns(true);
    }
    return;
  }
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
  rm.setWorldBounds(pMin,pMax,periodic);
  if(!importedShape) rm.fitPeriodicBounds(pMin,pMax); // frame the full cell on import; preserves zoom on re-preview
  try{
    const result=await bakeField(bakedRecipe, N, bakeOpts);
    // v0.5.0-rc14: cache preview fieldMin/Max for export reuse (see shape path above).
    if(bakeOpts.bakeRaw){
      bakedRecipe._previewFieldMin=result.fieldMin;
      bakedRecipe._previewFieldMax=result.fieldMax;
    }
    if(!isCurrent()) return;   // superseded by a newer preview
    rm.setScaffoldField(result.data,result.N,result.fieldMin,result.fieldMax,result.lipschitz,result.topology);
    clearStale();
    triPill.style.display='block';
    triPill.textContent='preview · '+result.ms+'ms';
    updateSeamPill(currentRecipe);
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
  // Neutralized in weld mode: cell size scales the per-body lattice, but the
  // welded preview bakes one fixed union — live rescaling there blows up the
  // whole group. Un-weld the body to adjust its cell size, then re-weld.
  if(typeof activeGroupId==='function' && activeGroupId() && groupMembers(activeGroupId()).length>=2) return;
  var cellSizeMm=parseFloat(document.getElementById('shapeCellSizeMm')?.value)||3;
  if(rm)rm.setCellSize(cellSizeMm);
  // Only mark stale for aperiodic recipes — those genuinely need a field re-bake
  // over the cell-size-dependent world extent. Periodic scaffolds update live
  // via setCellSize (hardware REPEAT wrap handles the retiling).
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
