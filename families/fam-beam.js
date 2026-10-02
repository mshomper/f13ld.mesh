/* ============================================================
   F13LD.mesh · families/fam-beam.js
   Beam family descriptor (F13LD.beam, F13LD.sweep beam). See 03-registry.js.
   ============================================================ */
'use strict';
function _beamSubtype(json){ return (json.topology&&json.topology.name)||(json.cell&&json.cell.name)||'custom'; }
function _beamVer(json){ return (json.meta&&(json.meta.tool_version||json.meta.version))||'(unknown)'; }
registerFamily({
  id: 'beam', label: 'BEAM', color: '#b8cf50',
  fromFamilyField(json){
    if(!Array.isArray(json.beams)||json.beams.length===0){
      const toolStr=(json.meta&&json.meta.tool)||'?';
      throw new Error('Beam recipe is missing beams[] array (meta.tool='+toolStr+', v'+_beamVer(json)+'). Re-export with the beam endpoint list included.');
    }
    return _beamSubtype(json);
  },
  legacy: [
    // Legacy F13LD.beam tool (predates sweep)
    {order: 10, detect(json){
      if(!(json.meta&&(json.meta.tool==='beam'||json.meta.tool==='beam-builder'))) return null;
      if(!Array.isArray(json.beams)||json.beams.length===0){
        throw new Error('Beam recipe is missing beams[] array (meta.tool='+json.meta.tool+', v'+_beamVer(json)+'). Re-export from F13LD.beam v0.2.1 or newer — preset exports now include the beam endpoint list.');
      }
      return _beamSubtype(json);
    }},
    // Structural fallback — last resort: well-formed beams[] plus lattice-like geometry.
    {order: 90, detect(json){
      if(!(Array.isArray(json.beams) && json.beams.length>0)) return null;
      const b0=json.beams[0];
      if(!(Array.isArray(b0) && b0.length>=6 && typeof b0[0]==='number' && typeof b0[5]==='number')) return null;
      const g=json.geometry||{};
      const hasLatticeGeom = (Array.isArray(g.scale_xyz)&&g.scale_xyz.length===3)
        || (typeof g.cell==='number'&&g.cell>0)
        || (typeof g.radius==='number'&&g.radius>0);
      return hasLatticeGeom ? _beamSubtype(json) : null;
    }},
  ],
  summary(r){ return buildBeamSummary(r); },
  isPeriodic(){ return true; },            // cubic tile via wrap + halo neighbors
  bakeBounds(r){ return computeBeamBakeBounds(r); },
  maxExportVoxels: 30e6,                   // high SA/V; capsule unions stress Manifold
  // New schema: radius_x/y/z in mm (thinnest axis). Old schema: radius in
  // cell-local half-units → radius·cell/2. Otherwise fall back to generic.
  thinnestFeatureMm(r, cellSizeMm){
    const g=r.json?.geometry||{};
    if(typeof g.radius_x==='number' && g.radius_x > 0){
      const ry = (typeof g.radius_y==='number' && g.radius_y>0) ? g.radius_y : g.radius_x;
      const rz = (typeof g.radius_z==='number' && g.radius_z>0) ? g.radius_z : g.radius_x;
      return Math.min(g.radius_x, ry, rz);
    }
    if(g.radius != null && g.radius > 0) return g.radius * cellSizeMm / 2;
    return undefined;
  },
  wallFraction(r){
    const g=r?.json?.geometry||{};
    let beamWallRad=null;
    if(typeof g.radius_x==='number') beamWallRad = Math.max(g.radius_x, g.radius_y??g.radius_x, g.radius_z??g.radius_x);
    else if(g.radius!=null) beamWallRad = g.radius * 2;
    return beamWallRad!=null ? Math.min(1, beamWallRad/0.30) : null;
  },
  // Sweep's characterized cell size (mm) sets the cell-size input on load.
  defaultCellMm(r){
    const cellMm=r.json&&r.json.geometry&&r.json.geometry.cell;
    return (typeof cellMm==='number'&&isFinite(cellMm)&&cellMm>0) ? cellMm : null;
  },
  options: { trimToNodes: true },
});
