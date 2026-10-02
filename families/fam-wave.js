/* ============================================================
   F13LD.mesh · families/fam-wave.js
   Wave family descriptor (F13LD.wave cymatic standing waves). See 03-registry.js.
   ============================================================ */
'use strict';
registerFamily({
  id: 'wave', label: 'WAVE', color: '#D97706',
  fromFamilyField(json){ return (json.field&&json.field.symmetry)||'pure'; },
  legacy: [{order: 50, detect(json){
    if(json.field&&Array.isArray(json.field.modes)) return (json.field.symmetry)||'wave';
    return null;
  }}],
  validate(j){ requireThat(isPlainObj(j.field)&&Array.isArray(j.field.modes), 'Wave recipe is missing its "field.modes" list.'); },
  summary(r){ return buildWaveSummary(r); },
  isPeriodic(){ return true; },   // cosine sums are 2π-periodic; one seamless cell across [-5,5]
  // Non-integer mode indices need a supercell (S > 1); the bake grid scales by S.
  bakeBounds(r){ return computeWaveBakeBounds(r); },
  seamWarning(r){
    const a=analyzeWaveTiling(r);
    return a.exact ? null : {text: '⚠ tiles with seams', title: waveSeamTooltip(a)};
  },
});
