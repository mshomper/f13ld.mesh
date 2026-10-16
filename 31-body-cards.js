/* ============================================================
   F13LD.mesh · 31-body-cards.js
   Parts model behind the left rail (v0.12.0): fill / skin per body, weld
   groups (create, join, merge, take out, rule), recipe-library hooks.
   The visible UI (recipe cards, parts list, editor) is 55-rail.js; this file
   keeps the state operations and the renderBodyCards / renderRecipeLibrary
   entry points that the rest of the app already calls.
   ============================================================ */
'use strict';

// ── Import-in-progress state ──────────────────────────────────────────────
// setShapeUI is the thin entry point 30-shape-import.js uses. The real
// renderer is renderBodyCards → renderRail (55-rail.js), which draws from the
// bodies Map plus an optional "in progress" row from _pendingImport (loading /
// error state that has no body record yet).
let _pendingImport = null;  // { name, state:'loading'|'err', errMsg? }

function setShapeUI(state, name, meta, errMsg, suggestedCell){
  // Track transient import state — gets cleared on 'ok' (body now in Map)
  // and on 'idle' (no import in flight).
  if(state==='loading'){
    _pendingImport = { name, state:'loading' };
  } else if(state==='err'){
    _pendingImport = { name, state:'err', errMsg: errMsg||'import failed' };
  } else {
    _pendingImport = null;
  }

  // The legacy structure inputs (cell size, trim, rotation …) stay in the
  // hidden #legacyHold: handlers and per-body state saving read them, and the
  // rail editor drives them. Their wrappers' display still tells the rest of
  // the app whether a shape is loaded.
  const cellOv=document.getElementById('cellOverlay');
  const xfOv=document.getElementById('structXformOverlay');
  const anyBody = bodies.size > 0;
  if(anyBody && state!=='err'){
    if(cellOv) cellOv.style.display='flex';
    if(xfOv) xfOv.style.display='flex';
    if(state==='ok'){
      const inp=document.getElementById('shapeCellSizeMm');
      if(inp&&suggestedCell) inp.value=suggestedCell;
      // Beam-family-only trim toggle visibility.
      const trimWrap=document.getElementById('trimNodesWrap');
      if(trimWrap) trimWrap.style.display=familyHasTrim(currentRecipe)?'inline':'none';
      const trimMul=document.getElementById('trimInsetWrap');
      const trimTg=document.getElementById('trimToNodes');
      if(trimMul) trimMul.style.display=(familyHasTrim(currentRecipe)&&trimTg&&trimTg.checked)?'inline-flex':'none';
    }
  } else if(!anyBody){
    if(cellOv) cellOv.style.display='none';
    if(xfOv) xfOv.style.display='none';
  }
  renderBodyCards();
  renderRecipeLibrary();
}

// rc3.5: Reserved assignment value meaning "this body is solid, no lattice."
// Stored in the assignments Map as a string sentinel — code that consumes
// assignments must distinguish it from valid recipeIds. The literal string
// 'solid' is safer than null/undefined because it survives JSON round-trips
// and is unambiguous in logging.
const SOLID_SENTINEL = 'solid';
function isSolidAssignment(rid){ return rid === SOLID_SENTINEL; }
// Color used for solid bodies in both active and ghost rendering. Mid-gray
// reads as "solid material, no scaffold" without being too bright against
// the dark canvas. Was #cccccc in initial rc3.5 — toned down for legibility.
const SOLID_COLOR_HEX = '#a0a0a0';

// rc3.6: Per-body visibility state for inactive bodies. The active body
// always renders fully; non-active bodies render according to this state.
//   'inactive-solid' — opaque rendering (body surface + color, no lattice)
//   'ghost'          — translucent envelope (today's rc3 behavior)
//   'hidden'         — does not render in the canvas at all
// Default for new bodies is 'inactive-solid' (per user decision rc3.6).
const VIS_INACTIVE_SOLID = 'inactive-solid';
const VIS_GHOST          = 'ghost';
const VIS_HIDDEN         = 'hidden';
const VIS_DEFAULT        = VIS_INACTIVE_SOLID;

// rc3.6: 16-swatch palette for per-body color override. Chosen to span hue
// while staying within the brand palette feel — mostly muted, no neons.
// The first swatch (null) is the "reset to family default" option.
const COLOR_PALETTE = [
  null,        // reset → use family / solid color
  '#5ecaa5',   // tpms green (family default)
  '#ea7050',   // noise terracotta (family default)
  '#a8a59a',   // grain warm gray (family default)
  '#b8cf50',   // beam olive (family default)
  '#d97706',   // wave amber (family default)
  '#22d3ee',   // cyan
  '#7c6ff7',   // purple
  '#f59e0b',   // amber
  '#ef4444',   // red
  '#ec4899',   // pink
  '#84cc16',   // lime
  '#06b6d4',   // teal
  '#3b82f6',   // blue
  '#f97316',   // orange
  '#a855f7',   // violet
  '#ffffff'    // white (high contrast)
];

// ── Fill model (v0.12.0) ──────────────────────────────────────────────────
// Per body: fill = 'solid' | 'lattice' | 'skin', skinMm (skin wall, default
// 0.4). 'solid' is the solid assignment; 'lattice' / 'skin' need a recipe.
// bodyFill() derives the truth from the assignment, so it is always right even
// when the assignment was changed elsewhere; _syncBodyFills() writes it back to
// body.fill / body.skinMm (called on every render).
const SKIN_DEFAULT_MM = 0.4;
function bodyFill(bodyId){
  const b = bodies.get(bodyId); if(!b) return 'solid';
  const rid = assignments.get(bodyId);
  if(!(rid && rid !== SOLID_SENTINEL && recipes.has(rid))) return 'solid';
  return b.fill === 'skin' ? 'skin' : 'lattice';
}
function _syncBodyFills(){
  for(const [id, b] of bodies){
    b.fill = bodyFill(id);
    if(b.skinMm == null) b.skinMm = SKIN_DEFAULT_MM;
    const rid = assignments.get(id);
    if(rid && rid !== SOLID_SENTINEL && recipes.has(rid)) b.lastRecipeId = rid;
  }
}
// Pick Solid / Lattice / Lattice + skin for a body. Lattice needs a recipe:
// the body's last one, else the active recipe, else the newest in the library.
function setBodyFill(bodyId, fill){
  const b = bodies.get(bodyId); if(!b) return;
  if(fill === 'solid'){ assignSolidToBody(bodyId); b.fill = 'solid'; return; }
  let rid = assignments.get(bodyId);
  if(!(rid && rid !== SOLID_SENTINEL && recipes.has(rid))){
    rid = (b.lastRecipeId && recipes.has(b.lastRecipeId)) ? b.lastRecipeId
        : (activeRecipeId && recipes.has(activeRecipeId)) ? activeRecipeId
        : recipeOrder[recipeOrder.length-1];
  }
  if(!rid){ if(typeof meshToast==='function') meshToast('Add a recipe first'); renderBodyCards(); return; }
  b.fill = fill;
  if(assignments.get(bodyId) !== rid){ assignRecipeToBody(bodyId, rid); return; }   // activates the body and rebuilds the preview
  // Same recipe: only the lattice <-> lattice + skin flag changed.
  if(bodyId !== activeBodyId) switchActiveBody(bodyId);
  renderBodyCards();
  _bodyFillChanged(bodyId);
}
function setBodySkin(bodyId, mm){
  const b = bodies.get(bodyId); if(!b) return;
  b.skinMm = Math.max(0.05, +mm || SKIN_DEFAULT_MM);
  _bodyFillChanged(bodyId);
}
// Fill / skin changes alter the part's geometry: refresh the preview (debounced
// by the caller for sliders) and the export estimate.
function _bodyFillChanged(bodyId){
  if(typeof updateExportEstimate==='function') updateExportEstimate();
  if(bodyId === activeBodyId && typeof railPreviewSoon==='function') railPreviewSoon();
}

// ── Weld-group UI helpers + join / leave ops (v0.7.0, v0.12.0) ─────────────
// weldGroups[gid] = { filletMm, colorIndex,
//                     joinRule:'union'|'anchor'|'graded', anchorMm, gradeMm,
//                     showJoins }
// The geometry reads joinRule / anchorMm / gradeMm (and body.fill / skinMm).
const WELD_COLORS = ['#a78bfa','#2dd4bf','#fbbf24','#fb7185','#38bdf8'];
let _weldColorSeq = 0;
const WELD_RULES = ['union','anchor','graded'];
function weldGroupColor(gid){ const g=weldGroups.get(gid); const ci=(g&&g.colorIndex!=null)?g.colorIndex:0; return WELD_COLORS[ci%WELD_COLORS.length]; }
function weldGroupLetter(gid){ const g=weldGroups.get(gid); const ci=(g&&g.colorIndex!=null)?g.colorIndex:0; return String.fromCharCode(65+(ci%26)); }
function newWeldGroup(filletMm){
  const used=new Set(); for(const g of weldGroups.values()) used.add(g.colorIndex);
  let ci=0; while(used.has(ci)) ci++;
  const gid='wg'+Date.now().toString(36)+ci;
  weldGroups.set(gid,{filletMm:(filletMm!=null?filletMm:0.4), colorIndex:ci,
    joinRule:'union', anchorMm:0.6, gradeMm:1.5, showJoins:true});
  return gid;
}
function weldGroupRule(gid){ const g=weldGroups.get(gid); return (g&&g.joinRule)||'union'; }
function _bodyOrderMoveAfter(id, afterId){ const i=bodyOrder.indexOf(id); if(i>=0) bodyOrder.splice(i,1); const j=bodyOrder.indexOf(afterId); bodyOrder.splice(j<0?bodyOrder.length:j+1,0,id); }
function _bodyOrderMoveEnd(id){ const i=bodyOrder.indexOf(id); if(i>=0) bodyOrder.splice(i,1); bodyOrder.push(id); }
// Signature of the ACTIVE body's preview-relevant state (its group + that
// group's member count). If unchanged across a weld edit, the active body's
// preview doesn't need rebuilding — so we don't thrash the raymarcher when the
// user welds two OTHER bodies.
function _weldActiveSig(){ const g=activeBodyId?(bodyGroup.get(activeBodyId)||null):null; const n=g?groupMembers(g).length:0; return g+'|'+n; }
function _refreshAfterWeld(prevSig){
  renderBodyCards();                       // also dissolves any sub-2 group
  if(_weldActiveSig()===prevSig) return;   // active body's preview is unaffected
  const ag=activeGroupId();
  if(ag && groupMembers(ag).length>=2) triggerPreview(rm&&rm._quality||'draft');         // show the weld
  else if(typeof reloadActiveRecipeIntoPreview==='function') reloadActiveRecipeIntoPreview(); // restore single body
  updateExportEstimate();                  // v0.9.3: weld-aware estimate
}
function weldDropOnGroup(id, gid){
  if(!weldGroups.has(gid) || bodyGroup.get(id)===gid) return;
  const sig=_weldActiveSig();
  bodyGroup.set(id,gid);
  const others=groupMembers(gid).filter(x=>x!==id);
  _bodyOrderMoveAfter(id, others.length?others[others.length-1]:id);
  _refreshAfterWeld(sig);
}
function weldDropOnBody(id, targetId){
  if(id===targetId) return;
  const tgid=bodyGroup.get(targetId);
  if(tgid){ weldDropOnGroup(id, tgid); return; }   // target already grouped → join it
  const sig=_weldActiveSig();                        // both ungrouped → new weld group
  const gid=newWeldGroup(0.4);
  bodyGroup.set(targetId,gid); bodyGroup.set(id,gid);
  _bodyOrderMoveAfter(id, targetId);
  _refreshAfterWeld(sig);
  return gid;
}
// Join any mix of loose parts, members and whole welds into ONE weld.
//   partIds   bodies that move into the weld (a member leaves its old weld)
//   targetGid the weld that receives them and KEEPS ITS SETTINGS (omitted →
//             the first merged weld, else a new weld)
//   mergeGids welds that dissolve into the target, all members moving across
// Returns the target gid.
function weldTogether(partIds, targetGid, mergeGids){
  const ids=(partIds||[]).filter(id=>bodies.has(id));
  const merge=(mergeGids||[]).filter(g=>weldGroups.has(g));
  let tgt=(targetGid && weldGroups.has(targetGid)) ? targetGid : null;
  if(!tgt && merge.length) tgt=merge[0];
  const sig=_weldActiveSig();
  if(!tgt) tgt=newWeldGroup(0.4);
  const moving=[];
  for(const g of merge){ if(g===tgt) continue; for(const id of groupMembers(g)) moving.push(id); weldGroups.delete(g); }
  for(const id of ids) if(!moving.includes(id)) moving.push(id);
  for(const id of moving){
    bodyGroup.set(id,tgt);
    const others=groupMembers(tgt).filter(x=>x!==id);
    _bodyOrderMoveAfter(id, others.length?others[others.length-1]:id);
  }
  _refreshAfterWeld(sig);
  return weldGroups.has(tgt)?tgt:null;
}
function weldDetach(id){
  if(!bodyGroup.has(id)) return;
  const sig=_weldActiveSig();
  bodyGroup.delete(id);
  _bodyOrderMoveEnd(id);
  _refreshAfterWeld(sig);
}
// Take every part out of a weld; the weld itself goes away.
function weldSeparateAll(gid){
  if(!weldGroups.has(gid)) return 0;
  const sig=_weldActiveSig();
  const mem=groupMembers(gid);
  for(const id of mem) bodyGroup.delete(id);
  weldGroups.delete(gid);
  _refreshAfterWeld(sig);
  return mem.length;
}
function _weldPreviewIfActive(gid){
  if(activeBodyId && bodyGroup.get(activeBodyId)===gid && groupMembers(gid).length>=2)
    triggerPreview(rm&&rm._quality||'draft');
}
function weldSetFillet(gid, mm){
  const g=weldGroups.get(gid); if(!g) return;
  g.filletMm=Math.max(0, mm||0);
  if(activeBodyId && bodyGroup.get(activeBodyId)===gid && groupMembers(gid).length>=2)
    triggerPreview(rm&&rm._quality||'draft');
  updateExportEstimate();
}
function weldSetRule(gid, rule){
  const g=weldGroups.get(gid); if(!g || WELD_RULES.indexOf(rule)<0) return;
  g.joinRule=rule;
  if(g.anchorMm==null) g.anchorMm=0.6;
  if(g.gradeMm==null) g.gradeMm=1.5;
  _weldPreviewIfActive(gid); updateExportEstimate();
}
function weldSetAnchor(gid, mm){ const g=weldGroups.get(gid); if(!g) return; g.anchorMm=Math.max(0, +mm||0); _weldPreviewIfActive(gid); updateExportEstimate(); }
function weldSetGrade(gid, mm){ const g=weldGroups.get(gid); if(!g) return; g.gradeMm=Math.max(0.05, +mm||0.05); _weldPreviewIfActive(gid); updateExportEstimate(); }
function weldSetShowJoins(gid, on){ const g=weldGroups.get(gid); if(!g) return; g.showJoins=!!on; }

// ── Render entry points ───────────────────────────────────────────────────
// The visible UI is 55-rail.js. These keep their old names: the import,
// recipe-router and state code already call them.
function renderBodyCards(){
  // Dissolve any weld group that has fallen below 2 members. A weld left with
  // exactly one part says so.
  let dissolved = 0;
  for(const gid of [...weldGroups.keys()]){
    const mem = groupMembers(gid);
    if(mem.length < 2){
      for(const id of mem) bodyGroup.delete(id);
      weldGroups.delete(gid);
      if(mem.length === 1) dissolved++;
    }
  }
  if(dissolved && typeof meshToast==='function') meshToast('Weld dissolved');
  _syncBodyFills();
  if(typeof renderRail==='function') renderRail();
}

// Recipe library: usage counts and the active card changed.
function renderRecipeLibrary(){
  if(typeof renderRailRecipes==='function') renderRailRecipes();
}

// rc3.5: Assign the solid sentinel to a body. Same flow as assignRecipeToBody
// but routes through the solid rendering path instead of a recipe lookup.
function assignSolidToBody(bodyId){
  if(!bodies.has(bodyId)) return;
  const _prevRid = assignments.get(bodyId);   // remembered so Lattice can restore it
  if(_prevRid && _prevRid !== SOLID_SENTINEL && bodies.get(bodyId)) bodies.get(bodyId).lastRecipeId = _prevRid;
  assignments.set(bodyId, SOLID_SENTINEL);
  bodies.get(bodyId).fill = 'solid';
  // Auto-switch active to this body so user sees the result (per decision 3).
  if(bodyId !== activeBodyId){
    switchActiveBody(bodyId);
  } else {
    // Already active — rebuild preview directly.
    syncCurrentRecipeFromActiveBody();
    if(rm) reloadActiveRecipeIntoPreview();
    renderBodyCards();
    renderRecipeLibrary();
  }
  // Refresh ghost colors (this body's ghost color may have changed).
  syncGhostsToRaymarcher();
}

window.clearImportedShape=function(bodyId){
  // rc2: bodyId is passed from the card × button. If absent (legacy callers),
  // falls back to the active body (matches rc1 behavior).
  const cleared = clearActiveBody(bodyId) || {};
  _assertModeAInvariants('after-clearImportedShape');
  clearShapeWire();
  // If no bodies remain, hide overlays. Otherwise the surviving active body
  // keeps the overlays visible with its own cell size + transform.
  if(bodies.size === 0){
    const cellOv=document.getElementById('cellOverlay');if(cellOv)cellOv.style.display='none';
    const xfOv=document.getElementById('structXformOverlay');if(xfOv)xfOv.style.display='none';
    resetStructureTransform();
    setShapeUI('idle');
    // Reset raymarcher to cube mode and re-bake the periodic field.
    if(rm) rm.clearShape();
    if(currentRecipe) triggerPreview(rm&&rm._quality||'low');
  } else {
    // A new active body was promoted inside clearActiveBody. Re-render cards.
    renderBodyCards();
    renderRecipeLibrary();
    // v0.8.3: a different recipe family needs the full re-init (summary, badge).
    if(cleared.recipeChanged && currentRecipe) reloadActiveRecipeIntoPreview();
    else if(currentRecipe) triggerPreview(rm&&rm._quality||'low');
  }
  updateExportEstimate();
};
