/* F13LD.mesh · worker/m21-sdf-beam.js — Beam capsule-lattice SDF builder. */
// ── Beam (capsule lattice) SDF builder ─────────────────────────────────────
// v0.5.0-rc16: F13LD.beam handoff. Beams are stored in cell-local [-1,+1]³
// coordinates as flat 6-element arrays [ax,ay,az,bx,by,bz]. Radius is in
// the same cell-local units (so wall thickness in mm = radius·cellSizeMm/2).
//
// World-to-cell mapping: one cell is cell_scale wide across world [-5,+5].
// Default cell_scale=1 (one cell fills the cube). Cell-local q[i] obtained
// by wrapping (p[i]·cell_scale/5) into [-1,+1] via mod-2-shift-1.
//
// Tiling: when q is within (radius+halo) of a face/edge/corner, also evaluate
// the capsule union over the 6 face / 12 edge / 8 corner neighbor cells with
// ±2 offset on the relevant axes — same scheme the beam tool's preview shader
// uses (index_-_beam.html lines 1526-1565). Halo = radius + 0.02 in cell-local
// units (matches beam tool, per Matt's sign-off).
//
// Returns canonical NEGATIVE-INSIDE in cell-local distance units. The caller
// (buildSDF) returns this directly; the existing wrappedSDF in the export path
// applies worldToMm = cellSizeMm/10 to convert to mm. Cell-local 1 unit =
// cellSizeMm/2 mm, so the world-units → mm scaling needs a 5× compensation:
// we scale the SDF output by 5 here, so 1 returned unit = 1 world unit
// (matching TPMS convention where SDF is in world units).
//
// v0.5.0-rc17: optional pruneCtx parameter enables per-tile beam masking for
// shape-mode export ("trim to nodes"). When provided, beams whose endpoints
// lie outside the shape (with inset margin) are excluded from the union for
// that specific lattice tile. Mask layout:
//   pruneCtx = { mask:Uint8Array, tXMin,tYMin,tZMin, NX,NY,NZ }
//   mask[((tz-tZMin)*NY*NX + (ty-tYMin)*NX + (tx-tXMin)) * BC + beamIdx]
// Tiles outside the pre-computed range get zero beams (safe: out-of-bbox
// regions correspond to outside the shape anyway, where the intersection
// with -shape will yield void).
//
// v0.5.0-rc22: F13LD.sweep v0.15.0+ schema additions, all backward-compatible:
//   geometry.scale_xyz:[sx,sy,sz] mm — per-axis cell sizes (anisotropic cells)
//   geometry.radius_x/y/z         mm — per-axis strut radii (anisotropic struts)
//   geometry.cell                 mm — geometric-mean cell size, ≈ geomean(scale_xyz)
//   geometry.node_smoothing_k     mm — smin radius at strut junctions (0 = hard min)
//   geometry.node_ball_radius     mm — sphere radius at unique nodes (0 = no balls)
//   beams[i][6]                      — sharing factor (parsed implicitly; unused)
//
// Conversion from mm-schema to mesh's cell-local convention:
//   cellScale_i = cell / scale_xyz[i]            (per-axis; geomean=1)
//   r_local_i   = 2·radius_xyz[i] / scale_xyz[i] (per-axis cell-local radius)
//   smin_local  = 2·node_smoothing_k / cell      (isotropic; normalized by cell)
//   ball_local  = 2·node_ball_radius / cell      (isotropic; normalized by cell)
// Old recipes (no scale_xyz / cell): falls through to scalar radius and cell_scale,
// identical behavior to v0.5.0-rc21.
//
// Per-strut effective radius via direction-weighted RMS in cell-local space:
//   r_strut[i] = sqrt(r_local_x²·ux² + r_local_y²·uy² + r_local_z²·uz²)
// where (ux,uy,uz) is the strut's unit direction in cell-local. Pre-computed
// once at SDF-build time; inner loop reads r_strut[i] instead of legacy scalar r.
//
// SDF return scaling: anisotropic cells have per-axis L2W_i. Inner capsule
// distance is in cell-local-isotropic units; we return d · geomean(L2W_x/y/z).
// Geomean equals 5 by construction (since geomean(cellScale)=1), so isotropic
// recipes are bit-identical to v0.5.0-rc21.
// v0.8.2: worst-case physical strut radius in mm at the user's cell size.
// Derived from buildBeamSDF's own unit chain: cell-local radius r spans a
// [-1,1] cell, world = local·5/cellScale, mm = world·cellSizeMm/10, so
// r_mm = r·cellSizeMm/(2·cellScale). New schema: r = 2·radius_x/scale_x and
// cellScale = cell/scale_x, giving radius_x·cellSizeMm/cell. Old schema:
// radius·cellSizeMm/(2·cell_scale). Used by trim-to-nodes for its inset.
function beamStrutRadiusMm(geom, cellSizeMm){
  geom=geom||{};
  let sxyz=null;
  if(Array.isArray(geom.scale_xyz)&&geom.scale_xyz.length===3&&geom.scale_xyz.every(v=>isFinite(v)&&v>0)) sxyz=geom.scale_xyz;
  else if([geom.cell_scale_x,geom.cell_scale_y,geom.cell_scale_z].every(v=>typeof v==='number'&&v>0)) sxyz=[geom.cell_scale_x,geom.cell_scale_y,geom.cell_scale_z];
  const cell=geom.cell, isNew=sxyz!==null&&typeof cell==='number'&&isFinite(cell)&&cell>0;
  if(isNew&&typeof geom.radius_x==='number'&&geom.radius_x>=0){
    const rx=geom.radius_x;
    const ry=(typeof geom.radius_y==='number'&&geom.radius_y>=0)?geom.radius_y:rx;
    const rz=(typeof geom.radius_z==='number'&&geom.radius_z>=0)?geom.radius_z:rx;
    return Math.max(rx,ry,rz)*cellSizeMm/cell;
  }
  const r=(typeof geom.radius==='number'&&geom.radius>=0)?geom.radius:0.1;
  const cs=isNew?1:((typeof geom.cell_scale==='number'&&geom.cell_scale>0)?geom.cell_scale:1);
  return r*cellSizeMm/(2*cs);
}
function buildBeamSDF(json, pruneCtx){
  const beams=json.beams||[];
  const geom=json.geometry||{};

  // ── Schema detection: scale_xyz OR cell_scale_x/y/z + cell ⇒ new schema.
  // v0.5.0-rc25: sweep v0.15.0 emits cell_scale_x/y/z (per-axis mm cell sizes
  // for beam family — distinct from TPMS convention where cell_scale_x is a
  // unitless frequency multiplier). Same field name, different semantics
  // across families; the disambiguator is the presence of geom.cell (mm),
  // which beam recipes have and TPMS recipes never do. We do not enter this
  // code path for TPMS anyway (buildTPMSSDF handles those), so the
  // field-name collision is safe to ignore here.
  let sxyz=null;
  if(Array.isArray(geom.scale_xyz)&&geom.scale_xyz.length===3
     &&isFinite(geom.scale_xyz[0])&&isFinite(geom.scale_xyz[1])&&isFinite(geom.scale_xyz[2])
     &&geom.scale_xyz[0]>0&&geom.scale_xyz[1]>0&&geom.scale_xyz[2]>0){
    sxyz=geom.scale_xyz;
  } else if(typeof geom.cell_scale_x==='number'&&geom.cell_scale_x>0
         && typeof geom.cell_scale_y==='number'&&geom.cell_scale_y>0
         && typeof geom.cell_scale_z==='number'&&geom.cell_scale_z>0){
    sxyz=[geom.cell_scale_x, geom.cell_scale_y, geom.cell_scale_z];
  }
  const cellMm=geom.cell;
  const hasScaleXYZ = sxyz!==null;
  const hasCell=(typeof cellMm==='number')&&isFinite(cellMm)&&cellMm>0;
  const isNew=hasScaleXYZ&&hasCell;

  // Per-axis cellScale (mesh's convention: cells per world-span [-5,+5]).
  // New schema: derived from cell/scale_xyz. Old schema: scalar cell_scale.
  let cellScaleX, cellScaleY, cellScaleZ;
  if(isNew){
    cellScaleX = cellMm / sxyz[0];
    cellScaleY = cellMm / sxyz[1];
    cellScaleZ = cellMm / sxyz[2];
  } else {
    const cs=(typeof geom.cell_scale==='number'&&geom.cell_scale>0)?geom.cell_scale:1;
    cellScaleX = cellScaleY = cellScaleZ = cs;
  }

  // Per-axis cell-local radii.
  // New schema: radius_x/y/z (mm) converted via 2·radius/scale_xyz.
  // Falls through field-by-field (radius_y/z optional, fall back to radius_x).
  // Old schema: scalar radius (already cell-local).
  let rLocX, rLocY, rLocZ;
  if(isNew && typeof geom.radius_x==='number' && geom.radius_x>=0){
    const rx=geom.radius_x;
    const ry=(typeof geom.radius_y==='number'&&geom.radius_y>=0)?geom.radius_y:rx;
    const rz=(typeof geom.radius_z==='number'&&geom.radius_z>=0)?geom.radius_z:rx;
    rLocX = 2*rx / sxyz[0];
    rLocY = 2*ry / sxyz[1];
    rLocZ = 2*rz / sxyz[2];
  } else {
    const r=(typeof geom.radius==='number'&&geom.radius>=0)?geom.radius:0.1;
    rLocX = rLocY = rLocZ = r;
  }

  // Node smoothing / ball radii (cell-local, isotropic, normalized by cell).
  // Both default to 0 when missing or zero → behavior reduces to legacy hard-min
  // union with no node decorations. Only consulted when isNew (mm-units required).
  const sminLocal = (isNew && typeof geom.node_smoothing_k==='number' && geom.node_smoothing_k>0)
    ? (2*geom.node_smoothing_k / cellMm) : 0;
  const ballLocal = (isNew && typeof geom.node_ball_radius==='number' && geom.node_ball_radius>0)
    ? (2*geom.node_ball_radius / cellMm) : 0;
  const useSmin = sminLocal > 0;
  const useBalls = ballLocal > 0;

  // Per-axis world ↔ cell-local conversions.
  const W2Lx=cellScaleX/5, W2Ly=cellScaleY/5, W2Lz=cellScaleZ/5;
  const L2Wx=5/cellScaleX, L2Wy=5/cellScaleY, L2Wz=5/cellScaleZ;
  // Geometric-mean cell-local→world scale for the SDF return value.
  // Equals 5 exactly when geomean(cellScale)=1 (always true under new schema
  // by construction; equals 5/cellScale for legacy isotropic recipes).
  const L2Wgeo = Math.cbrt(L2Wx*L2Wy*L2Wz);

  // Pre-extract beam endpoints into typed arrays for tight inner loop.
  // beams[i][6] (sharing factor) is left unread — informational only.
  const N=beams.length;
  const ax=new Float64Array(N), ay=new Float64Array(N), az=new Float64Array(N);
  const bx=new Float64Array(N), by=new Float64Array(N), bz=new Float64Array(N);
  const rStrut=new Float64Array(N);  // per-strut effective radius (cell-local)
  let maxR=0;
  for(let i=0;i<N;i++){
    const b=beams[i];
    ax[i]=b[0]; ay[i]=b[1]; az[i]=b[2];
    bx[i]=b[3]; by[i]=b[4]; bz[i]=b[5];
    // Direction-weighted RMS radius. Unit direction (ux,uy,uz) in cell-local.
    const ex=b[3]-b[0], ey=b[4]-b[1], ez=b[5]-b[2];
    const elen=Math.sqrt(ex*ex+ey*ey+ez*ez);
    if(elen>1e-12){
      const ux=ex/elen, uy=ey/elen, uz=ez/elen;
      rStrut[i]=Math.sqrt(rLocX*rLocX*ux*ux + rLocY*rLocY*uy*uy + rLocZ*rLocZ*uz*uz);
    } else {
      // Zero-length strut — degenerate; fall back to RMS of axis radii.
      rStrut[i]=Math.sqrt((rLocX*rLocX + rLocY*rLocY + rLocZ*rLocZ)/3);
    }
    if(rStrut[i]>maxR) maxR=rStrut[i];
  }

  // Pre-compute unique node positions (deduplicated endpoints) for node-ball
  // union. Rounded to a small tolerance to handle FP artifacts. Only built
  // when useBalls so the empty-case has zero memory cost.
  let nodeX=null, nodeY=null, nodeZ=null;
  let nodeCount=0;
  if(useBalls){
    const TOL=1e-5, INV_TOL=1/TOL;
    const seen=new Map();
    const tmpX=[], tmpY=[], tmpZ=[];
    for(let i=0;i<N;i++){
      // endpoint A
      const kxA=Math.round(ax[i]*INV_TOL), kyA=Math.round(ay[i]*INV_TOL), kzA=Math.round(az[i]*INV_TOL);
      const keyA=kxA+','+kyA+','+kzA;
      if(!seen.has(keyA)){ seen.set(keyA,true); tmpX.push(ax[i]); tmpY.push(ay[i]); tmpZ.push(az[i]); }
      // endpoint B
      const kxB=Math.round(bx[i]*INV_TOL), kyB=Math.round(by[i]*INV_TOL), kzB=Math.round(bz[i]*INV_TOL);
      const keyB=kxB+','+kyB+','+kzB;
      if(!seen.has(keyB)){ seen.set(keyB,true); tmpX.push(bx[i]); tmpY.push(by[i]); tmpZ.push(bz[i]); }
    }
    nodeX=new Float64Array(tmpX);
    nodeY=new Float64Array(tmpY);
    nodeZ=new Float64Array(tmpZ);
    nodeCount=tmpX.length;
  }

  // Halo for boundary-tile evaluation. Use the LARGEST per-strut radius
  // so we never miss a contributing capsule near a face. Smin blend radius
  // and node ball radius both extend the influence zone — add both.
  const halo = maxR + sminLocal + ballLocal + 0.02;

  // Polynomial smooth-min (Inigo Quilez). Matches F13LD.bundle's smin_k.
  // k=0 ⇒ degenerates to hard min (no allocation, no blend).
  function smin(a, b, k){
    if(k <= 0) return a < b ? a : b;
    const diff = a > b ? a-b : b-a;
    const h = (k - diff) > 0 ? (k - diff)/k : 0;
    return (a < b ? a : b) - h*h*h*k*(1/6);
  }

  // Capsule SDF — distance from q to each strut(a,b) minus per-strut radius.
  // q,a,b are all in cell-local [-1,+1] units. Optional smin between unions
  // and optional node sphere union (both gated by closure-bound flags).
  function capsuleUnion(qx,qy,qz){
    let d=1e6;
    for(let i=0;i<N;i++){
      const dx=qx-ax[i], dy=qy-ay[i], dz=qz-az[i];
      const ex=bx[i]-ax[i], ey=by[i]-ay[i], ez=bz[i]-az[i];
      const ll=ex*ex+ey*ey+ez*ez;
      let h=ll>1e-12?(dx*ex+dy*ey+dz*ez)/ll:0;
      if(h<0)h=0; else if(h>1)h=1;
      const px=dx-ex*h, py=dy-ey*h, pz=dz-ez*h;
      const di=Math.sqrt(px*px+py*py+pz*pz)-rStrut[i];
      d = useSmin ? smin(d, di, sminLocal) : (di<d ? di : d);
    }
    if(useBalls){
      for(let n=0;n<nodeCount;n++){
        const dx=qx-nodeX[n], dy=qy-nodeY[n], dz=qz-nodeZ[n];
        const di=Math.sqrt(dx*dx+dy*dy+dz*dz)-ballLocal;
        d = useSmin ? smin(d, di, sminLocal) : (di<d ? di : d);
      }
    }
    return d;
  }

  // Mask-gated capsule union: same union math as capsuleUnion but skips
  // struts whose mask byte is 0 for the given tile. Returns 1e6 when tile
  // is out of mask range (treated as "no struts here"). Node balls are not
  // masked — they belong to the lattice as designed, not per-trimmed-strut.
  function capsuleUnionMasked(qx,qy,qz,tileBase,mask){
    if(tileBase<0) return 1e6;
    let d=1e6;
    for(let i=0;i<N;i++){
      if(!mask[tileBase+i]) continue;
      const dx=qx-ax[i], dy=qy-ay[i], dz=qz-az[i];
      const ex=bx[i]-ax[i], ey=by[i]-ay[i], ez=bz[i]-az[i];
      const ll=ex*ex+ey*ey+ez*ez;
      let h=ll>1e-12?(dx*ex+dy*ey+dz*ez)/ll:0;
      if(h<0)h=0; else if(h>1)h=1;
      const px=dx-ex*h, py=dy-ey*h, pz=dz-ez*h;
      const di=Math.sqrt(px*px+py*py+pz*pz)-rStrut[i];
      d = useSmin ? smin(d, di, sminLocal) : (di<d ? di : d);
    }
    if(useBalls){
      for(let n=0;n<nodeCount;n++){
        const dx=qx-nodeX[n], dy=qy-nodeY[n], dz=qz-nodeZ[n];
        const di=Math.sqrt(dx*dx+dy*dy+dz*dz)-ballLocal;
        d = useSmin ? smin(d, di, sminLocal) : (di<d ? di : d);
      }
    }
    return d;
  }

  // ── Un-pruned path (preview, cube-mode export, or shape-mode without trim)
  if(!pruneCtx){
    return p=>{
      // Map world point to cell-local q in [-1,+1] (per-axis under new schema)
      const lx=p[0]*W2Lx, ly=p[1]*W2Ly, lz=p[2]*W2Lz;
      // Wrap to single cell.
      const qx=((lx+1)-2*Math.floor((lx+1)/2))-1;
      const qy=((ly+1)-2*Math.floor((ly+1)/2))-1;
      const qz=((lz+1)-2*Math.floor((lz+1)/2))-1;

      let d=capsuleUnion(qx,qy,qz);

      const nx_=qx>1-halo, px_=qx<-1+halo;
      const ny_=qy>1-halo, py_=qy<-1+halo;
      const nz_=qz>1-halo, pz_=qz<-1+halo;

      if(nx_||px_||ny_||py_||nz_||pz_){
        if(nx_) d=Math.min(d,capsuleUnion(qx-2,qy,qz));
        if(px_) d=Math.min(d,capsuleUnion(qx+2,qy,qz));
        if(ny_) d=Math.min(d,capsuleUnion(qx,qy-2,qz));
        if(py_) d=Math.min(d,capsuleUnion(qx,qy+2,qz));
        if(nz_) d=Math.min(d,capsuleUnion(qx,qy,qz-2));
        if(pz_) d=Math.min(d,capsuleUnion(qx,qy,qz+2));
        if(nx_&&ny_) d=Math.min(d,capsuleUnion(qx-2,qy-2,qz));
        if(nx_&&py_) d=Math.min(d,capsuleUnion(qx-2,qy+2,qz));
        if(px_&&ny_) d=Math.min(d,capsuleUnion(qx+2,qy-2,qz));
        if(px_&&py_) d=Math.min(d,capsuleUnion(qx+2,qy+2,qz));
        if(nx_&&nz_) d=Math.min(d,capsuleUnion(qx-2,qy,qz-2));
        if(nx_&&pz_) d=Math.min(d,capsuleUnion(qx-2,qy,qz+2));
        if(px_&&nz_) d=Math.min(d,capsuleUnion(qx+2,qy,qz-2));
        if(px_&&pz_) d=Math.min(d,capsuleUnion(qx+2,qy,qz+2));
        if(ny_&&nz_) d=Math.min(d,capsuleUnion(qx,qy-2,qz-2));
        if(ny_&&pz_) d=Math.min(d,capsuleUnion(qx,qy-2,qz+2));
        if(py_&&nz_) d=Math.min(d,capsuleUnion(qx,qy+2,qz-2));
        if(py_&&pz_) d=Math.min(d,capsuleUnion(qx,qy+2,qz+2));
        if(nx_&&ny_&&nz_) d=Math.min(d,capsuleUnion(qx-2,qy-2,qz-2));
        if(nx_&&ny_&&pz_) d=Math.min(d,capsuleUnion(qx-2,qy-2,qz+2));
        if(nx_&&py_&&nz_) d=Math.min(d,capsuleUnion(qx-2,qy+2,qz-2));
        if(nx_&&py_&&pz_) d=Math.min(d,capsuleUnion(qx-2,qy+2,qz+2));
        if(px_&&ny_&&nz_) d=Math.min(d,capsuleUnion(qx+2,qy-2,qz-2));
        if(px_&&ny_&&pz_) d=Math.min(d,capsuleUnion(qx+2,qy-2,qz+2));
        if(px_&&py_&&nz_) d=Math.min(d,capsuleUnion(qx+2,qy+2,qz-2));
        if(px_&&py_&&pz_) d=Math.min(d,capsuleUnion(qx+2,qy+2,qz+2));
      }

      return d*L2Wgeo;
    };
  }

  // ── Pruned path (shape-mode export with trim-to-nodes) ─────────────────
  // Same neighbor-halo logic, but each capsuleUnion call consults the
  // appropriate tile's mask. Tile index for the current p_world matches
  // the wrap math: tile_x = floor((lx+1)/2) where lx = p_world*W2Lx (per axis).
  const {mask, tXMin, tYMin, tZMin, NX, NY, NZ}=pruneCtx;
  const NXY=NX*NY;
  // Compute mask base offset (in bytes) for tile (tx,ty,tz). Returns -1 if
  // out of precomputed range.
  function tileBaseOf(tx,ty,tz){
    const ix=tx-tXMin, iy=ty-tYMin, iz=tz-tZMin;
    if(ix<0||ix>=NX||iy<0||iy>=NY||iz<0||iz>=NZ) return -1;
    return ((iz*NY+iy)*NX+ix)*N;
  }
  return p=>{
    const lx=p[0]*W2Lx, ly=p[1]*W2Ly, lz=p[2]*W2Lz;
    const qx=((lx+1)-2*Math.floor((lx+1)/2))-1;
    const qy=((ly+1)-2*Math.floor((ly+1)/2))-1;
    const qz=((lz+1)-2*Math.floor((lz+1)/2))-1;
    // Tile index from world coords (matches the wrap math above)
    const tx=Math.floor((lx+1)/2);
    const ty=Math.floor((ly+1)/2);
    const tz=Math.floor((lz+1)/2);

    let d=capsuleUnionMasked(qx,qy,qz,tileBaseOf(tx,ty,tz),mask);

    const nx_=qx>1-halo, px_=qx<-1+halo;
    const ny_=qy>1-halo, py_=qy<-1+halo;
    const nz_=qz>1-halo, pz_=qz<-1+halo;

    if(nx_||px_||ny_||py_||nz_||pz_){
      // For each neighbor offset, look up that neighbor tile's mask.
      // qx-2 corresponds to neighbor at tx-1 (we crossed the boundary into
      // the previous tile's frame); qx+2 → tx+1.
      if(nx_) d=Math.min(d,capsuleUnionMasked(qx-2,qy,qz,tileBaseOf(tx-1,ty,tz),mask));
      if(px_) d=Math.min(d,capsuleUnionMasked(qx+2,qy,qz,tileBaseOf(tx+1,ty,tz),mask));
      if(ny_) d=Math.min(d,capsuleUnionMasked(qx,qy-2,qz,tileBaseOf(tx,ty-1,tz),mask));
      if(py_) d=Math.min(d,capsuleUnionMasked(qx,qy+2,qz,tileBaseOf(tx,ty+1,tz),mask));
      if(nz_) d=Math.min(d,capsuleUnionMasked(qx,qy,qz-2,tileBaseOf(tx,ty,tz-1),mask));
      if(pz_) d=Math.min(d,capsuleUnionMasked(qx,qy,qz+2,tileBaseOf(tx,ty,tz+1),mask));
      if(nx_&&ny_) d=Math.min(d,capsuleUnionMasked(qx-2,qy-2,qz,tileBaseOf(tx-1,ty-1,tz),mask));
      if(nx_&&py_) d=Math.min(d,capsuleUnionMasked(qx-2,qy+2,qz,tileBaseOf(tx-1,ty+1,tz),mask));
      if(px_&&ny_) d=Math.min(d,capsuleUnionMasked(qx+2,qy-2,qz,tileBaseOf(tx+1,ty-1,tz),mask));
      if(px_&&py_) d=Math.min(d,capsuleUnionMasked(qx+2,qy+2,qz,tileBaseOf(tx+1,ty+1,tz),mask));
      if(nx_&&nz_) d=Math.min(d,capsuleUnionMasked(qx-2,qy,qz-2,tileBaseOf(tx-1,ty,tz-1),mask));
      if(nx_&&pz_) d=Math.min(d,capsuleUnionMasked(qx-2,qy,qz+2,tileBaseOf(tx-1,ty,tz+1),mask));
      if(px_&&nz_) d=Math.min(d,capsuleUnionMasked(qx+2,qy,qz-2,tileBaseOf(tx+1,ty,tz-1),mask));
      if(px_&&pz_) d=Math.min(d,capsuleUnionMasked(qx+2,qy,qz+2,tileBaseOf(tx+1,ty,tz+1),mask));
      if(ny_&&nz_) d=Math.min(d,capsuleUnionMasked(qx,qy-2,qz-2,tileBaseOf(tx,ty-1,tz-1),mask));
      if(ny_&&pz_) d=Math.min(d,capsuleUnionMasked(qx,qy-2,qz+2,tileBaseOf(tx,ty-1,tz+1),mask));
      if(py_&&nz_) d=Math.min(d,capsuleUnionMasked(qx,qy+2,qz-2,tileBaseOf(tx,ty+1,tz-1),mask));
      if(py_&&pz_) d=Math.min(d,capsuleUnionMasked(qx,qy+2,qz+2,tileBaseOf(tx,ty+1,tz+1),mask));
      if(nx_&&ny_&&nz_) d=Math.min(d,capsuleUnionMasked(qx-2,qy-2,qz-2,tileBaseOf(tx-1,ty-1,tz-1),mask));
      if(nx_&&ny_&&pz_) d=Math.min(d,capsuleUnionMasked(qx-2,qy-2,qz+2,tileBaseOf(tx-1,ty-1,tz+1),mask));
      if(nx_&&py_&&nz_) d=Math.min(d,capsuleUnionMasked(qx-2,qy+2,qz-2,tileBaseOf(tx-1,ty+1,tz-1),mask));
      if(nx_&&py_&&pz_) d=Math.min(d,capsuleUnionMasked(qx-2,qy+2,qz+2,tileBaseOf(tx-1,ty+1,tz+1),mask));
      if(px_&&ny_&&nz_) d=Math.min(d,capsuleUnionMasked(qx+2,qy-2,qz-2,tileBaseOf(tx+1,ty-1,tz-1),mask));
      if(px_&&ny_&&pz_) d=Math.min(d,capsuleUnionMasked(qx+2,qy-2,qz+2,tileBaseOf(tx+1,ty-1,tz+1),mask));
      if(px_&&py_&&nz_) d=Math.min(d,capsuleUnionMasked(qx+2,qy+2,qz-2,tileBaseOf(tx+1,ty+1,tz-1),mask));
      if(px_&&py_&&pz_) d=Math.min(d,capsuleUnionMasked(qx+2,qy+2,qz+2,tileBaseOf(tx+1,ty+1,tz+1),mask));
    }

    return d*L2Wgeo;
  };
}

// ── Registry (v0.9.0) ───────────────────────────────────────────────────────
registerSDF('beam', { build(recipe){ return buildBeamSDF(recipe.json); }, trimToNodes: true });
