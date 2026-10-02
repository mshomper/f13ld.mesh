/* ============================================================
   F13LD.mesh · 03-registry.js
   Family + loader registries (v0.9.0).

   A design-tool family is ONE descriptor file in families/ that calls
   registerFamily({...}); its worker SDF file calls registerSDF(...) (see
   worker/m05-sdf-registry.js). The app never branches on family ids —
   every family-specific decision is a lookup on the descriptor here.

   Descriptor fields (only id, label, color, detect are required):
     id, label, color          'tpms', 'TPMS', '#5ecaa5'
     badgeCss                  inline style for the type badge (optional;
                               older families style it from mesh.css)
     fromFamilyField(json)     → subtype  — json.family === id (may throw)
     legacy: [{order, detect(json) → subtype|null}]
                               structural detection for recipes without a
                               family field; lower order is tried first
     validate(json)            throws with a plain message on bad input
     summary(recipe)           → html (escaped)
     isPeriodic(recipe)        → bool   (default false)
     bakeBounds(recipe)        → {wMin, wMax, S?} | null  (periodic bake tile)
     stochastic                raw normalized bake (noise-like fields)
     rawRange(recipe,min,max)  → {min,max}  post-bake range for stochastic
     hyperuniform(recipe)      → bool   (hyperuniform pre-bake path)
     seamWarning(recipe)       → {text,title} | null  (tiling seam badge)
     maxExportVoxels           export voxel cap (default 40e6)
     thinnestFeatureMm(recipe, cellMm) → mm | null | undefined
                               undefined = use the generic geometry lookup
     wallFraction(recipe)      → 0..1 | null (null = generic lookup)
     defaultCellMm(recipe)     → mm | null   (sets the cell-size input)
     options: { trimToNodes }  shows the trim-to-nodes toggle in shape mode
   ============================================================ */
'use strict';

const FAMILIES = Object.create(null);
const FAMILY_ORDER = [];
const FAMILY_LABEL = Object.create(null);
const FAMILY_COLOR = Object.create(null);

function registerFamily(d){
  if(!d || typeof d.id !== 'string') throw new Error('registerFamily: descriptor needs an id');
  if(FAMILIES[d.id]) throw new Error('registerFamily: duplicate family "'+d.id+'"');
  FAMILIES[d.id] = d;
  FAMILY_ORDER.push(d.id);
  FAMILY_LABEL[d.id] = d.label;
  FAMILY_COLOR[d.id] = d.color;
}
function familyOf(recipeOrId){
  if(!recipeOrId) return null;
  const id = typeof recipeOrId === 'string' ? recipeOrId : recipeOrId.family;
  return FAMILIES[id] || null;
}
function familyColor(fam){ return FAMILY_COLOR[fam] || '#888'; }

// Small helpers for descriptor validate() functions.
const isPlainObj = v => v!==null && typeof v==='object' && !Array.isArray(v);
function requireThat(cond, msg){ if(!cond) throw new Error(msg); }

// Type badge above the canvas: label + subtype; class kept for mesh.css.
function applyTypeBadge(badge, recipe){
  if(!badge) return;
  const fam = familyOf(recipe);
  badge.className = recipe.family;
  badge.style.cssText = (fam && fam.badgeCss) || '';
  badge.textContent = FAMILY_LABEL[recipe.family]+' · '+String(recipe.subtype).toUpperCase();
}

// Trim-to-nodes toggle applies only to families that declare it (beam).
function familyHasTrim(recipe){
  const d = familyOf(recipe);
  return !!(d && d.options && d.options.trimToNodes);
}
// A family may suggest the shape cell size (beam: sweep's geometry.cell).
// Writes it into the cell-size input at 4 significant figures.
function applyFamilyDefaultCellMm(recipe){
  const d = familyOf(recipe);
  const cellMm = (d && typeof d.defaultCellMm==='function') ? d.defaultCellMm(recipe) : null;
  if(cellMm == null) return;
  const cellInp = document.getElementById('shapeCellSizeMm');
  if(cellInp) cellInp.value = parseFloat(cellMm.toPrecision(4));
}

// ── Recipe loaders ──────────────────────────────────────────────────────────
// A loader brings recipes in from a URL source. At boot, the first loader
// (lowest priority number) whose matches() is true runs; the rest are skipped,
// so ?queue= keeps taking priority over ?r= as before. File drop/pick share
// the same parse path through parseRecipe → openRecipe.
//   registerLoader({ id, priority, matches(params, loc) → bool, load(params, loc) })
const LOADERS = [];
function registerLoader(d){
  if(!d || typeof d.id !== 'string' || typeof d.matches !== 'function' || typeof d.load !== 'function')
    throw new Error('registerLoader: needs id, matches() and load()');
  LOADERS.push(d);
}
function runUrlLoaders(){
  const params = new URLSearchParams(location.search);
  const ordered = LOADERS.slice().sort((a, b) => (a.priority || 50) - (b.priority || 50));
  for(const L of ordered){
    if(L.matches(params, location)){ L.load(params, location); return L.id; }
  }
  return null;
}
