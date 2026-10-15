/* ============================================================
   F13LD.mesh · worker/field-bake-worker.js
   Single-body export field bake (v0.11.0). Launched by the mesh worker
   (m33-field-pool.js) — one per core — for open-cube and shape-clipped
   exports, the same way weld-bake-worker.js serves weld groups. Loads the
   SDF families and the shared export field (m32-export-field.js), no
   Manifold, builds the exact levelSet callback the mesh worker would use,
   then evaluates z-layer jobs of the levelSet grid (m31-weld-grid.js).

   Messages in:
     {type:'init', spec, edge, grid:{min,max,edge}, f32}
        spec = the export message fields the field depends on
        edge = voxel edge of the pass (shape short-circuit threshold)
     {type:'job',  id, qa, qb}
   Messages out:
     {type:'ready', n}
     {type:'slab', id, main, off, kmA, kmB, koA, koB, ms}   (buffers transferred)
     {type:'error', message}
   ============================================================ */
importScripts(
  "m05-sdf-registry.js"+self.location.search,
  "m10-noise.js"+self.location.search,
  "m11-grain-fields.js"+self.location.search,
  "m12-reaction-diffusion.js"+self.location.search,
  "m20-sdf-noise-tpms.js"+self.location.search,
  "m21-sdf-beam.js"+self.location.search,
  "m22-sdf-grain.js"+self.location.search,
  "m23-sdf-bundle.js"+self.location.search,
  "m24-sdf-wave.js"+self.location.search,
  "m25-sdf-foam.js"+self.location.search,
  "m30-sdf-assembly.js"+self.location.search,
  "m31-weld-grid.js"+self.location.search,
  "m32-export-field.js"+self.location.search
);
let _field=null, _grid=null, _f32=false;
self.onmessage=function(e){
  const d=e.data;
  try{
    if(d.type==='init'){
      _field=buildExportField(d.spec, d.edge, null);
      _grid=weldGridDims(d.grid.min, d.grid.max, d.grid.edge);
      _f32=!!d.f32;
      self.postMessage({type:'ready', n:_grid.n});
      return;
    }
    if(d.type==='job'){
      const t0=performance.now();
      const r=weldBakeLayers(_field, _grid, d.qa, d.qb, _f32);
      self.postMessage({type:'slab', id:d.id, main:r.main.buffer, off:r.off.buffer,
        kmA:r.kmA, kmB:r.kmB, koA:r.koA, koB:r.koB, ms:performance.now()-t0},
        [r.main.buffer, r.off.buffer]);
    }
  }catch(err){
    self.postMessage({type:'error', message:(err&&err.message)||String(err)});
  }
};
