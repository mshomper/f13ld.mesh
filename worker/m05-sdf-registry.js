/* ============================================================
   F13LD.mesh · worker/m05-sdf-registry.js
   Worker-side family registry (v0.9.0). Each m2x-sdf-*.js file calls
   registerSDF(id, {...}); buildSDF (m30) and the raw-bake path (m90) look
   the family up here instead of branching on family ids.

     build(recipe, shapeCtx, normOverride, opts) → sdf(p)   (required)
     rawEval(d)  → {evalRaw(p), topology} | null
                 stochastic families: raw (un-normalized) field for the
                 preview bake; d is the bake message
     rawRange(json, minV, maxV) → {min, max}   post-bake range (default as-is)
     trimToNodes                 family supports the trim-to-nodes pass
   ============================================================ */
'use strict';
const SDF_FAMILIES = Object.create(null);
function registerSDF(id, d){
  if(!d || typeof d.build !== 'function') throw new Error('registerSDF('+id+'): needs build()');
  if(SDF_FAMILIES[id]) throw new Error('registerSDF: duplicate family "'+id+'"');
  SDF_FAMILIES[id] = d;
}
