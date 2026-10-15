/* F13LD.mesh · worker/m90-onmessage.js — Worker message handler: bake / preview / export meshing. */
self.onmessage=async function(e){
  const d=e.data,t0=performance.now();
  let lastStage='initializing';
  // v0.5.0-rc19.1: friendly translation of WASM heap-exhaustion errors.
  // Manifold throws "RuntimeError: memory access out of bounds" when its
  // marching-cubes working memory exceeds the WASM heap (typically around
  // ~2GB). The raw error tells the user nothing useful; this wrapper
  // converts it into actionable advice. Non-OOM errors propagate unchanged
  // so real bugs still surface clearly.
  function safeLevelSet(sdfFn, bounds, edge, stageLabel){
    try {
      return ManifoldAPI.Manifold.levelSet(sdfFn, bounds, edge);
    } catch(err){
      const msg = (err && err.message) || String(err);
      const isWasmOOM = /out of bounds/i.test(msg) || (err && err.name === 'RuntimeError');
      if(isWasmOOM){
        throw new Error(
          'Geometry too complex at this quality — Manifold ran out of working ' +
          'memory during '+(stageLabel||'marching cubes')+'. Try a coarser ' +
          'export quality (Med or Low), or increase your cell size to make ' +
          'each beam/wall thicker relative to the voxel grid.'
        );
      }
      throw err;
    }
  }
  try{
    // ── Bake mode: field → N³ SDF grid, no Manifold needed ──────────────────
    if(d.mode==='bake'&&d.bakeRaw){
      const N=d.N||64;
      const wMin=d.worldMin||[-5,-5,-5],wMax=d.worldMax||[5,5,5];
      const sx=(wMax[0]-wMin[0])/N,sy=(wMax[1]-wMin[1])/N,sz=(wMax[2]-wMin[2])/N;
      const fam=d.recipe.family,json=d.recipe.json;
      // v0.9.0: stochastic families supply their raw field (registerSDF rawEval).
      const sdfFam=SDF_FAMILIES[fam];
      const raw=(sdfFam && typeof sdfFam.rawEval==='function') ? sdfFam.rawEval(d) : null;
      const evalRaw=raw?raw.evalRaw:null, topology=raw?raw.topology:null;
      if(evalRaw){
        const zS=d.zStart||0, zE=(d.zEnd!=null)?d.zEnd:N, slabN=zE-zS;
        const field=new Float32Array(N*N*slabN);
        let minV=Infinity,maxV=-Infinity;
        for(let iz=zS;iz<zE;iz++)for(let iy=0;iy<N;iy++)for(let ix=0;ix<N;ix++){
          const v=evalRaw([wMin[0]+sx*(ix+0.5),wMin[1]+sy*(iy+0.5),wMin[2]+sz*(iz+0.5)]);
          field[ix+iy*N+(iz-zS)*N*N]=v;if(v<minV)minV=v;if(v>maxV)maxV=v;
        }
        if(d.zEnd!=null){const sbuf=field.buffer;self.postMessage({type:'slab',slab:sbuf,zStart:zS,zEnd:zE,N,partialMin:minV,partialMax:maxV,worldMin:wMin,worldMax:wMax,topology},[sbuf]);return;}
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
        self.postMessage({type:'baked',field:buf,N,fieldMin:postMin,fieldMax:postMax,
          lipschitz:lip,worldMin:wMin,worldMax:wMax,isPeriodic:false,topology},[buf]);
        return;
      }
    }
    if(d.mode==='bake'){
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
      const field=new Float32Array(N*N*N);
      let minV=Infinity,maxV=-Infinity;
      for(let iz=0;iz<N;iz++)for(let iy=0;iy<N;iy++)for(let ix=0;ix<N;ix++){
        const v=sdfFn([wMin[0]+sx*(ix+0.5),wMin[1]+sy*(iy+0.5),wMin[2]+sz*(iz+0.5)]);
        field[ix+iy*N+iz*N*N]=v;
        if(v<minV)minV=v;if(v>maxV)maxV=v;
      }
      let maxG=0;
      const step=(sx+sy+sz)/3;
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
      const buf=field.buffer;
      self.postMessage({type:'baked',field:buf,N,fieldMin:minV,fieldMax:maxV,
        lipschitz:Math.max(lipRobust*1.1,0.05),
        worldMin:wMin,worldMax:wMax,isPeriodic},[ buf]);
      return;
    }
    await manifoldReady;
    if(!ManifoldAPI)throw new Error('Manifold not available in worker.');
    await meshoptReady;
    self.postMessage({type:'progress',stage:'building SDF...'});
    const shapeCtx=exportShapeCtx(d);   // m32-export-field.js
    // Weld-group export carries no top-level recipe (each member has its own in
    // d.bodies); the assembly branch builds its own SDF, so skip this single-
    // recipe build to avoid buildSDF(undefined) dereferencing recipe._previewFieldMin.
    const tSetup0=performance.now();
    const sdfFn=(d.bodies&&d.bodies.length)?null:buildSDF(d.recipe,shapeCtx);
    let setupMs=performance.now()-tSetup0;   // v0.11.0: field pool sizing (m33)
    let mfld;
    let msLevelSet=0; // shared across branches for the timings pill
    let fieldBake=null; // v0.11.0: {workers, ms, f32, stats} when the single-body field was pre-baked
    let weldDustMm3=0; // v0.9.3 hybrid weld: drop shells smaller than this (dropTinyShells)
    // (v0.5.0-rc7) Legacy mode:'shape' branch removed — was never invoked from
    // main thread. Boolean CSG via Manifold.intersection no longer needed; the
    // implicit max(scaffold,-shape) composition in mode:'export' replaced it.
    if(d.mode==='export'){
      // ── Export mode: pre-computed edge/simplify lengths, returns scale ───────
      if(d.bodies && d.bodies.length){
        // ── Weld-group export (W3; v0.9.3 hybrid) ───────────────────────────
        // d.bodies = per-member specs (shape grid + recipe + cell), d.bbox =
        // group bbox (mm), d.blendK = fillet. d.weld (v0.9.3, planned by
        // 14-weld-bake.js on the main thread):
        //   hybrid       solids with a closed mesh come from that mesh; only the
        //                regions around lattice members are level-set, with
        //                those solids pulled one voxel inside (spec.insetMm) so
        //                the exact mesh covers them in the union
        //   solidMeshes  [i] = {pos, idx} for each such solid, else null
        //   regions      [{min,max, main?,off?,f32}] level-set boxes; main/off
        //                are the field pre-baked at levelSet's grid points by
        //                the worker pool (m31-weld-grid.js)
        //   reachMm      far-member skip distance (buildAssemblySDF)
        // The field is canonical NEGATIVE-INSIDE, flipped to Manifold
        // POSITIVE-INSIDE (NaN-guarded) by makeWeldField.
        const w=d.weld||{};
        const gbb=d.bbox, edge=d.relEdgeMm;
        const fullBox={min:[gbb.mnx,gbb.mny,gbb.mnz],max:[gbb.mxx,gbb.mxy,gbb.mxz]};
        let bodies=d.bodies, regions=(w.regions&&w.regions.length)?w.regions:[fullBox];
        let hybrid=!!w.hybrid;
        const solidMf=[];
        if(hybrid){
          try{
            for(let i=0;i<bodies.length;i++){
              const sm=w.solidMeshes&&w.solidMeshes[i]; if(!sm) continue;
              const mesh=new ManifoldAPI.Mesh({numProp:3, vertProperties:new Float32Array(sm.pos), triVerts:new Uint32Array(sm.idx)});
              mesh.merge();
              const m=new ManifoldAPI.Manifold(mesh);   // throws if not a closed manifold
              solidMf.push(m);
              if(!(m.volume()>0)) throw new Error('solid mesh is inside-out');
            }
          }catch(err){
            // The main thread's closed-mesh check passed but Manifold disagrees:
            // mesh the whole group the pre-v0.9.3 way (no inset, no cache).
            for(const m of solidMf) m.delete();
            solidMf.length=0; hybrid=false;
            bodies=bodies.map(b=>b.insetMm?Object.assign({},b,{insetMm:0}):b);
            regions=[fullBox];
            self.postMessage({type:'progress',stage:'solid mesh rejected ('+((err&&err.message)||err)+') — meshing the whole group...'});
          }
        }
        // Built on first use: with every point pre-baked it may never be needed,
        // and some fields are costly to set up (foam relaxation, RD).
        let _field=null;
        const field=function(p){ if(!_field) _field=makeWeldField(bodies,d.blendK,w.reachMm||0); return _field(p); };
        const tLevelSet=performance.now();
        const pieces=[], diag=[];
        for(let ri=0;ri<regions.length;ri++){
          const r=regions[ri];
          const g=weldGridDims(r.min,r.max,edge);
          let fn=field, stats=null;
          if(r.main && r.off && g.ok){
            const A=r.f32?Float32Array:Float64Array;
            const M=new A(r.main), O=new A(r.off);
            if(M.length===g.mainCount && O.length===g.offCount){ stats={}; fn=makeWeldLookup(g,M,O,field,stats); }
          }
          lastStage='weld level set'+(regions.length>1?' '+(ri+1)+'/'+regions.length:'')+' ('+edge.toFixed(3)+'mm'+(stats?', pre-baked':'')+')';
          self.postMessage({type:'progress',stage:lastStage+'...'});
          const m=safeLevelSet(fn,{min:r.min,max:r.max},edge,'weld level set');
          diag.push({region:ri, points:g.mainCount+g.offCount, cached:stats?stats.hit:0, direct:stats?stats.miss:(g.mainCount+g.offCount)});
          if(m.isEmpty()) m.delete(); else pieces.push(m);
        }
        msLevelSet=Math.round(performance.now()-tLevelSet);
        let msUnion=0;
        const parts=pieces.concat(solidMf);
        if(!parts.length) throw new Error('Empty weld mesh — check group overlap.');
        if(parts.length===1){ mfld=parts[0]; }
        else{
          lastStage='union with '+solidMf.length+' solid mesh'+(solidMf.length===1?'':'es');
          self.postMessage({type:'progress',stage:lastStage+'...'});
          const tU=performance.now();
          mfld=ManifoldAPI.Manifold.union(parts);
          for(const m of parts) m.delete();
          msUnion=Math.round(performance.now()-tU);
        }
        if(mfld.isEmpty()){mfld.delete();throw new Error('Empty weld mesh — check group overlap.');}
        if(hybrid) weldDustMm3=0.1*edge*edge*edge;
        self.postMessage({type:'diag',diag:{weld:true, hybrid, solids:solidMf.length, regions:diag, msLevelSet, msUnion}});
      } else if(d.shapeSdfData){
        const{relEdgeMm,simplifyTol,bbox,shapeSdfData,shapeN}=d;
        const tShape0=performance.now();
        const shapeField=buildShapeExportField(d, sdfFn, m=>self.postMessage(m));
        setupMs+=performance.now()-tShape0;
        const wrappedSDF=shapeField.fn;
      // ── Export two-pass: coarse → live bbox → fine ──────────────────────────
      // No boolean intersect — the max()-composed SDF already emits only the
      // scaffold-inside-shape surface. Coarse pass still worth running: tight
      // bbox lets fine pass skip empty regions of the original bbox.
      const eMaxDim=Math.max(bbox.mxx-bbox.mnx,bbox.mxy-bbox.mny,bbox.mxz-bbox.mnz);
      const eCoarseEdge=Math.min(relEdgeMm*4,eMaxDim/3);
      // Voxel counts help diagnose OOM / timeout issues — user sees what's happening
      const coarseVox=Math.round(((bbox.mxx-bbox.mnx)*(bbox.mxy-bbox.mny)*(bbox.mxz-bbox.mnz))/Math.pow(eCoarseEdge,3)/1e6);
      lastStage='coarse pass ('+eCoarseEdge.toFixed(1)+'mm, ~'+coarseVox+'M voxels)';
      self.postMessage({type:'progress',stage:lastStage+'...'});
      shapeField.setEdge(eCoarseEdge); // v0.5.0-rc19: short-circuit threshold tracks pass edge
      let eCoarseMfld=safeLevelSet(wrappedSDF,{min:[bbox.mnx,bbox.mny,bbox.mnz],max:[bbox.mxx,bbox.mxy,bbox.mxz]},eCoarseEdge,'coarse pass');
      // v0.8.2: the coarse pass samples at 4× the fine edge, so struts or walls
      // thinner than that can fall between its samples. An empty coarse result
      // therefore no longer means "empty part" — fall back to meshing the full
      // box, and only the fine pass decides emptiness. When the coarse pass does
      // find surface, pad its box by a whole coarse voxel (was 2 fine voxels,
      // smaller than the coarse voxel itself, so missed features near the
      // extremes could be cut off).
      let eInner;
      if(eCoarseMfld.isEmpty()){
        eCoarseMfld.delete();
        self.postMessage({type:'progress',stage:'coarse pass found no surface (features thinner than '+eCoarseEdge.toFixed(2)+' mm) — meshing full box...'});
        eInner={mnx:bbox.mnx,mxx:bbox.mxx,mny:bbox.mny,mxy:bbox.mxy,mnz:bbox.mnz,mxz:bbox.mxz};
      } else {
        lastStage='extracting coarse bbox';
        const ecm=eCoarseMfld.getMesh(),evp=ecm.vertProperties;
        let emnx=Infinity,emny=Infinity,emnz=Infinity,emxx=-Infinity,emxy=-Infinity,emxz=-Infinity;
        for(let i=0;i<evp.length;i+=3){
          if(evp[i  ]<emnx)emnx=evp[i  ]; if(evp[i  ]>emxx)emxx=evp[i  ];
          if(evp[i+1]<emny)emny=evp[i+1]; if(evp[i+1]>emxy)emxy=evp[i+1];
          if(evp[i+2]<emnz)emnz=evp[i+2]; if(evp[i+2]>emxz)emxz=evp[i+2];
        }
        // ── Coarse-pass diagnostic (v0.5.1-rc4.0b) ────────────────────────────
        // The earlier rc4.0a memory-projection/auto-coarsen guard lived here. It
        // was removed: the coarse pass undersamples thin walls, so its triangle
        // count cannot distinguish a safe export from a runaway one (a dense 2mm
        // spinodoid and a sparse 8mm one produce near-identical coarse tris). The
        // real guard now runs on the MAIN THREAD before dispatch — a feature-to-
        // voxel-edge ratio check (Layer 1), backed by a wall-clock timeout
        // (Layer 2). We keep a console-only coarse-tris log purely for calibration
        // reference; it drives no decision. coarseVox now reports ACTUAL voxels
        // (the old /1e6 rounding made it read 0 for small parts).
        const coarseTris = ecm.triVerts.length/3;
        const coarseVoxActual = Math.round(((bbox.mxx-bbox.mnx)*(bbox.mxy-bbox.mny)*(bbox.mxz-bbox.mnz))/Math.pow(eCoarseEdge,3));
        self.postMessage({type:'diag',diag:{
          coarseTris, coarseVox: coarseVoxActual, eCoarseEdge,
          fineEdgeMm: relEdgeMm
        }});
        eCoarseMfld.delete();
        const ePad=eCoarseEdge+relEdgeMm*2;
        eInner={
          mnx:Math.max(bbox.mnx,emnx-ePad),mxx:Math.min(bbox.mxx,emxx+ePad),
          mny:Math.max(bbox.mny,emny-ePad),mxy:Math.min(bbox.mxy,emxy+ePad),
          mnz:Math.max(bbox.mnz,emnz-ePad),mxz:Math.min(bbox.mxz,emxz+ePad)
        };
      }
      const fineVox=Math.round(((eInner.mxx-eInner.mnx)*(eInner.mxy-eInner.mny)*(eInner.mxz-eInner.mnz))/Math.pow(relEdgeMm,3)/1e6);
      lastStage='fine level set ('+relEdgeMm.toFixed(3)+'mm, ~'+fineVox+'M voxels)';
      shapeField.setEdge(relEdgeMm); // v0.5.0-rc19: short-circuit threshold tracks pass edge
      // v0.11.0: evaluate the fine grid on every core first (m33-field-pool.js).
      const fineMin=[eInner.mnx,eInner.mny,eInner.mnz], fineMax=[eInner.mxx,eInner.mxy,eInner.mxz];
      let fineFn=wrappedSDF;
      const fpb=await prebakeExportField(d, wrappedSDF, fineMin, fineMax, relEdgeMm, m=>self.postMessage(m), {setupMs});
      if(fpb){ fineFn=fpb.fn; fieldBake=fpb; }
      self.postMessage({type:'progress',stage:lastStage+(fpb?' (field pre-baked on '+fpb.workers+' cores)':'')+'...'});
      const tLevelSet=performance.now();
      mfld=safeLevelSet(fineFn,{min:fineMin,max:fineMax},relEdgeMm,'fine level set ('+relEdgeMm.toFixed(3)+'mm, ~'+fineVox+'M voxels)');
      if(mfld.isEmpty()){mfld.delete();throw new Error('Empty mesh — check shape/scaffold overlap.');}
      msLevelSet=Math.round(performance.now()-tLevelSet);
      // Shape-sdf export mode falls through to the unified extract+simplify+done
      // block below. msLevelSet captured here so timings-pill stays accurate.
      } else {
        // Cube export — apply the canonical→Manifold sign flip that wrappedSDF
        // does for shape-clipped exports. Builders return negative-inside;
        // Manifold treats positive as solid for marching cubes. Without the
        // flip, cube exports come out topologically inverted relative to the
        // renderer (which uses canonical negative-inside as designed).
        // v0.11.0: evaluate the grid on every core first (m33-field-pool.js).
        const cubeFn=p=>-sdfFn(p);
        let lsFn=cubeFn;
        const cpb=await prebakeExportField(d, cubeFn, [-5,-5,-5], [5,5,5], d.edgeWorld, m=>self.postMessage(m), {setupMs});
        if(cpb){ lsFn=cpb.fn; fieldBake=cpb; }
        lastStage='level set ('+d.edgeWorld.toFixed(3)+' world edge'+(cpb?', field pre-baked on '+cpb.workers+' cores':'')+')';
        self.postMessage({type:'progress',stage:lastStage+'...'});
        const tLevelSet=performance.now();
        mfld=safeLevelSet(lsFn,{min:[-5,-5,-5],max:[5,5,5]},d.edgeWorld,'cube export level set');
        if(mfld.isEmpty()){mfld.delete();throw new Error('Empty mesh — adjust recipe parameters.');}
        msLevelSet=Math.round(performance.now()-tLevelSet);
      }
    } else {
      // Defensive — only mode='bake' (handled+returned earlier) and mode='export'
      // (handled above) are dispatched anywhere in the codebase. Surface any
      // future regression where a new mode bypasses the export branches.
      throw new Error('unknown worker mode: '+d.mode);
    }
    // ── Unified extract + meshopt simplify + done ─────────────────────────────
    // All export paths (shape CSG, weld group, cube) funnel here with mfld set.
    lastStage='extracting mesh';
    self.postMessage({type:'progress',stage:'extracting mesh...'});
    const extractedMesh=mfld.getMesh();
    let vertProperties=new Float32Array(extractedMesh.vertProperties);
    let triVerts=new Uint32Array(extractedMesh.triVerts);
    mfld.delete();mfld=null;
    if(weldDustMm3>0){
      const r=dropTinyShells(vertProperties,triVerts,weldDustMm3);
      if(r){
        vertProperties=r.vertProperties; triVerts=r.triVerts;
        self.postMessage({type:'diag',diag:{weld:true, tinyShellsDropped:r.dropped, ofShells:r.shells, droppedVolMm3:+r.droppedVol.toExponential(2)}});
      }
    }
    const preTris=triVerts.length/3;
    const simplifyTol=d.simplifyTol||0;
    let msSimplify=0;
    if(simplifyTol>0){
      // Tolerance is in vertex units (mm for shape-clipped exports where
      // d.scale=1.0; world units for cube exports where d.scale=domainMm/10).
      // Convert to mm for the user-facing pill: tol_mm = tol_vert × scale.
      const tolMm = simplifyTol * (d.scale || 1.0);
      // Display in microns when below 0.01mm — easier to read than 0.003
      const tolStr = tolMm < 0.01 ? (tolMm*1000).toFixed(1)+'µm' : tolMm.toFixed(3)+'mm';
      const capStr = d.simplifyCappedByFeature
        ? ' (capped by feature size, '+(d.featMm*1000).toFixed(0)+'µm half-thickness)'
        : '';
      lastStage='meshopt simplify ('+(preTris/1e6).toFixed(2)+'M tris, tol '+tolStr+capStr+')';
      self.postMessage({type:'progress',stage:lastStage+'...'});
      const tSimp=performance.now();
      const r=meshoptSimplify(vertProperties,triVerts,simplifyTol);
      msSimplify=Math.round(performance.now()-tSimp);
      if(r){
        vertProperties=r.positions;
        triVerts=r.indices;
        self.postMessage({type:'progress',stage:'simplified '+(r.preTris/1e6).toFixed(2)+'M → '+(r.postTris/1e6).toFixed(2)+'M tris ('+msSimplify+'ms)'});
      }else{
        self.postMessage({type:'progress',stage:'simplify skipped — meshopt unavailable, keeping '+(preTris/1e6).toFixed(2)+'M tris'});
      }
    }
    const triCount=triVerts.length/3;
    const ms=Math.round(performance.now()-t0);
    if(fieldBake) self.postMessage({type:'diag',diag:{fieldBake:{workers:fieldBake.workers, ms:fieldBake.ms, f32:fieldBake.f32, points:fieldBake.points, cached:fieldBake.stats.hit, direct:fieldBake.stats.miss}}});
    self.postMessage({type:'done',vertProperties:vertProperties.buffer,triVerts:triVerts.buffer,triCount,ms,scale:d.scale,cores:fieldBake?fieldBake.workers:1,msBreakdown:{field:fieldBake?fieldBake.ms:0,levelSet:msLevelSet,simplify:msSimplify,total:ms}},[vertProperties.buffer,triVerts.buffer]);
  }catch(e){
    const base=e.message||String(e);
    const msg=lastStage!=='initializing'?base+' — crashed during: '+lastStage:base;
    self.postMessage({type:'error',message:msg});
  }
};
