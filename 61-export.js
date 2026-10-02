/* ============================================================
   F13LD.mesh · 61-export.js
   Export pipeline: weld-group export, triggerExport, timings.
   ============================================================ */
'use strict';

// ── Weld-group export (W4, v0.7.x) ─────────────────────────────────────────
// Active body in a >=2-member weld group: emit the group's union as ONE
// watertight 3MF part. Re-bakes each member's shape SDF at export resolution,
// bakes the union via Manifold.levelSet in the worker (buildAssemblySDF), and
// restores CAD coordinates by +sceneCenter (shared across all members).
async function _exportWeldGroup(gid){
  const btn=document.getElementById('expBtn');
  const report=document.getElementById('expReport');
  if(meshWorker){meshWorker.terminate();meshWorker=null;}
  const _tp=document.getElementById('timingsPill');if(_tp)_tp.classList.remove('show');
  btn.disabled=true;btn.classList.add('sweeping');btn.textContent='computing weld...';report.innerHTML='';
  const elapsedEl=document.getElementById('expElapsed');
  let elapsedSec=0,elapsedTimer=null;
  if(elapsedEl){elapsedEl.style.display='block';elapsedEl.textContent='elapsed: 0s';
    elapsedTimer=setInterval(()=>{elapsedSec++;elapsedEl.textContent='elapsed: '+elapsedSec+'s';},1000);}
  _exportElapsedTimer=elapsedTimer;
  const letter=(typeof weldGroupLetter==='function')?weldGroupLetter(gid):'A';
  try{
    const gbb=computeGroupBbox(gid);
    if(!gbb) throw new Error('weld group has no geometry');
    const exportN=EXPORT_SHAPE_SDF_N_BY_QUAL[currentExportQual]||192;
    coMain.textContent='preparing weld export...';
    coSub.textContent='refining member SDFs ('+exportN+'\u00b3)...';
    overlay.classList.remove('hidden');showCancelBtn(true);
    if(window._orbStart)_orbStart();
    const {specs}=await gatherGroupSpecs(gid, exportN, true);   // ensureN re-bake + clone for transfer
    if(!specs.length) throw new Error('no exportable members in weld group');
    showCancelBtn(false);
    // Edge clamp against the GROUP bbox; protect the thinnest lattice wall across members.
    const rawEdge=QUAL_EDGE_MM[currentExportQual]||0.10;
    // v0.8.3: cap by the strictest lattice member (was: the active body's recipe).
    const capVox=specs.reduce((m,sp)=>(sp.solid||!sp.recipe)?m:Math.min(m,getMaxExportVoxels(sp.recipe)), MAX_EXPORT_VOXELS_DEFAULT);
    const {safeEdge:relEdgeMm}=clampEdgeMm(rawEdge, gbb, capVox);
    // Track WHICH member is thinnest, not just the value: the suggested cell
    // size has to come from that member's own cellSizeMm, since members in a
    // weld group can each carry a different cell size.
    let minFeatMm=Infinity, minFeatSpec=null, minFeatIdx=-1;
    for(let i=0;i<specs.length;i++){
      const sp=specs[i];
      if(sp.solid || !sp.recipe) continue;
      const f=getThinnestFeatureMm(sp.recipe, sp.cellSizeMm);
      if(f!=null && f>0 && f<minFeatMm){ minFeatMm=f; minFeatSpec=sp; minFeatIdx=i; }
    }
    const edgeTol=relEdgeMm*0.15;
    const cappedTol=(minFeatMm<Infinity)?minFeatMm*0.05:Infinity;
    const simplifyTol=Math.min(edgeTol,cappedTol);
    const simplifyCappedByFeature=cappedTol<edgeTol;
    const featMm=(minFeatMm<Infinity)?minFeatMm:undefined;
    // ── Feature-ratio guard (shared helper; see FEATURE_EDGE_RATIO_MIN) ─────
    const weldChk=checkFeatureEdgeRatio(
      (minFeatMm<Infinity)?minFeatMm:null,
      relEdgeMm,
      minFeatSpec?minFeatSpec.cellSizeMm:0);
    console.log('[export][feature-guard][weld]', {
      group: letter, members: specs.length,
      thinnestMember: minFeatSpec?memberLabel(minFeatSpec,minFeatIdx):null,
      thinnestFeatureMm: (minFeatMm<Infinity)?+minFeatMm.toFixed(4):null,
      memberCellSizeMm: minFeatSpec?minFeatSpec.cellSizeMm:null,
      fineEdgeMm: +relEdgeMm.toFixed(4),
      featureEdgeRatio: weldChk.ratio!=null?+weldChk.ratio.toFixed(2):null,
      ratioFloor: weldChk.floor, quality: currentExportQual
    });
    if(!weldChk.ok){
      // Same teardown contract as the single-body path: this runs before the
      // worker dispatch, so tear the UI down explicitly and return rather than
      // throwing into an uncaught rejection that strands the overlay.
      if(elapsedTimer)clearInterval(elapsedTimer);
      _exportElapsedTimer=null;_exportTimeoutTimer=null;
      if(elapsedEl)elapsedEl.style.display='none';
      hideComputing();showCancelBtn(false);
      report.innerHTML=featureRatioErrorHtml(weldChk, minFeatMm, relEdgeMm, currentExportQual,
        memberLabel(minFeatSpec,minFeatIdx));
      btn.disabled=false;btn.classList.remove('sweeping');btn.textContent='Export 3MF';
      return;
    }
    coMain.textContent='exporting weld...';
    coSub.textContent='union level set over group bbox...';
    overlay.classList.remove('hidden');showCancelBtn(true);
    const workerMsg={
      mode:'export', bodies:specs, blendK:groupFilletMm(gid),
      bbox:{mnx:gbb.mnx,mny:gbb.mny,mnz:gbb.mnz,mxx:gbb.mxx,mxy:gbb.mxy,mxz:gbb.mxz},
      relEdgeMm, simplifyTol, simplifyCappedByFeature, featMm, scale:1.0
    };
    const worker=new Worker(getMeshWorkerUrl());
    meshWorker=worker;
    const EXPORT_TIMEOUT_MS=180000;
    let exportTimedOut=false, exportTimer=null;
    const result=await new Promise((resolve,reject)=>{
      exportTimer=setTimeout(()=>{ exportTimedOut=true; try{worker.terminate();}catch(_){} if(meshWorker===worker)meshWorker=null;
        reject(new Error('Weld export exceeded '+(EXPORT_TIMEOUT_MS/1000)+'s and was stopped. The group is too dense at this quality \u2014 increase cell size or lower export quality.')); }, EXPORT_TIMEOUT_MS);
      _exportTimeoutTimer=exportTimer;
      _exportCancelReject=reject;
      worker.onmessage=e=>{ const dd=e.data; if(exportTimedOut)return;
        if(dd.type==='progress')coSub.textContent=dd.stage;
        else if(dd.type==='diag')console.log('[export][mem-guard]',dd.diag);
        else if(dd.type==='done'){clearTimeout(exportTimer);resolve(dd);}
        else if(dd.type==='error'){clearTimeout(exportTimer);reject(new Error(dd.message));} };
      worker.onerror=e=>{ clearTimeout(exportTimer); reject(new Error(e.message||'Worker error')); };
      worker.postMessage(workerMsg, specs.map(s=>s.shapeSdfData));
    });
    if(meshWorker===worker)meshWorker=null;
    worker.terminate();
    if(elapsedTimer)clearInterval(elapsedTimer);
    _exportElapsedTimer=null;_exportTimeoutTimer=null;
    hideComputing();showCancelBtn(false);
    btn.textContent='building 3MF...';
    const vertProps=new Float32Array(result.vertProperties);
    const triVerts=new Uint32Array(result.triVerts);
    // CAD-space restore: every member shares sceneCenter (== importCenter).
    if(sceneCenter){ for(let i=0;i<vertProps.length;i+=3){ vertProps[i]+=sceneCenter.x; vertProps[i+1]+=sceneCenter.y; vertProps[i+2]+=sceneCenter.z; } }
    const blob=await buildMinimal3MF(vertProps,triVerts,result.scale??1.0);
    const ts=new Date().toISOString().slice(0,10);
    const filename='weld_'+letter+'_'+specs.length+'bodies_'+ts+'.3mf';
    downloadBlob(blob, filename);
    report.innerHTML='<div class="exp-report">'+
      expChip('part','weld '+letter)+
      expChip('bodies',specs.length)+
      expChip('triangles',result.triCount.toLocaleString())+
      expChip('edge',relEdgeMm.toFixed(2)+'mm')+
      expChip('file',(blob.size/1024).toFixed(1)+' KB')+
      expChip('time',result.ms+'ms')+
    '</div>';
    if(elapsedEl)elapsedEl.style.display='none';
    btn.classList.remove('sweeping');btn.textContent='Export 3MF';
  }catch(e){
    if(elapsedTimer)clearInterval(elapsedTimer);
    if(_exportTimeoutTimer)clearTimeout(_exportTimeoutTimer);
    _exportElapsedTimer=null;_exportTimeoutTimer=null;
    if(elapsedEl)elapsedEl.style.display='none';
    if(meshWorker){meshWorker.terminate();meshWorker=null;}
    hideComputing();showCancelBtn(false);
    report.innerHTML=(e.message==='cancelled')?'':'<div class="exp-err">&#9888; '+esc(e.message||e)+'</div>';
    btn.classList.remove('sweeping');btn.textContent='Export 3MF';
    if(e.message!=='cancelled') console.error('[weld export]',e);
  }
  btn.disabled=false;
}

// ── One export at a time (v0.8.1) ─────────────────────────────────────────
// Re-rendering the panel mid-export creates a fresh, enabled Export button.
// A second export used to terminate the first's worker; the first then hung,
// and its timeout later tore down the second — leaving the button stuck with
// no way to cancel. Exports now run one at a time, and any error that escapes
// the pipeline still resets the panel instead of leaving the overlay up.
let _exportBusy=false;
window.triggerExport=async function(){
  if(_exportBusy){
    const rep=document.getElementById('expReport');
    if(rep) rep.innerHTML='<div class="exp-err">&#9888; An export is already running — wait for it to finish or press cancel.</div>';
    return;
  }
  _exportBusy=true;
  try{ await _triggerExportImpl(); }
  catch(e){ _exportFailUI(e); }
  finally{ _exportBusy=false; _exportCancelReject=null; }
};
function _exportFailUI(e){
  if(_exportElapsedTimer) clearInterval(_exportElapsedTimer);
  if(_exportTimeoutTimer) clearTimeout(_exportTimeoutTimer);
  _exportElapsedTimer=null; _exportTimeoutTimer=null;
  const el=document.getElementById('expElapsed'); if(el) el.style.display='none';
  if(meshWorker){ try{ meshWorker.terminate(); }catch(_){} meshWorker=null; }
  hideComputing(); showCancelBtn(false);
  const btn=document.getElementById('expBtn');
  if(btn){ btn.disabled=false; btn.classList.remove('sweeping'); btn.textContent='Export 3MF'; }
  const cancelled=e&&e.message==='cancelled';
  const rep=document.getElementById('expReport');
  if(rep && !cancelled) rep.innerHTML='<div class="exp-err">&#9888; '+esc((e&&e.message)||e)+'</div>';
  if(!cancelled) console.error('[export]',e);
}

async function _triggerExportImpl(){
  // ── Weld-group export (W4): active body in a >=2-member weld group emits the
  //    group's union as ONE watertight 3MF part (mirrors active-body export). ──
  const _wgid=(typeof activeGroupId==='function')?activeGroupId():null;
  if(_wgid && groupMembers(_wgid).length>=2){ await _exportWeldGroup(_wgid); return; }
  // rc3.5: Solid-body fast path. If the active body is solid, the lattice
  // pipeline doesn't apply — we just emit the body's own watertight mesh as
  // a 3MF, restoring CAD-space vertex coordinates via importCenter.
  if(activeBodyId !== null && isSolidAssignment(assignments.get(activeBodyId))){
    if(!importedShape || !importedShape.posArr || !importedShape.idxArr){
      console.warn('[export] solid body has no mesh data; aborting');
      return;
    }
    const btn=document.getElementById('expBtn');
    btn.disabled=true; btn.classList.add('sweeping'); btn.textContent='exporting solid...';
    try {
      // Restore CAD-space vertices by adding back the importCenter offset
      // (same logic used by the lattice export path further below).
      const verts = new Float32Array(importedShape.posArr.length);
      const c = importedShape.importCenter || {x:0,y:0,z:0};
      for(let i=0;i<importedShape.posArr.length;i+=3){
        verts[i]   = importedShape.posArr[i]   + c.x;
        verts[i+1] = importedShape.posArr[i+1] + c.y;
        verts[i+2] = importedShape.posArr[i+2] + c.z;
      }
      // Index array is reused verbatim (uint32).
      const tris = (importedShape.idxArr instanceof Uint32Array)
        ? importedShape.idxArr
        : new Uint32Array(importedShape.idxArr);
      const blob = await buildMinimal3MF(verts, tris, 1.0);
      const name = (importedShape.meta && importedShape.meta.name) || 'body';
      const baseName = name.replace(/\.[^.]+$/, '');
      const ts = (function(){ const d=new Date(); const p=n=>String(n).padStart(2,'0');
        return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes()); })();
      const fname = safeFilePart(baseName) + '_solid_' + ts + '.3mf';
      downloadBlob(blob, fname);
      const rep=document.getElementById('expReport');
      if(rep) rep.innerHTML='<div class="exp-report">'+expChip('part','solid body')+expChip('triangles',(tris.length/3).toLocaleString())+expChip('file',(blob.size/1024).toFixed(1)+' KB')+'</div>';
    } catch(e) {
      // v0.8.3: show the failure in the export report, not just the console.
      console.error('[export] solid body export failed:', e);
      const rep=document.getElementById('expReport');
      if(rep) rep.innerHTML='<div class="exp-err">&#9888; Solid body export failed — '+esc(e.message||e)+'</div>';
    } finally {
      btn.disabled=false; btn.classList.remove('sweeping'); btn.textContent='Export 3MF';
    }
    return;
  }
  if(!currentRecipe)return;
  if(meshWorker){meshWorker.terminate();meshWorker=null;}
  // Hide stale timings pill from a previous export
  const _tp=document.getElementById('timingsPill');if(_tp)_tp.classList.remove('show');
  const btn=document.getElementById('expBtn');
  const report=document.getElementById('expReport');
  btn.disabled=true;btn.classList.add('sweeping');btn.textContent='computing...';report.innerHTML='';
  // elapsed counter
  const elapsedEl=document.getElementById('expElapsed');
  let elapsedSec=0,elapsedTimer=null;
  if(elapsedEl){elapsedEl.style.display='block';elapsedEl.textContent='elapsed: 0s';
    elapsedTimer=setInterval(()=>{elapsedSec++;elapsedEl.textContent='elapsed: '+elapsedSec+'s';},1000);}
  _exportElapsedTimer=elapsedTimer; // expose to cancelMesh()

  // Compute params on main thread (lightweight math only)
  let workerMsg, scale, domainLabel, edgeLabel;
  if(importedShape){
    const cellSizeMm=parseFloat(document.getElementById('shapeCellSizeMm')?.value)||3;
    const rawRelEdgeMm=QUAL_EDGE_MM[currentExportQual]||0.10;
    const {mnx,mny,mnz,mxx,mxy,mxz}=importedShape.bbox;
    const{safeEdge:relEdgeMm,clamped:exportClamped}=clampEdgeMm(rawRelEdgeMm,importedShape.bbox,getMaxExportVoxels(currentRecipe));
    // ── Feature-aware simplify tolerance (v0.4.2; iso-aware in v0.5.0) ──────
    // Edge-based rule (15% of voxel edge) is the default. For recipes with
    // explicit thin features (wall_thickness, pipe_radius, half_width), cap
    // tolerance at 5% of the physical half-thickness to keep meshopt's edge-
    // collapse from eroding beams symmetrically inward.
    //
    // v0.5.0: iso offset modifies the actual wall thickness. Positive iso
    // (UI: thicker) increases effective featMm; negative iso decreases it.
    // The cap must use the SMALLER of (recipe-declared featMm, effective
    // post-iso featMm) so we stay safe when iso shrinks walls. When iso
    // makes walls vanish (effective ≤ 0), the cap is meaningless — skip.
    const edgeTol=relEdgeMm*0.15;
    const featMm=getThinnestFeatureMm(currentRecipe,cellSizeMm);
    let effectiveFeatMm = featMm;
    if(featMm != null){
      const isoMm = structureTransform.isoOffsetMm || 0;
      effectiveFeatMm = featMm + isoMm;
      // Use the more conservative of original or post-iso half-thickness.
      // (When iso shrinks walls, effective < featMm; when iso grows them,
      // effective > featMm but we don't relax the cap — safer.)
      effectiveFeatMm = Math.min(featMm, effectiveFeatMm);
    }
    const cappedTol = (effectiveFeatMm != null && effectiveFeatMm > 0)
                      ? effectiveFeatMm * 0.05 : Infinity;
    const simplifyTol=Math.min(edgeTol,cappedTol);
    const simplifyCappedByFeature=effectiveFeatMm != null && effectiveFeatMm > 0 && cappedTol < edgeTol;
    // Re-bake shape SDF at export resolution if the cached grid is coarser than
    // our target. Target N is quality-scaled — draft is ~5s, ultra ~270s. If a
    // later export requests higher N than cached, we re-bake; if lower (or equal),
    // we reuse the cached higher-resolution grid.
    const targetShapeN=EXPORT_SHAPE_SDF_N_BY_QUAL[currentExportQual]||192;
    if(!importedShape.sdfGrid||importedShape.sdfGrid.N<targetShapeN){
      coMain.textContent='preparing export...';
      coSub.textContent='refining shape SDF ('+targetShapeN+'³)...';
      overlay.classList.remove('hidden');
      showCancelBtn(true);
      if(window._orbStart)_orbStart();
      const bakeStart=performance.now();
      try{
        importedShape.sdfGrid=await computeShapeSDF(
          importedShape.posArr,importedShape.idxArr,importedShape.bbox,
          targetShapeN,
          pct=>{
            const elapsed=Math.round((performance.now()-bakeStart)/1000);
            const remaining=Math.max(0,Math.round(elapsed/Math.max(pct,0.01)-elapsed));
            coSub.textContent='refining shape SDF ('+targetShapeN+'³) · '+Math.round(pct*100)+'% · ~'+remaining+'s left';
          }
        );
        // Timings pill: remember how long the SDF bake took so the pill can
        // display it alongside the levelSet/simplify times from the mesh worker.
        window._lastSdfBakeMs=Math.round(performance.now()-bakeStart);
      }catch(e){
        if(e.message==='cancelled'){
          // User cancelled — undo elapsed timer, reset export button, bail cleanly.
          if(elapsedTimer)clearInterval(elapsedTimer);
          if(elapsedEl)elapsedEl.style.display='none';
          hideComputing();showCancelBtn(false);
          btn.disabled=false;btn.classList.remove('sweeping');btn.textContent='Export 3MF';
          return;
        }
        throw e;
      }
      showCancelBtn(false);
    }
    // ── HU pre-bake (v0.5.0-rc20) ─────────────────────────────────────────
    // Hyperuniform recipes need a full-domain kernel grid baked in mm-space.
    // Doing it in the export worker was a serial bottleneck (~10s+ for typical
    // orthopedic shapes); doing it on the main thread via a parallel worker
    // pool drops to ~1-2s. Result is cached on the recipe so re-exports at the
    // same quality reuse the grid (iso/quality changes don't invalidate; field
    // params, bbox/cellSizeMm, AND structure rotation+offset all change the
    // bake bbox so they DO invalidate).
    let huGridForExport = null;
    const isHURecipe = currentRecipe.family==='grain' && currentRecipe.json.field?.type==='hyperuniform';
    if(isHURecipe){
      const f=currentRecipe.json.field;
      let dirTheta=0, dirPhi=0;
      if(f.dir_mode==='single' && f.principal_direction){
        const [mx,my,mz]=f.principal_direction;
        dirTheta=Math.acos(Math.max(-1,Math.min(1,mz)))*180/Math.PI;
        dirPhi=Math.atan2(my,mx)*180/Math.PI;
      }
      const huParams={
        kappa:f.kappa??6, rngSeed:f.rng_seed??42,
        dirMode:f.dir_mode||'single', dirTheta, dirPhi,
        wX:f.ortho_weights?.[0]??.33, wY:f.ortho_weights?.[1]??.33, wZ:f.ortho_weights?.[2]??.34,
        huN:f.hu_n||80, huAspect:f.hu_aspect||4, huWidth:f.hu_width||.04,
        huCross:f.hu_cross||2, huSharp:f.hu_sharp||1, huBlend:f.hu_blend||1, huEll:f.hu_ell||1
      };
      // Bake bbox = AABB of structure-transformed shape bbox corners (mm).
      // The export worker queries the grid at xform(p) = R^T·(p - pivot - off) + pivot
      // for p ∈ shape_bbox. The grid must cover that set; otherwise the SDF
      // closure's c01 clamp produces boundary-slice extrusion artifacts in
      // the rotated direction (same failure mode as the rc20 spinodoid fix,
      // just in mm-space here). For identity rotation + zero offset, the
      // AABB collapses to the shape bbox exactly — no behavior change.
      const xfR=structureTransform.rotMat;
      const xfPivX=(mnx+mxx)*0.5, xfPivY=(mny+mxy)*0.5, xfPivZ=(mnz+mxz)*0.5;
      const xfOffX=structureTransform.spatialOffsetMmX;
      const xfOffY=structureTransform.spatialOffsetMmY;
      const xfOffZ=structureTransform.spatialOffsetMmZ;
      let bMnx=Infinity,bMny=Infinity,bMnz=Infinity, bMxx=-Infinity,bMxy=-Infinity,bMxz=-Infinity;
      for(let cx=0;cx<2;cx++)for(let cy=0;cy<2;cy++)for(let cz=0;cz<2;cz++){
        const px=cx?mxx:mnx, py=cy?mxy:mny, pz=cz?mxz:mnz;
        const qx=px-xfPivX-xfOffX, qy=py-xfPivY-xfOffY, qz=pz-xfPivZ-xfOffZ;
        const lx=xfR[0]*qx+xfR[3]*qy+xfR[6]*qz;
        const ly=xfR[1]*qx+xfR[4]*qy+xfR[7]*qz;
        const lz=xfR[2]*qx+xfR[5]*qy+xfR[8]*qz;
        const tx=lx+xfPivX, ty=ly+xfPivY, tz=lz+xfPivZ;
        if(tx<bMnx)bMnx=tx; if(ty<bMny)bMny=ty; if(tz<bMnz)bMnz=tz;
        if(tx>bMxx)bMxx=tx; if(ty>bMxy)bMxy=ty; if(tz>bMxz)bMxz=tz;
      }
      const huBbox={mnx:bMnx, mny:bMny, mnz:bMnz, mxx:bMxx, mxy:bMxy, mxz:bMxz};
      // N_hu sized to the BAKE bbox (rotation can grow extents beyond the
      // shape bbox). Keeps the "32 voxels per design cell" target consistent.
      const _ddx=huBbox.mxx-huBbox.mnx, _ddy=huBbox.mxy-huBbox.mny, _ddz=huBbox.mxz-huBbox.mnz;
      const _maxCells=Math.max(_ddx,_ddy,_ddz)/cellSizeMm;
      const huN=Math.max(32, Math.ceil(32*_maxCells));
      // Cache key uses the bake bbox directly — captures rotation+offset
      // dependency without needing separate fields. Quality/iso don't appear
      // because they sit downstream of the bake.
      const huCacheKey=`${huParams.rngSeed}|${huParams.huN}|${huParams.huAspect}|${huParams.huWidth}|${huParams.kappa}|${huParams.dirMode}|${huParams.dirTheta}|${huParams.dirPhi}|${huParams.wX}|${huParams.wY}|${huParams.wZ}|${cellSizeMm}|${huBbox.mnx}|${huBbox.mny}|${huBbox.mnz}|${huBbox.mxx}|${huBbox.mxy}|${huBbox.mxz}|${huN}`;
      if(currentRecipe._huGridCache && currentRecipe._huGridCache.key===huCacheKey){
        huGridForExport=currentRecipe._huGridCache;
      } else {
        coMain.textContent='preparing export...';
        coSub.textContent='pre-baking HU field ('+huN+'\u00b3 grid)...';
        overlay.classList.remove('hidden');
        showCancelBtn(true);
        const huStart=performance.now();
        try{
          const huResult=await computeHUGridMM(
            huParams, huBbox, cellSizeMm, huN,
            pct=>{
              const elapsed=Math.round((performance.now()-huStart)/1000);
              const remaining=Math.max(0,Math.round(elapsed/Math.max(pct,0.01)-elapsed));
              coSub.textContent='pre-baking HU field ('+huN+'\u00b3) · '+Math.round(pct*100)+'% · ~'+remaining+'s left';
            }
          );
          huGridForExport={key:huCacheKey, data:huResult.data, N:huResult.N, fieldMin:huResult.fieldMin, fieldMax:huResult.fieldMax, bbox:huBbox};
          currentRecipe._huGridCache=huGridForExport;
        }catch(e){
          if(e.message==='cancelled'){
            if(elapsedTimer)clearInterval(elapsedTimer);
            if(elapsedEl)elapsedEl.style.display='none';
            hideComputing(); showCancelBtn(false);
            btn.disabled=false; btn.classList.remove('sweeping'); btn.textContent='Export 3MF';
            return;
          }
          throw e;
        }
        showCancelBtn(false);
      }
    }
    const {estTris,estSec}=estimateMeshStats(currentRecipe,relEdgeMm,importedShape.bbox,cellSizeMm);
    if(exportClamped) console.warn('[export] grid clamped to '+relEdgeMm.toFixed(3)+'mm — cell size too small for export voxel budget');
    // ── Layer 1: feature-ratio guard (v0.5.1-rc4.1) ────────────────────
    // Floor, rationale, and message text now live at module scope alongside
    // checkFeatureEdgeRatio / featureRatioErrorHtml, shared with the weld path.
    const thinnestFeatureMm = getThinnestFeatureMm(currentRecipe, cellSizeMm);
    const chk = checkFeatureEdgeRatio(thinnestFeatureMm, relEdgeMm, cellSizeMm);
    console.log('[export][feature-guard]', {
      thinnestFeatureMm: thinnestFeatureMm != null ? +thinnestFeatureMm.toFixed(4) : null,
      fineEdgeMm: +relEdgeMm.toFixed(4),
      featureEdgeRatio: chk.ratio != null ? +chk.ratio.toFixed(2) : null,
      ratioFloor: chk.floor,
      cellSizeMm, quality: currentExportQual
    });
    if(!chk.ok){
      // This guard runs BEFORE the main export try/catch opens (which starts at
      // the worker dispatch). Throwing here escapes as an uncaught promise
      // rejection and leaves the overlay stuck on "preparing export". So we tear
      // down the UI explicitly and return — mirroring the HU pre-bake cancel
      // path above. Surfaces through the same exp-err styling as the catch.
      if(elapsedTimer)clearInterval(elapsedTimer);
      _exportElapsedTimer=null; _exportTimeoutTimer=null;
      if(elapsedEl)elapsedEl.style.display='none';
      hideComputing(); showCancelBtn(false);
      report.innerHTML=featureRatioErrorHtml(chk, thinnestFeatureMm, relEdgeMm, currentExportQual, null);
      btn.disabled=false; btn.classList.remove('sweeping'); btn.textContent='Export 3MF';
      return;
    }
    coMain.textContent='exporting...';
    coSub.textContent='~'+(estTris/1e6).toFixed(1)+'M tris estimated · ~'+estSec+'s';
    overlay.classList.remove('hidden');showCancelBtn(true);
    scale=1.0;
    domainLabel=importedShape.meta.bbox;
    edgeLabel=relEdgeMm.toFixed(2)+'mm';
    // Transfer a COPY of the SDF buffer so the cache survives in main thread.
    const shapeSdfBuffer=importedShape.sdfGrid.data.buffer.slice(0);
    // Same pattern for HU grid: clone so the recipe-level cache survives the
    // transfer. ~10 MB temp peak for typical bbox+cellSize combinations.
    const huGridBuffer = huGridForExport ? huGridForExport.data.buffer.slice(0) : null;
    workerMsg={
      mode:'export',recipe:currentRecipe,
      shapeSdfData:shapeSdfBuffer,
      shapeN:importedShape.sdfGrid.N,
      bbox:{mnx,mny,mnz,mxx,mxy,mxz},
      cellSizeMm,relEdgeMm,simplifyTol,scale,
      simplifyCappedByFeature,featMm:effectiveFeatMm,
      // v0.5.0-rc20: HU shape-mode grid baked in parallel on main thread.
      // Worker uses these instead of running its own serial bakeGridMM.
      // Absent for non-HU recipes; absent + falls back to legacy serial bake
      // if the parallel orchestrator failed gracefully.
      huGridData: huGridBuffer || undefined,
      huGridN:    huGridForExport ? huGridForExport.N : undefined,
      huFieldMin: huGridForExport ? huGridForExport.fieldMin : undefined,
      huFieldMax: huGridForExport ? huGridForExport.fieldMax : undefined,
      // Bake bbox (mm). Differs from `bbox` (shape bbox) when structure
      // rotation or offset is non-identity — covers the rotated query set so
      // the SDF closure can map uvw without clamping at boundaries.
      huBbox:     huGridForExport ? huGridForExport.bbox : undefined,
      // v0.5.0-rc17: trim-to-nodes for beam family (no-op for other families).
      // Read from UI checkbox; default ON when checkbox missing.
      // v0.5.0-rc18: pruneInsetMult scales the auto-clamped inset (default 1.0,
      // range 1.0–2.0). Worker uses max(beam_radius, voxel_size × multiplier).
      pruneToNodes: (function(){
        if(currentRecipe.family!=='beam') return false;
        const el=document.getElementById('trimToNodes');
        return el ? !!el.checked : true;
      })(),
      pruneInsetMult: (function(){
        const el=document.getElementById('trimInsetMult');
        const v=el?parseFloat(el.value):1.0;
        return (isFinite(v)&&v>=1.0&&v<=2.0) ? v : 1.0;
      })(),
      // ── Structure SDF transform (v0.5.0 Phase B) ────────────────────────
      // Mm-unit values; worker does its own world conversion using cellSizeMm
      // and shape bbox (matches main-thread MeshRaymarcher.setStructureTransform).
      // Iso sign here is raw user-input: positive = thicker walls. Worker
      // negates before adding to SDF (same convention as shader uniform).
      structXform:{
        rotMat: structureTransform.rotMat.slice(),
        spatialOffsetMm:[
          structureTransform.spatialOffsetMmX,
          structureTransform.spatialOffsetMmY,
          structureTransform.spatialOffsetMmZ
        ],
        isoOffsetMm: structureTransform.isoOffsetMm
      }
    };
  } else {
    const domainEl=document.getElementById('expDomainMm');
    const domainMm=Math.max(1,Math.min(100,parseFloat(domainEl?.value)||10));
    // v0.8.3: open-cube exports now respect the same family voxel cap as
    // shape exports (clampEdgeWorld existed but was never called): a 100 mm
    // domain at Low asked Manifold for 125M voxels.
    const rawEdgeMmC=QUAL_EDGE_MM[currentExportQual]||.10;
    const {safeEdge:edgeWorld,clamped:cubeClamped}=clampEdgeWorld(rawEdgeMmC*10/domainMm, getMaxExportVoxels(currentRecipe));
    const edgeMm=+(edgeWorld*domainMm/10).toFixed(4);
    if(cubeClamped) console.warn('[export] cube grid clamped to '+edgeMm+'mm edge — voxel budget for '+currentRecipe.family);
    const {estTris,estSec}=estimateMeshStats(currentRecipe,edgeWorld,null);
    coMain.textContent='exporting...';
    coSub.textContent='~'+(estTris/1e6).toFixed(1)+'M tris estimated · ~'+estSec+'s';
    overlay.classList.remove('hidden');showCancelBtn(true);
    scale=domainMm/10;
    domainLabel=domainMm+'mm';
    edgeLabel=edgeMm+'mm';
    // Cube exports run levelSet over [-5,5]³ world space, so vertices come
    // out in world units (scaled to mm in main thread via scale=domainMm/10).
    // Simplify tol must therefore be in world units. Same 15%-of-edge default
    // and 5%-of-feature cap as the shape-clipped path. domainMm is the right
    // "cellSizeMm" to pass getThinnestFeatureMm because the cube spans one
    // design cell.
    const cubeEdgeTolWorld = edgeWorld * 0.15;
    const cubeFeatMm = getThinnestFeatureMm(currentRecipe, domainMm);
    const cubeFeatWorld = (cubeFeatMm != null && cubeFeatMm > 0) ? cubeFeatMm * 10 / domainMm : null;
    const cubeCappedTolWorld = (cubeFeatWorld != null) ? cubeFeatWorld * 0.05 : Infinity;
    const cubeSimplifyTol = Math.min(cubeEdgeTolWorld, cubeCappedTolWorld);
    const cubeSimplifyCappedByFeature = cubeFeatWorld != null && cubeCappedTolWorld < cubeEdgeTolWorld;
    workerMsg={
      mode:'export',recipe:currentRecipe,edgeWorld,
      simplifyTol:cubeSimplifyTol,
      simplifyCappedByFeature:cubeSimplifyCappedByFeature,
      featMm:cubeFeatMm,  // mm value, for timings-pill display
      scale
    };
  }

  try{
    const worker=new Worker(getMeshWorkerUrl());
    meshWorker=worker;
    // ── Layer 2: wall-clock timeout backstop (v0.5.1-rc4.0b) ────────────────
    // The feature-ratio guard (Layer 1) catches the known thin-wall failure
    // before dispatch. This is the categorical safety net: if ANY export — for
    // any reason Layer 1 didn't anticipate — runs past the ceiling, force-kill
    // the worker so the app never hangs indefinitely. Generous (180s) so it
    // never trips a legitimately large-but-progressing fine export; only true
    // runaways reach it. Manifold's level set is synchronous inside the worker,
    // so worker.terminate() is the only reliable way to stop it.
    const EXPORT_TIMEOUT_MS = 180000;
    let exportTimedOut = false;
    let exportTimer = null;
    const result=await new Promise((resolve,reject)=>{
      exportTimer = setTimeout(()=>{
        exportTimedOut = true;
        try{ worker.terminate(); }catch(_){}
        if(meshWorker===worker) meshWorker=null;
        reject(new Error(
          'Export exceeded '+(EXPORT_TIMEOUT_MS/1000)+'s and was stopped. The '+
          'geometry is too dense to mesh at this quality — increase cell size '+
          'or lower export quality, then try again.'
        ));
      }, EXPORT_TIMEOUT_MS);
      _exportTimeoutTimer = exportTimer; // expose to cancelMesh()
      _exportCancelReject = reject;      // v0.8.1: Cancel settles this wait
      worker.onmessage=e=>{
        const d=e.data;
        if(exportTimedOut) return; // ignore late messages from a killed worker
        if(d.type==='progress') coSub.textContent=d.stage;
        else if(d.type==='diag'){
          // v0.5.1-rc4.0b: calibration log for the export guards.
          console.log('[export][mem-guard]', d.diag);
        }
        else if(d.type==='done'){ clearTimeout(exportTimer); resolve(d); }
        else if(d.type==='error'){ clearTimeout(exportTimer); reject(new Error(d.message)); }
      };
      worker.onerror=e=>{ clearTimeout(exportTimer); reject(new Error(e.message||'Worker error')); };
      // Build transfer list — only include buffers that are actually present.
      // shapeSdfData is mandatory for shape-clipped exports; huGridData is
      // optional (only set for HU recipes when the parallel pre-bake ran).
      const transferList=[];
      if(workerMsg.shapeSdfData) transferList.push(workerMsg.shapeSdfData);
      if(workerMsg.huGridData) transferList.push(workerMsg.huGridData);
      if(transferList.length){
        worker.postMessage(workerMsg, transferList);
      } else {
        worker.postMessage(workerMsg);
      }
    });
    if(meshWorker===worker){meshWorker=null;}
    worker.terminate();
    if(elapsedTimer)clearInterval(elapsedTimer);
    _exportElapsedTimer=null; _exportTimeoutTimer=null;
    hideComputing();showCancelBtn(false);
    btn.textContent='building 3MF...';
    const vertProps=new Float32Array(result.vertProperties);
    const triVerts=new Uint32Array(result.triVerts);
    // Restore original CAD coordinates: mesh was translated to origin at
    // import so the preview pipeline could operate in a single consistent
    // coord system. Shift vertices back by +importCenter so the exported
    // 3MF lines up with the user's CAD assembly on reimport.
    if(importedShape&&importedShape.importCenter){
      const c=importedShape.importCenter;
      for(let i=0;i<vertProps.length;i+=3){
        vertProps[i]  +=c.x;
        vertProps[i+1]+=c.y;
        vertProps[i+2]+=c.z;
      }
    }
    const blob=await buildMinimal3MF(vertProps,triVerts,result.scale??scale);
    const j=currentRecipe.json;
    const preset=safeFilePart(j.surface?.preset||j.surface?.noise_type||j.field?.type||currentRecipe.subtype);
    const shapeSuffix=importedShape?('_'+safeFilePart(importedShape.meta.name.replace(/\.[^.]+$/,''))):'';
    // Filename decorators (v0.5.0-rc8): embed cell size and iso offset so
    // downstream files are self-describing. Filesystem-safe formatting:
    //   - dots → 'p' (5.0mm → "5p0mm")
    //   - negatives → 'n' prefix ("-0.05mm" → "n0p05mm")
    //   - iso=0 → "iso0" to make the exported geometry unambiguous
    const fmtMm = v => {
      const abs = Math.abs(v).toFixed(2).replace(/\.?0+$/,'');
      const body = abs.replace('.','p') || '0';
      return (v<0?'n':'') + body + 'mm';
    };
    let paramSuffix = '';
    if(importedShape){
      const cellSizeMm = parseFloat(document.getElementById('shapeCellSizeMm')?.value)||3;
      const isoMm = structureTransform.isoOffsetMm || 0;
      paramSuffix = '_cell'+fmtMm(cellSizeMm)+'_iso'+(isoMm===0?'0':fmtMm(isoMm));
    }
    const ts=new Date().toISOString().slice(0,10);
    const filename=currentRecipe.family+'_'+preset+shapeSuffix+paramSuffix+'_'+ts+'.3mf';
    downloadBlob(blob, filename);
    report.innerHTML='<div class="exp-report">'+
      expChip('triangles',result.triCount.toLocaleString())+
      expChip('domain',domainLabel)+
      expChip('edge',edgeLabel)+
      expChip('file',(blob.size/1024).toFixed(1)+' KB')+
      expChip('time',result.ms+'ms')+
    '</div>';
    // ── Timings pill: SDF bake + levelSet + simplify ──────────────────────
    // SDF bake is tracked on main thread (window._lastSdfBakeMs), levelSet
    // and simplify come from worker's msBreakdown. Total is wall-clock
    // from first-bake-start through worker-done.
    const pill=document.getElementById('timingsPill');
    if(pill){
      const fmt=ms=>ms>=1000?(ms/1000).toFixed(1)+'s':ms+'ms';
      const sdfMs=window._lastSdfBakeMs||0;
      const bd=result.msBreakdown||{};
      const simpMs=bd.simplify||0;
      const totalMs=sdfMs+(bd.total||result.ms||0);
      document.getElementById('tpSdf').textContent=sdfMs>0?fmt(sdfMs):'cached';
      document.getElementById('tpSimplify').textContent=simpMs>0?fmt(simpMs):'—';
      document.getElementById('tpTotal').textContent=fmt(totalMs);
      pill.classList.add('show');
    }
    // Clear for next export so cached SDF shows correctly
    window._lastSdfBakeMs=0;
    if(elapsedEl)elapsedEl.style.display='none';
    btn.classList.remove('sweeping');btn.textContent='Export 3MF';
  }catch(e){
    if(elapsedTimer)clearInterval(elapsedTimer);
    if(_exportTimeoutTimer){clearTimeout(_exportTimeoutTimer);}
    _exportElapsedTimer=null; _exportTimeoutTimer=null;
    if(elapsedEl){elapsedEl.style.display='none';}
    if(meshWorker){meshWorker.terminate();meshWorker=null;}
    hideComputing();showCancelBtn(false);
    report.innerHTML=(e.message==='cancelled')?'':'<div class="exp-err">&#9888; '+esc(e.message||e)+'</div>';
    btn.classList.remove('sweeping');btn.textContent='Export 3MF';
    if(e.message!=='cancelled') console.error(e);
  }
  btn.disabled=false;
};
function expChip(l,v){return`<div class="exp-chip">${esc(l)} <b>${esc(v)}</b></div>`;}
