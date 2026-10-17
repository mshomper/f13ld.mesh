// F13LD.mesh · tests/slabmesh.js — parallel slab mesher checks in Node (v0.15.0).
// Usage: node tests/slabmesh.js [quick]
// For each test field: mesh with Manifold.levelSet and with the slab mesher at
// 1, 2, 7 and 16 slabs; checks every slab mesh is a closed manifold with the
// same vertices and triangles whatever the slab count, and reports volume,
// area, triangle count and needle triangles next to Manifold and the exact
// value where it is known.
'use strict';
const fs=require('fs'), path=require('path'), vm=require('vm');
const root=path.join(__dirname,'..');
const ctx={console, meshoptReady:Promise.resolve(), Math, Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Map, Array, Object, Number, performance};
vm.createContext(ctx);
for(const f of ['worker/m31-weld-grid.js','worker/m34-slab-mesher.js','worker/m35-slab-cleanup.js'])
  if(fs.existsSync(path.join(root,f))) vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f});
const quick=process.argv[2]==='quick';
function stats(pos,idx){
  let vol=0, area=0, needles=0;
  for(let t=0;t<idx.length;t+=3){
    const a=3*idx[t], b=3*idx[t+1], c=3*idx[t+2];
    const ax=pos[a],ay=pos[a+1],az=pos[a+2], bx=pos[b],by=pos[b+1],bz=pos[b+2], cx=pos[c],cy=pos[c+1],cz=pos[c+2];
    vol+=(ax*(by*cz-bz*cy)+ay*(bz*cx-bx*cz)+az*(bx*cy-by*cx))/6;
    const ux=bx-ax,uy=by-ay,uz=bz-az, vx=cx-ax,vy=cy-ay,vz=cz-az;
    const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx, A=Math.hypot(nx,ny,nz)/2; area+=A;
    const l2=Math.max(ux*ux+uy*uy+uz*uz, vx*vx+vy*vy+vz*vz, (cx-bx)**2+(cy-by)**2+(cz-bz)**2);
    if(l2>0 && 2*A/l2<0.05) needles++;     // height / longest edge below 5 %
  }
  return {vol, area, tris:idx.length/3, needles};
}
function simplifiedSlabs(F,g,nS,tol){
  const Lmax=g.layers-2, slabs=[], seamZ=[]; let slowest=0;
  for(let s=0;s<nS;s++){
    const a=Math.round(Lmax*s/nS), c=Math.round(Lmax*(s+1)/nS);
    const ts=performance.now();
    let r=ctx.slabMeshLayers(F.fn,g,a,c);
    if(tol>0) r=ctx.simplifySlab(r,tol);
    slowest=Math.max(slowest,performance.now()-ts);
    slabs.push(r);
    if(s>0) seamZ.push(a&1 ? g.min[2]+g.s[2]*((a-1)/2) : g.min[2]+g.s[2]*(a/2-0.5));
  }
  const t0=performance.now();
  const J=ctx.joinSlabs(slabs);
  let idx=J.idx;
  if(tol>0 && seamZ.length) idx=ctx.simplifySeamBands(J.pos,idx,seamZ,4*Math.max(g.s[0],g.s[1],g.s[2]),tol);
  const C=ctx.compactIndexed(J.pos,idx);
  return {pos:C.pos, idx:C.idx, slowest, joinMs:performance.now()-t0};
}
(async()=>{
  const {MeshoptSimplifier:S}=await import(path.join(__dirname,'node_modules/meshoptimizer/index.js')); await S.ready;
  ctx.MeshoptSimplifier=S;

  const Module=(await import(path.join(__dirname,'node_modules/manifold-3d/manifold.js'))).default;
  const w=await Module(); w.setup();
  const {Manifold, Mesh}=w;
  const sc=Math.PI/2;
  const fields=[
    {name:'sphere r0.6', fn:p=>0.6-Math.hypot(p[0],p[1],p[2]), box:[-1,1], exact:4/3*Math.PI*0.216},
    {name:'gyroid sheet', under:0.4, fn:p=>0.3-Math.abs(Math.sin(sc*p[0])*Math.cos(sc*p[1])+Math.sin(sc*p[1])*Math.cos(sc*p[2])+Math.sin(sc*p[2])*Math.cos(sc*p[0])), box:[-4,4]},
    {name:'gyroid solid', fn:p=>Math.sin(sc*p[0])*Math.cos(sc*p[1])+Math.sin(sc*p[1])*Math.cos(sc*p[2])+Math.sin(sc*p[2])*Math.cos(sc*p[0]), box:[-4,4], exact:256},
    {name:'box cap', fn:p=>1, box:[-1,1], exact:8},
    {name:'thin wall', under:1, fn:p=>0.02-Math.abs(p[0]-0.013), box:[-1,1], exact:0.04*4},
  ];
  const edges=quick?[0.1]:[0.1,0.05];
  let fail=0;
  for(const F of fields) for(const e0 of edges){
    const e=F.box[1]>2?e0*4:e0;
    const b={min:[F.box[0],F.box[0],F.box[0]],max:[F.box[1],F.box[1],F.box[1]]};
    let t0=performance.now();
    const ref=Manifold.levelSet(F.fn,b,e); const msRef=performance.now()-t0;
    const rm=ref.getMesh(); const rs=stats(rm.vertProperties,rm.triVerts); ref.delete();
    const g=ctx.weldGridDims(b.min,b.max,e);
    const Lmax=g.layers-2;
    let first=null;
    // raw: identical whatever the slab count
    for(const nS of [1,2,7,16]){
      const R=simplifiedSlabs(F,g,nS,0);
      const st=stats(R.pos,R.idx), sig=st.tris+':'+R.pos.length+':'+st.vol.toFixed(9);
      let ok=ctx.meshClosedReport(R.pos,R.idx).ok?'closed':'OPEN';
      if(ok!=='closed') fail++;
      if(!first) first=sig; else if(sig!==first){ ok+=' DIFFERS'; fail++; }
      if(nS===16||ok!=='closed') console.log(F.name.padEnd(13),'edge '+e,'raw',String(nS).padStart(2)+' slabs',ok,'| tris',st.tris,'vs manifold',rs.tris,'| needles',st.needles,'vs',rs.needles);
    }
    // simplified pipeline vs Manifold + one whole-mesh simplify
    const tol=0.15*e;
    const [ri]=S.simplify(new Uint32Array(rm.triVerts),rm.vertProperties,3,6,tol,['ErrorAbsolute']);
    const RC=ctx.compactIndexed(rm.vertProperties,ri), rss=stats(RC.pos,RC.idx);
    let v1=null;
    for(const nS of [1,8]){
      const R=simplifiedSlabs(F,g,nS,tol), st=stats(R.pos,R.idx), cl=ctx.meshClosedReport(R.pos,R.idx);
      let ok=cl.ok?'closed':('OPEN '+cl.bad+' edges');
      if(!cl.ok) fail++;
      if(v1==null) v1=st.vol; else if(Math.abs(st.vol/v1-1)>0.015){ if(F.under>=e) ok+=' (under-sampled: wall thinner than the edge, volume not checked)'; else { ok+=' VOL DRIFT'; fail++; } }
      const ex=F.exact?' exact '+((st.vol/F.exact-1)*100).toFixed(2)+'% (classic '+((rss.vol/F.exact-1)*100).toFixed(2)+'%)':'';
      console.log(F.name.padEnd(13),'edge '+e,'simplified',String(nS).padStart(2)+' slabs',ok,'| tris',st.tris,'vs classic',rss.tris,'| needles',st.needles,'vs',rss.needles,'| vol vs classic',((st.vol/rss.vol-1)*100).toFixed(3)+'%'+ex,'| slowest slab ms',Math.round(R.slowest),'join',Math.round(R.joinMs),'manifold levelSet',Math.round(msRef));
    }
  }
  // loose-piece clean-up: big sphere + a small detached speck
  {
    // big sphere with a sealed cavity (r 0.1, kept) + a small detached speck (dropped)
    const fn=p=>Math.max(Math.min(0.6-Math.hypot(p[0]+0.2,p[1],p[2]), Math.hypot(p[0]+0.2,p[1],p[2])-0.1), 0.06-Math.hypot(p[0]-0.75,p[1]-0.6,p[2]-0.6));
    const g=ctx.weldGridDims([-1,-1,-1],[1,1,1],0.02);
    const R=simplifiedSlabs({fn},g,4,0.003);
    const cell=0.02**3, r1=ctx.removeLoosePieces(R.pos,R.idx,'largest',cell), r0=ctx.removeLoosePieces(R.pos,R.idx,'keep',cell), rs=ctx.removeLoosePieces(R.pos,R.idx,'specks',cell);
    // speck: 0.06 radius sphere = 9e-4 mm³ = 113 cells → not a speck; largest drops it and keeps the cavity
    const okL=r1&&r1.dropped===1&&r1.pieces===3&&ctx.meshClosedReport(r1.vertProperties,r1.triVerts).ok&&r0===null&&rs===null;
    if(!okL) fail++;
    console.log('loose pieces', okL?'ok':'FAIL', r1?('dropped '+r1.dropped+' of '+r1.pieces+', '+r1.droppedVol.toExponential(2)+' vs kept '+r1.keptVol.toFixed(3)):'nothing dropped', '| keep: nothing dropped', r0===null, '| specks: nothing dropped (113 cells)', rs===null);
  }
  console.log(fail?('FAIL '+fail):'all slab meshes closed; raw meshes identical across slab counts');
  process.exit(fail?1:0);
})();
