/* ============================================================
   F13LD.mesh · worker/weld-bake-worker.js
   Weld export bake worker (v0.9.3). Launched by 61-export.js
   (bakeWeldRegion). Loads the SDF families and the weld assembly — no
   Manifold or meshoptimizer — builds the weld field once per region, then
   evaluates z-layer jobs of the levelSet grid (m31-weld-grid.js) on request.

   Messages in:
     {type:'init', bodies, blendK, reachMm, grid:{min,max,edge}, f32}
     {type:'job',  id, qa, qb}
   Messages out:
     {type:'ready', n}                                      (grid cells per axis)
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
  "m31-weld-grid.js"+self.location.search
);
let _field=null, _grid=null, _f32=false;
self.onmessage=function(e){
  const d=e.data;
  try{
    if(d.type==='init'){
      _field=makeWeldField(d.bodies, d.blendK, d.reachMm);
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
