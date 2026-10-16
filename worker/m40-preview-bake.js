/* ============================================================
   F13LD.mesh · worker/m40-preview-bake.js
   Preview field bake (field → N³ grid, no Manifold). Moved out of
   m90-onmessage.js in v0.13.0 so the light preview worker
   (preview-bake-worker.js) and the mesh worker share one copy.

   runPreviewBake(d, post) handles {mode:'bake', recipe, N, worldMin, worldMax,
   isPeriodic, bakeRaw, shapeCtx, bodies, mmScale, blendK, zStart?, zEnd?}.
   With zStart/zEnd it bakes only that block of z-layers and posts
     {type:'slab', slab, zStart, zEnd, N, partialMin, partialMax, worldMin,
      worldMax, isPeriodic, topology?, raw?}   (raw: normalized stochastic bake)
   for the main thread to stitch (42-preview-bake.js). Without them it posts
     {type:'baked', field, N, fieldMin, fieldMax, lipschitz, worldMin,
      worldMax, isPeriodic, topology?}
   exactly as before.

   Weld shape grids (v0.13.0): a body spec may carry shapeGridId. With data it
   is stored in this worker; without data it is filled in from the store.
   d.keepGrids lists the ids the main thread expects this worker to keep —
   anything else is dropped, so both sides agree on what is cached.
   ============================================================ */
const _bakeGrids=new Map();   // shapeGridId -> ArrayBuffer
function _bakeResolveGrids(d){
  if(!d.bodies||!d.bodies.length) return;
  for(const sp of d.bodies){
    if(sp.shapeGridId==null) continue;
    if(sp.shapeSdfData) _bakeGrids.set(sp.shapeGridId, sp.shapeSdfData);
    else{
      const buf=_bakeGrids.get(sp.shapeGridId);
      if(!buf) throw new Error('preview bake: shape grid '+sp.shapeGridId+' missing in worker');
      sp.shapeSdfData=buf;
    }
  }
  if(Array.isArray(d.keepGrids)){
    const keep=new Set(d.keepGrids);
    for(const id of [..._bakeGrids.keys()]) if(!keep.has(id)) _bakeGrids.delete(id);
  }
}
// 98th-percentile gradient Lipschitz of an SDF grid (v0.6.1). The main thread
// keeps a copy (42-preview-bake.js _bakeSdfLipschitz) for stitched slab bakes;
// tests/slabbake.js checks the two agree.
function bakeSdfLipschitz(field,N,sx,sy,sz){
  let maxG=0;
  for(let iz=1;iz<N-1;iz++)for(let iy=1;iy<N-1;iy++)for(let ix=1;ix<N-1;ix++){
    const i=ix+iy*N+iz*N*N;
    const gx=(field[i+1]-field[i-1])/(2*sx);
    const gy=(field[i+N]-field[i-N])/(2*sy);
    const gz=(field[i+N*N]-field[i-N*N])/(2*sz);
    const g=Math.sqrt(gx*gx+gy*gy+gz*gz);if(g>maxG)maxG=g;
  }
  // v0.6.1: robust Lipschitz for raymarch step control. A few cusp voxels
  // (tight smin/smax blends, twist shear, braid Newton) inflate the raw max
  // and throttle every step across the model. Use the 98th-percentile
  // gradient via a 256-bin histogram instead; the shader's 0.85 safety
  // factor + min-step clamp still cover the rare steeper voxels. Metric
  // families (tpms/beam/grain) are unaffected since their p98 ~= max.
  let lipRobust=maxG;
  if(maxG>0){
    const BINS=256, hist=new Int32Array(BINS), invB=BINS/maxG;
    let cnt=0;
    for(let iz=1;iz<N-1;iz++)for(let iy=1;iy<N-1;iy++)for(let ix=1;ix<N-1;ix++){
      const i=ix+iy*N+iz*N*N;
      const gx=(field[i+1]-field[i-1])/(2*sx);
      const gy=(field[i+N]-field[i-N])/(2*sy);
      const gz=(field[i+N*N]-field[i-N*N])/(2*sz);
      const g=Math.sqrt(gx*gx+gy*gy+gz*gz);
      let b=(g*invB)|0; if(b>=BINS)b=BINS-1; else if(b<0)b=0;
      hist[b]++; cnt++;
    }
    const target=cnt*0.98;
    let acc=0,bin=BINS-1;
    for(let b=0;b<BINS;b++){acc+=hist[b];if(acc>=target){bin=b;break;}}
    lipRobust=(bin+1)/invB; // upper edge of the 98th-percentile bin
  }
  return Math.max(lipRobust*1.1,0.05);
}
function runPreviewBake(d, post){
  _bakeResolveGrids(d);
  const slabbed=(d.zEnd!=null);
  // ── Raw (normalized) bake for stochastic families ────────────────────────
  if(d.bakeRaw){
    const N=d.N||64;
    const wMin=d.worldMin||[-5,-5,-5],wMax=d.worldMax||[5,5,5];
    const sx=(wMax[0]-wMin[0])/N,sy=(wMax[1]-wMin[1])/N,sz=(wMax[2]-wMin[2])/N;
    const fam=d.recipe.family,json=d.recipe.json;
    // v0.9.0: stochastic families supply their raw field (registerSDF rawEval).
    const sdfFam=SDF_FAMILIES[fam];
    const raw=(sdfFam && typeof sdfFam.rawEval==='function') ? sdfFam.rawEval(d) : null;
    const evalRaw=raw?raw.evalRaw:null, topology=raw?raw.topology:null;
    if(evalRaw){
      const zS=d.zStart||0, zE=slabbed?d.zEnd:N, slabN=zE-zS;
      const field=new Float32Array(N*N*slabN);
      let minV=Infinity,maxV=-Infinity;
      for(let iz=zS;iz<zE;iz++)for(let iy=0;iy<N;iy++)for(let ix=0;ix<N;ix++){
        const v=evalRaw([wMin[0]+sx*(ix+0.5),wMin[1]+sy*(iy+0.5),wMin[2]+sz*(iz+0.5)]);
        field[ix+iy*N+(iz-zS)*N*N]=v;if(v<minV)minV=v;if(v>maxV)maxV=v;
      }
      if(slabbed){const sbuf=field.buffer;post({type:'slab',slab:sbuf,zStart:zS,zEnd:zE,N,partialMin:minV,partialMax:maxV,worldMin:wMin,worldMax:wMax,isPeriodic:false,topology,raw:true},[sbuf]);return;}
      let maxG=0;
      for(let iz=1;iz<N-1;iz++)for(let iy=1;iy<N-1;iy++)for(let ix=1;ix<N-1;ix++){
        const i=ix+iy*N+iz*N*N;
        const gx=(field[i+1]-field[i-1])/(2*sx);
        const gy=(field[i+N]-field[i-N])/(2*sy);
        const gz=(field[i+N*N]-field[i-N*N])/(2*sz);
        const g=Math.sqrt(gx*gx+gy*gy+gz*gz);if(g>maxG)maxG=g;
      }
      const halfR=Math.max((maxV-minV)*0.5,0.001);
      const lip=Math.max(maxG/halfR*1.1,0.05);
      // v0.5.0-rc27: pad noise family's empirical [minV, maxV] by ±5% to match
      // the canonical F13LD.noise tool's prepass convention (its _runPrepass
      // applies the same range×0.05 padding). Grain family computes bounds
      // from cosine sums via a different convention and is left unpadded.
      // The padded values are what get cached as recipe._previewFieldMin/Max
      // on the main thread, used by buildSDF's normOverride path on export.
      let postMin=minV, postMax=maxV;
      if(sdfFam && typeof sdfFam.rawRange==='function'){
        const rr=sdfFam.rawRange(json,minV,maxV); postMin=rr.min; postMax=rr.max;
      }
      const buf=field.buffer;
      post({type:'baked',field:buf,N,fieldMin:postMin,fieldMax:postMax,
        lipschitz:lip,worldMin:wMin,worldMax:wMax,isPeriodic:false,topology},[buf]);
      return;
    }
  }
  // ── SDF bake ─────────────────────────────────────────────────────────────
  const N=d.N||64;
  // For stochastic fields with a shape: bake over the full world bbox.
  // For periodic fields: bake one cell in [-5,5]^3 and let shader tile.
  const isPeriodic=d.isPeriodic||false;
  const wMin=d.worldMin||[-5,-5,-5];
  const wMax=d.worldMax||[5,5,5];
  const sx=(wMax[0]-wMin[0])/N, sy=(wMax[1]-wMin[1])/N, sz=(wMax[2]-wMin[2])/N;
  // Pass shapeCtx for HU domain-spanning kernels (stochastic with shape)
  const shapeCtx=d.shapeCtx||null;
  // W2 -- preview hook: assembly when bodies[] present, scaled mm->world by mmScale
  const sdfFn=(d.bodies&&d.bodies.length)?(function(){var _a=buildAssemblySDF(d.bodies,d.blendK,true),_s=d.mmScale||1;return function(p){return _a([p[0]/_s,p[1]/_s,p[2]/_s])*_s;};})():buildSDF(d.recipe,shapeCtx);
  const zS=slabbed?(d.zStart||0):0, zE=slabbed?d.zEnd:N;
  const field=new Float32Array(N*N*(zE-zS));
  let minV=Infinity,maxV=-Infinity;
  for(let iz=zS;iz<zE;iz++)for(let iy=0;iy<N;iy++)for(let ix=0;ix<N;ix++){
    const v=sdfFn([wMin[0]+sx*(ix+0.5),wMin[1]+sy*(iy+0.5),wMin[2]+sz*(iz+0.5)]);
    field[ix+iy*N+(iz-zS)*N*N]=v;
    if(v<minV)minV=v;if(v>maxV)maxV=v;
  }
  if(slabbed){
    const sbuf=field.buffer;
    post({type:'slab',slab:sbuf,zStart:zS,zEnd:zE,N,partialMin:minV,partialMax:maxV,worldMin:wMin,worldMax:wMax,isPeriodic},[sbuf]);
    return;
  }
  const buf=field.buffer;
  post({type:'baked',field:buf,N,fieldMin:minV,fieldMax:maxV,
    lipschitz:bakeSdfLipschitz(field,N,sx,sy,sz),
    worldMin:wMin,worldMax:wMax,isPeriodic},[buf]);
}
