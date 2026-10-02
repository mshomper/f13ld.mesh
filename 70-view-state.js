/* ============================================================
   F13LD.mesh · 70-view-state.js
   Error / computing overlay / stale state, showRecipe, resetToDropzone.
   ============================================================ */
'use strict';

function showError(m){errorBox.style.display='block';errorBox.textContent='⚠ '+m;}
function clearError(){errorBox.style.display='none';}
function showComputing(m,s){overlay.classList.remove('hidden');coMain.textContent=m;coSub.textContent=s||'';triPill.style.display='none';if(seamPill)seamPill.style.display='none';if(window._orbStart)_orbStart();}
function hideComputing(){overlay.classList.add('hidden');if(window._orbStop)_orbStop();}

function setStale(){
  const banner=document.getElementById('staleBanner');
  const btn=document.getElementById('staleRefreshBtn');
  const area=document.getElementById('previewArea');
  if(banner){banner.style.display='flex';}
  if(btn){btn.classList.add('pulsing');}
  if(area){area.classList.add('preview-stale');}
  // v0.5.0-rc14: invalidate cached preview field range. If the user changes
  // a parameter that affects the field (frequency, seed, wave count, etc.)
  // without re-baking preview, the cached range is no longer trustworthy
  // and export should fall back to its own pre-scan.
  if(currentRecipe){
    delete currentRecipe._previewFieldMin;
    delete currentRecipe._previewFieldMax;
  }
}
function clearStale(){
  const banner=document.getElementById('staleBanner');
  const btn=document.getElementById('staleRefreshBtn');
  const area=document.getElementById('previewArea');
  if(banner){banner.style.display='none';}
  if(btn){btn.classList.remove('pulsing');}
  if(area){area.classList.remove('preview-stale');}
}
function showTriCount(n,ms){triPill.style.display='block';triPill.textContent=n.toLocaleString()+' tri · '+ms+' ms';if(seamPill)seamPill.style.display='none';}
function setBtns(on){['btnDraft','btnLow','btnMed','btnHigh','btnUltra'].forEach(id=>{const el=document.getElementById(id);if(el)el.disabled=!on;});}
function setActivBtn(id){['btnDraft','btnLow','btnMed','btnHigh','btnUltra'].forEach(b=>{const el=document.getElementById(b);if(el)el.classList.toggle('active',b===id);});}

// Parallel to _qualUserSet (export), this tracks whether the user has
// explicitly clicked a preview-quality button this session. If false on
// recipe import, default to 'low' (per Matt's UX preference); if true,
// respect the user's existing choice.
let _previewQualUserSet=false;
const PREVIEW_BTN_ID={draft:'btnDraft',low:'btnLow',med:'btnMed',high:'btnHigh',ultra:'btnUltra'};

async function showRecipe(recipe){
  clearError();
  const added = setActiveRecipe(recipe);
  if(!added){
    // rc2.5: setActiveRecipe rejected (recipe cap reached). Toast was already
    // shown by setActiveRecipe itself; just abort the preview pipeline.
    return;
  }
  _assertModeAInvariants('after-showRecipe');
  // Default to Low quality on first recipe of the session, but respect any
  // user-selected quality from a previous recipe (v0.5.0).
  if(!_qualUserSet) currentExportQual='low';
  // Same pattern for preview render quality.
  const initialPreviewQ=_previewQualUserSet ? (rm&&rm._quality||'low') : 'low';
  // v0.5.0-rc22: auto-default UI cellSizeMm to recipe.geometry.cell for
  // new-schema beam recipes. The recipe's `cell` is sweep's characterized
  // (geometric mean) cell size in mm; matching the UI to it on load shows
  // the lattice at the absolute scale sweep designed it for. User can
  // still adjust cellSizeMm after load to rescale; we only set on ingest.
  if(recipe.family==='beam'){
    const cellMm=recipe.json&&recipe.json.geometry&&recipe.json.geometry.cell;
    if(typeof cellMm==='number'&&isFinite(cellMm)&&cellMm>0){
      const cellInp=document.getElementById('shapeCellSizeMm');
      if(cellInp){
        // Format to a sensible precision for the input field. 4 sig figs.
        cellInp.value=parseFloat(cellMm.toPrecision(4));
      }
    }
  }
  dropzone.style.display='none';recipeView.style.display='flex';
  document.getElementById('shapeStrip').style.display='block';
  typeBadge.className=recipe.family;typeBadge.textContent=FAMILY_LABEL[recipe.family]+' · '+String(recipe.subtype).toUpperCase();
  summaryEl.innerHTML=renderSummary(recipe);
  // v0.5.0-rc17: refresh trim-to-nodes toggle visibility for the new family.
  // setShapeUI only fires on shape state changes, so if a shape was already
  // loaded when this recipe arrives, the toggle wouldn't update otherwise.
  // v0.5.0-rc18: multiplier visibility tracks the toggle state.
  const trimWrap=document.getElementById('trimNodesWrap');
  if(trimWrap){
    const cellOv=document.getElementById('cellOverlay');
    const shapeLoaded=cellOv&&cellOv.style.display!=='none';
    trimWrap.style.display=(shapeLoaded&&recipe.family==='beam')?'inline':'none';
    const trimMul=document.getElementById('trimInsetWrap');
    const trimTg=document.getElementById('trimToNodes');
    if(trimMul) trimMul.style.display=(shapeLoaded&&recipe.family==='beam'&&trimTg&&trimTg.checked)?'inline-flex':'none';
  }
  setActivBtn(PREVIEW_BTN_ID[initialPreviewQ]||'btnLow');
  triggerPreview(initialPreviewQ);
  setTimeout(updateExportEstimate,0); // panel renders async
  // rc2.5: refresh both rows so the new recipe appears in the library and
  // any existing body cards update their recipe chips.
  renderBodyCards();
  renderRecipeLibrary();
}
function resetToDropzone(){
  recipeView.style.display='none';dropzone.style.display='flex';
  document.getElementById('shapeStrip').style.display='none';
  clearError();triPill.style.display='none';if(seamPill)seamPill.style.display='none';
  overlay.classList.remove('hidden');coMain.textContent='awaiting recipe…';coSub.textContent='';
  // rc2.5: "load different" is a TRUE RESET — clear all bodies + all recipes.
  // Previously (rc2) bodies persisted across recipe changes; with per-body
  // assignment in rc2.5, the reload button is now an explicit "start over"
  // gesture per the user-confirmed design.
  clearAllBodies();
  recipes.clear();
  recipeOrder.length = 0;
  assignments.clear();
  activeRecipeId = null;
  currentRecipe = null;
  // rc3: drop all ghost textures.
  if(rm && rm.clearGhosts) rm.clearGhosts();
  // Refresh both rows so they hide cleanly.
  renderBodyCards();
  renderRecipeLibrary();
  clearShapeWire();setShapeUI('idle');
}
document.getElementById('reloadBtn').addEventListener('click',resetToDropzone);
document.getElementById('btnDraft').addEventListener('click',()=>{if(!currentRecipe)return;_previewQualUserSet=true;setActivBtn('btnDraft');triggerPreview('draft');});
document.getElementById('btnLow').addEventListener('click',()=>{if(!currentRecipe)return;_previewQualUserSet=true;setActivBtn('btnLow');triggerPreview('low');});
document.getElementById('btnMed').addEventListener('click',()=>{if(!currentRecipe)return;_previewQualUserSet=true;setActivBtn('btnMed');triggerPreview('med');});
document.getElementById('btnHigh').addEventListener('click',()=>{if(!currentRecipe)return;_previewQualUserSet=true;setActivBtn('btnHigh');triggerPreview('high');});
document.getElementById('btnUltra').addEventListener('click',()=>{if(!currentRecipe)return;_previewQualUserSet=true;setActivBtn('btnUltra');triggerPreview('ultra');});
