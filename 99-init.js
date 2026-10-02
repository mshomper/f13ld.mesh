/* ============================================================
   F13LD.mesh · 99-init.js
   Boot: runs the URL loaders (loaders/ld-*.js), file drop, shape strip events.
   ============================================================ */
'use strict';

// ── Show a parsed recipe; any error while building the panel/preview is
// reported instead of leaving a half-drawn view (v0.8.1). ──────────────────
function openRecipe(recipe){
  return Promise.resolve()
    .then(()=>showRecipe(recipe))
    .catch(e=>{ console.error(e); showError('Could not display this recipe — '+(e.message||e)); });
}

// ── URL ingestion (v0.9.0: loaders/ld-*.js register themselves) ─────────────
// ?queue= (loaders/ld-queue.js) takes priority over ?r= (loaders/ld-link.js).
runUrlLoaders();

// ── File handling ─────────────────────────────────────────────────────────
function handleJSON(text,filename){let json;try{json=JSON.parse(text);}catch(e){showError('Invalid JSON in '+(filename||'file')+' — '+e.message);return;}let recipe;try{recipe=parseRecipe(json,filename);}catch(e){showError(e.message);return;}if(filename) recipe.filename=filename;openRecipe(recipe);}
function handleFile(file){if(!file)return;if(!file.name.toLowerCase().endsWith('.json')){showError('Expected a .json file. Got: '+file.name);return;}const reader=new FileReader();reader.onload=e=>handleJSON(e.target.result,file.name);reader.onerror=()=>showError('Could not read: '+file.name);reader.readAsText(file);}
const fileInput=document.getElementById('fileInput'),pickBtn=document.getElementById('pickBtn');
dropzone.addEventListener('click',()=>fileInput.click());
pickBtn.addEventListener('click',e=>{e.stopPropagation();fileInput.click();});
fileInput.addEventListener('change',()=>{if(fileInput.files[0])handleFile(fileInput.files[0]);fileInput.value='';});
document.addEventListener('dragover',e=>{e.preventDefault();dropzone.classList.add('dragover');});
document.addEventListener('dragleave',e=>{if(!e.relatedTarget)dropzone.classList.remove('dragover');});
document.addEventListener('drop',e=>{
  e.preventDefault();
  dropzone.classList.remove('dragover');
  const f=e.dataTransfer?.files?.[0];
  if(!f) return;
  // rc2: route by extension. Mesh/CAD files go to handleShapeFile, everything
  // else (json recipes) goes through handleFile. Note: handleShapeFile gates
  // on currentRecipe being set — without a recipe, we can't preview a body,
  // so we keep the "recipe first" gate by simply letting handleFile run for
  // JSON-only main dropzone interactions until a recipe is loaded.
  if(isShapeFile(f)){
    if(!currentRecipe){
      // No recipe loaded yet — main dropzone needs a recipe first.
      // Show error in the recipe view, since shape strip isn't visible.
      // (Same gate behavior as before, just via routing instead of refusal.)
      handleFile(f);  // will surface "expected JSON" error
      return;
    }
    handleShapeFile(f);
  } else {
    handleFile(f);
  }
});

// ── Shape strip events ────────────────────────────────────────────────────
const shapeDZ=document.getElementById('shapeDZ');
const shapeInput=document.getElementById('shapeInput');
const SHAPE_EXTS=new Set(['stl','obj','3mf','step','stp','iges','igs']);
function isShapeFile(f){return f&&SHAPE_EXTS.has(f.name.split('.').pop().toLowerCase());}
shapeDZ.addEventListener('click',()=>shapeInput.click());
shapeInput.addEventListener('change',()=>{if(shapeInput.files[0])handleShapeFile(shapeInput.files[0]);shapeInput.value='';});
shapeDZ.addEventListener('dragover',e=>{e.stopPropagation();e.preventDefault();shapeDZ.classList.add('dragover');});
shapeDZ.addEventListener('dragleave',e=>{shapeDZ.classList.remove('dragover');});
shapeDZ.addEventListener('drop',e=>{e.stopPropagation();e.preventDefault();shapeDZ.classList.remove('dragover');const f=e.dataTransfer?.files?.[0];if(f&&isShapeFile(f))handleShapeFile(f);});

// ── Cell size stale detection (event delegation — input is dynamically rendered) ──
document.addEventListener('input',e=>{if(e.target&&e.target.id==='shapeCellSizeMm'&&importedShape&&!recipeIsPeriodic(currentRecipe)){setStale();}});
