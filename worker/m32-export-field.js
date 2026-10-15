/* ============================================================
   F13LD.mesh · worker/m32-export-field.js
   Shape-clipped export field (v0.11.0). Moved here unchanged from
   m90-onmessage.js so the mesh worker and the field bake workers
   (field-bake-worker.js) build exactly the same function: the shape SDF
   sampler, structure transform, trim-to-nodes mask and the
   min(scaffold, shape) composition in Manifold's positive-inside convention.

   buildShapeExportField(d, sdfFn, post)
     d      the export message (shapeSdfData, shapeN, bbox, cellSizeMm,
            relEdgeMm, structXform, pruneToNodes, pruneInsetMult, recipe)
     sdfFn  buildSDF(d.recipe, shapeCtx) — canonical negative-inside, world
     post   progress callback ({type:'progress', stage}); a no-op in bake workers
   returns {fn, setEdge}: fn is the levelSet callback; setEdge(e) sets the
   voxel edge its far-outside short-circuit uses (coarse vs fine pass).
   ============================================================ */
'use strict';
// The shapeCtx buildSDF gets for an export message (null for open-cube and
// weld exports). Shared so bake workers build the same lattice field.
function exportShapeCtx(d){
  return (d.mode==='export'&&d.shapeSdfData)?{
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
}
// The whole levelSet callback for a single-body export, as the mesh worker
// uses it for the pass whose voxel edge is `edge`: the shape-clipped field
// (with its short-circuit at that edge), or the open-cube sign flip.
function buildExportField(d, edge, post){
  const sdfFn=buildSDF(d.recipe, exportShapeCtx(d));
  if(d.shapeSdfData){
    const sf=buildShapeExportField(d, sdfFn, post||function(){});
    sf.setEdge(edge);
    return sf.fn;
  }
  return p=>-sdfFn(p);
}
function buildShapeExportField(d, sdfFn, post){
  const{relEdgeMm,bbox,shapeSdfData,shapeN}=d;
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
  return {fn:wrappedSDF, setEdge:function(e){ currentVoxelEdge=e; }};
}
