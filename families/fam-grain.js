/* ============================================================
   F13LD.mesh · families/fam-grain.js
   Grain family descriptor (F13LD.grain: spinodoid, GRF, hyperuniform,
   reaction-diffusion). See 03-registry.js.
   ============================================================ */
'use strict';
registerFamily({
  id: 'grain', label: 'GRAIN', color: '#a8a59a',
  fromFamilyField(json){ return (json.field&&json.field.type)||'unknown'; },
  legacy: [{order: 30, detect(json){
    if(json.field&&json.field.type){
      const ft=json.field.type;
      if(['spinodoid','gaussian','hyperuniform','reactiondiffusion'].includes(ft)) return ft;
    }
    return null;
  }}],
  validate(j){ requireThat(isPlainObj(j.field), 'Grain recipe is missing its "field" block.'); },
  summary(r){ return buildGrainSummary(r); },
  // Reaction-diffusion bakes one periodic cell; the other grain fields are stochastic.
  isPeriodic(r){ return (r.json.field&&r.json.field.type)==='reactiondiffusion'; },
  stochastic: true,
  rawRange(r, minV, maxV){ return {min: minV, max: maxV}; },   // unpadded (cosine-sum bounds)
  hyperuniform(r){ return r.json.field?.type==='hyperuniform'; },
  maxExportVoxels: 40e6,
  thinnestFeatureMm(){ return null; },
});
