/* ============================================================
   F13LD.mesh · families/fam-foam.js
   Foam family descriptor (F13LD.foam — Voronoi cell-boundary foams:
   open struts, closed walls, Plateau borders). See 03-registry.js.
   Worker side: worker/m25-sdf-foam.js.
   ============================================================ */
'use strict';
const FOAM_MODES=['poisson','lloyd','random','weairePhelan','kelvin'];
const FOAM_TOPOLOGIES=['open','closed','plateau'];
function _foamSubtype(json){ return (json.geometry&&json.geometry.mode)||'plateau'; }
registerFamily({
  id: 'foam', label: 'FOAM', color: '#E8D4A2',
  badgeCss: 'background:rgba(232,212,162,.1);color:#E8D4A2;border:.5px solid #E8D4A2',
  fromFamilyField(json){ return _foamSubtype(json); },
  // F13LD.foam v0.2.x exports had no family field.
  legacy: [{order: 60, detect(json){
    return (json.meta&&json.meta.tool==='f13ld.foam') ? _foamSubtype(json) : null;
  }}],
  validate(j){
    requireThat(isPlainObj(j.seeds), 'Foam recipe is missing its "seeds" block.');
    requireThat(isPlainObj(j.geometry), 'Foam recipe is missing its "geometry" block.');
    // Only periodic foams tile into a part (F13LD.foam checks this before handing off).
    requireThat(j.domain && j.domain.periodic===true,
      'This foam is not periodic, so it can’t tile. In F13LD.foam, turn on "periodic" under seed distribution and export again.');
    requireThat(j.geometry.mode==null||FOAM_TOPOLOGIES.includes(j.geometry.mode),
      'Unknown foam topology "'+j.geometry.mode+'". Supported: '+FOAM_TOPOLOGIES.join(', ')+'.');
    requireThat(typeof j.geometry.thickness==='number'&&j.geometry.thickness>0, 'Foam recipe needs a positive "geometry.thickness".');
    const pos=j.seeds.positions;
    if(pos!=null){
      requireThat(Array.isArray(pos)&&pos.length>=3&&pos.length%3===0&&pos.length<=3*4096,
        'Foam "seeds.positions" must be a flat list of x, y, z values for 1 to 4096 seeds.');
      requireThat(pos.every(v=>typeof v==='number'&&isFinite(v)&&v>=-5.0001&&v<=5.0001),
        'Foam "seeds.positions" must be numbers inside the cube from -5 to 5.');
    } else {
      requireThat(FOAM_MODES.includes(j.seeds.mode)&&typeof j.seeds.count==='number'&&j.seeds.count>=1,
        'Foam recipe has no seed positions and no seed settings to rebuild them from.');
    }
  },
  summary(r){
    const j=r.json, s=j.seeds||{}, g=j.geometry||{}, a=j.anisotropy||{};
    const n=Array.isArray(s.positions)?s.positions.length/3:(s.count_actual||s.count);
    const mode={poisson:'Poisson-disk',lloyd:'Lloyd-relaxed',random:'uniform random',weairePhelan:'Weaire–Phelan',kelvin:'Kelvin'}[s.mode]||s.mode;
    return `<div class="sec-lbl">foam scaffold</div><div class="meta-grid">`+
      card('topology',g.mode||'plateau')+card('seeds',mode)+card('cells',n)+
      card('thickness',g.thickness)+(g.mode==='plateau'?card('plateau k',g.plateau_k):'')+
      (g.organic>0?card('organic',g.organic):'')+
      (g.field===2?card('field','exact'):card('normalize',g.normalize===false?'off':'on'))+
      (a.enabled&&Array.isArray(a.stretch)?card('stretch',a.stretch.map(v=>(+v).toFixed(2)).join(' · ')):'')+
      card('tile',g.tile_mm!=null?g.tile_mm:null,'mm')+
      card('seed source',Array.isArray(s.positions)?'embedded':'regenerated')+
      `</div>${homoSection(j.homogenization)}${exportPanel()}`;
  },
  isPeriodic(){ return true; },        // only periodic foams are accepted
  maxExportVoxels: 30e6,               // strut networks: beam-like SA/V
  // thickness is the half-wall / strut radius in world units (10 per cell).
  thinnestFeatureMm(r, cellSizeMm){
    const t=r.json?.geometry?.thickness;
    return (typeof t==='number'&&t>0) ? t*cellSizeMm/10 : null;
  },
  wallFraction(r){
    const t=r.json?.geometry?.thickness;
    return (typeof t==='number'&&t>0) ? Math.min(1, (t*Math.PI/5)/0.30) : null;
  },
  // F13LD.foam sends the repeating cube's edge (mm) at the cell size set there.
  defaultCellMm(r){
    const v=r.json&&r.json.geometry&&r.json.geometry.tile_mm;
    return (typeof v==='number'&&isFinite(v)&&v>0) ? v : null;
  },
});
