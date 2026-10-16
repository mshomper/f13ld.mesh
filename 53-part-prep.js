/* ============================================================
   F13LD.mesh · 53-part-prep.js  (v0.10.0)
   Part preparation for 3D printing: process + material (52-materials.js),
   build orientation, print view, live estimate from the preview field,
   exact numbers from the exported mesh, and a Markdown print report.

   Frames. "Part frame" is the design / CAD frame the viewer and the
   exporter already use. "Print frame" has +Z pointing up out of the
   build plate. R (row-major 3×3) maps part → print:
       R = Ry(tiltY) · Rx(tiltX) · Rup
   Rup turns the chosen part axis to +Z. At +Z with no tilt R = I and the
   export is byte-identical to earlier versions (design position kept).
   Otherwise the exported part is rotated about its bounding-box centre,
   centred in X/Y and set on the plate (lowest point at Z = 0).

   Overhang angle convention: the tilt of a downward-facing surface from
   horizontal (0° = flat face pointing straight down). A surface tilted
   less than the overhang limit needs support.
   ============================================================ */
'use strict';

// ── State (remembered per browser) ─────────────────────────────────────────
const PP_STORE_KEY='f13ld.mesh.partPrep.v1';
const PP_UP_CODES=['+Z','-Z','+X','-X','+Y','-Y'];
const partPrep=(function(){
  const d={proc:'lpbf', mat:'ti64-g23-lpbf-asbuilt', customRho:1.15, up:'+Z', tiltX:0, tiltY:0, critDeg:45, printView:false, plateOpacity:90, standoff:0};
  try{
    const s=JSON.parse(localStorage.getItem(PP_STORE_KEY)||'null');
    if(s && typeof s==='object'){
      if(typeof s.proc==='string') d.proc=s.proc;
      if(typeof s.mat==='string') d.mat=s.mat;
      if(isFinite(s.customRho)&&s.customRho>0) d.customRho=+s.customRho;
      if(PP_UP_CODES.includes(s.up)) d.up=s.up;
      if(isFinite(s.tiltX)) d.tiltX=+s.tiltX;
      if(isFinite(s.tiltY)) d.tiltY=+s.tiltY;
      if(isFinite(s.critDeg)) d.critDeg=+s.critDeg;
      if(isFinite(s.plateOpacity)) d.plateOpacity=Math.max(0,Math.min(100,+s.plateOpacity));
      if(isFinite(s.standoff)) d.standoff=Math.max(0,+s.standoff);
    }
  }catch(_){}
  return d;
})();
function ppSave(){
  try{ localStorage.setItem(PP_STORE_KEY, JSON.stringify({proc:partPrep.proc, mat:partPrep.mat, customRho:partPrep.customRho,
    up:partPrep.up, tiltX:partPrep.tiltX, tiltY:partPrep.tiltY, critDeg:partPrep.critDeg, plateOpacity:partPrep.plateOpacity, standoff:partPrep.standoff})); }catch(_){}
  if(typeof dockRefresh==='function') dockRefresh();   // v0.12.0: dock tags
}
let ppLast=null;          // exact stats of the last export (rendered in the panel)
let ppLastEst=null;       // last live estimate

// ── Material / density ───────────────────────────────────────────────────────
function ppMaterial(){ return partPrep.mat==='custom'?null:ppFindMaterial(partPrep.mat); }
// g/cm³
function ppDensity(){
  const m=ppMaterial();
  if(m && m.pp===partPrep.proc) return m.rho_kgm3/1000;
  return partPrep.customRho;
}
function ppMaterialLabel(){
  const m=ppMaterial();
  if(m && m.pp===partPrep.proc) return m.name+' · '+m.condition;
  return 'Custom density';
}

// ── Orientation math (row-major 3×3) ─────────────────────────────────────────
function _ppRx(deg){const a=deg*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return [[1,0,0],[0,c,-s],[0,s,c]];}
function _ppRy(deg){const a=deg*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return [[c,0,s],[0,1,0],[-s,0,c]];}
function _ppMul(A,B){const r=[[0,0,0],[0,0,0],[0,0,0]];for(let i=0;i<3;i++)for(let j=0;j<3;j++)r[i][j]=A[i][0]*B[0][j]+A[i][1]*B[1][j]+A[i][2]*B[2][j];return r;}
function _ppUpMat(code){
  switch(code){
    case '-Z': return _ppRx(180);
    case '+X': return _ppRy(-90);
    case '-X': return _ppRy(90);
    case '+Y': return _ppRx(90);
    case '-Y': return _ppRx(-90);
    default:   return [[1,0,0],[0,1,0],[0,0,1]];
  }
}
function _ppNormDeg(v){ v=+v||0; v=((v%360)+360)%360; return v>180?v-360:v; }
// Part → print rotation. Tiny round-off from cos(90°) is snapped to 0.
function ppRotation(){
  const R=_ppMul(_ppRy(partPrep.tiltY),_ppMul(_ppRx(partPrep.tiltX),_ppUpMat(partPrep.up)));
  for(let i=0;i<3;i++)for(let j=0;j<3;j++){ if(Math.abs(R[i][j])<1e-12) R[i][j]=0; }
  return R;
}
function ppIsIdentity(){
  return partPrep.up==='+Z' && Math.abs(_ppNormDeg(partPrep.tiltX))<1e-9 && Math.abs(_ppNormDeg(partPrep.tiltY))<1e-9;
}
function ppOrientTag(){
  if(ppIsIdentity()) return '';
  const up=partPrep.up.replace('+','').replace(/^-(.)$/,'neg$1');
  let t='_up'+up;
  const tx=_ppNormDeg(partPrep.tiltX), ty=_ppNormDeg(partPrep.tiltY);
  if(tx||ty) t+='_tilt'+(tx?String(tx).replace('-','n').replace('.','p')+'x':'')+(ty?String(ty).replace('-','n').replace('.','p')+'y':'');
  return t;
}
function ppOrientLabel(){
  const tx=_ppNormDeg(partPrep.tiltX), ty=_ppNormDeg(partPrep.tiltY);
  let s='part '+partPrep.up+' up';
  if(tx) s+=', tilted '+tx+'° about X';
  if(ty) s+=', tilted '+ty+'° about Y';
  return s;
}

// ── Export: rotate geometry into the print frame ─────────────────────────────
// vp is in exporter units (× scale = mm). Returns new positions in mm with
// scale 1, or the inputs untouched at +Z / no tilt (byte-identical export).
function ppOrientForExport(vp, scale){
  scale=(scale==null)?1:scale;
  if(ppIsIdentity()) return {vp, scale, oriented:false};
  const R=ppRotation();
  const n=vp.length/3;
  let mnx=Infinity,mny=Infinity,mnz=Infinity,mxx=-Infinity,mxy=-Infinity,mxz=-Infinity;
  for(let i=0;i<vp.length;i+=3){
    const x=vp[i],y=vp[i+1],z=vp[i+2];
    if(x<mnx)mnx=x; if(x>mxx)mxx=x; if(y<mny)mny=y; if(y>mxy)mxy=y; if(z<mnz)mnz=z; if(z>mxz)mxz=z;
  }
  const cx=(mnx+mxx)*0.5*scale, cy=(mny+mxy)*0.5*scale, cz=(mnz+mxz)*0.5*scale;
  const out=new Float64Array(vp.length);
  let ax=Infinity,ay=Infinity,az=Infinity,bx=-Infinity,by=-Infinity;
  for(let i=0;i<vp.length;i+=3){
    const x=vp[i]*scale-cx, y=vp[i+1]*scale-cy, z=vp[i+2]*scale-cz;
    const X=R[0][0]*x+R[0][1]*y+R[0][2]*z;
    const Y=R[1][0]*x+R[1][1]*y+R[1][2]*z;
    const Z=R[2][0]*x+R[2][1]*y+R[2][2]*z;
    out[i]=X; out[i+1]=Y; out[i+2]=Z;
    if(X<ax)ax=X; if(X>bx)bx=X; if(Y<ay)ay=Y; if(Y>by)by=Y; if(Z<az)az=Z;
  }
  const ox=(ax+bx)*0.5, oy=(ay+by)*0.5;
  const res=new Float32Array(vp.length);
  for(let i=0;i<out.length;i+=3){ res[i]=out[i]-ox; res[i+1]=out[i+1]-oy; res[i+2]=out[i+2]-az; }
  void n;
  return {vp:res, scale:1, oriented:true};
}

// ── Exact stats from the exported triangles ──────────────────────────────────
// vp: positions (× scale = mm) in the print frame (Z up), tv: triangle
// indices. ctx: {kind:'cube'|'shape'|'solid'|'weld', domainMm, shapeVolMm3,
// edgeMm, name}. Down-facing overhang bins are 15° wide up to 60°, then 60–90.
const PP_BINS=[0,15,30,45,60,90];
function ppComputeStats(vp, tv, scale, ctx){
  scale=(scale==null)?1:scale;
  const nV=vp.length/3, nT=tv.length/3;
  let vol6=0, area2=0;
  let mnx=Infinity,mny=Infinity,mnz=Infinity,mxx=-Infinity,mxy=-Infinity,mxz=-Infinity;
  for(let i=0;i<vp.length;i+=3){
    const x=vp[i]*scale,y=vp[i+1]*scale,z=vp[i+2]*scale;
    if(x<mnx)mnx=x; if(x>mxx)mxx=x; if(y<mny)mny=y; if(y>mxy)mxy=y; if(z<mnz)mnz=z; if(z>mxz)mxz=z;
  }
  // Shift to the bbox centre for the volume sum (smaller round-off).
  const ox=(mnx+mxx)*0.5, oy=(mny+mxy)*0.5, oz=(mnz+mxz)*0.5;
  // Union-find over vertices → separate pieces.
  const parent=new Int32Array(nV); for(let i=0;i<nV;i++) parent[i]=i;
  const find=a=>{ while(parent[a]!==a){ parent[a]=parent[parent[a]]; a=parent[a]; } return a; };
  const unite=(a,b)=>{ a=find(a); b=find(b); if(a!==b) parent[a]=b; };
  for(let t=0;t<nT;t++){
    const a=tv[t*3],b=tv[t*3+1],c=tv[t*3+2];
    unite(a,b); unite(b,c);
    const ax=vp[a*3]*scale-ox, ay=vp[a*3+1]*scale-oy, az=vp[a*3+2]*scale-oz;
    const bx=vp[b*3]*scale-ox, by=vp[b*3+1]*scale-oy, bz=vp[b*3+2]*scale-oz;
    const cx=vp[c*3]*scale-ox, cy=vp[c*3+1]*scale-oy, cz=vp[c*3+2]*scale-oz;
    vol6+=ax*(by*cz-bz*cy)-ay*(bx*cz-bz*cx)+az*(bx*cy-by*cx);
    const ux=bx-ax,uy=by-ay,uz=bz-az, wx=cx-ax,wy=cy-ay,wz=cz-az;
    const nx=uy*wz-uz*wy, ny=uz*wx-ux*wz, nz=ux*wy-uy*wx;
    area2+=Math.sqrt(nx*nx+ny*ny+nz*nz);
  }
  // Inward-wound meshes (negative volume) flip the normals for the overhang pass.
  const sgn=vol6<0?-1:1;
  const volMm3=Math.abs(vol6)/6, areaMm2=area2/2;
  // Overhang pass (print frame: down = -Z).
  const critDeg=ppCritDeg();
  const critCos=(critDeg==null||critDeg<=0)?2:Math.cos(critDeg*Math.PI/180);
  const plateTol=Math.max(0.02, 0.6*((ctx&&ctx.edgeMm)||0.05));
  // Standoff: the part is lifted off the plate (analysis and view only — the
  // export is never moved), so nothing rests on the plate and the lowest
  // downward faces need support like any other overhang.
  const standoff=ppStandoff();
  const plateCos=Math.cos(30*Math.PI/180);
  const bins=new Float64Array(PP_BINS.length-1);
  let supportArea=0, footprint=0, plateArea=0, downArea=0;
  const pieceVol=new Map();
  for(let t=0;t<nT;t++){
    const a=tv[t*3],b=tv[t*3+1],c=tv[t*3+2];
    const ax=vp[a*3]*scale, ay=vp[a*3+1]*scale, az=vp[a*3+2]*scale;
    const bx=vp[b*3]*scale, by=vp[b*3+1]*scale, bz=vp[b*3+2]*scale;
    const cx=vp[c*3]*scale, cy=vp[c*3+1]*scale, cz=vp[c*3+2]*scale;
    const ux=bx-ax,uy=by-ay,uz=bz-az, wx=cx-ax,wy=cy-ay,wz=cz-az;
    const nx=(uy*wz-uz*wy)*sgn, ny=(uz*wx-ux*wz)*sgn, nz=(ux*wy-uy*wx)*sgn;
    const len=Math.sqrt(nx*nx+ny*ny+nz*nz);
    // per-piece volume
    const r=find(a);
    const pax=ax-ox,pay=ay-oy,paz=az-oz,pbx=bx-ox,pby=by-oy,pbz=bz-oz,pcx=cx-ox,pcy=cy-oy,pcz=cz-oz;
    const v6=pax*(pby*pcz-pbz*pcy)-pay*(pbx*pcz-pbz*pcx)+paz*(pbx*pcy-pby*pcx);
    pieceVol.set(r,(pieceVol.get(r)||0)+v6);
    if(len<=0) continue;
    const down=-nz/len;               // cosine of the angle to straight down
    if(down<=1e-6) continue;
    const A=len*0.5;
    const zc=(az+bz+cz)/3;
    if(!(standoff>0) && down>plateCos && zc-mnz<plateTol){ plateArea+=A; continue; }
    downArea+=A;
    const tilt=Math.acos(Math.min(1,down))*180/Math.PI;   // from horizontal
    for(let k=0;k<bins.length;k++){ if(tilt<PP_BINS[k+1]||k===bins.length-1){ bins[k]+=A; break; } }
    if(down>critCos){ supportArea+=A; footprint+=A*down; }
  }
  const pieces=[...pieceVol.values()].map(v=>Math.abs(v)/6).sort((x,y)=>y-x);
  let envelope=null;
  if(ctx){
    if(ctx.kind==='cube' && ctx.domainMm) envelope=Math.pow(ctx.domainMm,3);
    else if((ctx.kind==='shape'||ctx.kind==='solid') && ctx.shapeVolMm3>0) envelope=ctx.shapeVolMm3;
  }
  const rho=ppDensity();
  return {
    when:new Date(), name:(ctx&&ctx.name)||'', kind:(ctx&&ctx.kind)||'cube',
    tris:nT, volMm3, areaMm2, massG:volMm3*rho/1000, rho,
    vfPct:envelope?100*volMm3/envelope:null, envelopeMm3:envelope,
    size:[mxx-mnx, mxy-mny, mxz-mnz],
    pieces:pieces.length, largestPct:pieces.length&&volMm3>0?100*pieces[0]/volMm3:100,
    smallPieces:pieces.filter(v=>v<1e-3*volMm3).length,
    bins:Array.from(bins), downArea, supportArea, footprint, plateArea, critDeg,
    proc:partPrep.proc, procName:ppProcess(partPrep.proc).name, matLabel:ppMaterialLabel(),
    orient:ppOrientLabel(), oriented:!ppIsIdentity(),
    recipeVf:(ctx&&ctx.kind==='cube')?ppRecipeVf():null,
    edgeMm:ctx&&ctx.edgeMm, standoff
  };
}
// Standoff from the plate in mm (0 when the process needs no supports).
function ppStandoff(){ return ppProcess(partPrep.proc).supports ? Math.max(0,+partPrep.standoff||0) : 0; }
function ppCritDeg(){
  const p=ppProcess(partPrep.proc);
  if(!p.supports && !(partPrep.critDeg>0)) return null;
  return partPrep.critDeg;
}
// Volume fraction the design tool reported, in %, when it has one.
function ppRecipeVf(){
  try{
    const j=currentRecipe&&currentRecipe.json; if(!j) return null;
    let v=null;
    if(j.homogenization && j.homogenization.volume_fraction!=null) v=+j.homogenization.volume_fraction;
    else if(j.metrics && j.metrics.relative_density_pct!=null) v=+j.metrics.relative_density_pct;
    if(v==null||!isFinite(v)) return null;
    return v<=1?v*100:v;
  }catch(_){ return null; }
}
// Closed-mesh volume of the imported shape (mm³), cached on the shape.
function ppShapeVolume(shape){
  if(!shape||!shape.posArr||!shape.idxArr) return null;
  if(shape._ppVolMm3!=null) return shape._ppVolMm3;
  const p=shape.posArr, ix=shape.idxArr; let v6=0;
  for(let t=0;t<ix.length;t+=3){
    const a=ix[t]*3,b=ix[t+1]*3,c=ix[t+2]*3;
    v6+=p[a]*(p[b+1]*p[c+2]-p[b+2]*p[c+1])-p[a+1]*(p[b]*p[c+2]-p[b+2]*p[c])+p[a+2]*(p[b]*p[c+1]-p[b+1]*p[c]);
  }
  shape._ppVolMm3=Math.abs(v6)/6;
  return shape._ppVolMm3;
}
// Called by the export paths once the 3MF is downloaded.
function ppAfterExport(vp, tv, scale, ctx){
  const box=document.getElementById('ppExact');
  if(box) box.innerHTML='<div class="ic-note">measuring the exported part…</div>';
  setTimeout(()=>{
    try{ ppLast=ppComputeStats(vp, tv, scale, ctx); }
    catch(e){ console.error('[part prep] stats failed', e); ppLast=null;
      const b=document.getElementById('ppExact'); if(b) b.innerHTML='<div class="exp-err">Could not measure the exported part — '+esc(e.message||e)+'</div>'; return; }
    console.log('[part prep] exported part', ppLast);
    ppRenderExact();
  }, 0);
}
function ppCtxSolid(){ return {kind:'solid', shapeVolMm3:ppShapeVolume(importedShape), edgeMm:null}; }

// ── Live estimate from the preview field ─────────────────────────────────────
// Mirrors the viewer's implicit() on a grid: scaffold field (trilinear on
// the baked preview grid) clipped to the bounding shape. An estimate —
// the exact numbers come from the exported mesh.
function _ppTri(data,N,u,v,w,wrap){
  let x=u*N-0.5, y=v*N-0.5, z=w*N-0.5;
  const x0=Math.floor(x), y0=Math.floor(y), z0=Math.floor(z);
  const fx=x-x0, fy=y-y0, fz=z-z0;
  const ix=i=>wrap?((i%N)+N)%N:(i<0?0:(i>=N?N-1:i));
  const xa=ix(x0),xb=ix(x0+1),ya=ix(y0)*N,yb=ix(y0+1)*N,za=ix(z0)*N*N,zb=ix(z0+1)*N*N;
  const c00=data[xa+ya+za]*(1-fx)+data[xb+ya+za]*fx;
  const c10=data[xa+yb+za]*(1-fx)+data[xb+yb+za]*fx;
  const c01=data[xa+ya+zb]*(1-fx)+data[xb+ya+zb]*fx;
  const c11=data[xa+yb+zb]*(1-fx)+data[xb+yb+zb]*fx;
  return (c00*(1-fy)+c10*fy)*(1-fz)+(c01*(1-fy)+c11*fy)*fz;
}
function _ppScaffoldSampler(){
  if(!rm||!rm._fieldData||!rm.bakeN||!rm.worldMin) return null;
  const data=rm._fieldData, N=rm.bakeN, wn=rm.worldMin, wx=rm.worldMax;
  const sx=wx[0]-wn[0], sy=wx[1]-wn[1], sz=wx[2]-wn[2];
  const per=!!rm.isPeriodic;
  const fmin=rm.fieldMin, fmax=rm.fieldMax;
  const topo=rm.topology||{};
  const fmid=(fmin+fmax)*0.5, fhr=Math.max((fmax-fmin)*0.5,0.001);
  const center=topo.bakeRaw&&topo.rawUnits?(((topo.center??0)-fmid)/fhr):(topo.center!=null?topo.center:0);
  const halfW=topo.bakeRaw&&topo.rawUnits?((topo.halfW??0.15)/fhr):(topo.halfW!=null?topo.halfW:0.15);
  const tm=topo.topoMode==='half'?1:topo.topoMode==='solid'?2:0;
  const inv=!!topo.halfInvert, raw=!!topo.bakeRaw;
  const st=rm._assemblyMode?null:(rm._structXform||null);
  return function(px,py,pz){
    if(st){
      const qx=px-st.pivot[0]-st.offset[0], qy=py-st.pivot[1]-st.offset[1], qz=pz-st.pivot[2]-st.offset[2];
      const M=st.rotMat;   // column-major
      px=M[0]*qx+M[3]*qy+M[6]*qz+st.pivot[0];
      py=M[1]*qx+M[4]*qy+M[7]*qz+st.pivot[1];
      pz=M[2]*qx+M[5]*qy+M[8]*qz+st.pivot[2];
    }
    let u=(px-wn[0])/sx, v=(py-wn[1])/sy, w=(pz-wn[2])/sz;
    if(!per){ u=u<0?0:u>1?1:u; v=v<0?0:v>1?1:v; w=w<0?0:w>1?1:w; }
    let r=_ppTri(data,N,u,v,w,per);
    if(r<fmin) r=fmin; else if(r>fmax) r=fmax;
    let val;
    if(raw){ const adj=(r-fmid)/fhr-center; val=tm===0?Math.abs(adj)-halfW:tm===1?(inv?adj:-adj):halfW-Math.abs(adj); }
    else val=r;
    return val+(st?st.iso:0);
  };
}
// Oriented build size (mm) from a list of points in mm (part frame).
function _ppSizeOf(points){
  const R=ppRotation();
  let ax=Infinity,ay=Infinity,az=Infinity,bx=-Infinity,by=-Infinity,bz=-Infinity;
  for(let i=0;i<points.length;i+=3){
    const x=points[i],y=points[i+1],z=points[i+2];
    const X=R[0][0]*x+R[0][1]*y+R[0][2]*z, Y=R[1][0]*x+R[1][1]*y+R[1][2]*z, Z=R[2][0]*x+R[2][1]*y+R[2][2]*z;
    if(X<ax)ax=X; if(X>bx)bx=X; if(Y<ay)ay=Y; if(Y>by)by=Y; if(Z<az)az=Z; if(Z>bz)bz=Z;
  }
  return [bx-ax, by-ay, bz-az];
}
function _ppBoxCorners(mn,mx){const p=[];for(let i=0;i<8;i++)p.push(i&1?mx[0]:mn[0],i&2?mx[1]:mn[1],i&4?mx[2]:mn[2]);return p;}
function ppEstimate(){
  const out={ok:false};
  try{
    const wg=(typeof activeGroupId==='function')?activeGroupId():null;
    if(wg && groupMembers(wg).length>=2){
      const g=computeGroupBbox(wg);
      if(g) out.size=_ppSizeOf(_ppBoxCorners([g.mnx,g.mny,g.mnz],[g.mxx,g.mxy,g.mxz]));
      out.note='Weld group: volume and mass are measured when you export.';
      out.approxSize=true;
      return out;
    }
    const solid=(activeBodyId!==null && typeof isSolidAssignment==='function' && isSolidAssignment(assignments.get(activeBodyId)));
    if(importedShape && importedShape.posArr){
      const shapeVol=ppShapeVolume(importedShape);
      out.size=_ppSizeOf(importedShape.posArr);
      if(solid){ out.ok=true; out.vfPct=100; out.volMm3=shapeVol; out.envelope='shape'; return out; }
      if(!currentRecipe) return out;
      const samp=_ppScaffoldSampler(); const g=importedShape.sdfGrid;
      if(!samp||!g||!g.data){ out.note='Estimate appears once the preview has baked.'; return out; }
      const cell=parseFloat(document.getElementById('shapeCellSizeMm')?.value)||3, s=10/cell;
      const b=importedShape.bbox, dx=b.mxx-b.mnx, dy=b.mxy-b.mny, dz=b.mxz-b.mnz, GN=g.N, gd=g.data;
      const n=56; let inShape=0, inBoth=0;
      for(let k=0;k<n;k++){ const w=(k+0.5)/n;
        for(let j=0;j<n;j++){ const v=(j+0.5)/n;
          for(let i=0;i<n;i++){ const u=(i+0.5)/n;
            if(_ppTri(gd,GN,u,v,w,false)>=0) continue;
            inShape++;
            if(samp((b.mnx+u*dx)*s,(b.mny+v*dy)*s,(b.mnz+w*dz)*s)<0) inBoth++;
          } } }
      if(!inShape){ out.note='Shape has no inside at preview resolution.'; return out; }
      out.ok=true; out.vfPct=100*inBoth/inShape; out.volMm3=shapeVol*inBoth/inShape; out.envelope='shape';
      return out;
    }
    if(!currentRecipe) return out;
    const dm=(typeof exportDomainMm!=='undefined')?exportDomainMm:10;
    out.size=_ppSizeOf(_ppBoxCorners([-dm/2,-dm/2,-dm/2],[dm/2,dm/2,dm/2]));
    const samp=_ppScaffoldSampler();
    if(!samp){ out.note='Estimate appears once the preview has baked.'; return out; }
    const n=64; let inside=0;
    for(let k=0;k<n;k++){ const z=-5+10*(k+0.5)/n;
      for(let j=0;j<n;j++){ const y=-5+10*(j+0.5)/n;
        for(let i=0;i<n;i++){ if(samp(-5+10*(i+0.5)/n,y,z)<0) inside++; } } }
    out.ok=true; out.vfPct=100*inside/(n*n*n); out.volMm3=Math.pow(dm,3)*inside/(n*n*n); out.envelope='domain';
    return out;
  }catch(e){ console.warn('[part prep] estimate failed', e); out.note='Estimate unavailable.'; return out; }
}
let _ppEstTimer=null;
function ppScheduleEstimate(){
  clearTimeout(_ppEstTimer);
  _ppEstTimer=setTimeout(()=>{ ppLastEst=ppEstimate(); ppRenderEstimate(); ppApplyView(); }, 120);
}

// ── Formatting ───────────────────────────────────────────────────────────────
function _ppFmt(v,d){ if(v==null||!isFinite(v)) return '—'; return v.toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d}); }
function _ppSig(v){ if(v==null||!isFinite(v)) return '—'; const a=Math.abs(v); return _ppFmt(v, a>=1000?0:a>=100?1:a>=10?2:3); }
function _ppCard(l,v,u,wide){ return '<div class="ic-stat'+(wide?' ic-wide':'')+'"><div class="l">'+esc(l)+'</div><div class="v">'+esc(v)+(u?'<small>'+esc(u)+'</small>':'')+'</div></div>'; }
function _ppSizeStr(s){ return s?(_ppSig(s[0])+' × '+_ppSig(s[1])+' × '+_ppSig(s[2])):'—'; }

// ── Panel ────────────────────────────────────────────────────────────────────
// v0.12.0: ppInner() fills #ppBox in the dock drawer's Part prep tab, ppEstimateHtml()
// #ppEst (Estimate card) and ppExactHtml() #ppExact (Measured card); see 56-dock.js.
const PP_ICON_PRINT='<svg class="ic-ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 15.5h14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M2 17.5h16" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity=".5"/><rect x="6.5" y="6.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10 2.5v2.4M8.4 3.9 10 2.5l1.6 1.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PP_ICON_DOC='<svg class="ic-ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h7l3 3v12H5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M7.5 9h5M7.5 11.5h5M7.5 14h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
function ppInner(){
  const p=ppProcess(partPrep.proc);
  const mats=ppMaterialsFor(p.id);
  const matSel=(partPrep.mat!=='custom' && mats.some(m=>m.id===partPrep.mat))?partPrep.mat:(mats.length&&partPrep.mat!=='custom'?mats[0].id:'custom');
  if(matSel!==partPrep.mat){ partPrep.mat=matSel; }
  let procOpts=''; for(const q of PP_PROCESSES) procOpts+='<option value="'+q.id+'"'+(q.id===p.id?' selected':'')+'>'+esc(q.name)+'</option>';
  let matOpts=''; const fams=[...new Set(mats.map(m=>m.family))];
  for(const f of fams){
    matOpts+='<optgroup label="'+esc(f)+'">';
    for(const m of mats.filter(x=>x.family===f)) matOpts+='<option value="'+m.id+'"'+(m.id===matSel?' selected':'')+'>'+esc(m.name+' · '+m.condition)+'</option>';
    matOpts+='</optgroup>';
  }
  matOpts+='<option value="custom"'+(matSel==='custom'?' selected':'')+'>Custom density</option>';
  const m=ppMaterial();
  let h='<div class="dr-grid">';
  h+='<div class="dr-f"><label for="ppProc">Process</label><select id="ppProc" class="dr-sel" onchange="ppSetProc(this.value)">'+procOpts+'</select></div>';
  h+='<div class="dr-f"><label for="ppMat">Material</label><select id="ppMat" class="dr-sel" onchange="ppSetMat(this.value)">'+matOpts+'</select>';
  if(matSel==='custom'){
    h+='<div class="dr-pair"><input type="number" id="ppRho" class="dr-num" min="0.1" max="25" step="0.01" value="'+partPrep.customRho+'" oninput="ppSetCustomRho(this.value)" aria-label="Density"><span>g/cm³</span></div>';
    if(!mats.length) h+='<div class="dr-hint">The F13LD material library has no '+(p.id==='resin'?'resins':'materials for this process')+' yet — enter the density from the data sheet.</div>';
  } else if(m){
    h+='<div class="dr-hint">'+_ppFmt(m.rho_kgm3/1000,2)+' g/cm³ · '+esc(m.process)+'</div>';
  }
  h+='</div>';
  h+='<div class="dr-f"><label>Part axis facing up</label><div class="dr-chips" id="ppUp">';
  for(const c of PP_UP_CODES) h+='<button type="button" class="dr-chip'+(partPrep.up===c?' on':'')+'" aria-pressed="'+(partPrep.up===c)+'" onclick="ppSetUp(\''+c+'\')">'+(c.charAt(0)==='-'?'−'+c.slice(1):c)+'</button>';
  h+='</div></div>';
  h+='<div class="dr-f"><label>Tilt</label><div class="dr-pair"><span>about X</span><input type="number" class="dr-num" step="5" value="'+partPrep.tiltX+'" oninput="ppSetTilt(\'x\',this.value)" aria-label="Tilt about X"><span>about Y</span><input type="number" class="dr-num" step="5" value="'+partPrep.tiltY+'" oninput="ppSetTilt(\'y\',this.value)" aria-label="Tilt about Y"><span>°</span></div><div class="dr-hint" id="ppOrientNote">'+ppOrientNote()+'</div></div>';
  if(p.supports){
    h+='<div class="dr-f"><label>Overhang limit</label><div class="dr-pair"><input type="number" class="dr-num" min="0" max="89" step="1" value="'+partPrep.critDeg+'" oninput="ppSetCrit(this.value)" aria-label="Overhang limit"><span>° from the plate</span></div><div class="dr-hint">A downward face tilted less than this needs support.</div></div>';
    h+='<div class="dr-f"><label>Standoff</label><div class="dr-pair"><input type="number" class="dr-num" min="0" max="50" step="0.5" value="'+partPrep.standoff+'" oninput="ppSetStandoff(this.value)" aria-label="Standoff"><span>mm</span></div><div class="dr-hint">Gap between plate and part, filled with support. Changes the view and the support numbers; the export is not moved.</div></div>';
  } else {
    h+='<div class="dr-f"><label>Supports</label><div class="dr-hint">The powder bed holds the part up, so no supports are needed. Orientation still sets build height.</div></div>';
  }
  h+='<div class="dr-f dr-wide"><label>Print view</label><div class="dr-pair">';
  h+='<button type="button" id="ppViewBtn" class="dr-btn'+(partPrep.printView?' on':'')+'" aria-pressed="'+!!partPrep.printView+'" onclick="ppTogglePrintView()">'+PP_ICON_PRINT+'<span>'+(partPrep.printView?'Print view on':'Print view')+'</span></button>';
  if(partPrep.printView) h+='<span>plate opacity</span><input type="range" class="dr-range" min="0" max="100" step="5" value="'+partPrep.plateOpacity+'" oninput="ppSetPlateOpacity(this.value)" aria-label="Build plate opacity"><span id="ppPlateOpVal">'+partPrep.plateOpacity+' %</span>';
  h+='</div>';
  if(partPrep.printView) h+='<div class="dr-leg">'+(p.supports?'<span><i class="dr-sw red"></i>needs support</span><span><i class="dr-sw amb"></i>within 10° of limit</span>':'')+'<span><i class="dr-sw jade"></i>on plate</span></div>';
  h+='</div></div>';
  return h;
}
function ppOrientNote(){
  return ppIsIdentity()?'Exports in its design position.':'Export is rotated to this orientation, centred and set on the plate (Z = 0).';
}
function ppEstimateHtml(){
  const e=ppLastEst;
  let h='';
  if(!e){ return '<div class="ic-note">Waiting for the preview…</div>'; }
  h+='<div class="ic-stats">';
  if(e.ok){
    const rho=ppDensity();
    h+=_ppCard('volume filled','≈ '+_ppFmt(e.vfPct,1),'%');
    h+=_ppCard('porosity','≈ '+_ppFmt(100-e.vfPct,1),'%');
    h+=_ppCard('part volume','≈ '+_ppSig(e.volMm3),'mm³');
    h+=_ppCard('mass','≈ '+_ppSig(e.volMm3*rho/1000),'g');
  }
  if(e.size){
    h+=_ppCard('build size X × Y × Z'+(e.approxSize?' (box)':''),_ppSizeStr(e.size),'mm',true);
  }
  h+='</div>';
  if(e.ok) h+='<div class="ic-note">'+(e.envelope==='shape'?'Volume filled is measured against the bounding shape.':'Volume filled is measured against the export cube.')+' Exact numbers appear after export.</div>';
  if(e.note) h+='<div class="ic-note">'+esc(e.note)+'</div>';
  return h;
}
function ppExactHtml(){
  const s=ppLast; if(!s) return '<div class="ic-note">Export once to measure the real part: exact volume, support area, plate contact and where the time went.</div>';
  let h='<div class="ic-stats">';
  h+=_ppCard('part volume',_ppSig(s.volMm3),'mm³');
  h+=_ppCard('mass',_ppSig(s.massG),'g');
  if(s.vfPct!=null){ h+=_ppCard('volume filled',_ppFmt(s.vfPct,2),'%'); h+=_ppCard('porosity',_ppFmt(100-s.vfPct,2),'%'); }
  h+=_ppCard('surface area',_ppSig(s.areaMm2),'mm²');
  h+=_ppCard('area ÷ volume',_ppSig(s.volMm3>0?s.areaMm2/s.volMm3:null),'1/mm');
  h+=_ppCard('build size X × Y × Z',_ppSizeStr(s.size),'mm',true);
  h+=_ppCard('pieces',String(s.pieces),'');
  h+=_ppCard('build height',_ppSig(s.size[2]+(s.standoff||0)),'mm');
  h+='</div>';
  if(s.recipeVf!=null && s.vfPct!=null) h+='<div class="ic-note">Design tool reported '+_ppFmt(s.recipeVf,1)+' % volume filled.</div>';
  if(s.pieces>1) h+='<div class="ic-warn">'+s.pieces+' separate pieces — the largest holds '+_ppFmt(s.largestPct,1)+' % of the volume'+(s.smallPieces?'; '+s.smallPieces+' are tiny fragments':'')+'. Loose pieces will not print attached.</div>';
  // Overhangs
  h+='<div class="ic-sub">downward-facing surfaces</div>';
  if(s.critDeg!=null){
    const pct=s.areaMm2>0?100*s.supportArea/s.areaMm2:0;
    h+='<div class="ic-stats">'+_ppCard('needs support',_ppSig(s.supportArea),'mm²')+_ppCard('share of surface',_ppFmt(pct,1),'%')
      +_ppCard('support footprint',_ppSig(s.footprint),'mm²')+_ppCard('on plate',_ppSig(s.plateArea),'mm²')+'</div>';
  } else {
    h+='<div class="ic-stats">'+_ppCard('on plate',_ppSig(s.plateArea),'mm²')+'</div>';
  }
  const mx=Math.max(1e-9,...s.bins);
  h+='<div class="ic-hist">';
  for(let k=0;k<s.bins.length;k++){
    const lo=PP_BINS[k], hi=PP_BINS[k+1];
    const bad=s.critDeg!=null && lo<s.critDeg;
    const w=Math.max(0,100*s.bins[k]/mx);
    h+='<div class="ic-hrow"><span class="ic-hl">'+lo+'–'+hi+'°</span><span class="ic-hbar"><span class="'+(bad?'ic-hf bad':'ic-hf')+'" style="width:'+w.toFixed(1)+'%"></span></span><span class="ic-hv">'+_ppSig(s.bins[k])+'</span></div>';
  }
  h+='</div><div class="ic-note">Area (mm²) of downward surfaces by tilt from horizontal; plate contact left out.'+(s.critDeg!=null?' Red bands are below the '+s.critDeg+'° limit.':'')+'</div>';
  h+='<button type="button" class="ic-btn" onclick="ppDownloadReport()">'+PP_ICON_DOC+'<span>Download print report (.md)</span></button>';
  return h;
}
function ppRenderEstimate(){ const b=document.getElementById('ppEst'); if(b) b.innerHTML=ppEstimateHtml(); }
function ppRenderExact(){ const b=document.getElementById('ppExact'); if(b) b.innerHTML=ppExactHtml(); if(typeof dockFold==='function') dockFold('meas',false); }
function ppRerender(){ const b=document.getElementById('ppBox'); if(b) b.innerHTML=ppInner(); }

// ── Handlers ─────────────────────────────────────────────────────────────────
window.ppSetProc=function(id){
  partPrep.proc=ppProcess(id).id;
  const p=ppProcess(partPrep.proc);
  partPrep.critDeg=p.critDeg==null?0:p.critDeg;
  const mats=ppMaterialsFor(p.id);
  partPrep.mat=mats.length?mats[0].id:'custom';
  ppSave(); ppRerender(); ppRenderEstimate(); ppApplyView();
};
window.ppSetMat=function(id){ partPrep.mat=id; ppSave(); ppRerender(); ppRenderEstimate(); };
window.ppSetCustomRho=function(v){ const x=parseFloat(v); if(isFinite(x)&&x>0){ partPrep.customRho=x; ppSave(); ppRenderEstimate(); } };
window.ppSetUp=function(c){ if(!PP_UP_CODES.includes(c)) return; partPrep.up=c; ppSave(); ppRerender(); ppScheduleEstimate(); ppApplyView(true); };
window.ppSetTilt=function(axis,v){ const x=parseFloat(v); if(!isFinite(x)) return; if(axis==='x') partPrep.tiltX=x; else partPrep.tiltY=x; ppSave();
  const on=document.getElementById('ppOrientNote'); if(on) on.textContent=ppOrientNote();
  // Keep focus in the input: refresh only the dependent parts.
  ppScheduleEstimate(); ppApplyView(true); };
window.ppSetStandoff=function(v){ const x=parseFloat(v); if(!isFinite(x)) return; partPrep.standoff=Math.max(0,Math.min(50,x)); ppSave(); ppApplyView(); };
window.ppSetCrit=function(v){ const x=parseFloat(v); if(!isFinite(x)) return; partPrep.critDeg=Math.max(0,Math.min(89,x)); ppSave(); ppApplyView(); };
window.ppSetPlateOpacity=function(v){ const x=parseFloat(v); if(!isFinite(x)) return; partPrep.plateOpacity=Math.max(0,Math.min(100,x)); ppSave();
  const o=document.getElementById('ppPlateOpVal'); if(o) o.textContent=Math.round(partPrep.plateOpacity)+' %'; ppApplyView(); };
window.ppTogglePrintView=function(){
  partPrep.printView=!partPrep.printView;
  ppRerender(); ppApplyView(true, partPrep.printView);
};

// ── Viewer hook (20-raymarcher.js setPrintView) ──────────────────────────────
// World units: cube mode spans [-5,5] per domain; shape mode is mm × 10/cell.
function ppApplyView(_orientChanged, snapCamera){
  if(!rm||typeof rm.setPrintView!=='function') return;
  if(!partPrep.printView){ rm.setPrintView(null); return; }
  const R=ppRotation();
  const b=[R[2][0],R[2][1],R[2][2]], U=[R[0][0],R[0][1],R[0][2]], V=[R[1][0],R[1][1],R[1][2]];
  let plate=null, worldPerMm=1;
  try{
    const wg=(typeof activeGroupId==='function')?activeGroupId():null;
    if(wg && groupMembers(wg).length>=2){
      const g=computeGroupBbox(wg);
      const refCell=(bodies.get(activeBodyId)&&bodies.get(activeBodyId).cellSizeMm)||parseFloat(document.getElementById('shapeCellSizeMm')?.value)||3;
      worldPerMm=10/refCell;
      if(g){ const c=_ppBoxCorners([g.mnx,g.mny,g.mnz],[g.mxx,g.mxy,g.mxz]); plate=Infinity;
        for(let i=0;i<c.length;i+=3) plate=Math.min(plate,(c[i]*b[0]+c[i+1]*b[1]+c[i+2]*b[2])*worldPerMm); }
    } else if(importedShape && importedShape.posArr){
      const cell=parseFloat(document.getElementById('shapeCellSizeMm')?.value)||3; worldPerMm=10/cell;
      const p=importedShape.posArr; let mn=Infinity;
      for(let i=0;i<p.length;i+=3){ const d=p[i]*b[0]+p[i+1]*b[1]+p[i+2]*b[2]; if(d<mn) mn=d; }
      plate=mn*worldPerMm;
    } else {
      const dm=(typeof exportDomainMm!=='undefined')?exportDomainMm:10; worldPerMm=10/dm;
      plate=-5*(Math.abs(b[0])+Math.abs(b[1])+Math.abs(b[2]));
    }
  }catch(e){ console.warn('[part prep] plate level', e); }
  if(plate==null||!isFinite(plate)) plate=-5;
  plate-=ppStandoff()*worldPerMm;   // standoff gap under the part
  // Grid step: 1 / 2 / 5 / 10 … mm so the plate shows at most ~24 lines per side.
  const reachMm=(rm.viewH||5)*1.8/worldPerMm;
  let stepMm=1; const steps=[1,2,5,10,20,50,100];
  for(const s of steps){ stepMm=s; if(reachMm/s<=24) break; }
  const crit=ppCritDeg();
  rm.setPrintView({
    rtColMajor:[R[0][0],R[0][1],R[0][2],R[1][0],R[1][1],R[1][2],R[2][0],R[2][1],R[2][2]],
    buildDir:b, plateU:U, plateV:V, plateLevel:plate,
    critCos:(crit==null||crit<=0)?2.0:Math.cos(crit*Math.PI/180),
    tint:crit!=null && crit>0,
    gridStep:stepMm*worldPerMm,
    plateAlpha:partPrep.plateOpacity/100,
    lifted:ppStandoff()>0
  }, !!snapCamera);
}

// ── Print report (.md) ───────────────────────────────────────────────────────
window.ppDownloadReport=function(){
  const s=ppLast; if(!s) return;
  const L=[];
  const base=(s.name||'part').replace(/\.3mf$/i,'');
  L.push('# Print report — '+base, '');
  L.push('F13LD.mesh v'+(typeof F13LD_MESH_VERSION!=='undefined'?F13LD_MESH_VERSION:'?')+' · '+s.when.toISOString().replace('T',' ').slice(0,16)+' UTC', '');
  L.push('## Setup', '');
  L.push('| | |','|---|---|');
  L.push('| Exported file | '+(s.name||'—')+' |');
  L.push('| Process | '+s.procName+' |');
  L.push('| Material | '+s.matLabel+' |');
  L.push('| Density | '+_ppFmt(s.rho,3)+' g/cm³ |');
  L.push('| Build orientation | '+s.orient+(s.oriented?' (exported rotated, centred, on the plate at Z = 0)':' (design position)')+' |');
  L.push('| Overhang limit | '+(s.critDeg==null?'none (no supports for this process)':s.critDeg+'° from the plate')+' |');
  if(s.standoff>0) L.push('| Standoff from plate | '+_ppFmt(s.standoff,2)+' mm (support height; not applied to the exported file) |');
  if(s.edgeMm) L.push('| Mesh edge length | '+_ppFmt(s.edgeMm,3)+' mm |');
  L.push('| Triangles | '+s.tris.toLocaleString()+' |','');
  L.push('## Part', '');
  L.push('| | |','|---|---|');
  L.push('| Part volume | '+_ppSig(s.volMm3)+' mm³ |');
  L.push('| Mass | '+_ppSig(s.massG)+' g |');
  if(s.vfPct!=null){
    L.push('| Volume filled | '+_ppFmt(s.vfPct,2)+' % of '+(s.kind==='cube'?'the export cube':'the bounding shape')+' ('+_ppSig(s.envelopeMm3)+' mm³) |');
    L.push('| Porosity | '+_ppFmt(100-s.vfPct,2)+' % |');
  }
  if(s.recipeVf!=null) L.push('| Volume filled, design tool | '+_ppFmt(s.recipeVf,2)+' % |');
  L.push('| Surface area | '+_ppSig(s.areaMm2)+' mm² |');
  L.push('| Area ÷ volume | '+_ppSig(s.volMm3>0?s.areaMm2/s.volMm3:null)+' 1/mm |');
  L.push('| Build size X × Y × Z | '+_ppSizeStr(s.size)+' mm |');
  L.push('| Build height | '+_ppSig(s.size[2]+(s.standoff||0))+' mm'+(s.standoff>0?' (part '+_ppSig(s.size[2])+' mm + standoff)':'')+' |');
  L.push('| Separate pieces | '+s.pieces+(s.pieces>1?' (largest '+_ppFmt(s.largestPct,1)+' % of volume)':'')+' |','');
  L.push('## Downward-facing surfaces', '');
  if(s.critDeg==null) L.push('No supports needed for this process.','');
  L.push('| | |','|---|---|');
  if(s.critDeg!=null){
    L.push('| Needs support (tilt below '+s.critDeg+'°) | '+_ppSig(s.supportArea)+' mm² ('+_ppFmt(s.areaMm2>0?100*s.supportArea/s.areaMm2:0,1)+' % of surface) |');
    L.push('| Support footprint (projected on the plate) | '+_ppSig(s.footprint)+' mm² |');
  }
  L.push('| On the plate | '+_ppSig(s.plateArea)+' mm² |','');
  L.push('| Tilt from horizontal | Area (mm²) |','|---|---|');
  for(let k=0;k<s.bins.length;k++) L.push('| '+PP_BINS[k]+'–'+PP_BINS[k+1]+'°'+(s.critDeg!=null&&PP_BINS[k]<s.critDeg?' (below limit)':'')+' | '+_ppSig(s.bins[k])+' |');
  L.push('', '## Notes', '');
  L.push('- Numbers are measured on the exported triangle mesh. Mass assumes fully dense material at the listed density.');
  L.push('- Tilt is measured from horizontal for faces pointing down; 0° is a flat face pointing straight down. Faces on the plate are left out of the bands.');
  L.push('- Support footprint is the downward area below the limit projected onto the plate. It does not account for part surfaces below that would carry the support instead of the plate.');
  const blob=new Blob([L.join('\n')+'\n'],{type:'text/markdown'});
  downloadBlob(blob, safeFilePart(base)+'_print-report.md');
};
