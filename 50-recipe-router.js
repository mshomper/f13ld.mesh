/* ============================================================
   F13LD.mesh · 50-recipe-router.js
   routeRecipe — JSON recipe → {family, json} detection.
   ============================================================ */
'use strict';

// ── Recipe router (v0.9.0: registry-driven) ─────────────────────────────────
// Detection lives in each family descriptor (families/fam-*.js):
//   1. json.family names a registered family → that family's fromFamilyField
//      (sweep and modern emitters). An unknown family value falls through to
//      structural detection rather than hard-erroring.
//   2. Structural (legacy) detectors from every family, tried in ascending
//      `order` — the same sequence the pre-registry router used:
//      beam meta.tool (10) · bundle (20) · grain field.type (30) ·
//      noise surface.type (40) · tpms surface.type (41) · wave modes (50) ·
//      beam structural fallback (90).
function routeRecipe(json){
  if(typeof json.family === 'string'){
    const fam = FAMILIES[json.family];
    if(fam && typeof fam.fromFamilyField === 'function'){
      return {family: fam.id, subtype: fam.fromFamilyField(json), json};
    }
  }
  const legacy = [];
  for(const id of FAMILY_ORDER){
    const f = FAMILIES[id];
    (f.legacy || []).forEach(L => legacy.push({order: L.order, id, detect: L.detect}));
  }
  legacy.sort((a, b) => a.order - b.order);
  for(const L of legacy){
    const sub = L.detect(json);
    if(sub != null) return {family: L.id, subtype: sub, json};
  }
  throw new Error('Unrecognized recipe format — expected top-level "family" field, surface.type ("noise"/"terms"), field.type ("spinodoid"/"gaussian"/"hyperuniform"), or meta.tool ("beam"/"beam-builder").');
}

// ── Recipe validation (v0.8.1; per-family checks in the descriptors) ────────
// Catches recipes that would otherwise crash the summary panel or silently
// fall back to a different geometry in the worker. Throws an Error with a
// plain message naming the missing or unknown field; callers show it.
function validateRecipe(r){
  const j=r.json;
  const fam=FAMILY_LABEL[r.family]||r.family;
  if(j.geometry!==undefined && !isPlainObj(j.geometry)) throw new Error(fam+' recipe: "geometry" must be an object.');
  const d=familyOf(r);
  if(d && typeof d.validate === 'function') d.validate(j);
  r.subtype=String(r.subtype==null?'':r.subtype);
  return r;
}

// One entry point for every recipe source (file drop, file pick, ?r=, ?queue=).
// Returns the routed + validated recipe, or throws with a readable message.
function parseRecipe(json, sourceLabel){
  if(!json||typeof json!=='object'||Array.isArray(json))
    throw new Error((sourceLabel?sourceLabel+': ':'')+'recipe must be a JSON object.');
  try{ return validateRecipe(routeRecipe(json)); }
  catch(e){ throw new Error((sourceLabel?sourceLabel+': ':'')+(e.message||e)); }
}
