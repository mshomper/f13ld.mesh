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
function _scheduleStructXformRebake(){
  if(!importedShape) return;
  if(!currentRecipe||recipeIsPeriodic(currentRecipe)) return;
  if(_structXformRebakeTimer) clearTimeout(_structXformRebakeTimer);
  _structXformRebakeTimer=setTimeout(()=>{
    _structXformRebakeTimer=null;
    if(typeof triggerPreview==='function') triggerPreview();
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
  if(xformChanged) _scheduleStructXformRebake();
  // rc2: persist transform state to active body record so it survives switches.
  snapshotActiveBodyState();
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
  if(wasNonIdentity) _scheduleStructXformRebake();
  // rc2: persist reset state to active body record.
  snapshotActiveBodyState();
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
Object.defineProperty(window,'currentOversample',{get:()=>currentOversample});
