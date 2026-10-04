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
    const shapeCtx=(d.mode==='export'&&d.shapeSdfData)?{
      cellSizeMm:d.cellSizeMm,
      bbox:d.bbox,
      // v0.5.0-rc20: pre-baked HU grid from main-thread parallel pool.
      // Optional — absent for non-HU recipes; absent + falls back to legacy
      // serial bakeGridMM if the main-thread bake was skipped or failed.
      // huBbox is the rotation-aware bake bbox (mm); for identity transforms
      // it equals d.bbox. The supplied-grid SDF closure uses it for uvw
      // mapping; legacy serial fallback uses d.bbox.
      huGrid: d.huGridData,
      huGridN: d.huGridN,
      huFieldMin: d.huFieldMin,
      huFieldMax: d.huFieldMax,
      huBbox: d.huBbox
    }:null;
    // Weld-group export carries no top-level recipe (each member has its own in
    // d.bodies); the assembly branch builds its own SDF, so skip this single-
    // recipe build to avoid buildSDF(undefined) dereferencing recipe._previewFieldMin.
    const sdfFn=(d.bodies&&d.bodies.length)?null:buildSDF(d.recipe,shapeCtx);
    let mfld;
    let msLevelSet=0; // shared across branches for the timings pill
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
        const mmToWorld=10/d.cellSizeMm;
        const worldToMm=d.cellSizeMm/10;
        // ── Trilinear sampler over the baked shape SDF grid (in mm) ──────────
        // Outside bbox we fall back to the analytical axis-aligned-box SDF so the
        // field stays Lipschitz-continuous everywhere. Both are in mm, matching
        // the units of the bbox passed to levelSet — so max(scaffold_mm, shape_mm)
        // produces a well-conditioned SDF for marching cubes.
        const sdfArr=new Float32Array(shapeSdfData);
        const N=shapeN;
        const bminX=bbox.mnx,bminY=bbox.mny,bminZ=bbox.mnz;
        const bsizeX=bbox.mxx-bbox.mnx,bsizeY=bbox.mxy-bbox.mny,bsizeZ=bbox.mxz-bbox.mnz;
        const bmaxX=bbox.mxx,bmaxY=bbox.mxy,bmaxZ=bbox.mxz;
        // ── Structure SDF transform setup (v0.5.0 Phase B) ───────────────
        // Defaults to identity (no transform) when d.structXform absent or
        // all-zero, preserving v0.4.x behavior.
        const xf = d.structXform || {rotMat:[1,0,0,0,1,0,0,0,1],spatialOffsetMm:[0,0,0],isoOffsetMm:0};
        const xfRot = xf.rotMat;
        const xfOffMmX = xf.spatialOffsetMm[0], xfOffMmY = xf.spatialOffsetMm[1], xfOffMmZ = xf.spatialOffsetMm[2];
        // ── Iso offset sign convention (canonical, v0.5.0-rc9) ───────────────
        // Worker SDF builders now return canonical NEGATIVE-INSIDE (see the
        // "CANONICAL SDF CONVENTION" block above buildSDF). In that convention,
        // +isoOffsetMm = thicker walls means SUBTRACT iso from the SDF (pushes
        // zero-crossing outward so more of space is inside). The negation to
        // Manifold's positive-inside happens below in wrappedSDF composition,
        // so after the flip the iso term appears as "+ xfIsoMm". Matches the
        // shader: rawToSDF returns negative-inside; setStructureTransform
        // passes -isoOffsetMm to uStructIsoWorld so shader does (sc - iso_w).
        const xfIsoMm = xf.isoOffsetMm;
        // Pivot is shape center in mm.
        const xfPivotMmX = bminX + bsizeX*0.5;
        const xfPivotMmY = bminY + bsizeY*0.5;
        const xfPivotMmZ = bminZ + bsizeZ*0.5;
        // Detect identity to skip transform math in the hot loop (every voxel).
        // Iso offset must also be zero — otherwise the identity-fast-path
        // would silently drop it (the fast-path branch doesn't apply iso).
        const xfIsIdentity = (xfRot[0]===1 && xfRot[4]===1 && xfRot[8]===1 &&
                              xfRot[1]===0 && xfRot[2]===0 && xfRot[3]===0 &&
                              xfRot[5]===0 && xfRot[6]===0 && xfRot[7]===0 &&
                              xfOffMmX===0 && xfOffMmY===0 && xfOffMmZ===0 &&
                              xfIsoMm===0);
        const sampleShapeSDF=function(px,py,pz){
          const u=(px-bminX)/bsizeX, v=(py-bminY)/bsizeY, w=(pz-bminZ)/bsizeZ;
          if(u<0||u>1||v<0||v>1||w<0||w>1){
            const qx=Math.max(bminX-px, px-bmaxX, 0);
            const qy=Math.max(bminY-py, py-bmaxY, 0);
            const qz=Math.max(bminZ-pz, pz-bmaxZ, 0);
            return Math.sqrt(qx*qx+qy*qy+qz*qz);
          }
          // v0.8.2: the grid is baked at voxel CENTRES ((i+0.5)/N), the same
          // convention the preview's texture lookup uses. Reading it as if
          // values sat on voxel corners (u*(N-1)) scaled the shape by N/(N-1)
          // about its centre — ~0.4 mm too big per side on a 50 mm part at Draft.
          const fu=Math.min(Math.max(u*N-0.5,0),N-1), fv=Math.min(Math.max(v*N-0.5,0),N-1), fw=Math.min(Math.max(w*N-0.5,0),N-1);
          const i0=Math.floor(fu)|0, j0=Math.floor(fv)|0, k0=Math.floor(fw)|0;
          const i1=i0+1<N?i0+1:N-1, j1=j0+1<N?j0+1:N-1, k1=k0+1<N?k0+1:N-1;
          const tu=fu-i0, tv=fv-j0, tw=fw-k0;
          const NN=N*N;
          const c000=sdfArr[i0+j0*N+k0*NN], c100=sdfArr[i1+j0*N+k0*NN];
          const c010=sdfArr[i0+j1*N+k0*NN], c110=sdfArr[i1+j1*N+k0*NN];
          const c001=sdfArr[i0+j0*N+k1*NN], c101=sdfArr[i1+j0*N+k1*NN];
          const c011=sdfArr[i0+j1*N+k1*NN], c111=sdfArr[i1+j1*N+k1*NN];
          const c00=c000+(c100-c000)*tu, c10=c010+(c110-c010)*tu;
          const c01=c001+(c101-c001)*tu, c11=c011+(c111-c011)*tu;
          const c0=c00+(c10-c00)*tv, c1=c01+(c11-c01)*tv;
          return c0+(c1-c0)*tw;
        };
        // ── Canonical→Manifold flip + intersection composition ──────────────
        // Builder returns canonical NEGATIVE-INSIDE. Manifold.levelSet wants
        // POSITIVE-INSIDE (positive = "solid" for its marching-cubes extraction).
        // Shape SDF was baked positive-outside (standard SDF), so also negated.
        // Intersection interior = inside BOTH = both operands positive after
        // flip, so combined positive-inside field = min(scaffold, -shape).
        //
        // Iso in canonical: sc_neg_with_iso = sc_neg - xfIsoMm
        // After Manifold flip: sc_pos = -(sc_neg - xfIsoMm) = -sc_neg + xfIsoMm
        // So both flips collapse into: sc_mm = -sc_world*worldToMm + xfIsoMm.
        //
        // Guard against non-finite scaffold values — some recipes can emit NaN
        // or Infinity at edge-case points (trig cancellations, out-of-kernel-
        // support queries in HU). Manifold's marching-cubes sign-test chokes
        // on NaN with "table index out of bounds". Substitute a large negative
        // (firmly outside both fields) so any affected voxel votes "outside".
        // ── Structure transform applied per voxel (v0.5.0 Phase B) ────────
        // Identity case skips transform math for speed. Transform formula:
        //   q_mm = (p_mm - pivot_mm) - offset_mm
        //   local_mm = R^T × q_mm
        //   sc_local_mm = -lattice_eval(local_mm + pivot_mm) + xfIsoMm
        // R^T (xfRot) is column-major; xfRot[c*3+r] reads col c, row r.

        // ── Trim-to-nodes precompute (v0.5.0-rc17) ────────────────────────
        // For beam recipes with d.pruneToNodes set, build a per-tile beam
        // mask. Each beam is "kept" for a tile iff both its endpoints sit
        // at least pruneInsetMm INSIDE the shape. Endpoints are computed in
        // shape mm-space, accounting for the structure transform so a
        // rotated lattice gets pruned against the shape correctly.
        let activeSdfFn = sdfFn;
        if(d.pruneToNodes && SDF_FAMILIES[d.recipe.family] && SDF_FAMILIES[d.recipe.family].trimToNodes){
          const beamsArr = d.recipe.json.beams || [];
          const geomP = d.recipe.json.geometry || {};
          // v0.5.0-rc22/25: schema-aware radius and pitch resolution.
          // New schema (sxyzP resolved from scale_xyz OR cell_scale_x/y/z,
          // plus cell): radii in mm directly, per-axis pitch.
          // Old schema: scalar radius cell-local, scalar pitch.
          let sxyzP=null;
          if(Array.isArray(geomP.scale_xyz)&&geomP.scale_xyz.length===3
             &&isFinite(geomP.scale_xyz[0])&&isFinite(geomP.scale_xyz[1])&&isFinite(geomP.scale_xyz[2])
             &&geomP.scale_xyz[0]>0&&geomP.scale_xyz[1]>0&&geomP.scale_xyz[2]>0){
            sxyzP=geomP.scale_xyz;
          } else if(typeof geomP.cell_scale_x==='number'&&geomP.cell_scale_x>0
                 && typeof geomP.cell_scale_y==='number'&&geomP.cell_scale_y>0
                 && typeof geomP.cell_scale_z==='number'&&geomP.cell_scale_z>0){
            sxyzP=[geomP.cell_scale_x, geomP.cell_scale_y, geomP.cell_scale_z];
          }
          const cellMmP = geomP.cell;
          const hasScaleXYZP = sxyzP!==null;
          const hasCellP = (typeof cellMmP==='number')&&isFinite(cellMmP)&&cellMmP>0;
          const isNewP = hasScaleXYZP && hasCellP;
          // Effective worst-case radius in mm — used for inset auto-clamping.
          // New schema: max over per-axis radii (already in mm).
          // Old schema: scalar radius (cell-local) × cellSizeMm/2.
          // v0.8.2: physical radius at the user's cell size (was: new-schema
          // radius_x not scaled by cellSizeMm/cell; old schema ignored cell_scale).
          const radiusMm = beamStrutRadiusMm(geomP, d.cellSizeMm);
          // v0.5.0-rc18: auto-clamp the inset so it's never tighter than the
          // shape SDF discretization. Trilinear interpolation can mis-classify
          // endpoints by up to ~½ voxel; using full voxel size as the floor
          // gives a safety margin that covers high-curvature regions where
          // the boundary error grows. Multiplier (1.0–2.0) lets the user
          // ratchet up further for shapes with very fine surface features.
          const insetMult = (typeof d.pruneInsetMult==='number'&&d.pruneInsetMult>=1.0&&d.pruneInsetMult<=2.0) ? d.pruneInsetMult : 1.0;
          const voxelSizeMm = Math.max(bsizeX, bsizeY, bsizeZ) / shapeN;
          const insetCandidate = voxelSizeMm * insetMult;
          const insetMm = Math.max(radiusMm, insetCandidate);
          const insetReason = (insetMm===radiusMm) ? 'radius'
                             : ('voxel × '+insetMult.toFixed(1)+' = '+insetCandidate.toFixed(3)+' mm');
          self.postMessage({type:'progress',stage:'trim-to-nodes inset: '+insetMm.toFixed(3)+' mm ('+insetReason+', voxel='+voxelSizeMm.toFixed(3)+' mm)'});
          // Lattice mm pitch per axis — must match buildBeamSDF's W2Lx/y/z math.
          // New schema: pitchMm_i = cellSizeMm × scale_xyz[i] / cell.
          // Old schema: pitchMm = cellSizeMm / cell_scale (scalar, isotropic).
          let pitchMmX, pitchMmY, pitchMmZ;
          if(isNewP){
            pitchMmX = d.cellSizeMm * sxyzP[0] / cellMmP;
            pitchMmY = d.cellSizeMm * sxyzP[1] / cellMmP;
            pitchMmZ = d.cellSizeMm * sxyzP[2] / cellMmP;
          } else {
            const cellScaleP = (typeof geomP.cell_scale==='number'&&geomP.cell_scale>0) ? geomP.cell_scale : 1;
            pitchMmX = pitchMmY = pitchMmZ = d.cellSizeMm / cellScaleP;
          }
          // Tile centers in lattice-mm sit at integer multiples of pitchMm
          // (origin-centered, matching the wrap math: tile 0 has center at 0).
          // Tile range covering bbox in lattice-mm. We need to invert the
          // structure transform on the bbox corners to see what lattice-mm
          // range to pre-compute over.
          // For identity transform, lattice-mm == shape-mm.
          // For non-identity, we approximate by checking the 8 bbox corners
          // mapped through the inverse transform, then take the bounding
          // tile-range. This is conservative (may include a few extra tiles
          // outside the actual sweep) but correct.
          let lminX=Infinity,lminY=Infinity,lminZ=Infinity;
          let lmaxX=-Infinity,lmaxY=-Infinity,lmaxZ=-Infinity;
          const cornersShape=[
            [bminX,bminY,bminZ],[bmaxX,bminY,bminZ],[bminX,bmaxY,bminZ],[bmaxX,bmaxY,bminZ],
            [bminX,bminY,bmaxZ],[bmaxX,bminY,bmaxZ],[bminX,bmaxY,bmaxZ],[bmaxX,bmaxY,bmaxZ]
          ];
          for(const c of cornersShape){
            // shape-mm → lattice-mm: same transform the wrappedSDF applies.
            const qx=c[0]-xfPivotMmX-xfOffMmX, qy=c[1]-xfPivotMmY-xfOffMmY, qz=c[2]-xfPivotMmZ-xfOffMmZ;
            const lx=xfRot[0]*qx+xfRot[3]*qy+xfRot[6]*qz;
            const ly=xfRot[1]*qx+xfRot[4]*qy+xfRot[7]*qz;
            const lz=xfRot[2]*qx+xfRot[5]*qy+xfRot[8]*qz;
            const lmmX=lx+xfPivotMmX, lmmY=ly+xfPivotMmY, lmmZ=lz+xfPivotMmZ;
            if(lmmX<lminX)lminX=lmmX; if(lmmX>lmaxX)lmaxX=lmmX;
            if(lmmY<lminY)lminY=lmmY; if(lmmY>lmaxY)lmaxY=lmmY;
            if(lmmZ<lminZ)lminZ=lmmZ; if(lmmZ>lmaxZ)lmaxZ=lmmZ;
          }
          // Tile_x = round(lattice_mm_x / pitchMmX). Range floor/ceil
          // with one-tile padding so neighbor halo lookups don't miss edges.
          const tXMin=Math.floor(lminX/pitchMmX-0.5)-1;
          const tXMax=Math.floor(lmaxX/pitchMmX+0.5)+1;
          const tYMin=Math.floor(lminY/pitchMmY-0.5)-1;
          const tYMax=Math.floor(lmaxY/pitchMmY+0.5)+1;
          const tZMin=Math.floor(lminZ/pitchMmZ-0.5)-1;
          const tZMax=Math.floor(lmaxZ/pitchMmZ+0.5)+1;
          const NX=tXMax-tXMin+1, NY=tYMax-tYMin+1, NZ=tZMax-tZMin+1;
          const BC=beamsArr.length;
          const totalTiles=NX*NY*NZ;
          // Sanity cap: refuse pathological mask sizes (would indicate misuse).
          // 100³ tiles × 200 beams ≈ 200 MB, well over what we'd ever want.
          const maskBytes=totalTiles*BC;
          if(maskBytes>64*1024*1024){
            self.postMessage({type:'progress',stage:'trim-to-nodes mask too large ('+(maskBytes/1e6).toFixed(0)+' MB) — skipping prune'});
          } else {
            self.postMessage({type:'progress',stage:'computing trim-to-nodes mask ('+totalTiles.toLocaleString()+' tiles × '+BC+' beams)...'});
            const mask=new Uint8Array(maskBytes);
            // Forward transform: lattice-mm → shape-mm (inverse of wrappedSDF math).
            // q = R × l ; shape = q + pivot + offset.
            // R = transpose of R^T (xfRot stored as R^T col-major).
            // Forward: shape_mm[i] = sum_j R[i,j] × l_centered[j] + pivot_i + offset_i
            // Where R[i,j] = R^T[j,i] = xfRot[i*3+j].
            const fwd=(lmmX,lmmY,lmmZ)=>{
              const lx=lmmX-xfPivotMmX, ly=lmmY-xfPivotMmY, lz=lmmZ-xfPivotMmZ;
              const sx=xfRot[0]*lx+xfRot[1]*ly+xfRot[2]*lz;
              const sy=xfRot[3]*lx+xfRot[4]*ly+xfRot[5]*lz;
              const sz=xfRot[6]*lx+xfRot[7]*ly+xfRot[8]*lz;
              return [sx+xfPivotMmX+xfOffMmX, sy+xfPivotMmY+xfOffMmY, sz+xfPivotMmZ+xfOffMmZ];
            };
            const halfPitchX=pitchMmX*0.5, halfPitchY=pitchMmY*0.5, halfPitchZ=pitchMmZ*0.5;
            let kept=0;
            for(let iz=0;iz<NZ;iz++){
              const tz=iz+tZMin;
              const cz_lattice=tz*pitchMmZ; // tile center in lattice-mm
              for(let iy=0;iy<NY;iy++){
                const ty=iy+tYMin;
                const cy_lattice=ty*pitchMmY;
                for(let ix=0;ix<NX;ix++){
                  const tx=ix+tXMin;
                  const cx_lattice=tx*pitchMmX;
                  const tileBase=((iz*NY+iy)*NX+ix)*BC;
                  for(let bi=0;bi<BC;bi++){
                    const b=beamsArr[bi];
                    // Endpoint A in lattice-mm (cell-local [-1,+1] → mm), per-axis pitch
                    const amx=cx_lattice+b[0]*halfPitchX;
                    const amy=cy_lattice+b[1]*halfPitchY;
                    const amz=cz_lattice+b[2]*halfPitchZ;
                    // Endpoint B in lattice-mm
                    const bmx=cx_lattice+b[3]*halfPitchX;
                    const bmy=cy_lattice+b[4]*halfPitchY;
                    const bmz=cz_lattice+b[5]*halfPitchZ;
                    // Forward-transform to shape-mm
                    const aShape=fwd(amx,amy,amz);
                    const bShape=fwd(bmx,bmy,bmz);
                    // Sample shape SDF at both endpoints. Inside-with-inset:
                    // sh_sdf <= -insetMm.
                    const aInside=sampleShapeSDF(aShape[0],aShape[1],aShape[2])<=-insetMm;
                    const bInside=sampleShapeSDF(bShape[0],bShape[1],bShape[2])<=-insetMm;
                    if(aInside && bInside){ mask[tileBase+bi]=1; kept++; }
                  }
                }
              }
            }
            const totalCandidates=totalTiles*BC;
            self.postMessage({type:'progress',stage:'trim-to-nodes: '+kept.toLocaleString()+' / '+totalCandidates.toLocaleString()+' beams kept ('+(100*kept/Math.max(1,totalCandidates)).toFixed(1)+'%)'});
            // Override sdfFn with mask-aware version
            activeSdfFn = buildBeamSDF(d.recipe.json, {mask,tXMin,tYMin,tZMin,NX,NY,NZ});
          }
        }
        // ── Move 1 (v0.5.0-rc19): SDF-eval short-circuit ─────────────────────
        // wrappedSDF is called ~50M+ times during MC; ~70% of that time is the
        // lattice eval (36+ capsule SDFs per voxel). For voxels well outside
        // the shape, min(sc_mm, sh_mm) is dominated by sh_mm and Manifold needs
        // no surface there — so we can skip the lattice eval entirely.
        //
        // Threshold = 2× current pass's voxel edge. Since sampleShapeSDF is
        // Lipschitz-1 (true SDF), adjacent voxels differ by at most one edge,
        // so a voxel at sh_mm < -2*edge guarantees no sign-crossing within
        // its neighbors → no MC iso surface there.
        //
        // Coarse and fine passes use different edge sizes; the variable
        // currentVoxelEdge is updated before each levelSet call below.
        let currentVoxelEdge = relEdgeMm;
        const wrappedSDF = xfIsIdentity
          ? p=>{
              const sh_mm=-sampleShapeSDF(p[0],p[1],p[2]);
              // Far outside shape — skip lattice eval, return sh_mm directly.
              if(sh_mm < -2*currentVoxelEdge) return sh_mm;
              const sc_world=activeSdfFn([p[0]*mmToWorld,p[1]*mmToWorld,p[2]*mmToWorld]);
              const sc_mm=-sc_world*worldToMm;  // canonical neg-inside → Manifold pos-inside
              if(!(sc_mm>-1e20&&sc_mm<1e20))return -1e6;
              return sc_mm<sh_mm?sc_mm:sh_mm;
            }
          : p=>{
              const sh_mm = -sampleShapeSDF(p[0],p[1],p[2]);
              // Far outside shape — skip lattice + transform math.
              if(sh_mm < -2*currentVoxelEdge) return sh_mm;
              // Translate to pivot, subtract spatial offset.
              const qx = p[0] - xfPivotMmX - xfOffMmX;
              const qy = p[1] - xfPivotMmY - xfOffMmY;
              const qz = p[2] - xfPivotMmZ - xfOffMmZ;
              // Apply inverse rotation (R^T): col-major, so col c row r = xfRot[c*3+r].
              // R^T × q = sum_c (xfRot col c) * q[c] — i.e. dot of q with each row of R.
              // Actually: (M × v)[i] = sum_j M[i,j] × v[j], where M[i,j] = M_colmajor[j*3+i].
              // So (xfRot × q)[i] = sum_j xfRot[j*3+i] * q[j].
              const lx = xfRot[0]*qx + xfRot[3]*qy + xfRot[6]*qz;
              const ly = xfRot[1]*qx + xfRot[4]*qy + xfRot[7]*qz;
              const lz = xfRot[2]*qx + xfRot[5]*qy + xfRot[8]*qz;
              // Translate back to world origin so the periodic lattice tiles
              // around the shape center.
              const wx_mm = lx + xfPivotMmX;
              const wy_mm = ly + xfPivotMmY;
              const wz_mm = lz + xfPivotMmZ;
              const sc_world = activeSdfFn([wx_mm*mmToWorld, wy_mm*mmToWorld, wz_mm*mmToWorld]);
              const sc_mm = -sc_world*worldToMm + xfIsoMm;  // canonical neg-inside → Manifold pos-inside, + iso
              if(!(sc_mm>-1e20&&sc_mm<1e20))return -1e6;
              return sc_mm<sh_mm?sc_mm:sh_mm;
            };
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
      currentVoxelEdge = eCoarseEdge; // v0.5.0-rc19: short-circuit threshold tracks pass edge
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
      self.postMessage({type:'progress',stage:lastStage+'...'});
      const tLevelSet=performance.now();
      currentVoxelEdge = relEdgeMm; // v0.5.0-rc19: short-circuit threshold tracks pass edge
      mfld=safeLevelSet(wrappedSDF,{min:[eInner.mnx,eInner.mny,eInner.mnz],max:[eInner.mxx,eInner.mxy,eInner.mxz]},relEdgeMm,'fine level set ('+relEdgeMm.toFixed(3)+'mm, ~'+fineVox+'M voxels)');
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
        self.postMessage({type:'progress',stage:'level set ('+d.edgeWorld.toFixed(3)+' world edge)...'});
        const tLevelSet=performance.now();
        mfld=safeLevelSet(p=>-sdfFn(p),{min:[-5,-5,-5],max:[5,5,5]},d.edgeWorld,'cube export level set');
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
    self.postMessage({type:'done',vertProperties:vertProperties.buffer,triVerts:triVerts.buffer,triCount,ms,scale:d.scale,msBreakdown:{levelSet:msLevelSet,simplify:msSimplify,total:ms}},[vertProperties.buffer,triVerts.buffer]);
  }catch(e){
    const base=e.message||String(e);
    const msg=lastStage!=='initializing'?base+' — crashed during: '+lastStage:base;
    self.postMessage({type:'error',message:msg});
  }
};
