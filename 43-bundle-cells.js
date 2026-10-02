/* ============================================================
   F13LD.mesh · 43-bundle-cells.js
   F13LD.bundle main-thread cell helpers (mirror of worker/m23-sdf-bundle.js).
   ============================================================ */
'use strict';

// ── F13LD.bundle main-thread helpers (cell geometry; mirror worker port) ──
// Authoritative cell derivation for tiling. bundleZPeriod uses the cross-
// section's rotational symmetry for the tightest valid Z cell: C4 (quarter
// turn) for the square bundle grid, hStarts-fold for helicoid, bN-fold for
// braid, explicit zPeriod for weave. Warp breaks rotational symmetry, so the
// twist falls back to a full turn and is LCM'd with the warp period (capped,
// seams accepted past the cap). bundleSuperCellXY grows the XY tile to 2x2 for
// checker/handedness/alternating-twist, and extends it (parity-preserving, cap
// 8) until any z-ramp marries the Z period; past the cap it tiles with seams.
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
function bundleLcm(a,b,cap){
  if(!(b>1e-9))return a;
  for(var m=1;m<=cap;m++){var L=m*a,n=L/b;if(Math.abs(n-Math.round(n))<1e-3*Math.max(1,Math.round(n))&&Math.round(n)>=1)return L;}
  return cap*a;
}
function bundleZPeriod(p){
  var TP=Math.PI*2;
  if(p.structure===3)return Math.max(2*(p.wvA+p.wvR)+p.wvZGap,0.01);
  if(p.structure===1){
    var w=Math.abs(p.hPitch);
    if(w<=1e-6)return bundleXYPeriod(p);
    // v0.6.8: helicoid Z period = 2π/pitch, NOT /starts. At a fixed (x,y) the
    // field depends on z only via φ = starts·θ − pitch·z, so it repeats when
    // pitch·z advances 2π. starts sets angular sheet count, not the z period.
    // (Contrast braid: strands rotate rigidly at pitch, so N-fold → 2π/(N·pitch).)
    var Lh=TP/w;
    if(p.hZHand)Lh*=2; // z-handedness flips each base period → tile spans two
    return Lh;
  }
  if(p.structure===2){var w2=Math.abs(p.bPitch);return w2>1e-6?TP/(Math.max(1,p.bN)*w2):bundleXYPeriod(p);}
  var tw=Math.abs(p.twist);
  var singleCircle=(p.nx<=1&&p.n<=2.1);
  if(tw<1e-6||singleCircle){
    if(p.warpMode!==0&&Math.abs(p.warpFreq)>1e-6)return TP/Math.abs(p.warpFreq);
    return bundleXYPeriod(p);
  }
  if(p.warpMode===0)return (TP/4)/tw;
  var Ltwist=TP/tw;
  var Lwarp=(Math.abs(p.warpFreq)>1e-6)?TP/Math.abs(p.warpFreq):Ltwist;
  // v0.6.5: warped bundles bake continuously (non-periodic), so this period only
  // sizes the no-shape fallback and the reported cell aspect. Cap at one full
  // turn — the incommensurate LCM ceiling (8 turns) was an absurd ~55x cell.
  return Math.min(bundleLcm(Ltwist,Lwarp,8), Ltwist);
}
function bundleSuperCellXY(p,Lz){
  var alt=(Math.abs(p.zChkStep)>1e-9)
    ||(p.structure===0&&p.twistMode===1)
    ||(p.structure===1&&(p.hColHand||p.hZHand))
    ||(p.structure===2&&p.bColHand)
    ||(p.structure===3); // weave: cosine wave + over/under alternation repeat at 2*wvP -> 2x2 super-cell
  var baseK=alt?2:1;
  function rampK(ramp){
    if(Math.abs(ramp)<1e-9)return baseK;
    for(var K=baseK;K<=8;K+=(baseK===2?2:1)){var t=(K*ramp)/Lz;if(Math.abs(t-Math.round(t))<1e-3)return K;}
    return 8;
  }
  return {Kx:rampK(p.zRampX),Ky:rampK(p.zRampY)};
}
function computeBundleBakeBounds(recipe){
  var p=bundleParamsFromJSON(recipe.json);
  var Pxy=bundleXYPeriod(p), Lz=bundleZPeriod(p), sc=bundleSuperCellXY(p,Lz);
  var hx=5*sc.Kx, hy=5*sc.Ky, hz=5*(Lz/Pxy);
  return {wMin:[-hx,-hy,-hz],wMax:[hx,hy,hz],Kx:sc.Kx,Ky:sc.Ky,Lz:Lz,Pxy:Pxy};
}
