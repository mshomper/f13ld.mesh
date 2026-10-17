// F13LD.mesh · tests/flipedges.js — flipEdges / triQuality checks in Node (v0.16.0).
// Usage: node tests/flipedges.js
// Unit checks on small meshes (flat fan, folded quad, locks, existing edge,
// closed cube) and a timing run on a large slab mesh.
'use strict';
const fs=require('fs'), path=require('path'), vm=require('vm');
const root=path.join(__dirname,'..');
const ctx={console, meshoptReady:Promise.resolve(), Math, Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Map, Set, Array, Object, Number, performance};
vm.createContext(ctx);
for(const f of ['worker/m31-weld-grid.js','worker/m34-slab-mesher.js','worker/m35-slab-cleanup.js'])
  vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f});
let fail=0;
function check(name, ok, info){ if(!ok) fail++; console.log((ok?'ok  ':'FAIL')+' '+name+(info?' | '+info:'')); }
function vol(pos,idx){ let v=0; for(let t=0;t<idx.length;t+=3){ const a=3*idx[t],b=3*idx[t+1],c=3*idx[t+2];
  v+=(pos[a]*(pos[b+1]*pos[c+2]-pos[b+2]*pos[c+1])+pos[a+1]*(pos[b+2]*pos[c]-pos[b]*pos[c+2])+pos[a+2]*(pos[b]*pos[c+1]-pos[b+1]*pos[c]))/6; } return v; }
const F=ctx.flipEdges, Q=ctx.triQuality;
// 1. thin quad a(0,0) b(10,0.2)... diagonal along the long axis: two needles; flip makes the short diagonal
{
  // rhombus: a(0,0) b(4,0) c(2,0.3) d(2,-0.3); edge a→b long. tris (a,b,c),(b,a,d)
  const pos=new Float32Array([0,0,0, 4,0,0, 2,0.3,0, 2,-0.3,0]);
  const idx=new Uint32Array([0,1,2, 1,0,3]);
  // open patch: a,b boundary vertices of degree 2 → nothing flips (needs a closed fan)
  const o=F(pos,idx,null); check('open patch untouched', o.join()===idx.join());
}
// closed double-sided "pillow": a flat rhombus fan on top and bottom of a thin box
function pillow(){
  // octahedron-like: square ring of 4 points + needle-shaped flat top made of 2 tris + bottom apex
  const pos=new Float32Array([0,0,0, 4,0,0, 2,0.3,0, 2,-0.3,0, 2,0,-1]);
  // top: (0,1,2),(1,0,3) facing +z/-z? set orientation outward: top normal +z
  // a=0,b=1,c=2,d=3,e=4 (below). Faces: (0,1,2) n=+z; (1,0,3) n=+z; sides to e
  const idx=new Uint32Array([0,1,2, 1,0,3, 2,1,4, 0,2,4, 3,0,4, 1,3,4]);
  return {pos,idx};
}
{
  const {pos,idx}=pillow();
  check('pillow closed', ctx.meshClosedReport(pos,idx).ok);
  const q0=Q(pos,idx), o=F(pos,idx,null), q1=Q(pos,o);
  check('flat needle pair flipped', ctx.flipEdges.last.flips===1 && ctx.meshClosedReport(pos,o).ok && Math.abs(vol(pos,o)-vol(pos,idx))<1e-9,
    'flips '+ctx.flipEdges.last.flips+' needles '+q0.needles+'->'+q1.needles+' p5 '+q0.minAngleP5+'->'+q1.minAngleP5);
  const lock=new Uint8Array(5); lock[2]=1;
  F(pos,idx,lock); check('locked vertex blocks the flip', ctx.flipEdges.last.flips===0);
  F(pos,idx,lock,{lockMode:'edge'}); check('edge lock: one locked end may flip', ctx.flipEdges.last.flips===1);
  lock[3]=1; F(pos,idx,lock,{lockMode:'edge'}); check('edge lock: new edge between locked ends refused', ctx.flipEdges.last.flips===0);
  // fold the top by 5° → dihedral above 1°: no flip
  const p2=new Float32Array(pos); p2[3*2+2]=0.3*Math.tan(5*Math.PI/180);
  F(p2,idx,null); check('folded pair (5°) not flipped', ctx.flipEdges.last.flips===0);
  F(p2,idx,null,{maxDihedralDeg:10}); check('folded pair flips at maxDihedralDeg 10', ctx.flipEdges.last.flips===1);
}
// existing edge: tetrahedron — every edge flip would make an existing edge
{
  const pos=new Float32Array([0,0,0, 1,0,0, 0,1,0, 0,0,1]);
  const idx=new Uint32Array([0,2,1, 0,1,3, 1,2,3, 0,3,2]);
  F(pos,idx,null,{maxDihedralDeg:179}); check('tetrahedron: no flip (edge exists / degree)', ctx.flipEdges.last.flips===0);
}
// triQuality: equilateral → 60°, no needles
{
  const pos=new Float32Array([0,0,0, 1,0,0, 0.5,Math.sqrt(3)/2,0]), q=Q(pos,new Uint32Array([0,1,2]));
  check('triQuality equilateral', Math.abs(q.meanMinAngle-60)<1e-4 && q.needles===0 && q.minAngleP5>=59.9, JSON.stringify(q));
  const p2=new Float32Array([0,0,0, 1,0,0, 0.5,0.01,0]), q2=Q(p2,new Uint32Array([0,1,2]));
  check('triQuality needle', q2.needles===1 && Math.abs(q2.meanMinAngle-Math.atan(0.02)*180/Math.PI)<1e-3, JSON.stringify(q2));
}
(async()=>{
  const {MeshoptSimplifier:S}=await import(path.join(__dirname,'node_modules/meshoptimizer/index.js')); await S.ready;
  ctx.MeshoptSimplifier=S;
  // determinism + timing on a large simplified slab (gyroid, ~1 M raw tris) and a flat cap
  const sc=Math.PI/2;
  for(const [name,fn,B,e] of [['gyroid',p=>Math.sin(sc*p[0])*Math.cos(sc*p[1])+Math.sin(sc*p[1])*Math.cos(sc*p[2])+Math.sin(sc*p[2])*Math.cos(sc*p[0]),4,0.1],['box',p=>1,1,0.02]]){
    const g=ctx.weldGridDims([-B,-B,-B],[B,B,B],e), Lmax=g.layers-2;
    const r=ctx.slabMeshLayers(fn,g,Math.round(Lmax/3),Math.round(2*Lmax/3));
    // raw mesh: flip directly (lots of flat cap / many tris), timing per million
    const lock=new Uint8Array(r.pos.length/3); for(const v of r.seamV) lock[v]=1;
    let t0=performance.now(); const o1=F(r.pos,r.idx,lock,{lockMode:'edge'}); const ms=performance.now()-t0, fl=ctx.flipEdges.last;
    const o2=F(r.pos,r.idx,lock,{lockMode:'edge'});
    const cl=ctx.meshClosedReport(r.pos,o1,false,lock).ok, q0=Q(r.pos,r.idx), q1=Q(r.pos,o1);
    check(name+' raw slab flip closed, deterministic, volume kept', cl && o1.join()===o2.join() && Math.abs(vol(r.pos,o1)/vol(r.pos,r.idx)-1)<1e-4,
      (r.idx.length/3)+' tris, '+fl.flips+' flips in '+fl.passes+' passes, '+Math.round(ms)+' ms ('+(ms/(r.idx.length/3e6)).toFixed(0)+' ms/M tris) | needles '+q0.needles+'->'+q1.needles+' p5 '+q0.minAngleP5+'->'+q1.minAngleP5);
    t0=performance.now(); const s1=ctx.simplifySlab(r,0.15*e); const msS=performance.now()-t0;
    check(name+' simplified slab', true, s1.idx.length/3+' tris, '+s1.flips+' flips in '+s1.flipMs.toFixed(1)+' ms of '+Math.round(msS)+' ms simplify+flip');
  }
  console.log(fail?('FAIL '+fail):'flipEdges checks ok');
  process.exit(fail?1:0);
})();
