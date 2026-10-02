/* ============================================================
   F13LD.mesh · families/fam-bundle.js
   Bundle family descriptor (F13LD.bundle). See 03-registry.js.
   ============================================================ */
'use strict';
function _bundleSubtype(json){ return (json.surface&&json.surface.structure)||(json.meta&&json.meta.preset)||'bundle'; }
registerFamily({
  id: 'bundle', label: 'BUNDLE', color: '#7B4F9E',
  fromFamilyField(json){ return _bundleSubtype(json); },
  legacy: [{order: 20, detect(json){
    if((json.meta&&json.meta.tool==='bundle-builder')||(json.surface&&json.surface.type==='ihb')) return _bundleSubtype(json);
    return null;
  }}],
  summary(r){ return buildBundleSummary(r); },
  // v0.6.5: tile only when a small exact Z period exists — i.e. no warp.
  // Warped bundles bake continuously over the shape bbox instead (a true SDF,
  // baked raw, not normalized).
  isPeriodic(r){
    const wm=(r.json.geometry&&r.json.geometry.warp_mode)||0;
    return wm===0;
  },
  bakeBounds(r){ return computeBundleBakeBounds(r); },
  stochastic: false,
});
