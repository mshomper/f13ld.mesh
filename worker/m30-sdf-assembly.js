/* F13LD.mesh · worker/m30-sdf-assembly.js — Weld-group union, shape sampler, buildSDF dispatcher. */
function unionGradNorm(fn, p, h, cap){
  var f0=fn(p);
  var gx=(fn([p[0]+h,p[1],p[2]])-fn([p[0]-h,p[1],p[2]]))/(2*h);
  var gy=(fn([p[0],p[1]+h,p[2]])-fn([p[0],p[1]-h,p[2]]))/(2*h);
  var gz=(fn([p[0],p[1],p[2]+h])-fn([p[0],p[1],p[2]-h]))/(2*h);
  var g=Math.sqrt(gx*gx+gy*gy+gz*gz), d=f0/Math.max(g,1e-3);
  if(cap){ if(d>cap)d=cap; else if(d<-cap)d=-cap; } return d;
}
function unionSmin(a, b, k){ if(k<=1e-6)return Math.min(a,b); var hh=Math.max(k-Math.abs(a-b),0)/k; return Math.min(a,b)-hh*hh*k*0.25; }
// -- Weld-group assembly (v0.7.0) --------------------------------------------
// Composes the members of one weld group into a single canonical NEGATIVE-INSIDE
// field in absolute mm, smin-unioned with the group fillet. Fed to levelSet via
// p=>-assembly(p) (same neg->Manifold flip the cube path uses). v1 scope:
// identity per-body structXform; rotation/iso/HU/trim per body are deferred.
// Mirrors the single-body identity mapping: shape SDF trilinear-sampled over the
// body bbox (mm, neg-inside); lattice scaffold at p*mmToWorld then *worldToMm,
// intersected via max.
function makeShapeSampler(buf, N, bbox){
  var a=new Float32Array(buf);
  var bx=bbox.mnx, by=bbox.mny, bz=bbox.mnz;
  var sx=bbox.mxx-bbox.mnx, sy=bbox.mxy-bbox.mny, sz=bbox.mxz-bbox.mnz;
  var xX=bbox.mxx, xY=bbox.mxy, xZ=bbox.mxz, NN=N*N;
  return function(px,py,pz){
    var u=(px-bx)/sx, v=(py-by)/sy, w=(pz-bz)/sz;
    // v0.7.0: clamp-and-extend exterior. The old analytic box-distance fallback
    // hit 0 on the bbox shell, leaving each body exterior field near zero; the
    // group smin then dipped that to about -k/4 where two box shells met,
    // rendering phantom box faces/edges between welded bodies. Instead clamp uvw
    // into the grid (sampling the positive edge SDF, about the pad gap) and ADD
    // the exterior box distance: continuous across the face, strictly positive
    // outside the body, so no false zero-crossing. Interior (ext=0) unchanged.
    var ext=0;
    if(u<0||u>1||v<0||v>1||w<0||w>1){
      var qx=Math.max(bx-px,px-xX,0), qy=Math.max(by-py,py-xY,0), qz=Math.max(bz-pz,pz-xZ,0);
      ext=Math.sqrt(qx*qx+qy*qy+qz*qz);
      u=u<0?0:(u>1?1:u); v=v<0?0:(v>1?1:v); w=w<0?0:(w>1?1:w);
    }
    // v0.8.2: voxel-centre convention (grid baked at (i+0.5)/N) — see m90.
    var fu=Math.min(Math.max(u*N-0.5,0),N-1), fv=Math.min(Math.max(v*N-0.5,0),N-1), fw=Math.min(Math.max(w*N-0.5,0),N-1);
    var i0=Math.floor(fu)|0, j0=Math.floor(fv)|0, k0=Math.floor(fw)|0;
    var i1=i0+1<N?i0+1:N-1, j1=j0+1<N?j0+1:N-1, k1=k0+1<N?k0+1:N-1;
    var tu=fu-i0, tv=fv-j0, tw=fw-k0;
    var c000=a[i0+j0*N+k0*NN],c100=a[i1+j0*N+k0*NN],c010=a[i0+j1*N+k0*NN],c110=a[i1+j1*N+k0*NN];
    var c001=a[i0+j0*N+k1*NN],c101=a[i1+j0*N+k1*NN],c011=a[i0+j1*N+k1*NN],c111=a[i1+j1*N+k1*NN];
    var c00=c000+(c100-c000)*tu,c10=c010+(c110-c010)*tu,c01=c001+(c101-c001)*tu,c11=c011+(c111-c011)*tu;
    var c0=c00+(c10-c00)*tv,c1=c01+(c11-c01)*tv; return c0+(c1-c0)*tw+ext;
  };
}
function composeBodyMM(spec){
  var shp=makeShapeSampler(spec.shapeSdfData, spec.shapeN, spec.bbox);   // neg-inside mm
  if(spec.solid || !spec.recipe){ return function(p){ return shp(p[0],p[1],p[2]); }; }
  // v0.8.2: {periodic:true} — a weld member tiles its lattice through the whole
  // body. Hyperuniform otherwise used the single-cell evaluator and was all
  // void/solid outside world [-5,5].
  var sc=buildSDF(spec.recipe, null, {periodic:true});                   // neg-inside world
  var mmToWorld=10/spec.cellSizeMm, worldToMm=spec.cellSizeMm/10;
  return function(p){
    var sh=shp(p[0],p[1],p[2]);
    var scw=sc([p[0]*mmToWorld, p[1]*mmToWorld, p[2]*mmToWorld]);
    if(!(scw>-1e20&&scw<1e20)) scw=1e3;
    var sm=scw*worldToMm;
    return sm>sh?sm:sh;          // intersection (neg-inside): inside BOTH lattice and shape
  };
}
function buildAssemblySDF(specs, blendK, rawPreview){
  var k=(blendK!=null)?blendK:0;
  var h=Math.max(k*0.25, 0.05);  // mm central-diff step for the metric normalization
  var cap=Math.max(6,12*k);
  var comps=specs.map(composeBodyMM);
  var islat=specs.map(function(s){ return !(s.solid||!s.recipe); });
  // rawPreview: skip gradNorm so the implicit lattice renders crisply. gradNorm
  // is only needed for the metric fillet on EXPORT; in preview it smears the field.
  return function(p){
    var acc=1e9;
    for(var i=0;i<comps.length;i++){
      // v0.8.3: with no fillet (k≈0) the union is a plain min, whose zero set
      // doesn't depend on gradient normalization — skip its 7 extra evaluations.
      var d = (islat[i] && !rawPreview && k>1e-6) ? unionGradNorm(comps[i], p, h, cap) : comps[i](p);
      acc = unionSmin(acc, d, k);
    }
    return acc;
  };
}
function buildSDF(recipe,shapeCtx,opts){
  // v0.5.0-rc14: if the preview cached fieldMin/Max on the recipe, forward
  // them as a normalization override. Builders use the cached range instead
  // of their own pre-scan — guarantees preview/export agreement by
  // construction. Cache is cleared on setStale() so changed params fall back
  // to the builder's internal pre-scan.
  const normOverride = (recipe._previewFieldMin!==undefined && recipe._previewFieldMax!==undefined)
    ? {fieldMin:recipe._previewFieldMin, fieldMax:recipe._previewFieldMax}
    : null;
  if(recipe.family==='noise')return buildNoiseSDF(recipe.json,normOverride);
  if(recipe.family==='tpms') return buildTPMSSDF(recipe.json);
  if(recipe.family==='grain')return buildGrainSDF(recipe.json,shapeCtx,normOverride,opts);
  if(recipe.family==='beam') return buildBeamSDF(recipe.json);
  if(recipe.family==='bundle')return buildBundleSDF(recipe.json);
  if(recipe.family==='wave')  return buildWaveSDF(recipe.json);
  throw new Error('No evaluator for family: '+recipe.family);
}
