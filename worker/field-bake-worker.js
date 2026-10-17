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
     {type:'mesh', id, La, Lb, tol}   v0.15.0 slab mesher (m36-slab-pool.js):
        mesh tets with lowest layer in [La, Lb), simplify with seams locked
     {type:'band', id, pos, idx, outer, tol}   v0.15.0 seam band simplify
   Messages out:
     {type:'ready', n}
     {type:'slab', id, main, off, kmA, kmB, koA, koB, ms}   (buffers transferred)
     {type:'meshslab', id, pos, idx, seamV, seamK, rawTris, retries, locked, gaveUp, evals, ms}
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
  "m32-export-field.js"+self.location.search,
  "m34-slab-mesher.js"+self.location.search,
  "m35-slab-cleanup.js"+self.location.search
);
let _field=null, _grid=null, _f32=false;
self.onmessage=async function(e){
  const d=e.data;
  try{
    if(d.type==='init'){
      _field=buildExportField(d.spec, d.edge, null);
      _grid=weldGridDims(d.grid.min, d.grid.max, d.grid.edge);
      _f32=!!d.f32;
      self.postMessage({type:'ready', n:_grid.n});
      return;
    }
    if(d.type==='mesh'){
      const t0=performance.now();
      let r=slabMeshLayers(_field, _grid, d.La, d.Lb);
      if(d.tol>0){ await slabMeshoptReady; r=simplifySlab(r, d.tol); }
      else r.rawTris=r.idx.length/3;
      self.postMessage({type:'meshslab', id:d.id, pos:r.pos.buffer, idx:r.idx.buffer, seamV:r.seamV.buffer, seamK:r.seamK.buffer,
        rawTris:r.rawTris, retries:r.retries||0, locked:r.locked||0, gaveUp:!!r.gaveUp, evals:r.evals, ms:performance.now()-t0},
        [r.pos.buffer, r.idx.buffer, r.seamV.buffer, r.seamK.buffer]);
      return;
    }
    if(d.type==='band'){
      await slabMeshoptReady;
      const t0=performance.now();
      const r=simplifyBandJob({pos:new Float32Array(d.pos), idx:new Uint32Array(d.idx), outer:new Uint8Array(d.outer)}, d.tol);
      const idx=new Uint32Array(r.idx);
      self.postMessage({type:'band', id:d.id, idx:idx.buffer, retries:r.retries, locked:r.locked, gaveUp:r.gaveUp, unsafe:r.unsafe, ms:performance.now()-t0}, [idx.buffer]);
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
