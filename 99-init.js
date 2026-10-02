/* ============================================================
   F13LD.mesh · 99-init.js
   Boot: ?r= and ?queue= URL ingestion, file drop, shape strip events.
   ============================================================ */
'use strict';

// ── URL ingestion — auto-load recipe from ?r= parameter ──────────────────
(function(){
  try{
    const p=new URLSearchParams(location.search);
    if(p.has('r') && !p.has('queue')){
      const json=JSON.parse(decodeURIComponent(p.get('r')));
      // Wait for DOM + Manifold to be ready, then show
      setTimeout(()=>showRecipe(routeRecipe(json)),0);
    }
  }catch(e){
    console.warn('URL recipe parse error:',e);
  }
})();

// ── URL ingestion — load a saved queue from F13LD.queue via ?queue=CODE ──
// Stocks the recipe library with up to MAX_RECIPES items. Takes priority over ?r=.
(function(){
  const code=new URLSearchParams(location.search).get('queue');
  if(!code) return;
  const URL='https://axinljpecycnvfncyhfs.supabase.co/rest/v1/rpc/queue_fetch';
  const KEY='sb_publishable_DAlrNLqbUZiwkaA6wPSMIw_YUNY85LX';
  fetch(URL,{method:'POST',headers:{apikey:KEY,Authorization:'Bearer '+KEY,'Content-Type':'application/json'},body:JSON.stringify({p_code:code})})
    .then(r=>r.ok?r.json():Promise.reject(new Error('HTTP '+r.status)))
    .then(res=>{
      const items=(res&&res.items)||[];
      if(!items.length){showError('Queue "'+code+'" is empty or not found.');return;}
      const load=items.slice(0, Math.max(0, MAX_RECIPES-recipes.size));
      if(!load.length){showError('Recipe library is full — clear a recipe before loading a queue.');return;}
      setTimeout(()=>{
        for(let i=0;i<load.length-1;i++) setActiveRecipe(routeRecipe(load[i].recipe));
        showRecipe(routeRecipe(load[load.length-1].recipe));
        if(items.length>load.length) showCapToast('Loaded '+load.length+' of '+items.length+' — limit is '+MAX_RECIPES+'.');
      },0);
    })
    .catch(e=>showError('Could not load queue — '+e.message));
})();

// ── File handling ─────────────────────────────────────────────────────────
function handleJSON(text,filename){let json;try{json=JSON.parse(text);}catch(e){showError('Invalid JSON in '+(filename||'file')+' — '+e.message);return;}try{const recipe=routeRecipe(json);if(filename) recipe.filename=filename;showRecipe(recipe);}catch(e){showError(e.message);}}
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
