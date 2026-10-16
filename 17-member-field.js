/* ============================================================
   F13LD.mesh · 17-member-field.js
   Plain-JS reference of the P2 scene field (docs/P2_SCENE_SHADER_SCOPE.md
   §4.3): one member, one weld group, the whole scene, in absolute mm,
   negative inside. It mirrors the GLSL scene shader step for step and is
   checked against the export field (worker/m30, worker/m32) by
   tests/previewparity.js. Pure functions over plain data: no app state, no
   load-time dependencies. Part prep's CPU sampler will move onto it later.

   Plain objects (all lengths in mm unless named …W = lattice world units):
   scene  = {members:[member…], groups:[group…], sources:[source…]}
   member = {
     shape:      {data, n:[nx,ny,nz], minMm:[x,y,z], maxMm:[x,y,z]} | null
                 data: Float32Array nx·ny·nz, x fastest, mm distance, negative
                 inside, sampled at voxel centres (the preview shape grid).
                 null = no clip. Optional exterior:'add' = the export's rule
                 outside the box (tests only; the preview uses the bound).
     bboxMm:     {mnx,mny,mnz,mxx,mxy,mxz} part box; its centre is the lattice
                 pivot (absent: the shape box)
     kind:       'solid' | 'lattice'
     srcIndex:   index into scene.sources (lattice members)
     cellMm:     lattice cell size
     rotT:       9 numbers, Rᵀ column-major (structureTransform.rotMat)
     shiftMm:    [x,y,z] structure shift
     isoMm:      wall offset, + = thicker walls
     fill:       'solid' | 'lattice' | 'skin';  skinMm: skin wall
     groupIndex: index into scene.groups (a standalone part is a group of one)
     vis:        'solid' | 'ghost' | 'hidden'  (ghost and hidden are not in
                 the scene field; ghosts draw as shells elsewhere)
   }
   group  = {filletMm, rule:'union'|'anchor'|'graded', anchorMm, gradeMm,
             gradeMaxMm (0 = 0.15 × the lattice member's cell)}
   source = {kind:'tile'|'region', data: Float32Array nx·ny·nz (x fastest,
             voxel centres, the bake's values), n:[nx,ny,nz], minW:[3],
             maxW:[3] (box in lattice world = mm·10/cell), isSdf (value is
             used as is), fieldMin, fieldMax (the texture's decode range),
             topology:{center, halfW, topoMode:'sheet'|'half'|'solid',
             halfInvert, rawUnits} (raw sources)}
   A tile wraps like GL REPEAT + LINEAR, a region clamps like CLAMP_TO_EDGE.
   ============================================================ */
'use strict';

function mfSmoothstep01(t){ t=t<0?0:(t>1?1:t); return t*t*(3-2*t); }
// §4.3.6 smooth union (worker/m30 unionSmin).
function smin(a, b, k){
  if(k<=1e-6) return Math.min(a,b);
  const h=Math.max(k-Math.abs(a-b),0)/k;
  return Math.min(a,b)-h*h*k*0.25;
}
// Trilinear lookup on voxel centres, as a LINEAR 3D texture does: u in
// texture coordinates, wrap = REPEAT, otherwise CLAMP_TO_EDGE.
function mfTexel(data, nx, ny, nz, u, v, w, wrap){
  const x=u*nx-0.5, y=v*ny-0.5, z=w*nz-0.5;
  const x0=Math.floor(x), y0=Math.floor(y), z0=Math.floor(z);
  const tx=x-x0, ty=y-y0, tz=z-z0;
  const ix=(i,n)=>wrap?((i%n)+n)%n:(i<0?0:(i>=n?n-1:i));
  const xa=ix(x0,nx), xb=ix(x0+1,nx), sy=nx, sz=nx*ny;
  const ya=ix(y0,ny)*sy, yb=ix(y0+1,ny)*sy, za=ix(z0,nz)*sz, zb=ix(z0+1,nz)*sz;
  const c00=data[xa+ya+za]+(data[xb+ya+za]-data[xa+ya+za])*tx;
  const c10=data[xa+yb+za]+(data[xb+yb+za]-data[xa+yb+za])*tx;
  const c01=data[xa+ya+zb]+(data[xb+ya+zb]-data[xa+ya+zb])*tx;
  const c11=data[xa+yb+zb]+(data[xb+yb+zb]-data[xa+yb+zb])*tx;
  const c0=c00+(c10-c00)*ty, c1=c01+(c11-c01)*ty;
  return c0+(c1-c0)*tz;
}
// §4.3.1 shape distance (mm). Outside the grid box: P1's lower bound
// max(boxDist, clampedValue − boxDist) (20-raymarcher sampleShape), so marching
// stays safe; the weld export adds the box distance there instead
// (shape.exterior = 'add' reproduces that, for tests only).
function memberShapeMm(shape, p, exterior){
  if(!shape) return -1e9;
  const mn=shape.minMm, mx=shape.maxMm, n=shape.n;
  let u=(p[0]-mn[0])/(mx[0]-mn[0]), v=(p[1]-mn[1])/(mx[1]-mn[1]), w=(p[2]-mn[2])/(mx[2]-mn[2]);
  if(u<0||u>1||v<0||v>1||w<0||w>1){
    const qx=Math.max(mn[0]-p[0],p[0]-mx[0],0), qy=Math.max(mn[1]-p[1],p[1]-mx[1],0), qz=Math.max(mn[2]-p[2],p[2]-mx[2],0);
    const bd=Math.sqrt(qx*qx+qy*qy+qz*qz);
    u=u<0?0:(u>1?1:u); v=v<0?0:(v>1?1:v); w=w<0?0:(w>1?1:w);
    const dc=mfTexel(shape.data,n[0],n[1],n[2],u,v,w,false);
    return (exterior||shape.exterior)==='add' ? dc+bd : Math.max(bd, dc-bd);
  }
  return mfTexel(shape.data,n[0],n[1],n[2],u,v,w,false);
}
// Texture value → field value: sampleRaw (decode, clamped to the range like an
// 8-bit texture) + rawToSDF (raw sources: normalise, then topology).
function mfDecode(src, r){
  const fmin=src.fieldMin, fmax=src.fieldMax;
  if(r<fmin) r=fmin; else if(r>fmax) r=fmax;
  if(src.isSdf) return r;
  const t=src.topology||{};
  const fmid=(fmin+fmax)*0.5, fhr=Math.max((fmax-fmin)*0.5,0.001);
  const center=t.rawUnits?(((t.center!=null?t.center:0)-fmid)/fhr):(t.center!=null?t.center:0);
  const halfW=t.rawUnits?((t.halfW!=null?t.halfW:0.15)/fhr):(t.halfW!=null?t.halfW:0.15);
  const adj=(r-fmid)/fhr-center;
  if(t.topoMode==='half') return t.halfInvert?adj:-adj;
  if(t.topoMode==='solid') return halfW-Math.abs(adj);
  return Math.abs(adj)-halfW;
}
// §4.3.3 lattice value at lattice-world point x (tile: REPEAT, region: clamp).
function mfSourceValue(src, x){
  const mn=src.minW, mx=src.maxW, n=src.n, tile=src.kind==='tile';
  let u=(x[0]-mn[0])/(mx[0]-mn[0]), v=(x[1]-mn[1])/(mx[1]-mn[1]), w=(x[2]-mn[2])/(mx[2]-mn[2]);
  if(!tile){ u=u<0?0:(u>1?1:u); v=v<0?0:(v>1?1:v); w=w<0?0:(w>1?1:w); }
  return mfDecode(src, mfTexel(src.data,n[0],n[1],n[2],u,v,w,tile));
}
function mfIsSolid(m){ return m.kind==='solid' || m.fill==='solid'; }
function mfDrawn(m){ return m.vis!=='ghost' && m.vis!=='hidden'; }
// The member's pivot: centre of its part box (or its shape box).
function mfPivot(m){
  const b=m.bboxMm;
  if(b) return [(b.mnx+b.mxx)*0.5,(b.mny+b.mxy)*0.5,(b.mnz+b.mxz)*0.5];
  const s=m.shape;
  return s?[(s.minMm[0]+s.maxMm[0])*0.5,(s.minMm[1]+s.maxMm[1])*0.5,(s.minMm[2]+s.maxMm[2])*0.5]:[0,0,0];
}
// §4.3 steps 1–5 for one member at pMm → {f, sh, sm} (mm, negative inside).
// groupSolids: the group's drawn solid members (join rules read their shapes);
// src: this member's source (lattice members).
function memberFieldMm(member, group, groupSolids, src, pMm){
  let sh=memberShapeMm(member.shape, pMm);
  if(mfIsSolid(member)) return {f:sh, sh, sm:NaN};
  // 2. lattice frame: q = p − P − shift, l = Rᵀ·q (column-major), x = (l + P)·10/cell
  const P=mfPivot(member), s=member.shiftMm||[0,0,0], A=member.rotT||[1,0,0,0,1,0,0,0,1];
  const qx=pMm[0]-P[0]-s[0], qy=pMm[1]-P[1]-s[1], qz=pMm[2]-P[2]-s[2];
  const k=10/member.cellMm;
  const x=[(A[0]*qx+A[3]*qy+A[6]*qz+P[0])*k, (A[1]*qx+A[4]*qy+A[7]*qz+P[1])*k, (A[2]*qx+A[5]*qy+A[8]*qz+P[2])*k];
  // 3. value → mm, wall offset
  let val=src?mfSourceValue(src,x):1e3;
  if(!(val>-1e20&&val<1e20)) val=1e3;
  let sm=val*member.cellMm/10-(+member.isoMm||0);
  // 4. join rules (a group with at least one solid and one lattice member)
  if(group && groupSolids && groupSolids.length){
    const rule=group.rule||'union';
    const anchor=rule==='anchor'?(+group.anchorMm||0):0, grade=rule==='graded'?(+group.gradeMm||0):0;
    if(anchor>0 || grade>0){
      let ds=Infinity;
      // v0.14.0: the join distance uses the export's rule outside a box (it is
      // never marched), as the shader does.
      for(const g of groupSolids){ const d=memberShapeMm(g.shape,pMm,'add'); if(d<ds) ds=d; }
      if(anchor>0){
        const d0=anchor*0.25;   // none above d0 deep, full at 2·d0
        if(ds<-d0) sh-=anchor*mfSmoothstep01((-ds-d0)/d0);
      } else if(ds<grade){
        const gMax=(group.gradeMaxMm>0)?+group.gradeMaxMm:0.15*member.cellMm;
        sm-=gMax*mfSmoothstep01(1-(ds>0?ds:0)/grade);
      }
    }
  }
  // 5. fill
  const skin=(member.fill==='skin' && member.skinMm>0)?+member.skinMm:0;
  const f=skin>0?Math.max(sh, Math.min(sm, -(skin+sh))):Math.max(sm, sh);
  return {f, sh, sm};
}
// §4.3.6 one weld group: smooth union of its drawn members with the fillet.
// No gradient normalisation (preview = rawPreview).
function groupFieldMm(members, group, sources, pMm){
  const live=members.filter(mfDrawn), solids=live.filter(mfIsSolid);
  const k=group?(+group.filletMm||0):0;
  let acc=1e9;
  for(const m of live) acc=smin(acc, memberFieldMm(m, group, solids, mfIsSolid(m)?null:sources[m.srcIndex], pMm).f, k);
  return acc;
}
// §4.3.7 the scene: min over groups (parts that aren't welded don't blend).
function sceneFieldMm(scene, pMm){
  const byGroup=new Map();
  scene.members.forEach((m,i)=>{
    const g=(m.groupIndex!=null)?m.groupIndex:('own'+i);
    if(!byGroup.has(g)) byGroup.set(g,[]);
    byGroup.get(g).push(m);
  });
  let d=1e9;
  byGroup.forEach((ms,g)=>{
    const v=groupFieldMm(ms, typeof g==='number'?scene.groups[g]:null, scene.sources||[], pMm);
    if(v<d) d=v;
  });
  return d;
}
