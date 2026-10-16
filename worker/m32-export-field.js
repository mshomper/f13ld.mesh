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
  // v0.12.0: setup shared with weld members (m30 structXformSetup), same values.
  const xfS = structXformSetup(d.structXform, bbox);
  const xfRot = xfS.rot;
  const xfOffMmX = xfS.ox, xfOffMmY = xfS.oy, xfOffMmZ = xfS.oz;
  // ── Iso offset sign convention (canonical, v0.5.0-rc9) ───────────────
  // Worker SDF builders now return canonical NEGATIVE-INSIDE (see the
  // "CANONICAL SDF CONVENTION" block above buildSDF). In that convention,
  // +isoOffsetMm = thicker walls means SUBTRACT iso from the SDF (pushes
  // zero-crossing outward so more of space is inside). The negation to
  // Manifold's positive-inside happens below in wrappedSDF composition,
  // so after the flip the iso term appears as "+ xfIsoMm". Matches the
  // shader: rawToSDF returns negative-inside; setStructureTransform
  // passes -isoOffsetMm to uStructIsoWorld so shader does (sc - iso_w).
  const xfIsoMm = xfS.iso;
  // Pivot is shape center in mm.
  const xfPivotMmX = xfS.px;
  const xfPivotMmY = xfS.py;
  const xfPivotMmZ = xfS.pz;
  // Detect identity to skip transform math in the hot loop (every voxel).
  // Iso offset must also be zero — otherwise the identity-fast-path
  // would silently drop it (the fast-path branch doesn't apply iso).
  const xfIsIdentity = xfS.identity;
  // v0.12.0 skin fill: d.fill==='skin' adds a solid wall skinMm thick along the
  // shape surface (shape depth < skinMm), in Manifold's positive-inside terms
  //   field = min(sh, max(sc, skinMm - sh)).
  // Absent / 'lattice' / skinMm<=0 leaves the field exactly as before.
  const skinMm = (d.fill==='skin' && d.skinMm>0) ? +d.skinMm : 0;
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
  // v0.12.0: the mask builder moved to m30-sdf-assembly.js (buildTrimmedBeamSDF,
  // code unchanged) so weld members can trim to their own shape the same way.
  const activeSdfFn = buildTrimmedBeamSDF(d, sampleShapeSDF, xfS, post) || sdfFn;
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
        if(skinMm>0){ const t=skinMm-sh_mm, inner=sc_mm>t?sc_mm:t; return sh_mm<inner?sh_mm:inner; }
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
        if(skinMm>0){ const t=skinMm-sh_mm, inner=sc_mm>t?sc_mm:t; return sh_mm<inner?sh_mm:inner; }
        return sc_mm<sh_mm?sc_mm:sh_mm;
      };
  return {fn:wrappedSDF, setEdge:function(e){ currentVoxelEdge=e; }};
}
