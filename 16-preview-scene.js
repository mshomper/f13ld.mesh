/* ============================================================
   F13LD.mesh · 16-preview-scene.js
   v0.14.0 (P2) · one scene for the preview: every visible part is a member,
   welds are groups, and the bakes that remain are per recipe (sources).
   ============================================================ */
'use strict';

// The raymarcher pulls the scene from here on every dirty frame
// (rm._sceneProvider = previewSceneSync). A cheap signature of everything the
// scene depends on is compared first, so camera moves cost nothing. When it
// changed, buildPreviewScene() rebuilds the member table and the list of
// sources it needs; sources already baked (P1 cache, 42-preview-bake.js) commit
// in the same frame, so every structure setting is live: cell size, wall
// offset, rotation, shift, fill, skin, fillet, join rule and its distances.
//
// Sources (see docs/P2_SCENE_SHADER_SCOPE.md §4.2):
//   tile    periodic recipes (TPMS, beam, wave, foam, unwarped bundle,
//           reaction-diffusion and hyperuniform grain): exactly the P1 periodic
//           bake, shared by every part using the recipe. Never re-baked for a
//           transform, cell size or wall offset.
//   region  aperiodic recipes (noise, spinodoid / GRF grain, warped bundle): the
//           P1 shape-mode bake over the box the transformed part needs. The box
//           is the one P1 used (it also sets the noise / grain range the export
//           reads), so rotation, shift or cell size re-bake it — in the
//           background, the old region keeps drawing meanwhile (no hold).
// A source that is missing the first time a part shows holds the last frame
// (P1 rule) until it lands; with nothing on screen yet, that part draws as a
// solid shell meanwhile.

const PSC={
  lastSig:'', ver:0,                 // signature of the committed scene; bumped when a bake lands
  pend:new Map(),                    // bake key -> promise (in flight)
  lastByBody:new Map(),              // bodyId -> {recipe, kind, src} last committed source
  holding:false, lowDetail:false, slowGpu:false, fallbackOff:false,
  waiters:[], lastScene:null, lastBakeMs:null, commits:0, keyMemo:new WeakMap()
};
const SCENE_MAX_MEMBERS=8;

// -- Per-member settings --------------------------------------------------
function _scCellMm(id){
  const b=bodies.get(id);
  if(id===activeBodyId){ const v=parseFloat(document.getElementById('shapeCellSizeMm')?.value); if(v>0) return v; }
  return (b&&b.cellSizeMm>0)?b.cellSizeMm:3;
}
const _SC_IDENT={rotXDeg:0,rotYDeg:0,rotZDeg:0,spatialOffsetMmX:0,spatialOffsetMmY:0,spatialOffsetMmZ:0,isoOffsetMm:0,rotMat:[1,0,0,0,1,0,0,0,1]};
function _scXf(id){
  if(id===activeBodyId && typeof structureTransform!=='undefined') return structureTransform;
  const b=bodies.get(id); return (b&&b.structureTransform)||_SC_IDENT;
}
function _scRecipe(id){ const rid=assignments.get(id); return (rid && !isSolidAssignment(rid) && recipes.has(rid)) ? recipes.get(rid) : null; }

// The bake a lattice member needs: the P1 single-part bake for that part, as if
// it were selected (44-preview-trigger.js v0.13.0). body = null: open cube.
function sceneSourceNeed(recipe, quality, body, cellMm, xf){
  const periodic=recipeIsPeriodic(recipe);
  let N=PREVIEW_BAKE_N[quality]||64;
  const famDesc=familyOf(recipe);
  const isStochastic=!!(famDesc && famDesc.stochastic);
  let opts={isPeriodic:periodic,bakeRaw:!periodic&&isStochastic};
  let box=null, kind='tile';
  if(!periodic && body){
    const s=10/cellMm, b=body.bbox;
    const isHU=!!(famDesc && typeof famDesc.hyperuniform==='function' && famDesc.hyperuniform(recipe));
    if(isHU){
      opts={isPeriodic:true,bakeRaw:true,shapeCtx:{cellSizeMm:cellMm,bbox:{mnx:b.mnx,mny:b.mny,mnz:b.mnz,mxx:b.mxx,mxy:b.mxy,mxz:b.mxz}}};
      box={min:[-5,-5,-5],max:[5,5,5]};
    }else{
      // AABB of the structure-transformed part box (lattice world), as P1.
      const pX=(b.mnx+b.mxx)*0.5*s, pY=(b.mny+b.mxy)*0.5*s, pZ=(b.mnz+b.mxz)*0.5*s;
      const oX=xf.spatialOffsetMmX*s, oY=xf.spatialOffsetMmY*s, oZ=xf.spatialOffsetMmZ*s;
      const R=xf.rotMat;
      let aMnX=Infinity,aMnY=Infinity,aMnZ=Infinity,aMxX=-Infinity,aMxY=-Infinity,aMxZ=-Infinity;
      for(let cx=0;cx<2;cx++)for(let cy=0;cy<2;cy++)for(let cz=0;cz<2;cz++){
        const wx=(cx?b.mxx:b.mnx)*s, wy=(cy?b.mxy:b.mny)*s, wz=(cz?b.mxz:b.mnz)*s;
        const qx=wx-pX-oX, qy=wy-pY-oY, qz=wz-pZ-oZ;
        const tx=R[0]*qx+R[3]*qy+R[6]*qz+pX, ty=R[1]*qx+R[4]*qy+R[7]*qz+pY, tz=R[2]*qx+R[5]*qy+R[8]*qz+pZ;
        if(tx<aMnX)aMnX=tx; if(ty<aMnY)aMnY=ty; if(tz<aMnZ)aMnZ=tz;
        if(tx>aMxX)aMxX=tx; if(ty>aMxY)aMxY=ty; if(tz>aMxZ)aMxZ=tz;
      }
      const wMin=[aMnX,aMnY,aMnZ], wMax=[aMxX,aMxY,aMxZ];
      opts={isPeriodic:false,bakeRaw:isStochastic,worldMin:wMin,worldMax:wMax};
      if(isStochastic) opts.shapeCtx={cellSizeMm:cellMm,bbox:{mnx:b.mnx,mny:b.mny,mnz:b.mnz,mxx:b.mxx,mxy:b.mxy,mxz:b.mxz}};
      box={min:wMin,max:wMax}; kind='region';
    }
  }else{
    let pMin=[-5,-5,-5], pMax=[5,5,5];
    if(famDesc && typeof famDesc.bakeBounds==='function'){
      const bb=famDesc.bakeBounds(recipe);
      if(bb){ pMin=bb.wMin; pMax=bb.wMax; opts.worldMin=pMin; opts.worldMax=pMax; if(bb.S>1) N=Math.min(192, N*bb.S); }
    }
    box={min:pMin,max:pMax}; kind=periodic?'tile':'region';
  }
  return {recipe, N, opts, box, kind, key:_scKey(recipe,N,opts)};
}
// previewBakeKey stringifies the recipe; memoise per recipe object.
function _scKey(recipe, N, opts){
  let m=PSC.keyMemo.get(recipe); if(!m){ m=new Map(); PSC.keyMemo.set(recipe,m); }
  const s=N+'|'+JSON.stringify(opts)+'|'+recipe._previewFieldMin+'|'+recipe._previewFieldMax;
  let k=m.get(s); if(!k){ k=previewBakeKey(recipe,N,opts); if(m.size>64) m.clear(); m.set(s,k); }
  return k;
}

// -- What is selected (outline) ------------------------------------------
function _scSelected(id){
  const sel=(typeof railSel==='function')?railSel():(activeBodyId!=null?{t:'part',id:activeBodyId}:null);
  if(!sel) return false;
  return sel.t==='weld' ? bodyGroup.get(id)===sel.id : id===sel.id;
}

// -- Signature: everything buildPreviewScene reads -------------------------
function previewSceneSig(quality){
  const p=[quality,PSC.ver,PSC.lowDetail?1:0,activeBodyId,bodies.size,
    (typeof railSel==='function'&&railSel())?JSON.stringify(railSel()):'',
    importedShape?1:0, currentRecipe?currentRecipe.id||currentRecipe.family:'',
    document.getElementById('shapeCellSizeMm')?.value];
  for(const id of bodyOrder){
    const b=bodies.get(id); if(!b) continue;
    const xf=_scXf(id), g=bodyGroup.get(id)||'';
    const pg=(typeof previewShapeGrid==='function')?previewShapeGrid(b):b.sdfGrid;
    p.push(id,b.visibility||VIS_DEFAULT,assignments.get(id),bodyFill(id),b.skinMm,_scCellMm(id),
      xf.rotMat.join(','),xf.spatialOffsetMmX,xf.spatialOffsetMmY,xf.spatialOffsetMmZ,xf.isoOffsetMm,
      resolveBodyColor(id),g,pg?pg.N:0,b.bbox?b.bbox.mnx+','+b.bbox.mxx:'');
  }
  for(const [gid,g] of weldGroups) p.push(gid,g.filletMm,g.joinRule,g.anchorMm,g.gradeMm,g.gradeMaxMm,g.showJoins?1:0,g.colorHex||'');
  return p.join('|');
}

// -- Build ---------------------------------------------------------------
// Returns {desc (for rm.setScene, sources still unresolved), needs:[…]} or null.
// needs[j] belongs to desc.sources[j]; members point at it by index.
function buildPreviewScene(quality){
  const needs=[], needIdx=new Map();
  function addNeed(nd){
    if(needIdx.has(nd.key)){ const j=needIdx.get(nd.key); if(nd.forActive) needs[j].forActive=true; return j; }
    needIdx.set(nd.key, needs.length); needs.push(nd); return needs.length-1;
  }
  const desc={members:[], groups:[], sources:[], outline:false, joinBand:0.5, refCell:10,
    baseStep:10/(PREVIEW_BAKE_N[quality]||64), cube:false};
  // ── Open cube (no part): the recipe drawn in its own world frame.
  if(!importedShape || bodies.size===0){
    if(!currentRecipe) return null;
    const nd=sceneSourceNeed(currentRecipe, quality, null, 10, _SC_IDENT);
    nd.forActive=true; nd.bodyId=null;
    const j=addNeed(nd);
    desc.cube=true; desc.cubeBox=nd.box;
    desc.members.push({grid:null, bbox:{mnx:0,mny:0,mnz:0,mxx:0,mxy:0,mxz:0}, fill:1, vis:0,
      rotT:[1,0,0,0,1,0,0,0,1], cellMm:10, isoMm:0, skinMm:0, shiftMm:[0,0,0], src:j,
      color:_hexToRGB(familyColor(currentRecipe.family)), selected:false, group:0, padMm:0,
      nrmStep:0, shapeVoxMm:0, hasShape:false, bodyId:null, recipe:currentRecipe});
    desc.groups.push({start:0,count:1,filletMm:0,rule:0,anchorMm:0,gradeMm:0,gradeMaxMm:0,showJoins:false});
    return {desc, needs};
  }
  desc.refCell=_scCellMm(activeBodyId);
  // ── Parts: drawn ones (grouped) then ghost shells. Hidden parts aren't drawn.
  const drawn=[], ghosts=[];
  for(const id of bodyOrder){
    const b=bodies.get(id); if(!b||!b.bbox) continue;
    const v=b.visibility||VIS_DEFAULT;
    if(v===VIS_HIDDEN) continue;
    (v===VIS_GHOST?ghosts:drawn).push(id);
  }
  // Group key: a weld with two or more drawn members; anything else stands alone.
  const gCount=new Map();
  for(const id of drawn){ const g=bodyGroup.get(id); if(g) gCount.set(g,(gCount.get(g)||0)+1); }
  const gKey=id=>{ const g=bodyGroup.get(id); return (g&&gCount.get(g)>=2)?('w:'+g):('p:'+id); };
  const order=[], byKey=new Map();
  for(const id of drawn){ const k=gKey(id); if(!byKey.has(k)){ byKey.set(k,[]); order.push(k); } byKey.get(k).push(id); }
  const sel=new Set(); for(const id of drawn) if(_scSelected(id)) sel.add(id);
  let band=0.5;
  const mkMember=(id, vis, groupIdx, grp)=>{
    const b=bodies.get(id);
    const capN=(id===activeBodyId)?undefined:(typeof WELD_MEMBER_GRID_MAX!=='undefined'?WELD_MEMBER_GRID_MAX:undefined);
    const grid=(typeof previewShapeGrid==='function')?previewShapeGrid(b,capN):b.sdfGrid;
    const xf=_scXf(id), cell=_scCellMm(id);
    let fill={solid:0,lattice:1,skin:2}[bodyFill(id)]||0;
    let recipe=fill?_scRecipe(id):null; if(!recipe) fill=0;
    const span=Math.max(b.bbox.mxx-b.bbox.mnx,b.bbox.mxy-b.bbox.mny,b.bbox.mxz-b.bbox.mnz);
    const vox=grid&&grid.N?span/grid.N:span/64;
    const skin=b.skinMm>0?b.skinMm:SKIN_DEFAULT_MM;
    const m={grid, bbox:b.bbox, fill:vis?0:fill, vis, rotT:xf.rotMat.slice(), cellMm:cell,
      isoMm:+xf.isoOffsetMm||0, skinMm:skin,
      shiftMm:[+xf.spatialOffsetMmX||0,+xf.spatialOffsetMmY||0,+xf.spatialOffsetMmZ||0],
      src:-1, color:_hexToRGB(resolveBodyColor(id)), selected:!vis&&sel.has(id), group:groupIdx,
      padMm:(grp?(grp.filletMm||0)+(grp.rule===1?grp.anchorMm||0:0):0)+Math.abs(+xf.isoOffsetMm||0)+(fill===2?skin:0)+2*vox+0.25,
      nrmStep:desc.baseStep, shapeVoxMm:vox, hasShape:!!grid, bodyId:id, recipe};
    // Weak-GPU fallback: parts not being edited draw as shells while the view
    // moves; their sources stay in the scene so the atlases don't change.
    const shell=PSC.lowDetail && !sel.has(id) && id!==activeBodyId;
    if(!vis && m.fill && recipe && shell){ const nd=sceneSourceNeed(recipe, quality, b, cell, xf); nd.forActive=false; nd.bodyId=id; addNeed(nd); m.fill=0; }
    else if(!vis && m.fill && recipe){
      const nd=sceneSourceNeed(recipe, quality, b, cell, xf);
      nd.forActive=(id===activeBodyId); nd.bodyId=id;
      m.src=addNeed(nd); m.need=nd;
      const bx=nd.box;
      m.nrmStep=Math.max((bx.max[0]-bx.min[0])/Math.max(nd.N,1)*cell/desc.refCell,0.01);
    }
    return m;
  };
  for(const k of order){
    const ids=byKey.get(k), gi=desc.groups.length, start=desc.members.length;
    let grp={start, count:ids.length, filletMm:0, rule:0, anchorMm:0, gradeMm:0, gradeMaxMm:0, showJoins:false};
    if(k.indexOf('w:')===0){
      const g=weldGroups.get(k.slice(2))||{};
      const hasSolid=ids.some(id=>bodyFill(id)==='solid'||!_scRecipe(id)), hasLat=ids.some(id=>bodyFill(id)!=='solid'&&_scRecipe(id));
      const rule=(hasSolid&&hasLat)?({anchor:1,graded:2}[g.joinRule]||0):0;
      grp=Object.assign(grp,{filletMm:Math.max(0,+g.filletMm||0), rule,
        anchorMm:rule===1?Math.max(0,+g.anchorMm||0):0, gradeMm:rule===2?Math.max(0,+g.gradeMm||0):0,
        gradeMaxMm:(g.gradeMaxMm>0)?+g.gradeMaxMm:0, showJoins:!!g.showJoins});
      if(rule===1&&!(grp.anchorMm>0)) grp.rule=0;
      if(rule===2&&!(grp.gradeMm>0)) grp.rule=0;
    }
    desc.groups.push(grp);
    for(const id of ids){
      if(desc.members.length>=SCENE_MAX_MEMBERS) break;
      const m=mkMember(id, 0, gi, grp); desc.members.push(m);
      if(grp.showJoins) band=Math.max(band,(grp.filletMm||0)+0.2,0.75*m.shapeVoxMm);
    }
    grp.count=desc.members.length-start;
  }
  for(const id of ghosts){ if(desc.members.length>=SCENE_MAX_MEMBERS) break; desc.members.push(mkMember(id, 1, 0, null)); }
  desc.joinBand=band;
  const nDrawn=desc.members.filter(m=>!m.vis).length;
  desc.outline=nDrawn>=2 && desc.members.some(m=>m.selected);
  return {desc, needs};
}

// -- Sources --------------------------------------------------------------
function _scStartBake(nd){
  if(PSC.pend.has(nd.key)) return;
  const t0=performance.now();
  const p=bakeField(nd.recipe, nd.N, nd.opts).then(res=>{
    PSC.pend.delete(nd.key);
    PSC.lastBakeMs=Math.round(performance.now()-t0);
    // v0.8.3 rule: the selected part's raw bake writes its range to the recipe
    // it baked (the export reads it), even if superseded.
    if(nd.forActive && nd.opts.bakeRaw){ nd.recipe._previewFieldMin=res.fieldMin; nd.recipe._previewFieldMax=res.fieldMax; }
    PSC.ver++; if(rm) rm._dirty=true;
  }).catch(e=>{
    PSC.pend.delete(nd.key);
    if(e && e.message==='cancelled') return;
    console.error('[scene] bake', e);
    if(typeof showError==='function') showError('Preview: '+(e&&e.message||e));
    PSC.ver++; if(rm) rm._dirty=true;
  });
  PSC.pend.set(nd.key, p);
}
// Resolve every need: cached → ready; else bake. A part that had a source of
// the same recipe and kind keeps drawing it meanwhile (soft); otherwise the
// source is missing (hard).
function _scResolve(scene){
  const out={sources:[], hard:[], soft:[]};
  for(const nd of scene.needs){
    const res=previewBakeCached(nd.key);
    if(res){ out.sources.push({key:nd.key, kind:nd.kind, res, box:nd.box, need:nd}); continue; }
    _scStartBake(nd);
    const prev=nd.bodyId!=null?PSC.lastByBody.get(nd.bodyId):(PSC.lastByBody.get('cube')||null);
    if(prev && prev.recipe===nd.recipe && prev.kind===nd.kind && nd.kind==='region'){ out.sources.push(prev.src); out.soft.push(nd); }
    else { out.sources.push(null); out.hard.push(nd); }
  }
  return out;
}

// -- Commit ---------------------------------------------------------------
function _scCommit(scene, r){
  const desc=scene.desc;
  // Members whose source is missing draw as solid shells; re-index sources.
  const srcs=[], map=new Map();
  r.sources.forEach((s,j)=>{ if(s){ map.set(j,srcs.length); srcs.push(s); } });
  for(const m of desc.members){
    if(m.src>=0){ if(map.has(m.src)) m.src=map.get(m.src); else { m.src=-1; m.fill=0; } }
  }
  desc.sources=srcs;
  rm.setScene(desc);
  PSC.lastScene=desc; PSC.commits++;
  for(const m of desc.members) if(m.src>=0){ const s=srcs[m.src]; PSC.lastByBody.set(m.bodyId!=null?m.bodyId:'cube',{recipe:m.recipe, kind:s.kind, src:s}); }
  // Selected part's field, for code that reads it off the raymarcher (part
  // prep live estimate, 53-part-prep.js).
  const am=desc.members.find(m=>m.bodyId===activeBodyId) || (desc.cube?desc.members[0]:null);
  const as=am&&am.src>=0?srcs[am.src]:null;
  if(as){
    const res=as.res;
    rm._fieldData=res.data; rm.bakeN=res.N; rm.fieldMin=res.fieldMin; rm.fieldMax=res.fieldMax;
    rm.lipschitz=res.lipschitz; rm.topology=res.topology||null;
    rm.worldMin=as.box.min.slice(); rm.worldMax=as.box.max.slice(); rm.isPeriodic=as.kind==='tile';
    if(as.need && as.need.forActive && as.need.opts.bakeRaw){ as.need.recipe._previewFieldMin=res.fieldMin; as.need.recipe._previewFieldMax=res.fieldMax; }
  }
  rm._assemblyMode=false;
  if(desc.cube){ rm.fitPeriodicBounds(desc.cubeBox.min, desc.cubeBox.max); if(typeof seamPill!=='undefined'&&typeof updateSeamPill==='function') updateSeamPill(currentRecipe); }
  else if(typeof seamPill!=='undefined' && seamPill) seamPill.style.display='none';
  if(typeof ppScheduleEstimate==='function') ppScheduleEstimate();
}
function _scPill(){
  if(typeof triPill==='undefined'||!triPill||triPill.dataset.pg) return;
  triPill.style.display='block';
  triPill.textContent=PSC.lastBakeMs!=null?('preview · '+PSC.lastBakeMs+'ms'):'preview · cached';
}

// -- Weak-GPU fallback --------------------------------------------------
// Armed after about 1.5 s of slow GPU frames (rm.SLOW_FRAME_MS) while the view
// moves with two or more lattices drawn; then, while the view moves, parts
// that aren't being edited draw as shells and full detail returns as soon as it
// stops. The "Simplified while moving" pill turns it off for the session. Off
// under automation (software-rendered test browsers are always slow).
function _scFallback(){
  if(PSC.fallbackOff || (typeof navigator!=='undefined'&&navigator.webdriver)){ PSC.lowDetail=false; return; }
  if(!PSC.slowGpu && rm._interacting && rm._slowSince && performance.now()-rm._slowSince>1500 && PSC.lastScene &&
     PSC.lastScene.members.filter(m=>!m.vis&&m.fill).length>=2){ PSC.slowGpu=true; _scPillFallback(); }
  PSC.lowDetail=PSC.slowGpu && !!rm._interacting;
}
function _scPillFallback(){
  const area=document.getElementById('previewArea'); if(!area) return;
  let b=document.getElementById('scSimplified');
  if(!PSC.slowGpu || PSC.fallbackOff){ if(b) b.remove(); return; }
  if(b) return;
  b=document.createElement('button'); b.id='scSimplified'; b.type='button';
  b.title='Parts you are not editing show as shells while the view moves. Click for full detail.';
  b.textContent='Simplified while moving · show full detail';
  b.style.cssText='position:absolute;right:12px;bottom:12px;z-index:30;font:13px/1.2 "IBM Plex Mono",monospace;color:#c8f542;background:rgba(6,8,12,.82);border:1px solid rgba(200,245,66,.5);border-radius:999px;padding:6px 12px;cursor:pointer';
  b.onclick=()=>{ PSC.fallbackOff=true; PSC.lowDetail=false; _scPillFallback(); previewSceneChanged(); };
  area.appendChild(b);
}

// -- Sync (rm._sceneProvider) ----------------------------------------------
function previewSceneSync(){
  if(!rm) return;
  const q=rm._quality||'draft';
  _scFallback();
  const sig=previewSceneSig(q);
  if(sig===PSC.lastSig){
    if(rm.isHeld && rm.isHeld() && !PSC.holding) rm.releaseView();
    return;
  }
  const scene=buildPreviewScene(q);
  if(!scene){ PSC.lastSig=sig; _scSettle(); return; }
  const r=_scResolve(scene);
  // Bakes no longer needed by this scene are superseded.
  if(typeof cancelPreviewBakesExcept==='function') cancelPreviewBakesExcept(new Set(scene.needs.map(n=>n.key)));
  if(r.hard.length){
    if(!PSC.holding && rm.holdView) PSC.holding=rm.holdView();
    if(PSC.holding){
      if(typeof showComputing==='function') showComputing('building preview…','baking field…');
      if(typeof setBtns==='function') setBtns(false);
      return;                         // keep the held frame; retry when the bake lands
    }
  }
  _scCommit(scene, r);
  PSC.lastSig=(r.hard.length||r.soft.length)?'':sig;   // re-check once the bakes land
  if(!r.hard.length && !r.soft.length){
    if(PSC.holding || (rm.isHeld&&rm.isHeld())){ rm.releaseView(); }
    PSC.holding=false;
    _scSettle();
  }
}
function _scSettle(){
  if(typeof hideComputing==='function') hideComputing();
  if(typeof setBtns==='function') setBtns(true);
  if(typeof clearStale==='function') clearStale();
  _scPill();
  if(window.viewStripSync) viewStripSync();
  const w=PSC.waiters; PSC.waiters=[]; w.forEach(f=>f());
}
// Something the scene reads changed: draw it next frame.
function previewSceneChanged(){ PSC.lastSig=''; if(rm) rm._dirty=true; }
// Resolves once the scene is committed with every source in place.
function previewSceneSettled(){
  return new Promise(res=>{ PSC.waiters.push(res); previewSceneChanged(); });
}
window.previewSceneChanged=previewSceneChanged;
window.F13LD_scene={
  state:()=>(previewSceneSync(), {commits:PSC.commits, pending:PSC.pend.size, holding:PSC.holding, lowDetail:PSC.lowDetail,
    members:PSC.lastScene?PSC.lastScene.members.map(m=>({bodyId:m.bodyId,fill:m.fill,vis:m.vis,src:m.src,group:m.group,selected:m.selected})):[],
    groups:PSC.lastScene?PSC.lastScene.groups.slice():[], sources:PSC.lastScene?PSC.lastScene.sources.map(s=>({key:s.key,kind:s.kind,N:s.res.N})):[],
    frameMs:rm&&rm._frameEma?Math.round(rm._frameEma*10)/10:null, compileMs:rm?rm.compileMs:null,
    atlasMB:rm&&rm.atlasBytes?Math.round(rm.atlasBytes()/1048576*10)/10:0}),
  setSlowGpu:on=>{ PSC.slowGpu=!!on; PSC.fallbackOff=false; _scPillFallback(); previewSceneChanged(); },
  scene:()=>(previewSceneSync(), PSC.lastScene)
};

// -- Dev overlay (?debug=1): frame time and scene size --------------------
function _scDebugOverlay(){
  const area=document.getElementById('previewArea'); if(!area) return;
  const d=document.createElement('div');
  d.style.cssText='position:absolute;left:8px;bottom:8px;z-index:30;pointer-events:none;font:12px/1.4 "IBM Plex Mono",monospace;color:#c8f542;background:rgba(6,8,12,.72);padding:6px 8px;border-radius:6px;white-space:pre';
  area.appendChild(d);
  setInterval(()=>{
    const s=window.F13LD_scene.state();
    d.textContent='frame '+(s.frameMs!=null?s.frameMs+' ms':'-')+'  draw '+(rm&&rm._lastDrawMs!=null?rm._lastDrawMs.toFixed(1)+' ms':'-')+
      '\nparts '+s.members.length+'  sources '+s.sources.length+'  atlas '+s.atlasMB+' MB'+
      '\nshader '+(s.compileMs!=null?s.compileMs+' ms':'-')+'  bakes '+s.pending+(s.lowDetail?'  simplified':'');
  },300);
}
if(typeof location!=='undefined' && /[?&]debug=1\b/.test(location.search)) window.addEventListener('load', _scDebugOverlay);
