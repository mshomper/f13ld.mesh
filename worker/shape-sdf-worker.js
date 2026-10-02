/* F13LD.mesh · worker/shape-sdf-worker.js
   Shape SDF Z-slab bake worker. Launched by 12-shape-sdf-bake.js.
   (Moved verbatim from the former inline Blob source.) */
let THREE=null, MeshBVH=null;
const ready=(async()=>{
  // v0.5.0-rc19 fix: jsdelivr serves three-mesh-bvh's index.module.js with
  // bare 'three' imports inside, which workers cannot resolve without an
  // importmap (workers don't inherit the host page's importmap). esm.sh
  // rewrites bare specifiers to absolute URLs at CDN-time. The ?deps=
  // pin ensures bvh sees the same three version we explicitly load.
  // Without this, every worker import threw and the orchestrator silently
  // fell back to serial main-thread bake — which is why N=128 imports
  // were taking ~30s instead of the ~2s they should.
  const [threeMod, bvhMod] = await Promise.all([
    import('https://esm.sh/three@0.158.0'),
    import('https://esm.sh/three-mesh-bvh@0.7.8?deps=three@0.158.0')
  ]);
  THREE=threeMod; MeshBVH=bvhMod.MeshBVH;
})();

self.onmessage=async function(e){
  try{
    await ready;
    // v0.5.0-rc19: bandMask + coarseData are optional. If both present, the
    // worker runs in narrow-band mode: precise BVH only for band voxels,
    // trilinear sample of the coarse grid for far voxels. Otherwise falls
    // back to the original full-precision per-voxel path.
    const {posArr,idxArr,bbox,N,zStart,zEnd,workerId,bandMask,coarseData,coarseN}=e.data;
    const useBand = !!(bandMask && coarseData && coarseN);
    const geo=new THREE.BufferGeometry();
    geo.setAttribute('position',new THREE.BufferAttribute(posArr,3));
    geo.setIndex(new THREE.BufferAttribute(idxArr,1));
    const bvh=new MeshBVH(geo);
    const dx=bbox.mxx-bbox.mnx,dy=bbox.mxy-bbox.mny,dz=bbox.mxz-bbox.mnz;
    const nSlices=zEnd-zStart;
    const slab=new Float32Array(N*N*nSlices);
    let minV=Infinity,maxV=-Infinity;
    const qp=new THREE.Vector3();
    const closest={point:new THREE.Vector3()};
    const ray=new THREE.Ray();
    ray.direction.set(0.9732,0.1894,0.1225).normalize();
    // Coarse-grid trilinear sampler. Coarse grid is dense over the full bbox
    // at coarseN resolution. Cells are voxel-centered (matches the bake).
    const cN = coarseN|0;
    const cN2 = cN*cN;
    function sampleCoarse(px,py,pz){
      // Voxel-center uv in [0, cN] space
      const u = (px-bbox.mnx)/dx*cN - 0.5;
      const v = (py-bbox.mny)/dy*cN - 0.5;
      const w = (pz-bbox.mnz)/dz*cN - 0.5;
      const i0 = Math.max(0, Math.min(cN-2, Math.floor(u)));
      const j0 = Math.max(0, Math.min(cN-2, Math.floor(v)));
      const k0 = Math.max(0, Math.min(cN-2, Math.floor(w)));
      const i1=i0+1, j1=j0+1, k1=k0+1;
      const fu = Math.max(0, Math.min(1, u-i0));
      const fv = Math.max(0, Math.min(1, v-j0));
      const fw = Math.max(0, Math.min(1, w-k0));
      const c000=coarseData[i0+j0*cN+k0*cN2], c100=coarseData[i1+j0*cN+k0*cN2];
      const c010=coarseData[i0+j1*cN+k0*cN2], c110=coarseData[i1+j1*cN+k0*cN2];
      const c001=coarseData[i0+j0*cN+k1*cN2], c101=coarseData[i1+j0*cN+k1*cN2];
      const c011=coarseData[i0+j1*cN+k1*cN2], c111=coarseData[i1+j1*cN+k1*cN2];
      const c00 = c000*(1-fu)+c100*fu, c10 = c010*(1-fu)+c110*fu;
      const c01 = c001*(1-fu)+c101*fu, c11 = c011*(1-fu)+c111*fu;
      const c0  = c00*(1-fv)+c10*fv,   c1  = c01*(1-fv)+c11*fv;
      return c0*(1-fw)+c1*fw;
    }
    let lastReport=performance.now();
    for(let iz=zStart;iz<zEnd;iz++){
      const localZ=iz-zStart;
      for(let iy=0;iy<N;iy++){
        // bandMask is the slab-local portion (length N*N*nSlices), indexed by
        // localZ. The output Float32 slab uses the same local indexing.
        const rowBase = localZ*N*N + iy*N;
        for(let ix=0;ix<N;ix++){
          const px = bbox.mnx+(ix+0.5)/N*dx;
          const py = bbox.mny+(iy+0.5)/N*dy;
          const pz = bbox.mnz+(iz+0.5)/N*dz;
          let val;
          if(useBand && !bandMask[rowBase+ix]){
            // Far from surface — trilinear sample of coarse grid.
            val = sampleCoarse(px,py,pz);
          } else {
            // In band (or full-precision mode) — precise BVH.
            qp.set(px,py,pz);
            bvh.closestPointToPoint(qp,closest);
            const dist=qp.distanceTo(closest.point);
            ray.origin.copy(qp);
            const hits=bvh.raycast(ray,THREE.DoubleSide);
            const inside=(hits.length&1)===1;
            val = inside?-dist:dist;
          }
          slab[ix+iy*N+localZ*N*N]=val;
          if(val<minV)minV=val;
          if(val>maxV)maxV=val;
        }
      }
      if(performance.now()-lastReport>80){
        self.postMessage({type:'progress',workerId,pct:(iz-zStart+1)/nSlices});
        lastReport=performance.now();
      }
    }
    self.postMessage({type:'done',workerId,slab:slab.buffer,zStart,zEnd,sdfMin:minV,sdfMax:maxV},[slab.buffer]);
  }catch(err){
    self.postMessage({type:'error',message:err.message||String(err)});
  }
};
