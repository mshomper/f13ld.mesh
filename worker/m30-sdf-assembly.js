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
function makeShapeSampler(buf, N, bbox, crop){
  var a=new Float32Array(buf);
  var bx=bbox.mnx, by=bbox.mny, bz=bbox.mnz;
  var sx=bbox.mxx-bbox.mnx, sy=bbox.mxy-bbox.mny, sz=bbox.mxz-bbox.mnz;
  var xX=bbox.mxx, xY=bbox.mxy, xZ=bbox.mxz;
  // v0.9.3: optional crop {i0,j0,k0,nx,ny,nz} — the buffer holds only that
  // sub-block of the N³ grid (weld bake workers get just the part of each
  // member's grid that the region touches). Indices are computed on the full
  // grid exactly as before, then shifted into the crop, so any sample whose 8
  // corners lie inside the crop returns the same value bit-for-bit.
  var ci=0,cj=0,ck=0,SX=N,SXY=N*N,cnx=N,cny=N,cnz=N;
  if(crop){ ci=crop.i0; cj=crop.j0; ck=crop.k0; cnx=crop.nx; cny=crop.ny; cnz=crop.nz; SX=cnx; SXY=cnx*cny; }
  var ciM=ci+cnx-1, cjM=cj+cny-1, ckM=ck+cnz-1;
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
    if(crop){
      // Outside the crop only happens for points the weld bake never asks for;
      // clamp so a stray query reads a nearby value instead of garbage.
      i0=i0<ci?ci:(i0>ciM?ciM:i0); i1=i1<ci?ci:(i1>ciM?ciM:i1);
      j0=j0<cj?cj:(j0>cjM?cjM:j0); j1=j1<cj?cj:(j1>cjM?cjM:j1);
      k0=k0<ck?ck:(k0>ckM?ckM:k0); k1=k1<ck?ck:(k1>ckM?ckM:k1);
      i0-=ci; i1-=ci; j0-=cj; j1-=cj; k0-=ck; k1-=ck;
    }
    var c000=a[i0+j0*SX+k0*SXY],c100=a[i1+j0*SX+k0*SXY],c010=a[i0+j1*SX+k0*SXY],c110=a[i1+j1*SX+k0*SXY];
    var c001=a[i0+j0*SX+k1*SXY],c101=a[i1+j0*SX+k1*SXY],c011=a[i0+j1*SX+k1*SXY],c111=a[i1+j1*SX+k1*SXY];
    var c00=c000+(c100-c000)*tu,c10=c010+(c110-c010)*tu,c01=c001+(c101-c001)*tu,c11=c011+(c111-c011)*tu;
    var c0=c00+(c10-c00)*tv,c1=c01+(c11-c01)*tv; return c0+(c1-c0)*tw+ext;
  };
}
// v0.9.3: a weld member, split into its cheap shape distance (trilinear grid,
// mm, neg-inside) and its full value. Solids: full == shape (+ insetMm, which
// the hybrid weld uses to pull a solid one voxel inside its exact mesh).
// Lattices: full = max(lattice, shape). metric = the family's field is already
// a true distance (registerSDF metric:true), so the fillet needs no gradient
// normalization.
function composeMember(spec){
  var shp=makeShapeSampler(spec.shapeSdfData, spec.shapeN, spec.bbox, spec.shapeCrop||null);
  if(spec.solid || !spec.recipe){
    var ins=+spec.insetMm||0;
    var sfn=ins? function(x,y,z){ return shp(x,y,z)+ins; } : shp;
    return {lat:false, metric:true, shape:sfn, full:function(p){ return sfn(p[0],p[1],p[2]); }};
  }
  // v0.8.2: {periodic:true} — a weld member tiles its lattice through the whole
  // body. Hyperuniform otherwise used the single-cell evaluator and was all
  // void/solid outside world [-5,5].
  var sc=buildSDF(spec.recipe, null, {periodic:true});                   // neg-inside world
  var fam=SDF_FAMILIES[spec.recipe.family];
  var mmToWorld=10/spec.cellSizeMm, worldToMm=spec.cellSizeMm/10;
  return {lat:true, metric:!!(fam&&fam.metric), shape:shp, full:function(p){
    var sh=shp(p[0],p[1],p[2]);
    var scw=sc([p[0]*mmToWorld, p[1]*mmToWorld, p[2]*mmToWorld]);
    if(!(scw>-1e20&&scw<1e20)) scw=1e3;
    var sm=scw*worldToMm;
    return sm>sh?sm:sh;          // intersection (neg-inside): inside BOTH lattice and shape
  }};
}
function composeBodyMM(spec){ return composeMember(spec).full; }
// opts (export only; v0.9.3):
//   reachMm  skip a member wherever its shape distance is ≥ reachMm. Far from a
//            member its value is ≥ its shape distance, so with reach ≥ 2·fillet
//            + a few voxels it cannot change the smin near the surface; points
//            far from every member just return the nearest shape distance
//            (positive, so the sign is unchanged). Saves evaluating every
//            lattice everywhere in a large group.
function buildAssemblySDF(specs, blendK, rawPreview, opts){
  var k=(blendK!=null)?blendK:0;
  var h=Math.max(k*0.25, 0.05);  // mm central-diff step for the metric normalization
  var cap=Math.max(6,12*k);
  var mem=specs.map(composeMember), n=mem.length;
  var reach=(!rawPreview && opts && opts.reachMm>0) ? opts.reachMm : 0;
  // gradNorm only on export, only with a fillet, only for non-metric lattices.
  // rawPreview skips it so the implicit lattice renders crisply (it smears the
  // preview field). v0.8.3: with no fillet (k≈0) the union is a plain min,
  // whose zero set doesn't depend on normalization. v0.9.3: metric families
  // (foam, beam, bundle) are already distances — normalizing them cost 7
  // evaluations per point for no change in shape.
  var norm=mem.map(function(m){ return m.lat && !rawPreview && k>1e-6 && !m.metric; });
  if(!reach){
    return function(p){
      var acc=1e9;
      for(var i=0;i<n;i++){
        var d = norm[i] ? unionGradNorm(mem[i].full, p, h, cap) : mem[i].full(p);
        acc = unionSmin(acc, d, k);
      }
      return acc;
    };
  }
  var sh=new Float64Array(n);
  return function(p){
    var acc=1e9, near=0, i;
    for(i=0;i<n;i++){ sh[i]=mem[i].shape(p[0],p[1],p[2]); if(sh[i]<reach) near++; }
    if(near===0){ for(i=0;i<n;i++) if(sh[i]<acc) acc=sh[i]; return acc; }
    for(i=0;i<n;i++){
      if(sh[i]>=reach) continue;
      var d = norm[i] ? unionGradNorm(mem[i].full, p, h, cap) : mem[i].full(p);
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
  // v0.9.0: each m2x-sdf-*.js registers its builder (m05-sdf-registry.js).
  const fam=SDF_FAMILIES[recipe.family];
  if(!fam) throw new Error('No evaluator for family: '+recipe.family);
  return fam.build(recipe,shapeCtx,normOverride,opts);
}
