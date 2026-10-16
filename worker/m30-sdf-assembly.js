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
// p=>-assembly(p) (same neg->Manifold flip the cube path uses).
// Mirrors the single-body mapping: shape SDF trilinear-sampled over the
// body bbox (mm, neg-inside); lattice scaffold at p*mmToWorld then *worldToMm,
// intersected via max.
// v0.12.0: each lattice member honours its own body settings the way a single-
// body export does (m32): spec.structXform {rotMat, spatialOffsetMm, isoOffsetMm}
// (rotation about the shape bbox centre, spatial offset, iso/wall offset),
// spec.pruneToNodes / pruneInsetMult (trim-to-nodes), spec.fill 'skin' +
// spec.skinMm (solid wall along the shape surface). Absent fields = old field,
// bit for bit. Group join rules (spec.joinRule 'anchor' | 'graded', stamped on
// every spec of the group, or opts.join) are described at composeMember.
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
// ── Structure transform setup (v0.12.0) ──────────────────────────────────
// Shared by the single-body export field (m32) and weld members (composeMember).
// xf = {rotMat (R^T, column-major), spatialOffsetMm:[x,y,z], isoOffsetMm}; absent
// means identity. Pivot is the shape bbox centre. identity is true only when
// rotation, offset AND iso are all neutral (the fast path skips the transform
// and does not apply iso).
function structXformSetup(xf, bbox){
  xf = xf || {rotMat:[1,0,0,0,1,0,0,0,1],spatialOffsetMm:[0,0,0],isoOffsetMm:0};
  var rot = xf.rotMat, off = xf.spatialOffsetMm, iso = xf.isoOffsetMm;
  var bsx = bbox.mxx-bbox.mnx, bsy = bbox.mxy-bbox.mny, bsz = bbox.mxz-bbox.mnz;
  var S = {rot:rot, ox:off[0], oy:off[1], oz:off[2], iso:iso,
    px:bbox.mnx + bsx*0.5, py:bbox.mny + bsy*0.5, pz:bbox.mnz + bsz*0.5};
  S.identity = (rot[0]===1 && rot[4]===1 && rot[8]===1 &&
                rot[1]===0 && rot[2]===0 && rot[3]===0 &&
                rot[5]===0 && rot[6]===0 && rot[7]===0 &&
                S.ox===0 && S.oy===0 && S.oz===0 && iso===0);
  return S;
}
// ── Trim-to-nodes (v0.5.0-rc17; moved here from m32 in v0.12.0) ───────────
// For beam recipes with d.pruneToNodes set, build a per-tile beam mask and
// return the mask-aware beam SDF; null when trimming does not apply (flag off,
// family without trimToNodes, mask too large). d carries recipe, cellSizeMm,
// bbox, shapeN, pruneInsetMult; sampleShapeSDF(x,y,z) is the member's shape
// distance in mm (negative inside); S comes from structXformSetup; post is a
// progress callback ({type:'progress', stage}). Used verbatim by the
// single-body export field and by weld members.
function buildTrimmedBeamSDF(d, sampleShapeSDF, S, post){
  const bbox=d.bbox, shapeN=d.shapeN;
  const bminX=bbox.mnx,bminY=bbox.mny,bminZ=bbox.mnz;
  const bsizeX=bbox.mxx-bbox.mnx,bsizeY=bbox.mxy-bbox.mny,bsizeZ=bbox.mxz-bbox.mnz;
  const bmaxX=bbox.mxx,bmaxY=bbox.mxy,bmaxZ=bbox.mxz;
  const xfRot=S.rot, xfOffMmX=S.ox, xfOffMmY=S.oy, xfOffMmZ=S.oz;
  const xfPivotMmX=S.px, xfPivotMmY=S.py, xfPivotMmZ=S.pz;
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
    post({type:'progress',stage:'trim-to-nodes inset: '+insetMm.toFixed(3)+' mm ('+insetReason+', voxel='+voxelSizeMm.toFixed(3)+' mm)'});
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
      post({type:'progress',stage:'trim-to-nodes mask too large ('+(maskBytes/1e6).toFixed(0)+' MB) — skipping prune'});
    } else {
      post({type:'progress',stage:'computing trim-to-nodes mask ('+totalTiles.toLocaleString()+' tiles × '+BC+' beams)...'});
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
      post({type:'progress',stage:'trim-to-nodes: '+kept.toLocaleString()+' / '+totalCandidates.toLocaleString()+' beams kept ('+(100*kept/Math.max(1,totalCandidates)).toFixed(1)+'%)'});
      // Override sdfFn with mask-aware version
      return buildBeamSDF(d.recipe.json, {mask,tXMin,tYMin,tZMin,NX,NY,NZ});
    }
  }
  return null;
}

// -- Join rules (v0.12.0) ----------------------------------------------------
// joinRule per weld group, read from the specs (every spec of a group carries
// the group's values) or passed as opts.join:
//   'union'   (default) plain smooth union with the fillet — nothing changes
//   'anchor'  a lattice member continues INTO solid members by anchorMm: its
//             clipping shape is grown by anchorMm where it lies inside a solid
//             member. The growth is zero for the first quarter of anchorMm of
//             depth and reaches full over the next quarter (smoothstep), so the
//             field is untouched at and just under the solid's surface and the
//             level set sees no step there. Outside every solid the lattice is
//             untouched. The anchored lattice lies wholly inside the solid, so
//             in a single unioned mesh it adds no surface: it only matters to
//             what reads the member fields (preview of members, per-member use).
//   'graded'  lattice walls thicken toward solid members: iso (wall) offset
//             grows by up to gradeMaxMm (default 0.15 x the lattice cell size)
//             as the distance to the nearest solid goes from gradeMm to 0,
//             smoothstep.
function weldJoinFromSpecs(specs){
  for(var i=0;i<specs.length;i++){
    var s=specs[i];
    if(s && s.joinRule && s.joinRule!=='union'){
      return {rule:s.joinRule, anchorMm:+s.anchorMm||0, gradeMm:+s.gradeMm||0, gradeMaxMm:(s.gradeMaxMm>0)?+s.gradeMaxMm:0};
    }
  }
  return null;
}
function weldIsSolidSpec(spec){ return !!(spec.solid || !spec.recipe); }
function smoothstep01(t){ t=t<0?0:(t>1?1:t); return t*t*(3-2*t); }
// A weld member, split into its cheap shape distance (trilinear grid,
// mm, neg-inside) and its full value. Solids: full == shape (+ insetMm, which
// the hybrid weld uses to pull a solid one voxel inside its exact mesh).
// Lattices: full = max(lattice, shape). metric = the family's field is already
// a true distance (registerSDF metric:true), so the fillet needs no gradient
// normalization.
// shpIn (optional): this spec's shape sampler, so buildAssemblySDF builds each
// once. join (optional, only when a join rule applies):
//   {anchorMm, gradeMm, gradeMaxMm, solidDist(x,y,z)} where solidDist is the
//   nearest solid member's raw (un-inset) shape distance, negative inside.
function composeMember(spec, shpIn, join){
  var shp=shpIn||makeShapeSampler(spec.shapeSdfData, spec.shapeN, spec.bbox, spec.shapeCrop||null);
  if(weldIsSolidSpec(spec)){
    var ins=+spec.insetMm||0;
    var sfn=ins? function(x,y,z){ return shp(x,y,z)+ins; } : shp;
    return {lat:false, metric:true, shape:sfn, raw:shp, full:function(p){ return sfn(p[0],p[1],p[2]); }};
  }
  // v0.8.2: {periodic:true} — a weld member tiles its lattice through the whole
  // body. Hyperuniform otherwise used the single-cell evaluator and was all
  // void/solid outside world [-5,5].
  var sc=buildSDF(spec.recipe, null, {periodic:true});                   // neg-inside world
  var fam=SDF_FAMILIES[spec.recipe.family];
  var mmToWorld=10/spec.cellSizeMm, worldToMm=spec.cellSizeMm/10;
  // v0.12.0 per-body structure settings (see m32 buildShapeExportField).
  var S=structXformSetup(spec.structXform, spec.bbox);
  // Trim-to-nodes: beam families only, flag from the body. The mask is built
  // against this member's FULL shape grid (callers must not crop it).
  if(spec.pruneToNodes){
    var tr=buildTrimmedBeamSDF(spec, shp, S, function(){});
    if(tr) sc=tr;
  }
  var skinMm=(spec.fill==='skin' && spec.skinMm>0)?+spec.skinMm:0;
  var anchorMm=0, gradeMm=0, gradeMax=0, solidDist=null;
  if(join && join.solidDist){
    if(join.anchorMm>0){ anchorMm=join.anchorMm; solidDist=join.solidDist; }
    else if(join.gradeMm>0){
      gradeMm=join.gradeMm; solidDist=join.solidDist;
      gradeMax=(join.gradeMaxMm>0)?join.gradeMaxMm:0.15*spec.cellSizeMm;
    }
  }
  var anchorD0=anchorMm*0.25, anchorRamp=anchorMm*0.25;   // growth: none above D0 deep, full at D0+ramp
  var ident=S.identity, rot=S.rot, ox=S.ox, oy=S.oy, oz=S.oz, px=S.px, py=S.py, pz=S.pz, iso=S.iso;
  return {lat:true, metric:!!(fam&&fam.metric), shape:shp, full:function(p){
    var sh=shp(p[0],p[1],p[2]);
    var scw, sm;
    if(ident){
      scw=sc([p[0]*mmToWorld, p[1]*mmToWorld, p[2]*mmToWorld]);
      if(!(scw>-1e20&&scw<1e20)) scw=1e3;
      sm=scw*worldToMm;
    } else {
      // q = (p - pivot - offset); local = R^T q; evaluate at local + pivot.
      var qx=p[0]-px-ox, qy=p[1]-py-oy, qz=p[2]-pz-oz;
      var lx=rot[0]*qx+rot[3]*qy+rot[6]*qz;
      var ly=rot[1]*qx+rot[4]*qy+rot[7]*qz;
      var lz=rot[2]*qx+rot[5]*qy+rot[8]*qz;
      scw=sc([(lx+px)*mmToWorld, (ly+py)*mmToWorld, (lz+pz)*mmToWorld]);
      if(!(scw>-1e20&&scw<1e20)) scw=1e3;
      sm=scw*worldToMm - iso;        // + iso = thicker walls (neg-inside)
    }
    if(solidDist){
      var ds=solidDist(p[0],p[1],p[2]);
      if(anchorMm>0){
        if(ds<-anchorD0) sh-=anchorMm*smoothstep01((-ds-anchorD0)/anchorRamp);
      } else if(ds<gradeMm){
        sm-=gradeMax*smoothstep01(1-(ds>0?ds:0)/gradeMm);
      }
    }
    if(skinMm>0){                    // wall along the shape surface (m32 skin, neg-inside form)
      var inner=sm<-(skinMm+sh)?sm:-(skinMm+sh);
      return inner>sh?inner:sh;
    }
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
  // v0.12.0 join rules: solid members' raw shapes feed the lattice members.
  var jn=(opts&&opts.join)||weldJoinFromSpecs(specs);
  var shps=specs.map(function(sp){ return makeShapeSampler(sp.shapeSdfData, sp.shapeN, sp.bbox, sp.shapeCrop||null); });
  var jctx=null;
  if(jn && ((jn.rule==='anchor'&&jn.anchorMm>0) || (jn.rule==='graded'&&jn.gradeMm>0))){
    var solidShps=[];
    for(var si=0;si<specs.length;si++) if(weldIsSolidSpec(specs[si])) solidShps.push(shps[si]);
    var ns=solidShps.length;
    if(ns && ns<specs.length){
      jctx={anchorMm:jn.rule==='anchor'?jn.anchorMm:0, gradeMm:jn.rule==='graded'?jn.gradeMm:0, gradeMaxMm:jn.gradeMaxMm||0,
        solidDist:function(x,y,z){ var d=solidShps[0](x,y,z); for(var j=1;j<ns;j++){ var e=solidShps[j](x,y,z); if(e<d)d=e; } return d; }};
    }
  }
  var mem=specs.map(function(sp,i){ return composeMember(sp, shps[i], jctx); }), n=mem.length;
  var reach=(!rawPreview && opts && opts.reachMm>0) ? opts.reachMm : 0;
  // An anchored lattice reaches anchorMm past its own shape inside a solid.
  if(reach && jctx && jctx.anchorMm>0) reach+=jctx.anchorMm;
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
