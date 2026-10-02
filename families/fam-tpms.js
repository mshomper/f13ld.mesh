/* ============================================================
   F13LD.mesh · families/fam-tpms.js
   TPMS family descriptor (F13LD.tpms, F13LD.sweep tpms). See 03-registry.js.
   ============================================================ */
'use strict';
registerFamily({
  id: 'tpms', label: 'TPMS', color: '#5ecaa5',
  fromFamilyField(json){
    return (json.surface&&json.surface.preset)||(json.geometry&&json.geometry.mode)||'custom';
  },
  legacy: [{order: 41, detect(json){
    if(json.surface&&json.surface.type){
      const st=json.surface.type;
      if(st==='terms'||st==='raw_preset') return json.surface.preset||json.geometry?.mode||'custom';
    }
    return null;
  }}],
  validate(j){
    requireThat(isPlainObj(j.surface), 'TPMS recipe is missing its "surface" block.');
    if(j.surface.type==='raw_preset') requireThat(typeof j.surface.preset==='string', 'TPMS raw preset recipe is missing "surface.preset".');
    else requireThat(Array.isArray(j.surface.terms), 'TPMS recipe is missing its "surface.terms" list.');
  },
  summary(r){ return buildTPMSSummary(r); },
  isPeriodic(){ return true; },
  bakeBounds(r){ return computeTPMSBakeBounds(r); },
  maxExportVoxels: 50e6,   // shells, moderate SA/V (what the original cap was tuned for)
});
