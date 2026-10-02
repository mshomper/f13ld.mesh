/* ============================================================
   F13LD.mesh · families/fam-noise.js
   Noise family descriptor (F13LD.noise). See 03-registry.js.
   ============================================================ */
'use strict';
const KNOWN_NOISE_TYPES=['simplex','cellular','fbm','ridged','billow','foam','strut','veined','curl','warp'];
registerFamily({
  id: 'noise', label: 'NOISE', color: '#ea7050',
  fromFamilyField(json){ return (json.surface&&json.surface.noise_type)||'simplex'; },
  legacy: [{order: 40, detect(json){
    if(json.surface&&json.surface.type==='noise') return json.surface.noise_type||'simplex';
    return null;
  }}],
  validate(j){
    requireThat(isPlainObj(j.surface), 'Noise recipe is missing its "surface" block.');
    const nt=j.surface.noise_type;
    requireThat(nt==null||KNOWN_NOISE_TYPES.includes(nt), 'Unknown noise type "'+nt+'". Supported: '+KNOWN_NOISE_TYPES.join(', ')+'.');
  },
  summary(r){ return buildNoiseSummary(r); },
  isPeriodic(){ return false; },
  stochastic: true,
  // v0.5.0-rc27: pad the empirical range by ±5% to match F13LD.noise's prepass,
  // unless the recipe carries its own norm_min/norm_max.
  rawRange(r, minV, maxV){
    const ns=r.json&&r.json.surface;
    if(ns&&ns.norm_min!=null&&ns.norm_max!=null) return {min: ns.norm_min, max: ns.norm_max};
    const range=maxV-minV;
    return {min: minV-range*0.05, max: maxV+range*0.05};
  },
  maxExportVoxels: 40e6,   // bicontinuous topology, moderate-high SA/V
  // v0.5.1: wall band is a threshold on a normalized field, not a length.
  thinnestFeatureMm(){ return null; },
});
