/* F13LD.mesh · worker/m23-sdf-bundle.js — Canonical SDF convention notes + F13LD.bundle port. */
// ═══════════════════════════════════════════════════════════════════════════
// CANONICAL SDF CONVENTION (rc9 sign audit, rc10 normalization, rc14 override)
// ═══════════════════════════════════════════════════════════════════════════
// All SDF builders below (buildTPMSSDF, buildNoiseSDF, buildGrainSDF) return
// a STANDARD NEGATIVE-INSIDE signed distance field:
//
//   SDF(p) < 0  ⇔  p is INSIDE the scaffold (solid material)
//   SDF(p) = 0  ⇔  p is on the surface
//   SDF(p) > 0  ⇔  p is OUTSIDE the scaffold (void)
//
// This matches:
//   • Industry standard (meshopt, Three.js, every GPU raymarcher)
//   • The three design tools' raymarcher hit tests (d < thresh, thresh ≈ 0)
//   • F13LD.mesh preview shader's rawToSDF in both branches
//
// Manifold.levelSet internally treats POSITIVE values as "inside" for its
// marching-cubes extraction. The flip from our canonical negative-inside to
// Manifold's positive-inside happens EXACTLY ONCE — in the wrappedSDF closure
// inside the 'export' worker path (search for "Canonical→Manifold flip").
//
// FIELD NORMALIZATION (rc10 baseline, rc14 override): non-periodic stochastic
// fields (noise, spinodoid, GRF, hyperuniform) must be normalized to ~[-1,1]
// range BEFORE halfW/center are applied, otherwise walls come out at the
// wrong thickness.
//
// Single source of truth: the PREVIEW bake's actual fieldMin/fieldMax.
// After each preview bake, the main thread caches them on the recipe as
// _previewFieldMin / _previewFieldMax. On export, buildSDF forwards these
// to the noise/grain builders as normOverride. This guarantees
// preview/export agreement BY CONSTRUCTION — no drift from grid resolution
// or sampling density mismatches.
//
// Fallback: if override is absent (first export before any preview bake,
// or after a setStale event), the builder does its own 16³ pre-scan over
// world [-5,5]. No padding (rc14: the rc10 5% padding was compensation
// for the old mis-domain pre-scan in noise; rc14 fixes that bug too).
// RD path doesn't need normalization (Gray-Scott v-field is naturally in
// [0,1]). TPMS has no normalization concept — phi is in a well-defined
// implicit-function unit system.
//
// Iso offset semantics: +isoOffsetMm = THICKER WALLS. In canonical SDF terms,
// thicker walls means the zero-crossing pushes outward (more of space becomes
// "inside"), so +iso SUBTRACTS from the negative-inside SDF.
//
// If you add a new SDF builder or topology mode: return negative-inside from
// a normalized field, and the one flip at wrappedSDF handles Manifold handoff.
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// F13LD.bundle family (ported from F13LD.bundle v0.2.1) — twisted fiber array,
// helicoid, braid, woven sheet. BSDF.scene returns canonical NEGATIVE-INSIDE
// with iso offset + solid/sheet topology already folded in (matches mesh).
// Bundle evaluates over a [-PI,PI] domain; buildBundleSDF maps world->bundle
// via S = Pxy/10 so one structural XY period spans [-5,+5] world. Z anisotropy
// emerges because the twist period Lz differs from Pxy; export tiles via the
// SDF's own periodicity, preview GL_REPEATs the baked cell (computeBundleBakeBounds).
// ═══════════════════════════════════════════════════════════════════════════
var BSDF={
  PI:Math.PI,TWO_PI:Math.PI*2,
  smax:function(a,b,k){if(k<0.0001)return Math.max(a,b);var h=Math.max(k-Math.abs(a-b),0)/k;return Math.max(a,b)+h*h*k*0.25;},
  smin:function(a,b,k){if(k<0.0001)return Math.min(a,b);var h=Math.max(k-Math.abs(a-b),0)/k;return Math.min(a,b)-h*h*k*0.25;},
  ckSign:function(bi,bj){return(((bi+bj)%2)+2)%2===0?1:-1;},
  beamSDF:function(dx,dy,r,n){
    if(n>=14)return r-Math.max(Math.abs(dx),Math.abs(dy));
    if(n<=2.1)return r-Math.sqrt(dx*dx+dy*dy);
    return r-Math.pow(Math.pow(Math.abs(dx),n)+Math.pow(Math.abs(dy),n),1/n);
  },
  bundleRaw:function(lx,ly,p){
    var W=p.nx*p.d,hp=W*0.5,result=-1e6;
    for(var j=0;j<p.ny;j++)for(var i=0;i<p.nx;i++){
      var x0=(i-(p.nx-1)*0.5)*p.d,y0=(j-(p.ny-1)*0.5)*p.d;
      if(Math.abs(x0)+p.r<=hp&&Math.abs(y0)+p.r<=hp)
        result=BSDF.smax(result,BSDF.beamSDF(lx-x0,ly-y0,p.r,p.n),p.blend);
    }
    return result;
  },
  applyWarp:function(xm,ym,z,p){
    if(p.warpMode===0)return[xm,ym];
    var A=p.warpAmp,w=p.warpFreq;
    if(p.warpMode===1){var cx=A*Math.sin(w*z),dC=A*w*Math.cos(w*z),L=Math.sqrt(1+dC*dC);return[(xm-cx)/L,ym];}
    var cx=A*Math.sin(w*z),cy=A*Math.cos(w*z),L=Math.sqrt(1+A*A*w*w);
    return[-(xm-cx)*Math.sin(w*z)-(ym-cy)*Math.cos(w*z),((xm-cx)*Math.cos(w*z)-(ym-cy)*Math.sin(w*z))/L];
  },
  bundleCell:function(xm,ym,pz,cs,p){
    var ts=p.twistMode===0?1:cs;
    var th=ts*p.twist*pz,cosT=Math.cos(th),sinT=Math.sin(th);
    var lx,ly,w;
    if(p.warpFrame===0){w=BSDF.applyWarp(xm,ym,pz,p);lx=w[0]*cosT-w[1]*sinT;ly=w[0]*sinT+w[1]*cosT;}
    else{var tx=xm*cosT-ym*sinT,ty=xm*sinT+ym*cosT;w=BSDF.applyWarp(tx,ty,pz,p);lx=w[0];ly=w[1];}
    return -BSDF.bundleRaw(lx,ly,p);
  },
  bundle:function(px,py,pz_in,p){
    var period=Math.max(p.nx*p.d+p.gap,0.01);
    var hp=period*0.5,SH=Math.PI;
    var xBase=((px+SH)%period+period)%period-hp;
    var yBase=((py+SH)%period+period)%period-hp;
    var biBase=Math.floor((px+SH)/period);
    var bjBase=Math.floor((py+SH)/period);
    var result=1e6;
    for(var di=-1;di<=1;di++)for(var dj=-1;dj<=1;dj++){
      var xm=xBase-di*period,ym=yBase-dj*period;
      var bi=biBase+di,bj=bjBase+dj;
      var cs=BSDF.ckSign(bi,bj);
      var pz=pz_in+bi*p.zRampX+bj*p.zRampY+cs*p.zChkStep;
      result=BSDF.smin(result,BSDF.bundleCell(xm,ym,pz,cs,p),p.blend);
    }
    return result;
  },
  helicoidCell:function(xm,ym,pz,cs,p){
    var omega=p.hPitch;
    if(p.hColHand&&cs<0)omega=-omega;
    // Alternating: reverse twist every other period via a smooth (C0/C1) oscillation
    // of the accumulated twist angle, Lambda = 4*pi/|omega| (= two base periods).
    var twAng,twRate;
    if(p.hZHand){var hk=Math.abs(omega)*0.5;twRate=omega*Math.cos(hk*pz);twAng=(hk>1e-6?omega/hk:omega*pz)*Math.sin(hk*pz);}
    else{twAng=omega*pz;twRate=omega;}
    var rxy=Math.sqrt(xm*xm+ym*ym);
    var rMask=Math.min(rxy-p.hInner,p.hOuter-rxy);
    var phi=p.hStarts*Math.atan2(ym,xm)-twAng;
    phi-=BSDF.TWO_PI*Math.round(phi/BSDF.TWO_PI);
    var rSafe=Math.max(rxy,1e-4);
    var gradMag=Math.sqrt(p.hStarts*p.hStarts/(rSafe*rSafe)+twRate*twRate);
    var dSheet=Math.abs(phi)/gradMag-p.hThick;
    return Math.max(dSheet,-rMask);
  },
  helicoid:function(px,py,pz_in,p){
    var period=Math.max(2*p.hOuter+p.hGap,0.01);
    var hp=period*0.5,SH=Math.PI;
    var xBase=((px+SH)%period+period)%period-hp;
    var yBase=((py+SH)%period+period)%period-hp;
    var biBase=Math.floor((px+SH)/period);
    var bjBase=Math.floor((py+SH)/period);
    var result=1e6;
    for(var di=-1;di<=1;di++)for(var dj=-1;dj<=1;dj++){
      var xm=xBase-di*period,ym=yBase-dj*period;
      var bi=biBase+di,bj=bjBase+dj;
      var cs=BSDF.ckSign(bi,bj);
      var pz=pz_in+bi*p.zRampX+bj*p.zRampY+cs*p.zChkStep;
      result=BSDF.smin(result,BSDF.helicoidCell(xm,ym,pz,cs,p),p.hBlend);
    }
    return result;
  },
  braidCell:function(xm,ym,pz,cs,p){
    var omega=p.bPitch;
    if(p.bColHand&&cs<0)omega=-omega;
    var dA2=p.bRadius*p.bRadius*omega*omega+1;
    var result=-1e6;
    for(var k=0;k<p.bN;k++){
      var phase=BSDF.TWO_PI*k/p.bN,tt=pz;
      for(var iter=0;iter<5;iter++){
        var phi=omega*tt+phase;
        var Ckx=p.bRadius*Math.cos(phi),Cky=p.bRadius*Math.sin(phi);
        var dCkx=-p.bRadius*omega*Math.sin(phi),dCky=p.bRadius*omega*Math.cos(phi);
        var ddCkx=-p.bRadius*omega*omega*Math.cos(phi),ddCky=-p.bRadius*omega*omega*Math.sin(phi);
        var dx=xm-Ckx,dy=ym-Cky,dz=pz-tt;
        var f=-(dx*dCkx+dy*dCky+dz);
        var fp=dA2-(dx*ddCkx+dy*ddCky);
        tt-=f/(Math.abs(fp)>1e-6?fp:1e-6);
      }
      var phi2=omega*tt+phase;
      var dist=Math.sqrt((xm-p.bRadius*Math.cos(phi2))*(xm-p.bRadius*Math.cos(phi2))+(ym-p.bRadius*Math.sin(phi2))*(ym-p.bRadius*Math.sin(phi2))+(pz-tt)*(pz-tt));
      result=BSDF.smax(result,p.bFiber-dist,p.bBlend);
    }
    return -result;
  },
  braid:function(px,py,pz_in,p){
    var period=Math.max(2*(p.bRadius+p.bFiber)+p.bGap,0.01);
    var hp=period*0.5,SH=Math.PI;
    var xBase=((px+SH)%period+period)%period-hp;
    var yBase=((py+SH)%period+period)%period-hp;
    var biBase=Math.floor((px+SH)/period);
    var bjBase=Math.floor((py+SH)/period);
    var result=1e6;
    for(var di=-1;di<=1;di++)for(var dj=-1;dj<=1;dj++){
      var xm=xBase-di*period,ym=yBase-dj*period;
      var bi=biBase+di,bj=bjBase+dj;
      var cs=BSDF.ckSign(bi,bj);
      var pz=pz_in+bi*p.zRampX+bj*p.zRampY+cs*p.zChkStep;
      result=BSDF.smin(result,BSDF.braidCell(xm,ym,pz,cs,p),p.bBlend);
    }
    return result;
  },
  weave:function(px,py,pz,p){
    var period=Math.max(p.wvP,0.01),hp=period*0.5;
    var zPeriod=Math.max(2*(p.wvA+p.wvR)+p.wvZGap,0.01),zHalfP=zPeriod*0.5;
    var zmBase=((pz+zHalfP)%zPeriod+zPeriod)%zPeriod-zHalfP;
    var xBase=((px+hp)%period+period)%period-hp;
    var biBase=Math.floor((px+hp)/period);
    var yBase=((py+hp)%period+period)%period-hp;
    var bjBase=Math.floor((py+hp)/period);
    var result=1e6;
    for(var dzi=-1;dzi<=1;dzi++){
      var zm=zmBase-dzi*zPeriod;
      var warpD=1e6;
      for(var di=-1;di<=1;di++){
        var xm=xBase-di*period;
        var bi=biBase+di;
        var cs=(((bi%2)+2)%2===0)?1:-1;
        var zc=cs*p.wvA*Math.cos(Math.PI*py/period);
        warpD=Math.min(warpD,Math.sqrt(xm*xm+(zm-zc)*(zm-zc))-p.wvR);
      }
      var weftD=1e6;
      for(var dj=-1;dj<=1;dj++){
        var ym=yBase-dj*period;
        var bj=bjBase+dj;
        var cs2=(((bj%2)+2)%2===0)?1:-1;
        var zc2=-cs2*p.wvA*Math.cos(Math.PI*px/period);
        weftD=Math.min(weftD,Math.sqrt(ym*ym+(zm-zc2)*(zm-zc2))-p.wvR);
      }
      result=BSDF.smin(result,BSDF.smin(warpD,weftD,p.wvBlend),p.wvBlend);
    }
    return result;
  },
  raw:function(px,py,pz,p){
    if(p.structure===0)return BSDF.bundle(px,py,pz,p);
    if(p.structure===1)return BSDF.helicoid(px,py,pz,p);
    if(p.structure===2)return BSDF.braid(px,py,pz,p);
    return BSDF.weave(px,py,pz,p);
  },
  scene:function(px,py,pz,p){
    var raw=BSDF.raw(px,py,pz,p)-p.iso;
    if(p.topoMode===0)return p.flip?-raw:raw;
    return Math.abs(raw)-p.sheetW;
  }
};
function bundleParamsFromJSON(json){
  var surf=json.surface||{}, g=json.geometry||{};
  function num(v,d){return (typeof v==='number'&&isFinite(v))?v:d;}
  function int(v,d){return (typeof v==='number'&&isFinite(v))?Math.round(v):d;}
  var structNames=['bundle','helicoid','braid','weave'];
  var sName=surf.structure||(json.meta&&json.meta.preset)||'bundle';
  var structure=structNames.indexOf(sName); if(structure<0)structure=0;
  function shapeToN(sn){return sn==='square'?16:sn==='rounded'?4:2;}
  var topoMode=(surf.topology==='sheet')?1:0;
  var flip=(surf.topology==='void')?1:0;
  return {
    structure:structure,
    r:num(g.beam_radius,0.09), n:shapeToN(g.beam_shape||'circle'),
    nx:int(g.beams_per_side,2), ny:int(g.beams_per_side,2),
    d:num(g.beam_spacing,0.28), gap:num(g.column_gap,0.20),
    blend:num(g.blend_k,0.01), twist:num(g.twist_rate,1.20),
    twistMode:int(g.twist_mode,0),
    warpMode:int(g.warp_mode,0), warpAmp:num(g.warp_amp,0.15),
    warpFreq:num(g.warp_freq,1.50), warpFrame:int(g.warp_frame,0),
    hPitch:num(g.pitch,1.5), hThick:num(g.thickness,0.05),
    hInner:num(g.inner_radius,0.0), hOuter:num(g.outer_radius,0.4),
    hStarts:int(g.starts,1), hBlend:num(g.helicoid_blend,0.01),
    hGap:num(g.column_gap,0.20), hColHand:int(g.col_handed,0), hZHand:int(g.z_handed,0),
    bN:int(g.strand_count,3), bRadius:num(g.braid_radius,0.12),
    bPitch:num(g.pitch,1.20), bFiber:num(g.fiber_radius,0.06),
    bBlend:num(g.blend_k,0.01), bGap:num(g.column_gap,0.20),
    bColHand:int(g.braid_col_handed,0),
    wvP:num(g.weave_pitch,0.5), wvA:num(g.weave_amplitude,0.1),
    wvR:num(g.fiber_radius,0.06), wvZGap:num(g.weave_layer_gap,0.0),
    wvBlend:num(g.blend_k,0.01),
    iso:num(surf.iso_offset,0.0), sheetW:num(surf.sheet_width,0.025),
    topoMode:topoMode, flip:flip,
    zRampX:num(g.z_ramp_x,0.0), zRampY:num(g.z_ramp_y,0.0), zChkStep:num(g.z_checker_step,0.0)
  };
}
function bundleXYPeriod(p){
  if(p.structure===0)return Math.max(p.nx*p.d+p.gap,0.01);
  if(p.structure===1)return Math.max(2*p.hOuter+p.hGap,0.01);
  if(p.structure===2)return Math.max(2*(p.bRadius+p.bFiber)+p.bGap,0.01);
  return Math.max(p.wvP,0.01);
}
function buildBundleSDF(json){
  var p=bundleParamsFromJSON(json);
  var S=bundleXYPeriod(p)/10;
  var invS=1/S; // bundle-domain distance -> world units (one cell = 10 world units); analogous to beam's L2Wgeo
  return function(q){ return BSDF.scene(q[0]*S,q[1]*S,q[2]*S,p)*invS; };
}

// -- F13LD.wave: cymatic standing-wave SDF (negative-inside) --------------
// Sum of cosine modes under one of five symmetry operators, transcribed
// verbatim from F13LD.wave's f13ldWaveEvalRaw. The mesh world cube [-5,5]
// maps to exactly one wave cell via q = p * worldScale (pi/5): q spans
// [-pi,pi] (cos period 2pi = one cell), giving seamless cubic tiling.
// cellScale is a PHYSICAL size in wave (domain.size mm), intentionally NOT
// a frequency multiplier here -- the mesh cell-size input owns physical
// scale, exactly as on the analytic TPMS path.
