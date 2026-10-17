/* ============================================================
   F13LD.mesh · worker/m34-slab-mesher.js
   Parallel slab mesher (v0.15.0).

   Our own marching tetrahedra on the same body-centred cubic grid that
   Manifold.levelSet samples (weldGridDims, m31-weld-grid.js): main points
   min + s·i and offset (cell-centre) points min + s·(j − 0.5). The grid is
   cut into z slabs that are meshed independently, one per core, and joined
   afterwards without any cracks.

   Layers. q = 0..2n+2 runs up the grid: even q is offset layer q/2, odd q
   is main layer (q−1)/2 (same numbering as weldBakeLayers). Every tet of the
   BCC tetrahedralisation (two neighbouring cell centres plus one edge of the
   face they share) covers exactly three consecutive layers L..L+2; a slab
   owns the tets whose lowest layer L is in [La, Lb).

   Seams. Edges lying in layers Lb and Lb+1 are used by the tets of both
   slabs. Their crossing points are computed from the same two values with
   the same arithmetic in both slabs (always interpolated from the edge's
   owner end), so they are bit-identical; each slab reports them with a
   global key (owner point id · 7 + edge slot) and joinSlabs() welds them.

   Bounds. As levelSet does, values on the outer layer of the grid are
   clamped to ≤ 0 and vertex positions are clamped to the bounds, so solid
   reaching the box is capped exactly on its faces.

   Crossings at grid points. Where a grid point sits on (or within float32
   rounding of) the surface — TPMS and beam fields do at symmetry points —
   several edges' crossings would land on one position as separate vertices,
   and meshoptimizer tears the mesh at such duplicates. Each crossing is kept
   at least TCLAMP (0.01 % of an edge) from both ends of its edge, so every
   vertex has its own position and the topology still comes only from the
   signs: the raw mesh is always a closed 2-manifold. (Snapping crossings
   onto grid points — SNAP, still here but off — removed needles, but merging
   vertices collapsed walls thinner than one edge, and on fields with points
   exactly on the surface even a 0.1 % snap made edges shared by four
   triangles.) With snapping on, a slab evaluates two extra layers each side
   for the snap decision (halo).

   Field: fn([x,y,z]) in Manifold's convention (positive inside).
   ============================================================ */
'use strict';
var SLAB_SNAP=0;       // fraction of an edge; 0 = off (the default — see Snapping)
var SLAB_SNAP_IN=1e-3; // same for inside points
var SLAB_TCLAMP=1e-4;  // keep crossings this fraction of an edge away from grid points
var SLAB_HALO=2;       // extra value layers each side, for the snap decision

// Point helpers. A point is (t,i,j,k): t=1 main, t=0 offset.
// Layer of a point: main 2k+1, offset 2k.
function slabMeshLayers(fn, g, La, Lb, opts){
  opts=opts||{};
  var snap=(opts.snap!=null)?opts.snap:SLAB_SNAP;
  var snapIn=snap>0?Math.min(snap,SLAB_SNAP_IN):0;
  var tclamp=(opts.tclamp!=null)?opts.tclamp:SLAB_TCLAMP;
  var n0=g.n[0], n1=g.n[1], n2=g.n[2];
  var nx1=n0+1, ny1=n1+1, nx2=n0+2, ny2=n1+2;
  var mainCount=nx1*ny1*(n2+1);
  var Lq=g.layers;                       // 2·n2+3
  var Lmax=Lq-2;                         // tets have L in [0, Lq−3]
  if(La<0) La=0; if(Lb>Lmax) Lb=Lmax;
  var mn0=g.min[0], mn1=g.min[1], mn2=g.min[2];
  var mx0=g.max[0], mx1=g.max[1], mx2=g.max[2];
  var s0=g.s[0], s1=g.s[1], s2=g.s[2];
  var halo=snap>0?SLAB_HALO:0;
  var vals=[], snapL=[];
  var evals=0;
  // ── field values, per layer, boundary-clamped (computed on first use) ──
  function ensureVals(q){
    if(vals[q]||q<0||q>=Lq) return;
    var x,y,z,i,j,k,o=0,v;
    if(q&1){ k=(q-1)>>1; z=mn2+s2*k;
      var a=new Float64Array(nx1*ny1);
      var kb=(k===0||k===n2);
      for(j=0;j<ny1;j++){ y=mn1+s1*j; var jb=kb||j===0||j===n1;
        for(i=0;i<nx1;i++){ x=mn0+s0*i; v=fn([x,y,z]);
          if(!(v>-1e20&&v<1e20)) v=-1e3;
          if((jb||i===0||i===n0) && v>0) v=0;
          a[o++]=v; } }
      vals[q]=a;
    } else { k=q>>1; z=mn2+s2*(k-0.5);
      var b=new Float64Array(nx2*ny2);
      var kbo=(k===0||k===n2+1);
      for(j=0;j<ny2;j++){ y=mn1+s1*(j-0.5); var jbo=kbo||j===0||j===n1+1;
        for(i=0;i<nx2;i++){ x=mn0+s0*(i-0.5); v=fn([x,y,z]);
          if(!(v>-1e20&&v<1e20)) v=-1e3;
          if((jbo||i===0||i===n0+1) && v>0) v=0;
          b[o++]=v; } }
      vals[q]=b;
    }
    evals+=vals[q].length;
  }
  function val(t,i,j,k){ return t? vals[2*k+1][i+nx1*j] : vals[2*k][i+nx2*j]; }
  // ── snap decision: an outside point snaps if any crossing on its 14
  //    BCC edges lies within `snap` of it (needs values q−2..q+2).
  var DM=[[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]];
  function ensureSnap(q){
    if(!(snap>0)||snapL[q]||q<0||q>=Lq) return;
    for(var d=-2;d<=2;d++) ensureVals(q+d);
    var lay=vals[q], m=new Uint8Array(lay.length), tm=q&1, kk=tm?(q-1)>>1:q>>1;
    var nx=tm?nx1:nx2, ny=tm?ny1:ny2, nzMax=tm?n2:n2+1, i, j, v;
    for(j=0;j<ny;j++) for(i=0;i<nx;i++){
      v=lay[i+nx*j];
      var inP=v>0, lim=inP?snapIn:snap;
      var near=false, w, t, e;
      // crossing fraction measured from this point: v/(v−w) for a neighbour of the other sign
      if(i>0){ w=lay[i-1+nx*j]; if((w>0)!==inP&&v/(v-w)<lim) near=true; }
      if(!near&&i<nx-1){ w=lay[i+1+nx*j]; if((w>0)!==inP&&v/(v-w)<lim) near=true; }
      if(!near&&j>0){ w=lay[i+nx*(j-1)]; if((w>0)!==inP&&v/(v-w)<lim) near=true; }
      if(!near&&j<ny-1){ w=lay[i+nx*(j+1)]; if((w>0)!==inP&&v/(v-w)<lim) near=true; }
      if(!near&&kk>0){ w=vals[q-2][i+nx*j]; if((w>0)!==inP&&v/(v-w)<lim) near=true; }
      if(!near&&kk<nzMax){ w=vals[q+2][i+nx*j]; if((w>0)!==inP&&v/(v-w)<lim) near=true; }
      // other-type diagonal neighbours: main(i,j,k) ↔ offset(i+dx,j+dy,k+dz);
      // offset(i,j,k) ↔ main(i−1+dx, j−1+dy, k−1+dz)
      for(e=0;e<8&&!near;e++){ var dd=DM[e], ii, jj, kq;
        if(tm){ ii=i+dd[0]; jj=j+dd[1]; kq=kk+dd[2]; w=vals[2*kq][ii+nx2*jj]; }
        else { ii=i-1+dd[0]; jj=j-1+dd[1]; kq=kk-1+dd[2]; if(ii<0||jj<0||kq<0||ii>n0||jj>n1||kq>n2) continue; w=vals[2*kq+1][ii+nx1*jj]; }
        if((w>0)!==inP){ t=v/(v-w); if(t<lim) near=true; } }
      if(near) m[i+nx*j]=1;
    }
    snapL[q]=m;
  }
  function snapped(t,i,j,k){ return snap>0 && (t? snapL[2*k+1][i+nx1*j] : snapL[2*k][i+nx2*j])===1; }
  // ── output buffers ──
  var pos=new Float32Array(1<<16), np=0, idx=new Uint32Array(1<<16), ni=0;
  var seamV=[], seamK=[];
  function pushV(px,py,pz){
    if(np+3>pos.length){ var b2=new Float32Array(pos.length*2); b2.set(pos); pos=b2; }
    if(px<mn0)px=mn0; else if(px>mx0)px=mx0;
    if(py<mn1)py=mn1; else if(py>mx1)py=mx1;
    if(pz<mn2)pz=mn2; else if(pz>mx2)pz=mx2;
    pos[np]=px; pos[np+1]=py; pos[np+2]=pz; np+=3; return np/3-1;
  }
  // vertex caches: per value layer, Int32Array(points·8): slots 0..6 edges
  // owned by the point (0 +x, 1 +y, 2 +z same type, 3..6 diagonal up), 7 the
  // point itself when snapped.
  var cache=[];
  function cacheFor(q){ var c=cache[q]; if(!c){ c=new Int32Array(vals[q].length*8); c.fill(-1); cache[q]=c; } return c; }
  function gid(t,i,j,k){ return t? i+nx1*(j+ny1*k) : mainCount+i+nx2*(j+ny2*k); }
  function ppos(t,i,j,k,out){ if(t){ out[0]=mn0+s0*i; out[1]=mn1+s1*j; out[2]=mn2+s2*k; } else { out[0]=mn0+s0*(i-0.5); out[1]=mn1+s1*(j-0.5); out[2]=mn2+s2*(k-0.5); } }
  var PA=[0,0,0], PB=[0,0,0];
  function onSeam(qa,qb){ // both endpoint layers shared with a neighbour slab
    if(Lb<Lmax && qa>=Lb && qb>=Lb) return true;
    if(La>0 && qa<=La+1 && qb<=La+1) return true;
    return false;
  }
  function pointVert(t,i,j,k){
    var q=t?2*k+1:2*k, c=cacheFor(q), li=t?i+nx1*j:i+nx2*j, s=li*8+7;
    if(c[s]>=0) return c[s];
    ppos(t,i,j,k,PA); var id=pushV(PA[0],PA[1],PA[2]); c[s]=id;
    if(onSeam(q,q)){ seamV.push(id); seamK.push(gid(t,i,j,k)*8+7); }
    return id;
  }
  // Crossing on edge A–B (A inside, B outside, or the reverse). The owner end
  // is the one with the lower layer (same layer: lower in-layer index), and
  // the crossing is always interpolated from it.
  function edgeVert(ta,ia,ja,ka,va, tb,ib,jb,kb,vb){
    var inA=va>0;
    // a snapped end takes the crossing; the outside end wins if both are
    if(!inA && snapped(ta,ia,ja,ka)) return pointVert(ta,ia,ja,ka);
    if(inA && snapped(tb,ib,jb,kb)) return pointVert(tb,ib,jb,kb);
    if(inA && snapped(ta,ia,ja,ka)) return pointVert(ta,ia,ja,ka);
    if(!inA && snapped(tb,ib,jb,kb)) return pointVert(tb,ib,jb,kb);
    var qa=ta?2*ka+1:2*ka, qb=tb?2*kb+1:2*kb;
    var lia=ta?ia+nx1*ja:ia+nx2*ja, lib=tb?ib+nx1*jb:ib+nx2*jb;
    var swap = qb<qa || (qb===qa && lib<lia);
    if(swap){ var T; T=ta;ta=tb;tb=T; T=ia;ia=ib;ib=T; T=ja;ja=jb;jb=T; T=ka;ka=kb;kb=T; T=va;va=vb;vb=T; T=qa;qa=qb;qb=T; T=lia;lia=lib;lib=T; }
    // slot of B relative to owner A
    var slot;
    if(ta===tb){ slot = (ib!==ia)?0:(jb!==ja)?1:2; }
    else if(ta===1){ slot=3+(ib-ia)+2*(jb-ja); }          // main → offset above: (i+dx, j+dy, k+1)
    else { slot=3+(ib-ia+1)+2*(jb-ja+1); }                // offset → main above: (i−1+dx, j−1+dy, k)
    var c=cacheFor(qa), s=lia*8+slot;
    if(c[s]>=0) return c[s];
    ppos(ta,ia,ja,ka,PA); ppos(tb,ib,jb,kb,PB);
    var tt=va/(va-vb);
    if(tclamp>0){ if(tt<tclamp) tt=tclamp; else if(tt>1-tclamp) tt=1-tclamp; }
    var id=pushV(PA[0]+(PB[0]-PA[0])*tt, PA[1]+(PB[1]-PA[1])*tt, PA[2]+(PB[2]-PA[2])*tt);
    c[s]=id;
    if(onSeam(qa,qb)){ seamV.push(id); seamK.push(gid(ta,ia,ja,ka)*8+slot); }
    return id;
  }
  function pushT(a,b,c){
    if(a===b||b===c||a===c) return;
    if(ni+3>idx.length){ var b2=new Uint32Array(idx.length*2); b2.set(idx); idx=b2; }
    idx[ni++]=a; idx[ni++]=b; idx[ni++]=c;
  }
  // one tet. Winding comes from the tet's handedness: for a positively
  // oriented (a,b,c,d), triangle (ab,ac,ad) faces away from a, and with a,b
  // inside, (ac,ad,bd)+(ac,bd,bc) face from a,b towards c,d.
  var TT=[0,0,0,0],TI=[0,0,0,0],TJ=[0,0,0,0],TK=[0,0,0,0],TV=[0,0,0,0];
  var G=[[0,0,0],[0,0,0],[0,0,0],[0,0,0]];
  function det4(a,b,c,d){
    var A=G[a],B=G[b],C=G[c],D=G[d];
    var ux=B[0]-A[0],uy=B[1]-A[1],uz=B[2]-A[2], vx=C[0]-A[0],vy=C[1]-A[1],vz=C[2]-A[2], wx=D[0]-A[0],wy=D[1]-A[1],wz=D[2]-A[2];
    return ux*(vy*wz-vz*wy)-uy*(vx*wz-vz*wx)+uz*(vx*wy-vy*wx);
  }
  function ev(p,r){ return edgeVert(TT[p],TI[p],TJ[p],TK[p],TV[p], TT[r],TI[r],TJ[r],TK[r],TV[r]); }
  // Handedness is the same for every tet of one pattern (12 patterns: three
  // pair axes × four face edges), so it is worked out once (BASE) and only
  // adjusted for the order the case picks its corners in.
  var BASE=new Int8Array(12), curPat=0;
  var ODD22=[0,0,1,0,0,1,0,0,0,0,0,0,0,0,0,0];   // ins {0,2}=5, {1,3}=10 are odd
  ODD22[5]=1; ODD22[10]=1; ODD22[2]=0;
  function tet(){
    var nIn=0, m=0, a;
    for(a=0;a<4;a++) if(TV[a]>0){ nIn++; m|=1<<a; }
    if(nIn===0||nIn===4) return;
    var base=BASE[curPat];
    if(nIn===1||nIn===3){
      var lone=-1, o0=-1, o1=-1, o2=-1;
      for(a=0;a<4;a++){ var isIn=(m>>a)&1; if((nIn===1)===!!isIn) lone=a; else if(o0<0) o0=a; else if(o1<0) o1=a; else o2=a; }
      var pos1=((lone&1)?-base:base)>0;
      var x0=ev(lone,o0), x1=ev(lone,o1), x2=ev(lone,o2);
      // away from lone: right when lone is inside (nIn 1)
      if(pos1===(nIn===1)) pushT(x0,x1,x2); else pushT(x0,x2,x1);
    } else {
      var i0=-1,i1=-1,u0=-1,u1=-1;
      for(a=0;a<4;a++){ if((m>>a)&1){ if(i0<0) i0=a; else i1=a; } else { if(u0<0) u0=a; else u1=a; } }
      var e0=ev(i0,u0), e1=ev(i0,u1), e2=ev(i1,u1), e3=ev(i1,u0);
      if((ODD22[m]?-base:base)>0){ pushT(e0,e1,e2); pushT(e0,e2,e3); }
      else { pushT(e0,e2,e1); pushT(e0,e3,e2); }
    }
  }
  function setV(n,t,i,j,k){ TT[n]=t; TI[n]=i; TJ[n]=j; TK[n]=k; TV[n]=val(t,i,j,k); }
  var CI=[0,1,1,0], CJ=[0,0,1,1];          // square corner cycle offsets
  // handedness per pattern, from one tet of each at unit offsets
  (function(){
    for(var ax=0;ax<3;ax++) for(var mm=0;mm<4;mm++){ var m2=(mm+1)&3;
      if(ax===0){ ppos(0,1,1,1,G[0]); ppos(0,1,1,2,G[1]); ppos(1,CI[mm],CJ[mm],1,G[2]); ppos(1,CI[m2],CJ[m2],1,G[3]); }
      else if(ax===1){ ppos(0,1,1,1,G[0]); ppos(0,2,1,1,G[1]); ppos(1,1,CI[mm],CJ[mm],G[2]); ppos(1,1,CI[m2],CJ[m2],G[3]); }
      else { ppos(0,1,1,1,G[0]); ppos(0,1,2,1,G[1]); ppos(1,CI[mm],1,CJ[mm],G[2]); ppos(1,CI[m2],1,CJ[m2],G[3]); }
      BASE[ax*4+mm]=det4(0,1,2,3)>0?1:-1; }
  })();
  for(var L=La; L<Lb; L++){
    for(var qq=L;qq<=L+2;qq++){ ensureVals(qq); ensureSnap(qq); }
    var mm, m2, cj, ci, A, Bv, c0, c1, c2, c3, sg;
    if((L&1)===0){
      // Z pairs: centres (ci,cj,ck),(ci,cj,ck+1), face main z = ck
      var ck=L>>1, lo=vals[2*ck], hi=vals[2*ck+2], fm=vals[2*ck+1];
      for(cj=1;cj<=n1;cj++) for(ci=1;ci<=n0;ci++){
        A=lo[ci+nx2*cj]; Bv=hi[ci+nx2*cj];
        c0=fm[ci-1+nx1*(cj-1)]; c1=fm[ci+nx1*(cj-1)]; c2=fm[ci+nx1*cj]; c3=fm[ci-1+nx1*cj];
        sg=(A>0)+(Bv>0)+(c0>0)+(c1>0)+(c2>0)+(c3>0); if(sg===0||sg===6) continue;
        for(mm=0;mm<4;mm++){ m2=(mm+1)&3; curPat=mm;
          setV(0,0,ci,cj,ck); setV(1,0,ci,cj,ck+1);
          setV(2,1,ci-1+CI[mm],cj-1+CJ[mm],ck); setV(3,1,ci-1+CI[m2],cj-1+CJ[m2],ck);
          tet(); } }
    } else {
      var ck2=(L+1)>>1, cl=vals[2*ck2], fb=vals[2*ck2-1], ft=vals[2*ck2+1];
      // X pairs: centres (ci,cj,ck),(ci+1,cj,ck), face main x = ci, corners (j,k)
      for(cj=1;cj<=n1;cj++) for(ci=0;ci<=n0;ci++){
        A=cl[ci+nx2*cj]; Bv=cl[ci+1+nx2*cj];
        c0=fb[ci+nx1*(cj-1)]; c1=fb[ci+nx1*cj]; c2=ft[ci+nx1*cj]; c3=ft[ci+nx1*(cj-1)];
        sg=(A>0)+(Bv>0)+(c0>0)+(c1>0)+(c2>0)+(c3>0); if(sg===0||sg===6) continue;
        for(mm=0;mm<4;mm++){ m2=(mm+1)&3; curPat=4+mm;
          setV(0,0,ci,cj,ck2); setV(1,0,ci+1,cj,ck2);
          setV(2,1,ci,cj-1+CI[mm],ck2-1+CJ[mm]); setV(3,1,ci,cj-1+CI[m2],ck2-1+CJ[m2]);
          tet(); } }
      // Y pairs: centres (ci,cj,ck),(ci,cj+1,ck), face main y = cj, corners (i,k)
      for(cj=0;cj<=n1;cj++) for(ci=1;ci<=n0;ci++){
        A=cl[ci+nx2*cj]; Bv=cl[ci+nx2*(cj+1)];
        c0=fb[ci-1+nx1*cj]; c1=fb[ci+nx1*cj]; c2=ft[ci+nx1*cj]; c3=ft[ci-1+nx1*cj];
        sg=(A>0)+(Bv>0)+(c0>0)+(c1>0)+(c2>0)+(c3>0); if(sg===0||sg===6) continue;
        for(mm=0;mm<4;mm++){ m2=(mm+1)&3; curPat=8+mm;
          setV(0,0,ci,cj,ck2); setV(1,0,ci,cj+1,ck2);
          setV(2,1,ci-1+CI[mm],cj,ck2-1+CJ[mm]); setV(3,1,ci-1+CI[m2],cj,ck2-1+CJ[m2]);
          tet(); } }
    }
    // free caches and values no later tet can reach
    cache[L]=null; snapL[L]=null; vals[L-halo]=null;
  }
  return {pos:pos.slice(0,np), idx:idx.slice(0,ni),
    seamV:Uint32Array.from(seamV), seamK:Float64Array.from(seamK), evals:evals};
}

// Join slabs: concatenate, weld seam vertices with equal keys.
// slabs: [{pos, idx, seamV, seamK}] in any order.
function joinSlabs(slabs){
  var nv=0, nt=0, s, i;
  for(s=0;s<slabs.length;s++){ nv+=slabs[s].pos.length/3; nt+=slabs[s].idx.length; }
  var remap=[], key2id=new Map(), out=0, pos=new Float32Array(nv*3), idx=new Uint32Array(nt), oi=0;
  for(s=0;s<slabs.length;s++){
    var S=slabs[s], cnt=S.pos.length/3, r=new Int32Array(cnt).fill(-1);
    for(i=0;i<S.seamV.length;i++){
      var k=S.seamK[i], had=key2id.get(k);
      if(had!==undefined) r[S.seamV[i]]=had;
    }
    for(i=0;i<cnt;i++){ if(r[i]<0){ r[i]=out; pos[3*out]=S.pos[3*i]; pos[3*out+1]=S.pos[3*i+1]; pos[3*out+2]=S.pos[3*i+2]; out++; } }
    for(i=0;i<S.seamV.length;i++){ if(!key2id.has(S.seamK[i])) key2id.set(S.seamK[i], r[S.seamV[i]]); }
    for(i=0;i<S.idx.length;i++) idx[oi++]=r[S.idx[i]];
    remap.push(r);
  }
  return {pos:pos.slice(0,out*3), idx:idx, remap:remap};
}
