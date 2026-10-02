/* ============================================================
   F13LD.mesh · 41-quality-estimate.js
   Grid safety clamp, live export estimate, voxel-size labels.
   ============================================================ */
'use strict';

// ── Grid size safety clamp ────────────────────────────────────────────────────
// Prevents WASM memory crash when cell size is tiny or resMult is large.
// Returns { safeEdge, clamped, estVoxels } — safeEdge is always >= minSafeEdge.
function clampEdgeMm(edgeMm, bbox, maxVoxels){
  const vol=(bbox.mxx-bbox.mnx)*(bbox.mxy-bbox.mny)*(bbox.mxz-bbox.mnz);
  const minSafeEdge=Math.pow(vol/maxVoxels, 1/3);
  if(!isFinite(edgeMm)||edgeMm<=0){const estVoxels=vol/Math.pow(minSafeEdge,3);return{safeEdge:minSafeEdge,clamped:true,estVoxels:Math.round(estVoxels)};}
  const safeEdge=Math.max(minSafeEdge, edgeMm);
  const clamped=safeEdge!==edgeMm;
  const estVoxels=vol/Math.pow(safeEdge,3);
  return{safeEdge,clamped,estVoxels:Math.round(estVoxels)};
}
function clampEdgeWorld(edgeWorld, maxVoxels){
  // cube mode: domain is 10x10x10 world units
  const vol=1000;
  const minSafeEdge=Math.pow(vol/maxVoxels,1/3);
  const maxSafeEdge=5.0; // >5 gives <2 voxels/side — degenerate
  if(!isFinite(edgeWorld)||edgeWorld<=0) return{safeEdge:minSafeEdge,clamped:true};
  const safeEdge=Math.min(maxSafeEdge, Math.max(minSafeEdge, edgeWorld));
  const clamped=safeEdge!==edgeWorld;
  return{safeEdge,clamped};
}
const MAX_PREVIEW_VOXELS=8e6;
// v0.5.0-rc19.1: family-aware export voxel caps.
// Different scaffold families produce wildly different mesh complexity per
// voxel — beam lattices have ~10× the surface-area-per-volume of TPMS shells,
// so Manifold's working memory peaks much higher for beams at the same N.
// The previous single 50M cap was tuned for TPMS-class geometry and let
// beam exports at high quality crash the WASM heap with "memory access out
// of bounds" during marching cubes. These per-family caps keep peak memory
// under the ~2GB browser ceiling on typical hardware.
//
// Cap tuning (working assumption — adjust if real exports keep crashing):
//   beam      30M — high SA/V, capsule unions stress Manifold's vertex tables
//   noise     40M — bicontinuous topology, moderate-high SA/V
//   grain     40M — similar to noise
//   tpms      50M — shells, moderate SA/V (what the original cap was tuned for)
//   default   40M — conservative for unknown families
const MAX_EXPORT_VOXELS_BY_FAMILY = {
  beam: 30e6,
  noise: 40e6,
  grain: 40e6,
  tpms: 50e6
};
const MAX_EXPORT_VOXELS_DEFAULT = 40e6;
function getMaxExportVoxels(recipe){
  const fam = recipe?.family;
  if(fam && MAX_EXPORT_VOXELS_BY_FAMILY[fam] != null) return MAX_EXPORT_VOXELS_BY_FAMILY[fam];
  return MAX_EXPORT_VOXELS_DEFAULT;
}
// Legacy alias kept for any inadvertent reference; new code uses
// getMaxExportVoxels(recipe) instead. Equals the most permissive family cap
// so call sites that haven't migrated still produce sensible numbers.
const MAX_EXPORT_VOXELS=50e6;
// ── Live export estimate display ──────────────────────────────────────────────
function updateExportEstimate(){
  const el=document.getElementById('expEstimate');
  if(!el) return;
  // Refresh quality-button voxel labels alongside the estimate (v0.5.0).
  // Only meaningful when a shape is loaded — without one, voxel size is
  // determined by domain-size only and isn't meaningfully different across
  // qualities for the user's mental model.
  updateQualButtonVoxelSizes();
  if(!currentRecipe){el.textContent='';return;}
  try{
    let edgeMm, bbox=null, cellSizeMm=null; // declare at outer scope
    if(importedShape){
      cellSizeMm=parseFloat(document.getElementById('shapeCellSizeMm')?.value)||3;
      const rawEdge=QUAL_EDGE_MM[currentExportQual]||0.10;
      const{safeEdge}=clampEdgeMm(rawEdge,importedShape.bbox,getMaxExportVoxels(currentRecipe));
      edgeMm=safeEdge;
      bbox=importedShape.bbox;
    } else {
      const domainEl=document.getElementById('expDomainMm');
      const domainMm=Math.max(1,Math.min(100,parseFloat(domainEl?.value)||10));
      edgeMm=clampEdgeWorld((QUAL_EDGE_MM[currentExportQual]||.10)*10/domainMm, getMaxExportVoxels(currentRecipe)).safeEdge;
    }
    const{estTris,estSec}=estimateMeshStats(currentRecipe,edgeMm,bbox,cellSizeMm);
    // Rough bake time estimate: empirically ~4µs per voxel on typical meshes;
    // scales with N³. Only shown when a re-bake would actually happen.
    let bakeSec=0;
    let huBakeSec=0;
    if(importedShape){
      // Shape SDF bake is parallel via Z-slab worker pool (computeShapeSDF).
      // Worker count formula matches the orchestrator: min(12, hc-1, N).
      // Per-voxel cost ~4µs serial; near-linear scaling with workers.
      const hc=navigator.hardwareConcurrency||2;
      const targetN=EXPORT_SHAPE_SDF_N_BY_QUAL[currentExportQual]||192;
      const cachedN=importedShape.sdfGrid?importedShape.sdfGrid.N:0;
      if(cachedN<targetN){
        const sdfWorkers=Math.max(1,Math.min(12,hc-1,targetN));
        bakeSec=Math.max(1,Math.round(targetN*targetN*targetN*4e-6/sdfWorkers));
      }
      // HU pre-bake (rc20) — fires for grain+HU recipes when grid isn't cached.
      // Same worker formula as shape SDF; per-voxel cost ~6µs (hashed kernel
      // eval pulls 3³ buckets per query).
      const isHU = currentRecipe.family==='grain' && currentRecipe.json.field?.type==='hyperuniform';
      if(isHU){
        const ddx=bbox.mxx-bbox.mnx, ddy=bbox.mxy-bbox.mny, ddz=bbox.mxz-bbox.mnz;
        const maxCells=Math.max(ddx,ddy,ddz)/cellSizeMm;
        const huN=Math.max(32,Math.ceil(32*maxCells));
        // Cache check by N (rough; exact key check would duplicate the
        // export-time signature). Misses a small fraction of cache hits but
        // never overstates time when the grid is genuinely cached.
        const cached=currentRecipe._huGridCache;
        const cacheHit=cached && cached.N===huN;
        if(!cacheHit){
          const huWorkers=Math.max(1,Math.min(12,hc-1,huN));
          huBakeSec=Math.max(1,Math.round(huN*huN*huN*6e-6/huWorkers));
        }
      }
    }
    const totalSec=estSec+bakeSec+huBakeSec;
    const bakeBits=[];
    if(bakeSec>0)   bakeBits.push('~'+bakeSec+'s SDF bake');
    if(huBakeSec>0) bakeBits.push('~'+huBakeSec+'s HU bake');
    const bakeTxt = bakeBits.length ? ' (includes '+bakeBits.join(', ')+')' : '';
    el.textContent='~'+estTris.toLocaleString()+' triangles · ~'+totalSec+'s'+bakeTxt;
    // v0.5.0-rc20: thinnest-wall warning removed. The formula
    // (half_width × cellSizeMm/10) is dimensionally wrong for stochastic
    // fields — half_width is an iso-band threshold on a normalized field,
    // not a physical length. It's accurate for beam (radius in cell-local
    // half-units) and roughly correct for tpms thin walls, but the false
    // positives on grain/HU/spinodoid/GRF dominate. Quality-button voxel-
    // size labels already give users what they need to judge resolution.
  }catch(e){el.textContent='';}
}

// ── Voxel-size labels on quality buttons (v0.5.0) ─────────────────────────
// Updates the secondary text (e.g., "0.20mm") under each quality label so
// the user can see the actual physical resolution each quality will produce
// for their loaded shape + cell-size combination. Only populated when a
// shape is loaded; without one, labels are blanked.
function updateQualButtonVoxelSizes(){
  const ids={draft:'qlDraft',low:'qlLow',med:'qlMed',high:'qlHigh',ultra:'qlUltra'};
  const allEls=Object.entries(ids).map(([q,id])=>[q,document.getElementById(id)]).filter(([,el])=>el);
  if(allEls.length===0) return;
  if(!importedShape || !currentRecipe){
    allEls.forEach(([,el])=>{el.textContent='—';});
    return;
  }
  const cellSizeMm=parseFloat(document.getElementById('shapeCellSizeMm')?.value)||3;
  // Compute each quality's voxel size; collapse duplicates (small shapes
  // hit the bbox/voxel-budget clamp at fine qualities, producing the same
  // voxel size as a coarser tier).
  const sizes={};
  for(const [q,] of allEls){
    sizes[q]=voxelSizeForQuality(q,currentRecipe,cellSizeMm,importedShape.bbox);
  }
  // Format: show in mm with trailing-zero trim. Annotate "(=Med)" etc when
  // a quality clamps to the same size as a coarser tier.
  const order=['draft','low','med','high','ultra'];
  const labels={draft:'Draft',low:'Low',med:'Med',high:'High',ultra:'Ultra'};
  const fmt=mm=>mm<0.1?(mm*1000).toFixed(0)+'µm':mm.toFixed(2)+'mm';
  for(const [q,el] of allEls){
    if(sizes[q]==null){el.textContent='—';continue;}
    // Find the nearest coarser tier with the same size (within 0.5%)
    const idx=order.indexOf(q);
    let coarserSame=null;
    for(let i=idx-1;i>=0;i--){
      const co=order[i];
      if(sizes[co]!=null && Math.abs(sizes[co]-sizes[q])/sizes[q]<0.005){
        coarserSame=labels[co]; break;
      }
    }
    el.textContent=fmt(sizes[q])+(coarserSame?' (=' + coarserSame + ')':'');
  }
}

// ── Mesh pipeline ─────────────────────────────────────────────────────────
