/* F13LD.mesh · worker/m22-sdf-grain.js — Grain SDF builder + HU domain-spanning helpers. */
// ── HU domain-spanning helpers (shape mode) ──────────────────────────────────
function buildHUKernelsMM(params,bbox,cellSizeMm){
  // Build the design-cell kernels in [-π,π]³ — same seed, same N, same RNG
  // sequence as cube-mode preview. This guarantees the field pattern tiles.
  var designK=buildHUKernels(params);
  var TP=2*Math.PI,scale=cellSizeMm/TP;
  var aspect=params.huAspect||4,bw=params.huWidth||.04;
  // Scale kernel Gaussian widths from design-cell→mm
  var a_mm=designK.length>0?designK[0].a*scale:(bw*aspect*.5*cellSizeMm);
  var b1_mm=designK.length>0?designK[0].b1*scale:(bw*.5/Math.sqrt(params.huEll||1)*cellSizeMm);
  var b2_mm=designK.length>0?designK[0].b2*scale:(bw*.5*Math.sqrt(params.huEll||1)*cellSizeMm);
  var p_=designK.cross||2,m_=designK.sharp||1,Rc_=Math.pow(12.25,1/m_),reach=Math.max(a_mm*Math.sqrt(Rc_),b1_mm*Math.pow(Rc_,1/p_),b2_mm*Math.pow(Rc_,1/p_));
  // Tile grid: how many cells span the bbox, +1 cell padding per side
  // for Gaussian bleed across cell boundaries
  // v0.8.2: tiles are anchored at -cellSizeMm/2 — the preview cell's origin
  // (world -5) — not at the bake box corner. The old bbox anchor shifted the
  // pattern relative to preview, and moved it again whenever rotation or
  // offset changed the rotation-aware bake box.
  var A0=-cellSizeMm*0.5;
  var t0x=Math.floor((bbox.mnx-A0)/cellSizeMm),t0y=Math.floor((bbox.mny-A0)/cellSizeMm),t0z=Math.floor((bbox.mnz-A0)/cellSizeMm);
  var nTx=Math.ceil((bbox.mxx-A0)/cellSizeMm)-t0x,nTy=Math.ceil((bbox.mxy-A0)/cellSizeMm)-t0y,nTz=Math.ceil((bbox.mxz-A0)/cellSizeMm)-t0z;
  var ox=A0+t0x*cellSizeMm,oy=A0+t0y*cellSizeMm,oz=A0+t0z*cellSizeMm;
  // Padding: 2 cell minimum for Gaussian bleed across periodic cell boundaries
  // (preview) and export margin; more if kernel reach exceeds cell size
  var pad=Math.max(2,Math.ceil(reach/cellSizeMm));
  var kernels=[];
  for(var tz=-pad;tz<nTz+pad;tz++){
    for(var ty=-pad;ty<nTy+pad;ty++){
      for(var tx=-pad;tx<nTx+pad;tx++){
        for(var ki=0;ki<designK.length;ki++){
          var dk=designK[ki];
          // Map kernel position from [-π,π] → [0,cellSizeMm] then offset by tile
          kernels.push({
            px:ox+(dk.px+Math.PI)/TP*cellSizeMm+tx*cellSizeMm,
            py:oy+(dk.py+Math.PI)/TP*cellSizeMm+ty*cellSizeMm,
            pz:oz+(dk.pz+Math.PI)/TP*cellSizeMm+tz*cellSizeMm,
            tx:dk.tx,ty:dk.ty,tz:dk.tz,
            n1x:dk.n1x,n1y:dk.n1y,n1z:dk.n1z,
            n2x:dk.n2x,n2y:dk.n2y,n2z:dk.n2z,
            a:a_mm,b1:b1_mm,b2:b2_mm});
        }
      }
    }
  }
  // ── Spatial hash for O(1) kernel queries ────────────────────────────────
  var cutoff=reach;
  var cs=Math.max(cutoff,1e-6);
  var hmnx=ox-pad*cellSizeMm,hmny=oy-pad*cellSizeMm,hmnz=oz-pad*cellSizeMm;
  var hmxx=ox+(nTx+pad)*cellSizeMm,hmxy=oy+(nTy+pad)*cellSizeMm,hmxz=oz+(nTz+pad)*cellSizeMm;
  var hddx=hmxx-hmnx,hddy=hmxy-hmny,hddz=hmxz-hmnz;
  var nx=Math.max(1,Math.ceil(hddx/cs)),ny=Math.max(1,Math.ceil(hddy/cs)),nz=Math.max(1,Math.ceil(hddz/cs));
  var buckets=new Array(nx*ny*nz);
  for(var bi=0;bi<buckets.length;bi++)buckets[bi]=null;
  for(var ki2=0;ki2<kernels.length;ki2++){
    var kk=kernels[ki2];
    var hx=Math.max(0,Math.min(nx-1,Math.floor((kk.px-hmnx)/cs)));
    var hy=Math.max(0,Math.min(ny-1,Math.floor((kk.py-hmny)/cs)));
    var hz=Math.max(0,Math.min(nz-1,Math.floor((kk.pz-hmnz)/cs)));
    var bIdx=hx+hy*nx+hz*nx*ny;
    if(buckets[bIdx]===null)buckets[bIdx]=[];
    buckets[bIdx].push(ki2);
  }
  kernels.cross=designK.cross;kernels.sharp=designK.sharp;kernels.blend=designK.blend;kernels.hash={buckets:buckets,nx:nx,ny:ny,nz:nz,mnx:hmnx,mny:hmny,mnz:hmnz,cs:cs};
  return kernels;
}
function evalHUFieldMM(kernels,x,y,z){
  var h=kernels.hash,p=kernels.cross||2,m=kernels.sharp||1,P=kernels.blend||1,rnd=(p===2),shp=(m===1),bl=(P===1);
  // Fallback to linear scan if hash missing (defensive; buildHUKernelsMM always attaches).
  if(!h){
    var s=0;
    for(var i=0;i<kernels.length;i++){
      var k=kernels[i],dx=x-k.px,dy=y-k.py,dz=z-k.pz;
      var dt=dx*k.tx+dy*k.ty+dz*k.tz,dn1=dx*k.n1x+dy*k.n1y+dz*k.n1z,dn2=dx*k.n2x+dy*k.n2y+dz*k.n2z;
      var u=dt/k.a,w1=dn1/k.b1,w2=dn2/k.b2,R=u*u+(rnd?(w1*w1+w2*w2):(Math.pow(Math.abs(w1),p)+Math.pow(Math.abs(w2),p))),Rm=shp?R:Math.pow(R,m);s+=bl?Math.exp(-Rm):Math.exp(-P*Rm);
    }
    if(!bl)s=Math.pow(s,1/P);return s-0.3;
  }
  // Hashed path: 3×3×3 neighborhood of the query's hash cell covers all
  // kernels within cutoff distance (since cs = cutoff).
  var cs=h.cs,nx=h.nx,ny=h.ny,nz=h.nz,nxny=nx*ny;
  var ix=Math.floor((x-h.mnx)/cs),iy=Math.floor((y-h.mny)/cs),iz=Math.floor((z-h.mnz)/cs);
  var ix0=ix-1<0?0:ix-1,ix1=ix+1>=nx?nx-1:ix+1;
  var iy0=iy-1<0?0:iy-1,iy1=iy+1>=ny?ny-1:iy+1;
  var iz0=iz-1<0?0:iz-1,iz1=iz+1>=nz?nz-1:iz+1;
  if(ix1<ix0||iy1<iy0||iz1<iz0)return -0.3;  // query well outside bbox
  var sum=0;
  for(var jz=iz0;jz<=iz1;jz++)for(var jy=iy0;jy<=iy1;jy++)for(var jx=ix0;jx<=ix1;jx++){
    var bucket=h.buckets[jx+jy*nx+jz*nxny];
    if(bucket===null)continue;
    for(var bi=0;bi<bucket.length;bi++){
      var k=kernels[bucket[bi]];
      var dx=x-k.px,dy=y-k.py,dz=z-k.pz;
      var dt=dx*k.tx+dy*k.ty+dz*k.tz,dn1=dx*k.n1x+dy*k.n1y+dz*k.n1z,dn2=dx*k.n2x+dy*k.n2y+dz*k.n2z;
      var u=dt/k.a,w1=dn1/k.b1,w2=dn2/k.b2,R=u*u+(rnd?(w1*w1+w2*w2):(Math.pow(Math.abs(w1),p)+Math.pow(Math.abs(w2),p))),Rm=shp?R:Math.pow(R,m);sum+=bl?Math.exp(-Rm):Math.exp(-P*Rm);
    }
  }
  if(!bl)sum=Math.pow(sum,1/P);return sum-0.3;
}
function bakeGridMM(evalFn,N,bbox){
  var ddx=bbox.mxx-bbox.mnx,ddy=bbox.mxy-bbox.mny,ddz=bbox.mxz-bbox.mnz;
  var grid=new Float32Array(N*N*N);
  for(var iz=0;iz<N;iz++)for(var iy=0;iy<N;iy++)for(var ix=0;ix<N;ix++){
    grid[ix+iy*N+iz*N*N]=evalFn(bbox.mnx+(ix+0.5)/N*ddx,bbox.mny+(iy+0.5)/N*ddy,bbox.mnz+(iz+0.5)/N*ddz);
  }
  return grid;
}

// v0.8.3: one place that turns a grain recipe's field block into kernel/wave
// parameters (was duplicated here and in m90's raw preview bake). Explicit
// zeros are kept (κ = 0 isotropic, seed 0) as in F13LD.grain.
function grainParamsFromField(f){
  let dirTheta=0,dirPhi=0;
  if(f.dir_mode==='single'&&f.principal_direction){
    const[mx,my,mz]=f.principal_direction;
    dirTheta=Math.acos(Math.max(-1,Math.min(1,mz)))*180/Math.PI;
    dirPhi=Math.atan2(my,mx)*180/Math.PI;
  }
  return {fieldType:f.type,nWaves:f.n_waves||48,kappa:f.kappa??6,frequency:f.frequency||.27,rngSeed:f.rng_seed??42,
    dirMode:f.dir_mode||'single',dirTheta,dirPhi,wX:f.ortho_weights?.[0]??.33,wY:f.ortho_weights?.[1]??.33,wZ:f.ortho_weights?.[2]??.34,
    grfSigma:f.grf_sigma||.45,huN:f.hu_n||80,huAspect:f.hu_aspect||4,huWidth:f.hu_width||.04,huCross:f.hu_cross||2,
    huSharp:f.hu_sharp||1,huBlend:f.hu_blend||1,huEll:f.hu_ell||1};
}
// v0.8.3: reaction-diffusion grids are deterministic in their parameters, so
// keep the last few per worker (weld groups with several RD members, repeated
// builds) instead of re-running the 48³ simulation each time.
const _rdGridCache=new Map();
function cachedRDGrid(rdSys,rdParams,N){
  const key=rdSys+'|'+N+'|'+JSON.stringify(rdParams);
  let g=_rdGridCache.get(key);
  if(!g){
    g = rdSys==='brusselator'  ? buildBrusselator(rdParams,N)
      : rdSys==='schnakenberg' ? buildSchnakenberg(rdParams,N)
      :                          buildGrayScott(rdParams,N);
    _rdGridCache.set(key,g);
    if(_rdGridCache.size>4) _rdGridCache.delete(_rdGridCache.keys().next().value);
  }
  return g;
}
function buildGrainSDF(json,shapeCtx,normOverride,opts){
  const f=json.field,g=json.geometry||{};
  const center=g.center??0,halfW=g.half_width??.15,topo=g.topology||'sheet';
  // Canonical SDF topology application — used by RD path (which has no
  // normalization). HU-shape, HU-cube, and wave/GRF paths use inline
  // cN/hN transforms to map center/halfW from raw→normalized space.
  // Returns negative-inside matching design-tool shader at
  // index_-_Grain.html:706 and index_-_Noise.html:1053.
  //   sheet: negative where |raw-center| < halfW (thin wall band)
  //   half:  halfInvert=false → negative where raw > center
  //          halfInvert=true  → negative where raw < center
  //   solid: negative where |raw-center| > halfW (bulk, complement of sheet)
  const hi=!!g.half_invert;
  const applyTopology = (raw) => {
    if(topo==='half')  return hi?(raw-center):(center-raw);
    if(topo==='solid') return halfW-Math.abs(raw-center);
    return Math.abs(raw-center)-halfW;
  };

  // ── Reaction-diffusion ─────────────────────────────────────────────
  // v0.5.0-rc15: rd_Dv and rd_system now parsed from JSON. rd_system selects
  // among Gray-Scott / Brusselator / Schnakenberg builders. Wire-format key
  // names rd_F / rd_k carry different meanings per system (handoff §1):
  //   gray-scott     → F (feed) / k (kill)
  //   brusselator    → a / b
  //   schnakenberg   → a / b
  // Missing rd_system defaults to "grayscott" for backward compat with pre-
  // v0.9.1 grain exports.
  if(f.type==='reactiondiffusion'){
    const rdSys = f.rd_system || 'grayscott';
    const rdParams={
      rdF:f.rd_F!==undefined?f.rd_F:0.030,
      rdK:f.rd_k!==undefined?f.rd_k:0.057,
      rdDu:f.rd_Du!==undefined?f.rd_Du:0.14,
      rdDv:(f.rd_Dv!==undefined?f.rd_Dv:null),
      rdSteps:f.rd_steps||3000,
      rngSeed:f.rng_seed??42
    };
    const tile=f.rd_tile||1;
    let N_rd,getUVW;
    // v0.8.2: one cell mapping for cube and shape mode. The preview tiles the
    // world [-5,5] cell (GL_REPEAT), i.e. cells start at -cellSizeMm/2 in mm.
    // Shape-mode export used to start cells at the part's bounding-box corner,
    // shifting the pattern by (bbox.min + cell/2) mod cell relative to preview.
    // p is in world units (mm·10/cellSizeMm) in both modes, so the cube mapping
    // is exactly the preview's.
    N_rd=48;
    const frac=x=>x-Math.floor(x);
    getUVW=p=>[frac((p[0]/10+0.5)*tile),frac((p[1]/10+0.5)*tile),frac((p[2]/10+0.5)*tile)];
    const grid = cachedRDGrid(rdSys,rdParams,N_rd);
    return p=>{
      const[u,v,w]=getUVW(p);
      const raw=evalRDField(grid,N_rd,u,v,w);
      return applyTopology(raw);
    };
  }

  // ── Wave / kernel branch ──────────────────────────────────────────────
  const params=grainParamsFromField(f);
  const isHU=f.type==='hyperuniform';

  // ── HU shape mode: full-domain kernel field baked to a grid ───────────
  // Kernels are distributed throughout the bounding volume (not just one cell).
  // A pre-baked grid makes levelSet evaluation O(1) per sample after setup.
  // v0.5.0-rc20: when shapeCtx.huGrid is supplied (parallel main-thread bake),
  // skip the in-worker serial bakeGridMM and use the supplied grid directly.
  // Falls through to the legacy serial bake when no grid is supplied (e.g.
  // main-thread bake skipped or the worker pool failed gracefully). The
  // supplied-grid path uses shapeCtx.huBbox (rotation-aware bake bbox) for
  // uvw mapping so rotated queries land inside the baked region; the legacy
  // path falls back to the shape bbox (rotation+HU was broken on that path
  // pre-rc20 anyway, and it's defensive code that's unreachable in normal
  // flow now that the main-thread bake is always populated for HU recipes).
  if(isHU&&shapeCtx){
    const {cellSizeMm,bbox}=shapeCtx;
    let huGrid, N_hu, prebakedFieldMin, prebakedFieldMax, gridBbox;
    if(shapeCtx.huGrid && shapeCtx.huGridN){
      huGrid=new Float32Array(shapeCtx.huGrid);
      N_hu=shapeCtx.huGridN;
      prebakedFieldMin=shapeCtx.huFieldMin;
      prebakedFieldMax=shapeCtx.huFieldMax;
      gridBbox=shapeCtx.huBbox || bbox; // huBbox absent → legacy callers, fall back
      self.postMessage({type:'progress',stage:'using pre-baked HU field ('+N_hu+'\u00b3 grid)'});
    } else {
      // Legacy serial in-worker bake (defensive; unreachable in normal flow).
      const lddx=bbox.mxx-bbox.mnx, lddy=bbox.mxy-bbox.mny, lddz=bbox.mxz-bbox.mnz;
      const maxCells=Math.max(lddx,lddy,lddz)/cellSizeMm;
      N_hu=Math.max(32,Math.ceil(32*maxCells));
      const mmKernels=buildHUKernelsMM(params,bbox,cellSizeMm);
      self.postMessage({type:'progress',stage:'pre-baking HU field ('+N_hu+'\u00b3 grid, '+mmKernels.length+' kernels)...'});
      huGrid=bakeGridMM((x,y,z)=>evalHUFieldMM(mmKernels,x,y,z),N_hu,bbox);
      gridBbox=bbox;
    }
    const gddx=gridBbox.mxx-gridBbox.mnx;
    const gddy=gridBbox.mxy-gridBbox.mny;
    const gddz=gridBbox.mxz-gridBbox.mnz;
    // ── Field normalization (rc14: prefer preview override, else pre-baked
    // range from main-thread bake, else scan grid here) ────────────────────
    let hfMid,hfHalfR;
    if(normOverride){
      hfMid=(normOverride.fieldMin+normOverride.fieldMax)*0.5;
      hfHalfR=Math.max((normOverride.fieldMax-normOverride.fieldMin)*0.5,1e-6);
    } else if(prebakedFieldMin!==undefined && prebakedFieldMax!==undefined){
      hfMid=(prebakedFieldMin+prebakedFieldMax)*0.5;
      hfHalfR=Math.max((prebakedFieldMax-prebakedFieldMin)*0.5,1e-6);
    } else {
      let hmn=Infinity,hmx=-Infinity;
      for(let i=0;i<huGrid.length;i++){const v=huGrid[i];if(v<hmn)hmn=v;if(v>hmx)hmx=v;}
      hfMid=(hmn+hmx)*0.5;
      hfHalfR=Math.max((hmx-hmn)*0.5,1e-6);
    }
    const c01=v=>v<0?0:v>1?1:v;
    // Transform center/halfW from raw→normalized space (see cube-mode comment)
    const cN=(center-hfMid)/hfHalfR,hN=halfW/hfHalfR;
    return p=>{
      const u=c01((p[0]*cellSizeMm/10-gridBbox.mnx)/gddx);
      const v=c01((p[1]*cellSizeMm/10-gridBbox.mny)/gddy);
      const w=c01((p[2]*cellSizeMm/10-gridBbox.mnz)/gddz);
      const raw=sampleCenteredGrid(huGrid,N_hu,u,v,w);   // v0.8.2: centre convention, no wrap
      const norm=(raw-hfMid)/hfHalfR;
      if(topo==='half') return hi?(norm-cN):(cN-norm);
      if(topo==='solid') return hN-Math.abs(norm-cN);
      return Math.abs(norm-cN)-hN;
    };
  }

  // ── Cube mode / wave+GRF (spinodoid/GRF extend to infinity naturally) ──
  const waves=isHU?null:(f.type==='gaussian'?buildGRFWaves(params):buildSpinodoidWaves(params));
  const kernels=isHU?buildHUKernels(params):null;
  const PI5=Math.PI/5;
  // ── Field normalization (rc14: prefer preview override, else pre-scan) ──
  // Preview's bakeRaw=true path caches fieldMin/Max on the recipe. Using
  // those exactly matches preview's normalization — no drift by construction.
  // Fallback: 16³ pre-scan over world [-5,5] (matches runtime query domain).
  // No padding — design tools don't pad, and the rc10 5% padding was a
  // compensation for an earlier mis-sampled grid that rc14 supersedes.
  // v0.8.2: periodic HU for weld members (min-image wrap, same evaluator the
  // shape-mode preview bakes with); cube mode keeps the single-cell field.
  const huEvalFn = (opts&&opts.periodic) ? evalHUFieldPeriodic : evalHUField;
  const evalRaw = isHU
    ? (px,py,pz)=>huEvalFn(kernels,0.5+px/10,0.5+py/10,0.5+pz/10)
    : (px,py,pz)=>evalField(waves,px*PI5,py*PI5,pz*PI5,null);
  let fieldMid,fieldHalfR;
  if(normOverride){
    fieldMid=(normOverride.fieldMin+normOverride.fieldMax)*0.5;
    fieldHalfR=Math.max((normOverride.fieldMax-normOverride.fieldMin)*0.5,1e-6);
  } else {
    const PP=16;let mnF=Infinity,mxF=-Infinity;
    for(let zi=0;zi<PP;zi++)for(let yi=0;yi<PP;yi++)for(let xi=0;xi<PP;xi++){
      const px=(xi/(PP-1))*10-5, py=(yi/(PP-1))*10-5, pz=(zi/(PP-1))*10-5;
      const v=evalRaw(px,py,pz);
      if(v<mnF)mnF=v;if(v>mxF)mxF=v;
    }
    fieldMid=(mnF+mxF)*0.5;
    fieldHalfR=Math.max((mxF-mnF)*0.5,1e-6);
  }
  // Transform center/halfW from raw→normalized space for grain fields.
  // Grain design tool applies topology in raw field units; mesh normalizes
  // to [-1,1] first, so we must map center/halfW into that same space.
  const cN=(center-fieldMid)/fieldHalfR,hN=halfW/fieldHalfR;
  return p=>{
    const raw=evalRaw(p[0],p[1],p[2]);
    const norm=(raw-fieldMid)/fieldHalfR;
    if(topo==='half') return hi?(norm-cN):(cN-norm);
    if(topo==='solid') return hN-Math.abs(norm-cN);
    return Math.abs(norm-cN)-hN;
  };
}

// ── Registry (v0.9.0) ───────────────────────────────────────────────────────
registerSDF('grain', {
  build(recipe, shapeCtx, normOverride, opts){ return buildGrainSDF(recipe.json, shapeCtx, normOverride, opts); },
  // Raw field for the preview bake (moved from m90 in v0.9.0). Grain bounds
  // come from cosine sums under a different convention and stay unpadded.
  rawEval(d){
    const json=d.recipe.json;
    const PI5=Math.PI/5;
    const f=json.field,g=json.geometry||{};
    const params=grainParamsFromField(f);
    const isHU=f.type==='hyperuniform';
    // HU preview uses cube-mode evaluation (100 kernels, linear scan).
    // When a shape is imported, evalHUFieldPeriodic wraps kernel distances
    // to the nearest periodic image for seamless GL_REPEAT tiling.
    // Full-bbox tiled kernels are only needed for export (buildGrainSDF).
    const waves=isHU?null:(f.type==='gaussian'?buildGRFWaves(params):buildSpinodoidWaves(params));
    const kernels=isHU?buildHUKernels(params):null;
    const huEval=isHU&&d.shapeCtx?evalHUFieldPeriodic:evalHUField;
    const evalRaw=p=>isHU
      ?huEval(kernels,0.5+p[0]/10,0.5+p[1]/10,0.5+p[2]/10)
      :evalField(waves,p[0]*PI5,p[1]*PI5,p[2]*PI5,null);
    const topology={bakeRaw:true,rawUnits:true,halfW:g.half_width??0.15,center:g.center??0,
      topoMode:g.topology||'sheet',halfInvert:g.half_invert||false};
    return {evalRaw, topology};
  },
});
