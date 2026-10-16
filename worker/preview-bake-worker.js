/* ============================================================
   F13LD.mesh · worker/preview-bake-worker.js
   Preview field bake worker (v0.13.0). Loads the SDF families and the
   shared bake handler (m40-preview-bake.js) — no Manifold, no meshoptimizer,
   so it starts quickly and is kept warm between bakes by the pool in
   42-preview-bake.js. Stateless per message apart from the weld shape-grid
   store in m40.

   Messages in:  {mode:'bake', …} (see m40-preview-bake.js)
   Messages out: {type:'baked'|'slab', …} or {type:'error', message}
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
  "m32-export-field.js"+self.location.search,
  "m40-preview-bake.js"+self.location.search
);
self.onmessage=function(e){
  const d=e.data;
  try{
    if(d && d.mode==='bake'){ runPreviewBake(d,(m,t)=>self.postMessage(m,t||[])); return; }
    self.postMessage({type:'error',message:'preview bake worker: unknown message'});
  }catch(err){
    self.postMessage({type:'error',message:(err&&err.message)||String(err)});
  }
};
