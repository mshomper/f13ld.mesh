/* ============================================================
   F13LD.mesh · 60-export-ui.js
   DOM handles, export state, mesh / thin-feature / voxel estimators.
   ============================================================ */
'use strict';

// ── UI helpers ────────────────────────────────────────────────────────────
const dropzone=document.getElementById('dropzone'),recipeView=document.getElementById('recipeView');
const errorBox=document.getElementById('errorBox'),typeBadge=document.getElementById('typeBadge');
const summaryEl=document.getElementById('summaryContent'),triPill=document.getElementById('triPill'),seamPill=document.getElementById('seamPill');
const coMain=document.getElementById('coMain'),coSub=document.getElementById('coSub');
const overlay=document.getElementById('computeOverlay');
const FAMILY_LABEL={noise:'NOISE',tpms:'TPMS',grain:'GRAIN',beam:'BEAM',bundle:'BUNDLE',wave:'WAVE'};
// rc2.5: Family colors from F13LD.vault scheme. Used by library chips and
// the per-card recipe chip on body cards.
const FAMILY_COLOR={
  tpms:  '#5ecaa5',
  noise: '#ea7050',
  grain: '#a8a59a',
  beam:  '#b8cf50',
  bundle:'#7B4F9E',
  wave:  '#D97706'
};
function familyColor(fam){ return FAMILY_COLOR[fam] || '#888'; }
let currentRecipe=null;

// ── Export state & functions ───────────────────────────────────────────────
let currentExportQual='low';
// Tracks whether the user has explicitly chosen a quality this session.
// If false on recipe import, we default to 'low' (per Matt's UX preference);
// if true, we respect their existing choice.
let _qualUserSet=false;

window.setQual=function(q){
  currentExportQual=q;
  _qualUserSet=true;
  const ids={draft:'qDraft',low:'qLow',med:'qMed',high:'qHigh',ultra:'qUltra'};
  Object.keys(ids).forEach(k=>{const el=document.getElementById(ids[k]);if(el)el.classList.toggle('active',k===q);});
  updateExportEstimate();
};


// ── Mesh statistics estimator ─────────────────────────────────────────────────
// Surface-area based estimate — far more accurate than voxel counting.
// Empirical formula derived from real exports: vol * K / (cellSizeMm * edgeMm²)
// where K ≈ 1.5 gives ~13% error for typical TPMS/spinodoid at Fine quality.

// ── Thin-feature size detector (v0.4.2) ──────────────────────────────────
// Returns physical half-thickness in mm of the thinnest explicit feature in
// the recipe, or null if none is found (raw presets fall through). Used to
// cap the meshopt simplify tolerance so thin beams aren't eroded — see the
// 5%-of-feature cap rule at the shape-export call site.
//
// Features are stored in world units [-5,5]; world→mm scaling factor for the
// scaffold field is cellSizeMm/10 (one cell occupies 2π in SDF space, mapped
// from a 2-world-unit slice of [-5,5]).
function getThinnestFeatureMm(recipe, cellSizeMm){
  if(!recipe) return null;
  // v0.5.1: stochastic fields (noise, grain/spinodoid/GRF/HU/RD) define their
  // wall band as a threshold on a NORMALIZED field, not a physical length, so
  // half_width x cellSizeMm/10 is dimensionally meaningless for them (same
  // reasoning as the rc20 thin-wall-warning removal). Return null: the
  // feature-ratio export guard skips them (the 180s wall-clock timeout is the
  // real runaway backstop), and meshopt simplify falls back to its normal
  // edge-based tolerance instead of an over-conservative cap from a fake size.
  if(recipe.family==='noise' || recipe.family==='grain') return null;
  const g = recipe.json?.geometry || {};
  const s = recipe.json?.surface  || {};
  const w2mm = cellSizeMm / 10;
  // v0.5.0-rc16: Beam family — radius is in cell-local [-1,+1] half-units,
  // so beam half-thickness in mm is radius*cellSizeMm/2. This is twice as
  // dense (per cell-local unit) as the wall_thickness/half_width fields,
  // which use the [-π,+π] convention via w2mm = cellSizeMm/10.
  // v0.5.0-rc22: new schema (radius_xyz in mm directly) takes the per-axis
  // minimum as the thinnest feature — already in mm, no conversion needed.
  if(recipe.family==='beam'){
    if(typeof g.radius_x==='number' && g.radius_x > 0){
      const ry = (typeof g.radius_y==='number' && g.radius_y>0) ? g.radius_y : g.radius_x;
      const rz = (typeof g.radius_z==='number' && g.radius_z>0) ? g.radius_z : g.radius_x;
      return Math.min(g.radius_x, ry, rz);
    }
    if(g.radius != null && g.radius > 0) return g.radius * cellSizeMm / 2;
  }
  // TPMS shell (wall_thickness is half-thickness: SDF = wall_thickness - |φ|)
  if(g.wall_thickness != null && g.wall_thickness > 0) return g.wall_thickness * w2mm;
  // PI-TPMS pipe filaments (pipe_radius is the filament half-thickness)
  if(g.pipe_radius   != null && g.pipe_radius   > 0) return g.pipe_radius   * w2mm;
  // Grain / Noise sheet topology (half_width is the shell half-thickness)
  if(g.half_width    != null && g.half_width    > 0) return g.half_width    * w2mm;
  if(s.half_width    != null && s.half_width    > 0) return s.half_width    * w2mm;
  return null;
}

// ── Feature/edge ratio guard — shared (v0.5.1-rc4.1) ───────────────────
// Used by BOTH export paths: single-body (triggerExport) and weld-group
// (_exportWeldGroup). Previously the floor was a function-scoped const inside
// triggerExport while _exportWeldGroup referenced it by name across scopes — a
// ReferenceError that broke EVERY weld export containing a deterministic
// lattice member (beam/TPMS/bundle/wave). Single source of truth now lives
// here at module scope so the two paths cannot drift apart again.
//
// The real predictor of export blow-up is NOT triangle count (the coarse pass
// undersamples thin walls and cannot tell a safe export from a runaway one).
// It is the ratio of the thinnest physical feature to the marching-cubes voxel
// edge. The fine edge is fixed by QUALITY; cell size sets feature thickness.
// When walls get thin relative to a fixed edge, marching cubes produces
// sliver-dense surfaces that OOM or grind for minutes. Below this floor we stop
// BEFORE any level set and surface an actionable error.
//
// Floor = 0.5: the thinnest wall must be at least half a voxel edge thick.
// Calibrated against the spinodoid repro (half_width 0.15): 2mm cell gives
// 0.03mm walls (0.33x the 0.09mm High edge) and fails; 4mm gives 0.06mm walls
// (0.67x) and exports cleanly (user-verified); 8mm gives 0.12mm walls (1.33x).
// A 0.5 floor rejects the failing 2mm case and passes 4mm with margin. This sits
// below a strict one-voxel-per-wall limit because marching cubes resolves
// sub-voxel walls down to ~half an edge before sliver density blows up. The
// 180s wall-clock timeout (Layer 2) backstops anything that slips through near
// the floor and still grinds. Raise toward 0.6 for more safety margin; lower
// only with a verified passing run.
const FEATURE_EDGE_RATIO_MIN = 0.5;

// Evaluate one feature/edge pair against the floor. Returns a verdict object;
// never throws, never touches the DOM, so either path can call it before it has
// committed to any UI teardown.
//   featMm      thinnest feature half-thickness in mm (null => nothing to check)
//   edgeMm      the clamped marching-cubes voxel edge in mm
//   cellSizeMm  the cell size that produced featMm (drives the suggestion)
function checkFeatureEdgeRatio(featMm, edgeMm, cellSizeMm){
  const out={ok:true, ratio:null, floor:FEATURE_EDGE_RATIO_MIN, suggestCell:null};
  // null feature => stochastic field (noise/grain) or raw preset: not checkable.
  if(featMm==null || !(featMm>0) || !(edgeMm>0)) return out;
  out.ratio = featMm/edgeMm;
  out.ok    = (out.ratio >= FEATURE_EDGE_RATIO_MIN);
  // Features scale ~linearly with cell size for a fixed recipe, so the cell size
  // that lifts the ratio to the floor is cell x (floor/ratio), rounded up.
  if(!out.ok && cellSizeMm>0) out.suggestCell = Math.ceil(cellSizeMm*(FEATURE_EDGE_RATIO_MIN/out.ratio));
  return out;
}

// Shared error markup for both export paths. bodyLabel names the offending
// member in a weld group; pass null for single-body export, where the subject
// is unambiguous.
function featureRatioErrorHtml(chk, featMm, edgeMm, qual, bodyLabel){
  const subject = bodyLabel
    ? 'The thinnest features on <b>'+esc(bodyLabel)+'</b> are ~'+featMm.toFixed(3)+'mm'
    : 'The thinnest features are ~'+featMm.toFixed(3)+'mm';
  const fix = (chk.suggestCell!=null)
    ? (bodyLabel?'Increase its cell size to ~':'Increase cell size to ~')+chk.suggestCell+'mm, or lower export quality.'
    : 'Increase cell size, or lower export quality.';
  return '<div class="exp-err">&#9888; '+
    'Walls too thin for this quality. '+subject+', but '+qual+' quality uses a '+
    edgeMm.toFixed(3)+'mm voxel edge ('+chk.ratio.toFixed(1)+'\u00d7 \u2014 needs '+
    chk.floor+'\u00d7 or more). '+fix+'</div>';
}

// Human-readable label for a weld member, matching what the body card shows.
function memberLabel(spec, idx){
  if(!spec) return 'member '+(idx+1);
  const nm = spec.name || ('member '+(idx+1));
  return spec.recipeLabel ? nm+' \u2014 '+spec.recipeLabel : nm;
}

// ── Voxel size estimator for the export quality dropdown (v0.5.0) ─────────
// Returns the actual voxel size in mm a given quality would produce for the
// current recipe + shape combination. Mirrors the calc inside triggerExport
// (rawEdge → print floor → bbox/voxel-budget clamp). Used to label the
// quality buttons with their actual physical resolution so the user can
// pick informed by their geometry.
function voxelSizeForQuality(qual, recipe, cellSizeMm, bbox){
  if(!recipe || !bbox) return null;
  const rawEdgeMm  = QUAL_EDGE_MM[qual] || 0.10;
  const {safeEdge} = clampEdgeMm(rawEdgeMm, bbox, getMaxExportVoxels(recipe));
  return safeEdge;
}

function estimateMeshStats(recipe, edgeMm, bbox, cellSizeMm){
  const g=recipe?.json?.geometry||{};
  // v0.5.0-rc16: beam family — radius is in cell-local half-units, so the
  // 'effective' wall fraction scales as 2·radius (beam diameter as fraction
  // of half-cell). Empirically a 0.10 radius octet ≈ 13% density, similar
  // to a 0.30 wall TPMS, so we treat radius·2 as comparable to half_width·2
  // in the existing heuristic.
  // v0.5.0-rc22: beam family supports either new schema (radius_x in mm)
  // or old schema (radius cell-local). For wallFrac we use the max radius
  // as the "wall fraction" proxy — old behavior keeps the *2 scaling because
  // cell-local 1.0 spans half a cell; new behavior is already mm-scaled.
  let beamWallRad = null;
  if(recipe?.family==='beam'){
    if(typeof g.radius_x==='number') beamWallRad = Math.max(g.radius_x, g.radius_y??g.radius_x, g.radius_z??g.radius_x);
    else if(g.radius!=null) beamWallRad = g.radius * 2;
  }
  const wallFrac=beamWallRad!=null
                ?Math.min(1, beamWallRad/0.30)
                :g.wall_thickness!=null?Math.min(1,g.wall_thickness/0.30)
                :g.half_width!=null?Math.min(1,(g.half_width*2)/0.30)
                :g.pipe_radius!=null?Math.min(1,g.pipe_radius/0.18):0.5;
  let estTris;
  if(bbox && cellSizeMm){
    // Shape mode: surface-area model
    // Triangles ≈ domainVol × wallFrac × 1.5 / (cellSizeMm × edgeMm²)
    const vol=(bbox.mxx-bbox.mnx)*(bbox.mxy-bbox.mny)*(bbox.mxz-bbox.mnz);
    estTris=Math.round(vol*wallFrac*1.5/(cellSizeMm*edgeMm*edgeMm));
  } else {
    // Cube mode (edge in world units; the 10-unit cube is one design cell).
    // v0.8.3: triangles scale with surface area / edge², not volume / edge³ —
    // the old form overestimated ~100× at large domains. Constant calibrated
    // to post-simplify counts (gyroid sheet, 10 mm, Draft ≈ 3.1k tris).
    const cs=(typeof g.cell_scale==='number'&&g.cell_scale>0)?g.cell_scale:1;
    estTris=Math.round(500*wallFrac*cs/(edgeMm*edgeMm));
  }
  estTris=Math.max(1000, estTris);
  // Empirical: ~0.12ms per triangle for the full export pipeline. Was 0.08
  // (calibrated against fine-pass alone, 305k → ~25s); rc20 bumped to 0.12 to
  // cover the coarse pass (~3% of fine) and meshopt simplify (~50% of fine)
  // that actual exports also pay. Refine with new validation as needed.
  const estSec=Math.max(1,Math.round(estTris*0.00012));
  return{estTris,estSec};
}
