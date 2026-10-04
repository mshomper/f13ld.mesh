/* ============================================================
   F13LD.mesh · worker/m31-weld-grid.js
   Weld export grid (v0.9.3). Manifold.levelSet samples the field on a
   body-centred cubic grid and calls back into JS once per point, on one
   thread. These helpers reproduce that grid exactly so the field can be
   evaluated ahead of time by a pool of workers (weld-bake-worker.js), and
   levelSet then reads the stored values instead of evaluating the field.

   Grid (manifold-3d 3.4.1, checked bit-for-bit against the points levelSet
   asks for — tests/weldtest.js re-checks it):
     n[a]  = trunc(dim[a]/edge + 1) - 1          cells per axis
     s[a]  = dim[a] / n[a]                       spacing
     main  points  min + s·i,        i = 0..n    ((n+1)³ points)
     offset points min + s·(j − 0.5), j = 0..n+1 ((n+2)³ points)
   Each point is asked for once. The callback below recognises a point by
   recomputing its coordinates with the same arithmetic; anything it does not
   recognise is evaluated directly, so the mesh can never depend on the cache.

   Layers: the bake splits work by z layer q = 0..2n+2 — odd q is main layer
   (q−1)/2, even q is offset layer q/2.
   ============================================================ */
'use strict';
function weldGridDims(min, max, edge){
  var n=[0,0,0], s=[0,0,0];
  for(var a=0;a<3;a++){
    var dim=max[a]-min[a];
    n[a]=Math.trunc(dim/edge+1.0)-1;
    s[a]=n[a]>0 ? dim/n[a] : 0;
  }
  var ok=n[0]>0&&n[1]>0&&n[2]>0;
  return {min:[min[0],min[1],min[2]], max:[max[0],max[1],max[2]], edge:edge, n:n, s:s, ok:ok,
    mainCount: ok?(n[0]+1)*(n[1]+1)*(n[2]+1):0,
    offCount:  ok?(n[0]+2)*(n[1]+2)*(n[2]+2):0,
    layers:    ok?2*n[2]+3:0};
}
// Evaluate fn (already in Manifold's sign convention) on layers [qa, qb).
// Returns the main and offset slabs plus the z-index range each covers.
function weldBakeLayers(fn, g, qa, qb, f32){
  var mn=g.min, s=g.s, n=g.n;
  var kmA=Math.ceil((qa-1)/2), kmB=Math.ceil((qb-1)/2);   // main k with 2k+1 in [qa,qb)
  var koA=Math.ceil(qa/2),     koB=Math.ceil(qb/2);       // offset k with 2k in [qa,qb)
  if(kmA<0)kmA=0; if(kmB>n[2]+1)kmB=n[2]+1;
  if(koA<0)koA=0; if(koB>n[2]+2)koB=n[2]+2;
  var nx1=n[0]+1, ny1=n[1]+1, nx2=n[0]+2, ny2=n[1]+2;
  var Arr=f32?Float32Array:Float64Array;
  var main=new Arr(Math.max(0,kmB-kmA)*nx1*ny1), off=new Arr(Math.max(0,koB-koA)*nx2*ny2);
  // A fresh point array per call, as levelSet passes, in case a field ever
  // writes to its argument.
  var x, y, z, i, j, k, o=0;
  for(k=kmA;k<kmB;k++){ z=mn[2]+s[2]*k;
    for(j=0;j<ny1;j++){ y=mn[1]+s[1]*j;
      for(i=0;i<nx1;i++){ x=mn[0]+s[0]*i; main[o++]=fn([x,y,z]); } } }
  o=0;
  for(k=koA;k<koB;k++){ z=mn[2]+s[2]*(k-0.5);
    for(j=0;j<ny2;j++){ y=mn[1]+s[1]*(j-0.5);
      for(i=0;i<nx2;i++){ x=mn[0]+s[0]*(i-0.5); off[o++]=fn([x,y,z]); } } }
  return {main:main, off:off, kmA:kmA, kmB:kmB, koA:koA, koB:koB};
}
// levelSet callback that reads the baked values. stats.hit / stats.miss count
// how many points came from the cache.
function makeWeldLookup(g, main, off, direct, stats){
  var m0=g.min[0], m1=g.min[1], m2=g.min[2], s0=g.s[0], s1=g.s[1], s2=g.s[2];
  var n0=g.n[0], n1=g.n[1], n2=g.n[2];
  var nx1=n0+1, ny1=n1+1, nx2=n0+2, ny2=n1+2;
  stats=stats||{}; stats.hit=0; stats.miss=0;
  return function(p){
    var x=p[0], y=p[1], z=p[2];
    var fx=(x-m0)/s0, fy=(y-m1)/s1, fz=(z-m2)/s2;
    var i=Math.round(fx), j=Math.round(fy), k=Math.round(fz);
    if(i>=0&&i<=n0&&j>=0&&j<=n1&&k>=0&&k<=n2 && x===m0+s0*i && y===m1+s1*j && z===m2+s2*k){
      stats.hit++; return main[i+nx1*(j+ny1*k)];
    }
    i=Math.round(fx+0.5); j=Math.round(fy+0.5); k=Math.round(fz+0.5);
    if(i>=0&&i<=n0+1&&j>=0&&j<=n1+1&&k>=0&&k<=n2+1 && x===m0+s0*(i-0.5) && y===m1+s1*(j-0.5) && z===m2+s2*(k-0.5)){
      stats.hit++; return off[i+nx2*(j+ny2*k)];
    }
    stats.miss++; return direct(p);
  };
}
// The weld field in Manifold's convention (positive inside, NaN/Inf guarded).
// Shared by the bake workers and the mesh worker so both evaluate the same
// function.
function makeWeldField(bodies, blendK, reachMm){
  var asm=buildAssemblySDF(bodies, blendK, false, {reachMm:reachMm});
  return function(p){ var v=-asm(p); return (v>-1e20&&v<1e20)?v:-1e3; };
}
