/* ============================================================
   F13LD.mesh · worker/m35-slab-cleanup.js
   Finishing steps for the slab mesher (v0.15.0), plus the loose-piece
   clean-up every export runs.

   slabMeshoptReady        loads meshoptimizer where m00-libs.js isn't loaded
                           (the bake workers)
   simplifySlab(r, tol)    simplify one slab with every seam vertex locked, so
                           the slabs still join exactly; compacts and remaps
                           r.seamV
   simplifySeamBands(...)  light second pass over the triangles around each
                           seam plane (their outer edges locked)
   compactIndexed(pos,idx) drop unused vertices
   meshClosedReport(...)   every directed edge exactly once with its reverse
   safeSimplify(...)       simplify, and wherever that tears the closed mesh
                           (meshoptimizer can, where walls are thinner than
                           its tolerance) lock the points around the tear and
                           redo it; the classic mesher uses it too
   removeLoosePieces(...)  split into connected pieces and drop the small ones
   ============================================================ */
'use strict';
var _slabMeshopt=null;
function slabMeshopt(){
  if(_slabMeshopt) return _slabMeshopt;
  if(typeof MeshoptSimplifier!=='undefined' && MeshoptSimplifier) return (_slabMeshopt=MeshoptSimplifier);
  return null;
}
var slabMeshoptReady=(async function(){
  if(typeof meshoptReady!=='undefined'){ try{ await meshoptReady; }catch(_){} return slabMeshopt(); }
  try{
    var mod=await import('https://cdn.jsdelivr.net/npm/meshoptimizer@1.1.1/+esm');
    await mod.MeshoptSimplifier.ready; _slabMeshopt=mod.MeshoptSimplifier;
  }catch(e){ console.error('[slab] meshoptimizer load failed:', e); }
  return _slabMeshopt;
})();

// Remove unused vertices. Returns {pos, idx, remap} (remap old→new, -1 unused).
function compactIndexed(pos, idx){
  var nV=pos.length/3, remap=new Int32Array(nV).fill(-1), n=0, i;
  var out=new Uint32Array(idx.length);
  for(i=0;i<idx.length;i++){ var v=idx[i]; if(remap[v]<0) remap[v]=n++; out[i]=remap[v]; }
  var p=new Float32Array(n*3);
  for(i=0;i<nV;i++){ var r=remap[i]; if(r>=0){ p[3*r]=pos[3*i]; p[3*r+1]=pos[3*i+1]; p[3*r+2]=pos[3*i+2]; } }
  return {pos:p, idx:out, remap:remap};
}

// Simplify one slab in place of r ({pos, idx, seamV, seamK}). Seam vertices
// are locked so the neighbouring slab, simplified on its own, still meets
// them exactly.
function simplifySlab(r, tol){
  var S=slabMeshopt();
  if(!S || !(tol>0) || r.idx.length<3) return r;
  var nV=r.pos.length/3, open=new Uint8Array(nV), i;
  for(i=0;i<r.seamV.length;i++) open[r.seamV[i]]=1;
  var ss=safeSimplify(r.pos, r.idx, tol, open, null);
  var c=compactIndexed(r.pos, ss.idx);
  var sv=[], sk=[];
  for(i=0;i<r.seamV.length;i++){ var m=c.remap[r.seamV[i]]; if(m>=0){ sv.push(m); sk.push(r.seamK[i]); } }
  return {pos:c.pos, idx:c.idx, seamV:Uint32Array.from(sv), seamK:Float64Array.from(sk), rawTris:r.idx.length/3, evals:r.evals, retries:ss.retries, locked:ss.locked, gaveUp:!!ss.gaveUp, unsafe:!!ss.unsafe};
}

// Second pass over the band of triangles within bandW of each seam plane
// (z values in seamZ). The band's outer edges are locked (LockBorder on the
// sub-mesh), so the result stays closed. Returns new index array.
function simplifySeamBands(pos, idx, seamZ, bandW, tol){
  var S=slabMeshopt();
  if(!S || !(tol>0) || !seamZ.length) return idx;
  var nV=pos.length/3, near=new Uint8Array(nV), i, t;
  var zs=Array.from(seamZ).sort(function(a,b){return a-b;});
  for(i=0;i<nV;i++){
    var z=pos[3*i+2], lo=0, hi=zs.length-1;
    while(lo<hi){ var mid=(lo+hi)>>1; if(zs[mid]<z) lo=mid+1; else hi=mid; }
    if(Math.abs(zs[lo]-z)<=bandW || (lo>0 && Math.abs(zs[lo-1]-z)<=bandW)) near[i]=1;
  }
  var nT=idx.length/3, inBand=new Uint8Array(nT), nb=0;
  for(t=0;t<nT;t++){ if(near[idx[3*t]]||near[idx[3*t+1]]||near[idx[3*t+2]]){ inBand[t]=1; nb++; } }
  if(!nb) return idx;
  var band=new Uint32Array(nb*3), rest=new Uint32Array((nT-nb)*3), ob=0, or=0;
  for(t=0;t<nT;t++){ var dst=inBand[t]?band:rest, o=inBand[t]?ob:or;
    dst[o]=idx[3*t]; dst[o+1]=idx[3*t+1]; dst[o+2]=idx[3*t+2];
    if(inBand[t]) ob+=3; else or+=3; }
  // lock the band's outer vertices (those also used outside the band)
  var outer=new Uint8Array(nV);
  for(i=0;i<rest.length;i++) outer[rest[i]]=1;
  var ss=safeSimplify(pos, band, tol, outer, ['Sparse']);
  var nb2=ss.idx, out=new Uint32Array(rest.length+nb2.length);
  out.set(rest,0); out.set(nb2,rest.length);
  simplifySeamBands.last={bandTris:nb, after:nb2.length/3, retries:ss.retries, locked:ss.locked, gaveUp:!!ss.gaveUp, unsafe:!!ss.unsafe};
  return out;
}

// Closed, consistently oriented mesh: every directed edge a→b appears once
// and b→a appears once. Returns {ok, bad}; with wantVerts, also verts (the
// vertices of failing edges). ignore: optional Uint8Array; edges with both
// ends marked are not checked (the open seam edges of one slab).
function meshClosedReport(pos, idx, wantVerts, ignore){
  var nV=pos.length/3, f=new Float64Array(idx.length), r=new Float64Array(idx.length), t, q, nE=0;
  for(t=0;t<idx.length;t+=3) for(q=0;q<3;q++){
    var a=idx[t+q], b=idx[t+(q===2?0:q+1)];
    if(ignore && ignore[a] && ignore[b]) continue;
    f[nE]=a*nV+b; r[nE]=b*nV+a; nE++;
  }
  f=f.subarray(0,nE); r=r.subarray(0,nE);
  f.sort(); r.sort();
  var bad=0, i;
  for(i=0;i<nE;i++){ if(f[i]!==r[i]) bad++; else if(i>0 && f[i]===f[i-1]) bad++; }
  var out={ok:bad===0, bad:bad};
  if(bad && wantVerts){
    var cnt=new Map();
    for(i=0;i<nE;i++) cnt.set(f[i],(cnt.get(f[i])||0)+1);
    var vs=new Set();
    cnt.forEach(function(c,k){ var a2=Math.floor(k/nV), b2=k-a2*nV; if(c!==1 || cnt.get(b2*nV+a2)!==1){ vs.add(a2); vs.add(b2); } });
    out.verts=Uint32Array.from(vs);
  }
  return out;
}

// Simplify (meshopt, absolute error) and keep the result closed. lock0:
// optional Uint8Array of vertices that must not move (seams). flags: extra
// meshopt flags. Each retry locks the triangles touching a tear, grown by
// one ring per retry; after the last, the torn area stays unsimplified.
// Returns {idx, retries, locked, unsafe} — unsafe (input returned as is)
// when the input itself was not closed.
// open: optional Uint8Array of vertices on the sub-mesh's open edges (a
// slab's seam, a band's outer edge). Edges with both ends open are not
// checked, and every triangle holding an open edge is locked whole (its
// three corners), so no open edge can disappear.
function ringLock(idx, nV, open, lock){
  // open edges: edges used once in this sub-mesh, both ends open
  var cnt=new Map(), t, q, a, b, k;
  for(t=0;t<idx.length;t+=3) for(q=0;q<3;q++){
    a=idx[t+q]; b=idx[t+(q===2?0:q+1)];
    if(!(open[a]&&open[b])) continue;
    k=a<b?a*nV+b:b*nV+a; cnt.set(k,(cnt.get(k)||0)+1);
  }
  for(t=0;t<idx.length;t+=3){
    var hit=false;
    for(q=0;q<3&&!hit;q++){ a=idx[t+q]; b=idx[t+(q===2?0:q+1)];
      if(open[a]&&open[b]){ k=a<b?a*nV+b:b*nV+a; if(cnt.get(k)===1) hit=true; } }
    if(hit){ lock[idx[t]]=1; lock[idx[t+1]]=1; lock[idx[t+2]]=1; }
  }
}
function safeSimplify(pos, idx, tol, open, flags){
  var lock0=null;
  if(open){ lock0=new Uint8Array(open.length); ringLock(idx, open.length, open, lock0); }
  var S=slabMeshopt();
  if(!S || !(tol>0) || idx.length<3) return {idx:idx, retries:0, locked:0, unsafe:false};
  var nV=pos.length/3, nT=idx.length/3;
  var lock=new Uint8Array(nV); if(lock0) lock.set(lock0);
  var attr=new Float32Array(nV), fl=['ErrorAbsolute'].concat(flags||[]);
  if(meshClosedReport(pos, idx, false, open).ok===false) return {idx:idx, retries:0, locked:0, unsafe:true};
  var res=S.simplifyWithAttributes(idx, pos, 3, attr, 1, [0], lock, 6, tol, fl)[0];
  var retries=0, locked=0;
  for(; retries<4; retries++){
    var rep=meshClosedReport(pos, res, true, open);
    if(rep.ok) return {idx:res, retries:retries, locked:locked, unsafe:false};
    var hit=new Uint8Array(nV), t, k;
    for(k=0;k<rep.verts.length;k++) hit[rep.verts[k]]=1;
    // grow by retries+1 rings in the input mesh
    for(var ring=0; ring<=retries; ring++){
      var nxt=hit.slice();
      for(t=0;t<nT;t++){ var a=idx[3*t], b=idx[3*t+1], c=idx[3*t+2];
        if(hit[a]||hit[b]||hit[c]){ nxt[a]=1; nxt[b]=1; nxt[c]=1; } }
      hit=nxt;
    }
    for(k=0;k<nV;k++) if(hit[k]&&!lock[k]){ lock[k]=1; locked++; }
    res=S.simplifyWithAttributes(idx, pos, 3, attr, 1, [0], lock, 6, tol, fl)[0];
  }
  if(meshClosedReport(pos, res, false, open).ok) return {idx:res, retries:retries, locked:locked, unsafe:false};
  return {idx:idx, retries:retries, locked:locked, unsafe:false, gaveUp:true};
}

// Loose-piece clean-up. Splits the mesh into connected pieces (shared
// vertices) and drops every piece whose |volume| is below
//   max(minAbs, frac · |volume of the largest piece|).
// Pieces are kept or dropped whole, so the rest stays closed. Returns
// null when nothing was dropped, else
//   {vertProperties, triVerts, dropped, pieces, droppedVol, keptVol}.
function removeLoosePieces(vp, tv, frac, minAbs){
  var nV=vp.length/3, nT=tv.length/3, i, t;
  if(nT===0) return null;
  var parent=new Int32Array(nV); for(i=0;i<nV;i++) parent[i]=i;
  function find(x){ while(parent[x]!==x){ parent[x]=parent[parent[x]]; x=parent[x]; } return x; }
  for(t=0;t<nT;t++){
    var a=find(tv[3*t]), b=find(tv[3*t+1]), c=find(tv[3*t+2]);
    if(a!==b) parent[b]=a;
    c=find(c); a=find(a); if(a!==c) parent[c]=a;
  }
  var comp=new Int32Array(nV).fill(-1), nC=0, root=new Int32Array(nV);
  for(i=0;i<nV;i++){ var rr=find(i); if(comp[rr]<0) comp[rr]=nC++; root[i]=comp[rr]; }
  var vol=new Float64Array(nC), used=new Uint8Array(nC);
  for(t=0;t<nT;t++){
    var A=3*tv[3*t], B=3*tv[3*t+1], C=3*tv[3*t+2], k=root[tv[3*t]];
    used[k]=1;
    vol[k]+=(vp[A]*(vp[B+1]*vp[C+2]-vp[B+2]*vp[C+1])+vp[A+1]*(vp[B+2]*vp[C]-vp[B]*vp[C+2])+vp[A+2]*(vp[B]*vp[C+1]-vp[B+1]*vp[C]))/6;
  }
  var pieces=0, big=0;
  for(i=0;i<nC;i++){ if(!used[i]) continue; pieces++; if(Math.abs(vol[i])>big) big=Math.abs(vol[i]); }
  if(pieces<2) return null;
  var lim=Math.max(minAbs||0, (frac||0)*big);
  var drop=new Uint8Array(nC), nDrop=0, dropVol=0, keptVol=0;
  for(i=0;i<nC;i++){ if(!used[i]) continue;
    if(Math.abs(vol[i])<lim){ drop[i]=1; nDrop++; dropVol+=Math.abs(vol[i]); } else keptVol+=vol[i]; }
  if(!nDrop) return null;
  var keepT=0; for(t=0;t<nT;t++) if(!drop[root[tv[3*t]]]) keepT++;
  var map=new Int32Array(nV).fill(-1), nv=0, otv=new Uint32Array(keepT*3), o=0;
  for(t=0;t<nT;t++){
    if(drop[root[tv[3*t]]]) continue;
    for(var e=0;e<3;e++){ var v=tv[3*t+e]; if(map[v]<0) map[v]=nv++; otv[o++]=map[v]; }
  }
  var ovp=new Float32Array(nv*3);
  for(i=0;i<nV;i++){ var m=map[i]; if(m>=0){ ovp[3*m]=vp[3*i]; ovp[3*m+1]=vp[3*i+1]; ovp[3*m+2]=vp[3*i+2]; } }
  return {vertProperties:ovp, triVerts:otv, dropped:nDrop, pieces:pieces, droppedVol:dropVol, keptVol:keptVol};
}
