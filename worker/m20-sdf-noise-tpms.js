/* F13LD.mesh · worker/m20-sdf-noise-tpms.js — Noise + TPMS SDF builders (incl. PI-TPMS, field pairs). */
// ── SDF closures — all return canonical NEGATIVE-inside (see m23 header); the
//    single flip to Manifold's positive-inside happens in m90's export path ──

// seed -> coordinate-offset (verbatim port from F13LD.noise v0.9.1). Added in
// noise-input space before type dispatch, matching the canonical tool's sample().
function seedToOffset(s){
  if(!s) return [0,0,0];                  // seed 0 / absent = unchanged (back-compat)
  function h(n){var x=Math.sin(n)*43758.5453;return (x-Math.floor(x))*64.0;}
  return [h(s*127.1+11.7), h(s*269.5+53.3), h(s*113.5+97.1)];
}
const _seedOffCache=new WeakMap();       // memoize per-surf: computed once, not per-voxel
function evalNoiseRaw(surf,nx,ny,nz){
  const t=surf.noise_type||'simplex',o=surf.octaves||4,l=surf.lacunarity||2,g=surf.gain||.5;
  const j=surf.jitter??0.6,dm=surf.distance_metric||'euclidean';
  let so=_seedOffCache.get(surf);
  if(!so){so=seedToOffset(surf.seed||0);_seedOffCache.set(surf,so);}
  nx+=so[0];ny+=so[1];nz+=so[2];
  if(t==='simplex') return Noise.snoise(nx,ny,nz);
  if(t==='cellular')return Noise.cellular(nx,ny,nz,dm,j);
  if(t==='fbm')     return Noise.fbm(nx,ny,nz,o,l,g);
  if(t==='ridged')  return Noise.ridged(nx,ny,nz,o,l,g);
  if(t==='billow')  return Noise.billow(nx,ny,nz,o,l,g);
  if(t==='foam')    return Noise.foam(nx,ny,nz,dm,j);
  if(t==='strut')   return Noise.strut(nx,ny,nz,dm,j);
  if(t==='veined')  return Noise.veined(nx,ny,nz,surf.vein_turbulence??3.0,surf.vein_frequency??3.0,o,l,g);
  if(t==='curl')    return Noise.curl(nx,ny,nz,surf.curl_step||.1,surf.potential_scale||1);
  return Noise.warp(nx,ny,nz,surf.warp_strength||1,o,l,g);
}

function buildNoiseSDF(json,normOverride){
  const surf=json.surface,geom=json.geometry||{};
  const freq=surf.frequency||.3,sx=surf.scale_x??1,sy=surf.scale_y??1,sz=surf.scale_z??1;
  // v0.5.0-rc27: SCALE2=5/π removed. The canonical F13LD.noise tool's preview
  // cube is solver-space [-π, π] and applies SCALE=5/π to map solver→noise-input,
  // giving ±5*freq*scale at cube edge. Mesh's world cube is [-5, 5], so the
  // correct chain is world * (π/5) [world→solver] * (5/π) [solver→noise] = world.
  // Previously SCALE2 was being applied directly to world coords, producing a
  // 5/π ≈ 1.59× over-stretch in noise-input space — same recipe rendered ~1.59×
  // more pattern oscillations per cube than the canonical noise tool / F13LD.sweep
  // showed, and shifted the empirical mid (because wider sampling found more
  // extreme min values for asymmetric noise types like ridged/billow). Visible
  // effect was most pronounced in half/solid topology modes for ridged: lower
  // mid → larger fraction of field above threshold → thicker-looking solid.
  let mid,halfR;
  if(surf.norm_min!=null&&surf.norm_max!=null){
    // v0.5.1: carried normalization from F13LD.noise export. Identical mid/halfR
    // to the design tool's preview prepass, so the iso surface sits in the exact
    // same place regardless of bake resolution or shape AABB. No drift.
    mid=(surf.norm_min+surf.norm_max)*0.5;
    halfR=Math.max((surf.norm_max-surf.norm_min)*0.5,.001);
  } else if(normOverride){
    // v0.5.0-rc14: use preview's fieldMin/Max — zero drift, zero pre-scan cost.
    // v0.5.0-rc27: cached fieldMin/Max are now already +5% padded at bake time
    // (see worker post-message in this file), matching the canonical noise tool's
    // prepass convention. No additional padding needed here.
    mid=(normOverride.fieldMin+normOverride.fieldMax)*0.5;
    halfR=Math.max((normOverride.fieldMax-normOverride.fieldMin)*0.5,.001);
  } else {
    // Fallback pre-scan when preview hasn't cached a range yet (first export
    // without a preview bake, or after setStale). Samples over world [-5,5]
    // — the actual runtime query domain — at 16³ resolution.
    // v0.5.0-rc27: +5% padding restored (matching canonical F13LD.noise and
    // F13LD.sweep). The rc14 comment about "no padding" was correct given
    // the SCALE2 bug that was present then; with that bug fixed, padding is
    // needed again to match canonical bounds convention.
    const PP=16;let mn=Infinity,mx=-Infinity;
    for(let zi=0;zi<PP;zi++)for(let yi=0;yi<PP;yi++)for(let xi=0;xi<PP;xi++){
      const px=(xi/(PP-1))*10-5, py=(yi/(PP-1))*10-5, pz=(zi/(PP-1))*10-5;
      const raw=evalNoiseRaw(surf,px*freq*sx,py*freq*sy,pz*freq*sz);
      if(raw<mn)mn=raw;if(raw>mx)mx=raw;
    }
    const range=mx-mn;
    const padMin=mn-range*0.05, padMax=mx+range*0.05;
    mid=(padMin+padMax)*.5;
    halfR=Math.max((padMax-padMin)*.5,.001);
  }
  const center=surf.center??0,halfW=surf.half_width??.15,mode=geom.mode||'shell';
  return p=>{
    // v0.5.0-rc27: noise input = world * freq * scale (was world * SCALE2 * freq * scale;
    // SCALE2 = 5/π was incorrectly applied to world coords without the world→solver
    // step. See buildNoiseSDF header comment for full rationale.)
    const raw=evalNoiseRaw(surf,p[0]*freq*sx,p[1]*freq*sy,p[2]*freq*sz);
    const norm=(raw-mid)/halfR;
    // Canonical SDF: negative-inside, matches design-tool shader at index_-_Noise.html:1053.
    // half_invert=false → inside where norm > center (SDF = center-norm).
    // half_invert=true  → inside where norm < center (SDF = norm-center).
    if(mode==='half')   return (geom.half_invert?(norm-center):(center-norm));
    if(mode==='solid')  return halfW-Math.abs(norm-center);  // bulk (complement of sheet band)
    return Math.abs(norm-center)-halfW;                      // sheet (thin wall band, default)
  };
}

// Raw preset field functions — verbatim from TPMS builder _fn definitions
const RAW_PRESETS={
  splitP:       (x,y,z)=>Math.sin(x)*Math.sin(y)*Math.cos(z)+Math.sin(y)*Math.sin(z)*Math.cos(x)+Math.sin(z)*Math.sin(x)*Math.cos(y)-0.3,
  frd:          (x,y,z)=>Math.sin(2*x)*Math.cos(y)*Math.sin(z)+Math.sin(x)*Math.sin(2*y)*Math.cos(z)+Math.cos(x)*Math.sin(y)*Math.sin(2*z)-Math.cos(2*x)*Math.cos(2*y)-Math.cos(2*y)*Math.cos(2*z)-Math.cos(2*z)*Math.cos(2*x)+0.3,
  fks:          (x,y,z)=>Math.cos(2*x)*Math.sin(y)*Math.cos(z)+Math.cos(2*y)*Math.sin(z)*Math.cos(x)+Math.cos(2*z)*Math.sin(x)*Math.cos(y),
  gyroidHarmonic:(x,y,z)=>Math.sin(x)*Math.cos(y)+Math.sin(y)*Math.cos(z)+Math.sin(z)*Math.cos(x)+0.3*(Math.sin(2*x)*Math.cos(2*y)+Math.sin(2*y)*Math.cos(2*z)+Math.sin(2*z)*Math.cos(2*x)),
  primitiveC:   (x,y,z)=>2.0*(Math.cos(x)+Math.cos(y)+Math.cos(z))-(Math.cos(2*x)+Math.cos(2*y)+Math.cos(2*z)),
  octo:         (x,y,z)=>Math.cos(x)+Math.cos(y)+Math.cos(z)-0.5*(Math.cos(2*x)*Math.cos(2*y)+Math.cos(2*y)*Math.cos(2*z)+Math.cos(2*z)*Math.cos(2*x)),
  pHarmonic:    (x,y,z)=>Math.cos(x)+Math.cos(y)+Math.cos(z)+0.25*(Math.cos(2*x)+Math.cos(2*y)+Math.cos(2*z)),
  lidinoid:     (x,y,z)=>1.1*(Math.sin(2*x)*Math.cos(y)*Math.sin(z)+Math.sin(x)*Math.sin(2*y)*Math.cos(z)+Math.cos(x)*Math.sin(y)*Math.sin(2*z))-0.2*(Math.cos(2*x)*Math.cos(2*y)+Math.cos(2*y)*Math.cos(2*z)+Math.cos(2*z)*Math.cos(2*x))-0.4*(Math.cos(2*x)+Math.cos(2*y)+Math.cos(2*z)),
};

function buildTPMSSDF(json){
  const s=json.surface,g=json.geometry||{};
  // Per-axis cell scale (anisotropic-tiling spec v1.0). New recipes from
  // F13LD.sweep v0.10+ ship cell_scale_x/y/z; older recipes only have the
  // scalar cell_scale, which we fall back to (preserves isotropic behaviour
  // for hand-authored and pre-v0.10 recipes). TPMS is fully analytic — sin/cos
  // are intrinsically 2π-periodic — so we only need per-axis frequency
  // scaling on tx/ty/tz; no explicit modulo wrap required (unlike noise/grain
  // baked-field paths which sample R8 textures and DO need wrap).
  const csX=g.cell_scale_x??g.cell_scale??1;
  const csY=g.cell_scale_y??g.cell_scale??1;
  const csZ=g.cell_scale_z??g.cell_scale??1;
  // Fail loud — zero/negative produces NaN every voxel and a black render
  if(!(csX>0)||!(csY>0)||!(csZ>0))
    throw new Error('TPMS cell_scale must be positive on all axes (got '+csX+','+csY+','+csZ+')');
  const fsX=(Math.PI*csX)/5.0;
  const fsY=(Math.PI*csY)/5.0;
  const fsZ=(Math.PI*csZ)/5.0;
  const ps=g.phase_shift||{x:0,y:0,z:0},mode=g.mode||'shell';
  // v0.5.0-rc21: normal_weights — anisotropic shell-wall modulation.
  // Shell-only by spec; sweep doesn't generate it on pi-tpms or solid.
  const nw=g.normal_weights||null;
  const TP=2*Math.PI;
  // v0.5.0-rc22: TPMS normalize flags from F13LD.sweep v0.15.0+.
  // - shell_normalize: divides shell deviation by |∇φ| to produce true
  //   Euclidean wall thickness, independent of how steeply the TPMS field
  //   varies locally. Applies only in mode==='shell'.
  // - pi_normalize: angle-corrected distance to {φ_A=0 ∩ φ_B=0} curve set
  //   (the pipe network on the intersection of two phase-shifted level
  //   sets). Applies only in mode==='pi-tpms'.
  // Math copied verbatim from sweep's applyModeRaw (F13LD.tpms ground truth).
  //
  // v0.5.0-rc24: defaults updated to match sweep's renderer convention.
  // Sweep v0.15.0 omits these fields from emitted recipes (the field-thread
  // ships but the recipe writer is incomplete), yet sweep's renderer always
  // applies normalization for pi-tpms and shell modes. To match what sweep
  // shows the user (and presumably what sweep's solver characterized):
  //   - Absent (undefined) → default to true when mode is the matching topology
  //   - Explicit true/false → respect the flag verbatim
  // Legacy recipes that intentionally relied on the un-normalized envelope
  // can set the flag to false explicitly to restore prior behavior.
  const shellNorm=(g.shell_normalize!==undefined)?!!g.shell_normalize:(mode==='shell');
  const piNorm=(g.pi_normalize!==undefined)?!!g.pi_normalize:(mode==='pi-tpms');
  // Normalize constants — must match sweep's piField/shell-normalize exactly
  // or the preview will not agree with sweep's solver characterization.
  const NORM_E=0.012, NORM_EPS=0.08, NORM_COSCLAMP=0.95;
  const NORM_INV_2E=1/(2*NORM_E);
  // v0.5.0-rc22: off-surface SDF clip for preview-bake R8 quantization.
  // The normalize formulas amplify |φ| by 1/|∇φ| (up to ~12.5× at the EPS
  // clamp) at gradient degeneracies, which blows up the SDF range and
  // ruins R8 texture resolution near the iso surface. Clipping the
  // distance value at 5× the wall/pipe thickness keeps the iso surface
  // position exact (clip threshold >> wt or pipe_radius) while bounding
  // the off-surface SDF magnitude. Both export (Manifold.levelSet via
  // Float64) and the raymarcher (maxStep clamp) tolerate the clip-boundary
  // kink without artifacts. Five is conservative; tune downward if R8
  // resolution near the surface still feels coarse.
  const NORM_CLIP_MULT=5;

  // Gradient — matches TPMS shader: gF=mix(lo,hi,t01) where t01=(p+H)/(2H)
  // In world [-5,5]: t01=clamp(p/10+0.5,0,1); for PI mode gradient scales phase offset.
  const gradOn=!!(g.gradient&&g.gradient.enabled);
  const gxLo=gradOn?(g.gradient.x?.lo??1):1,gxHi=gradOn?(g.gradient.x?.hi??1):1;
  const gyLo=gradOn?(g.gradient.y?.lo??1):1,gyHi=gradOn?(g.gradient.y?.hi??1):1;
  const gzLo=gradOn?(g.gradient.z?.lo??1):1,gzHi=gradOn?(g.gradient.z?.hi??1):1;

  // Raw preset path — use the precomputed _fn directly
  const rawFn = (s.type==='raw_preset') ? (RAW_PRESETS[s.preset]||null) : null;
  if(s.type==='raw_preset'&&!rawFn)
    throw new Error('Unknown raw preset: '+s.preset+'. Supported: '+Object.keys(RAW_PRESETS).join(', '));

  // Term-tree path
  const terms=s.terms||[];
  function evalFactor(factor,tx,ty,tz){
    const t=factor.trig;
    let val=t.includes('(x)')?tx*(factor.fx||1):t.includes('(y)')?ty*(factor.fy||1):t.includes('(z)')?tz*(factor.fz||1):0;
    if(t.startsWith('sin'))return Math.sin(val);
    if(t.startsWith('cos'))return Math.cos(val);
    return 1;
  }
  function evalTermsList(list,tx,ty,tz){
    let sum=0;
    // Per-term phase_shift is in field-coord radians (sweep v0.13.1+).
    // Constant additive offset per term — preserves the term's period, so the
    // integer-period bake fix downstream is unaffected. Spec section 5 mandates
    // this for fidelity to what F13LD.sweep's solver characterized.
    for(const term of list){
      if(!term.on)continue;
      const tps=term.phase_shift;
      const ttx=tps?tx+(tps.x||0):tx;
      const tty=tps?ty+(tps.y||0):ty;
      const ttz=tps?tz+(tps.z||0):tz;
      let prod=term.coef??1;
      for(const f of term.factors)prod*=evalFactor(f,ttx,tty,ttz);
      sum+=prod;
    }
    return sum;
  }

  function evalTerms(tx,ty,tz){ return evalTermsList(terms,tx,ty,tz); }

  function evalPhi(tx,ty,tz){
    return rawFn ? rawFn(tx,ty,tz) : evalTerms(tx,ty,tz);
  }

  // v0.7.1: field-pair PI-TPMS (F13LD.tpms v1.1.0+).
  //   surface_b       independent field B (null/absent → B is a copy of A)
  //   field_b_freq    whole-number frequency multiple of A (keeps one A cell
  //                   periodic, so GL_REPEAT preview tiling stays seamless)
  //   field_b_scale   amplitude match rms(A)/rms(B); recomputed on the same
  //                   16³ cell-centred grid as F13LD.tpms when absent
  // Field B as used: φB_eff(t) = ampB · φB(kB·t + shift). With no surface_b,
  // kB=1 and ampB=1 this is exactly the legacy self-pair φA(t + shift).
  const sB=(mode==='pi-tpms'&&json.surface_b)?json.surface_b:null;
  const kB=Math.max(1,Math.round(g.field_b_freq||1));
  const rawFnB=sB?(sB.type==='raw_preset'?(RAW_PRESETS[sB.preset]||null):null):rawFn;
  if(sB&&sB.type==='raw_preset'&&!rawFnB)
    throw new Error('Unknown field B raw preset: '+sB.preset+'. Supported: '+Object.keys(RAW_PRESETS).join(', '));
  const termsB=sB?(sB.terms||[]):terms;
  function phiBBase(x,y,z){ return rawFnB ? rawFnB(x,y,z) : evalTermsList(termsB,x,y,z); }
  function fieldRMS(fn){
    const M=16,H=Math.PI,st=2*H/M; let acc=0;
    for(let i=0;i<M;i++){const x=-H+(i+.5)*st;
      for(let j=0;j<M;j++){const y=-H+(j+.5)*st;
        for(let k=0;k<M;k++){const z=-H+(k+.5)*st; const v=fn(x,y,z); acc+=v*v;}}}
    return Math.sqrt(acc/(M*M*M));
  }
  let ampB=1;
  if(typeof g.field_b_scale==='number'&&isFinite(g.field_b_scale)&&g.field_b_scale>0) ampB=g.field_b_scale;
  else if(sB){ const ra=fieldRMS(evalPhi), rb=fieldRMS(phiBBase); if(ra>1e-9&&rb>1e-9) ampB=ra/rb; }
  function evalPhiB(tx,ty,tz,sx,sy,sz){
    return ampB*phiBBase(kB*tx+sx,kB*ty+sy,kB*tz+sz);
  }
  // Field-coord gradient of φB_eff (same NORM_E step as gradPhiFieldCoord).
  function gradPhiB(tx,ty,tz,sx,sy,sz){
    const gx=(evalPhiB(tx+NORM_E,ty,tz,sx,sy,sz)-evalPhiB(tx-NORM_E,ty,tz,sx,sy,sz))*NORM_INV_2E;
    const gy=(evalPhiB(tx,ty+NORM_E,tz,sx,sy,sz)-evalPhiB(tx,ty-NORM_E,tz,sx,sy,sz))*NORM_INV_2E;
    const gz=(evalPhiB(tx,ty,tz+NORM_E,sx,sy,sz)-evalPhiB(tx,ty,tz-NORM_E,sx,sy,sz))*NORM_INV_2E;
    return {gx,gy,gz,mag:Math.sqrt(gx*gx+gy*gy+gz*gz)};
  }

  // v0.5.0-rc22: Field-coord central-difference gradient of phi.
  // Returns {gx, gy, gz, mag}. Step e=0.012 in field-coord radians matches
  // sweep's piField / shell-normalize implementation. Used by the normalize
  // branches below — kept separate from shellNormalAbs (which uses a different
  // eps and applies world-coord scaling for the anisotropic shell-wall path).
  function gradPhiFieldCoord(aX,aY,aZ){
    const gx=(evalPhi(aX+NORM_E,aY,aZ)-evalPhi(aX-NORM_E,aY,aZ))*NORM_INV_2E;
    const gy=(evalPhi(aX,aY+NORM_E,aZ)-evalPhi(aX,aY-NORM_E,aZ))*NORM_INV_2E;
    const gz=(evalPhi(aX,aY,aZ+NORM_E)-evalPhi(aX,aY,aZ-NORM_E))*NORM_INV_2E;
    const mag=Math.sqrt(gx*gx+gy*gy+gz*gz);
    return {gx,gy,gz,mag};
  }
  // v0.5.0-rc22: PI-normalize core. Angle-corrected distance to the curve
  // {φ_A=0 ∩ φ_B=0} in field-coord units. dA = φ_A/|∇φ_A|, dB = φ_B/|∇φ_B|
  // (signed distances to each level set). cos(θ) between gradients tells
  // us how the two surfaces intersect; clamped because parallel surfaces
  // (cos→±1, sin→0) would blow the formula up. num is floored at 0 to
  // guard against numerical artifacts near degenerate intersections.
  function piDistance(phiA_,phiB_,grA,grB){
    const magA=Math.max(grA.mag,NORM_EPS);
    const magB=Math.max(grB.mag,NORM_EPS);
    const dA=phiA_/magA, dB=phiB_/magB;
    let cosA=(grA.gx*grB.gx+grA.gy*grB.gy+grA.gz*grB.gz)/(magA*magB);
    if(cosA>NORM_COSCLAMP) cosA=NORM_COSCLAMP;
    if(cosA<-NORM_COSCLAMP) cosA=-NORM_COSCLAMP;
    const sin2=1-cosA*cosA;
    const num=dA*dA-2*cosA*dA*dB+dB*dB;
    return Math.sqrt(Math.max(num,0)/sin2);
  }

  // v0.5.0-rc21: unit world-space surface normal magnitudes via central
  // differences. Returns null at degenerate points (∇φ ≈ 0). Branches on
  // gradOn so the gradient is computed against whichever phi expression
  // the shell return uses. Treats gxF/gyF/gzF as locally constant across
  // the eps step — fine for typical recipes since they vary slowly in p.
  function shellNormalAbs(p){
    const eps=1e-3;
    const tx=p[0]*fsX,ty=p[1]*fsY,tz=p[2]*fsZ;
    let aX,aY,aZ,scX,scY,scZ;
    if(gradOn){
      const t01x=Math.max(0,Math.min(1,p[0]/10+0.5));
      const t01y=Math.max(0,Math.min(1,p[1]/10+0.5));
      const t01z=Math.max(0,Math.min(1,p[2]/10+0.5));
      const gxF=gxLo+(gxHi-gxLo)*t01x;
      const gyF=gyLo+(gyHi-gyLo)*t01y;
      const gzF=gzLo+(gzHi-gzLo)*t01z;
      aX=tx*gxF; aY=ty*gyF; aZ=tz*gzF;
      scX=fsX*gxF; scY=fsY*gyF; scZ=fsZ*gzF;
    } else {
      aX=tx; aY=ty; aZ=tz;
      scX=fsX; scY=fsY; scZ=fsZ;
    }
    const dx=(evalPhi(aX+eps,aY,aZ)-evalPhi(aX-eps,aY,aZ))*scX;
    const dy=(evalPhi(aX,aY+eps,aZ)-evalPhi(aX,aY-eps,aZ))*scY;
    const dz=(evalPhi(aX,aY,aZ+eps)-evalPhi(aX,aY,aZ-eps))*scZ;
    const len=Math.hypot(dx,dy,dz);
    if(len<1e-9) return null;
    return [Math.abs(dx/len),Math.abs(dy/len),Math.abs(dz/len)];
  }

  return p=>{
    const tx=p[0]*fsX,ty=p[1]*fsY,tz=p[2]*fsZ;
    if(gradOn){
      const t01x=Math.max(0,Math.min(1,p[0]/10+0.5));
      const t01y=Math.max(0,Math.min(1,p[1]/10+0.5));
      const t01z=Math.max(0,Math.min(1,p[2]/10+0.5));
      const gxF=gxLo+(gxHi-gxLo)*t01x;
      const gyF=gyLo+(gyHi-gyLo)*t01y;
      const gzF=gzLo+(gzHi-gzLo)*t01z;
      if(mode==='pi-tpms'){
        const sx=(ps.x||0)*TP*gxF, sy=(ps.y||0)*TP*gyF, sz=(ps.z||0)*TP*gzF;
        const phiA=evalPhi(tx,ty,tz);
        const phiB=evalPhiB(tx,ty,tz,sx,sy,sz);
        if(piNorm){
          const grA=gradPhiFieldCoord(tx,ty,tz);
          const grB=gradPhiB(tx,ty,tz,sx,sy,sz);
          const pipeR=(g.pipe_radius||.18);
          const d=piDistance(phiA,phiB,grA,grB);
          const dClipped=d<NORM_CLIP_MULT*pipeR?d:NORM_CLIP_MULT*pipeR;
          return dClipped-pipeR;
        }
        return Math.max(Math.abs(phiA),Math.abs(phiB))-(g.pipe_radius||.18);
      }
      const aX=tx*gxF, aY=ty*gyF, aZ=tz*gzF;
      const phiA=evalPhi(aX,aY,aZ);
      if(mode==='solid') return phiA-(g.offset||0);
      {let wt=g.wall_thickness||0.3;
       if(nw){const nrm=shellNormalAbs(p);if(nrm)wt*=(nw.wx*nrm[0]+nw.wy*nrm[1]+nw.wz*nrm[2]);}
       if(shellNorm){
         const gr=gradPhiFieldCoord(aX,aY,aZ);
         const gm=Math.max(gr.mag,NORM_EPS);
         const dist=Math.abs(phiA-(g.offset||0))/gm;
         const distClipped=dist<NORM_CLIP_MULT*wt?dist:NORM_CLIP_MULT*wt;
         return distClipped-wt;
       }
       return Math.abs(phiA-(g.offset||0))-wt;}
    }
    const phiA=evalPhi(tx,ty,tz);
    if(mode==='pi-tpms'){
      const sx=(ps.x||0)*TP, sy=(ps.y||0)*TP, sz=(ps.z||0)*TP;
      const phiB=evalPhiB(tx,ty,tz,sx,sy,sz);
      if(piNorm){
        const grA=gradPhiFieldCoord(tx,ty,tz);
        const grB=gradPhiB(tx,ty,tz,sx,sy,sz);
        const pipeR=(g.pipe_radius||.18);
        const d=piDistance(phiA,phiB,grA,grB);
        const dClipped=d<NORM_CLIP_MULT*pipeR?d:NORM_CLIP_MULT*pipeR;
        return dClipped-pipeR;
      }
      return Math.max(Math.abs(phiA),Math.abs(phiB))-(g.pipe_radius||.18);
    }
    if(mode==='solid') return phiA-(g.offset||0);
    {let wt=g.wall_thickness||0.3;
     if(nw){const nrm=shellNormalAbs(p);if(nrm)wt*=(nw.wx*nrm[0]+nw.wy*nrm[1]+nw.wz*nrm[2]);}
     if(shellNorm){
       const gr=gradPhiFieldCoord(tx,ty,tz);
       const gm=Math.max(gr.mag,NORM_EPS);
       const dist=Math.abs(phiA-(g.offset||0))/gm;
       const distClipped=dist<NORM_CLIP_MULT*wt?dist:NORM_CLIP_MULT*wt;
       return distClipped-wt;
     }
     return Math.abs(phiA-(g.offset||0))-wt;}
  };
}

