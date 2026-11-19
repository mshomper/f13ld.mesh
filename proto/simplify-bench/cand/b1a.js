/* proto/simplify-bench/cand/b1a.js - candidate B1a: SAME OUTPUT, faster checks.
   A classic script that the bench evaluates AFTER worker/m35-slab-cleanup.js in the same vm context. It
   redefines the global functions below; nothing in worker/ is edited and nothing is wired into the export.
     meshClosedReport  linear-time open-addressing hash of the directed edges instead of two Float64 sorts.
                       ok and the vertex set of failing edges equal the original's; `bad` is the number of failing
                       directed-edge entries (the original counts sorted-position mismatches, only a message number).
     safeSimplify      same control flow and the same meshopt calls as m35 (so the same indices come out), with:
                       the initial seam ring lock and the seam-edge counts only visiting triangles that hold two
                       open vertices; lockRings growing from the vertex ring frontier over a vertex->triangle CSR
                       instead of scanning every triangle once per ring.
   Licence: MIT (F13LD.mesh). */
'use strict';
function meshClosedReport(pos, idx, wantVerts, ignore){
  // per-vertex CSR of outgoing half-edges (targets only); an edge a->b is fine when b occurs exactly once among
  // a's targets and a occurs exactly once among b's targets (vertex degrees are small, so the scans are short)
  var nV=pos.length/3, nI=idx.length, t, q, i, a, b;
  var keep=new Uint8Array(nI), off=new Uint32Array(nV+1), isFn=typeof ignore==='function';
  for(t=0;t<nI;t+=3) for(q=0;q<3;q++){
    a=idx[t+q]; b=idx[t+(q===2?0:q+1)];
    if(ignore && (isFn ? ignore(a,b) : (ignore[a] && ignore[b]))) continue;
    keep[t+q]=1; off[a+1]++;
  }
  for(i=0;i<nV;i++) off[i+1]+=off[i];
  var fill=off.slice(0,nV), to=new Uint32Array(off[nV]);
  for(t=0;t<nI;t+=3) for(q=0;q<3;q++){ if(!keep[t+q]) continue; to[fill[idx[t+q]]++]=idx[t+(q===2?0:q+1)]; }
  var bad=0, vs=null;
  for(t=0;t<nI;t+=3) for(q=0;q<3;q++){
    if(!keep[t+q]) continue;
    a=idx[t+q]; b=idx[t+(q===2?0:q+1)];
    var c1=0, c2=0, p, e;
    for(p=off[a], e=off[a+1]; p<e; p++) if(to[p]===b) c1++;
    for(p=off[b], e=off[b+1]; p<e; p++) if(to[p]===a) c2++;
    if(c1!==1 || c2!==1){ bad++; if(wantVerts){ if(!vs) vs=new Set(); vs.add(a); vs.add(b); } }
  }
  var out={ok:bad===0, bad:bad};
  if(bad && wantVerts) out.verts=Uint32Array.from(vs);
  return out;
}

// open edges (both ends open AND shared(a,b)) counted per directed edge, visiting only triangles with >= 2 open corners
function openEdgeCountsFast(idx, nV, shared, open){
  var m=new Map(), t, q, a, b, k;
  for(t=0;t<idx.length;t+=3){
    if(open[idx[t]]+open[idx[t+1]]+open[idx[t+2]]<2) continue;
    for(q=0;q<3;q++){
      a=idx[t+q]; b=idx[t+(q===2?0:q+1)];
      if(!shared(a,b)) continue;
      k=a*nV+b; m.set(k,(m.get(k)||0)+1);
    }
  }
  return m;
}
function openEdgeChangesFast(before, idx, nV, shared, open){
  var after=openEdgeCountsFast(idx, nV, shared, open), vs=[];
  function add(k){ var a=Math.floor(k/nV); vs.push(a, k-a*nV); }
  before.forEach(function(c,k){ if(after.get(k)!==c) add(k); });
  after.forEach(function(c,k){ if(!before.has(k)) add(k); });
  return vs;
}
function ringLockFast(idx, nV, shared, lock, open){
  var cnt=new Map(), t, q, a, b, k;
  for(t=0;t<idx.length;t+=3){
    if(open[idx[t]]+open[idx[t+1]]+open[idx[t+2]]<2) continue;
    for(q=0;q<3;q++){
      a=idx[t+q]; b=idx[t+(q===2?0:q+1)];
      if(!shared(a,b)) continue;
      k=a<b?a*nV+b:b*nV+a; cnt.set(k,(cnt.get(k)||0)+1);
    }
  }
  for(t=0;t<idx.length;t+=3){
    if(open[idx[t]]+open[idx[t+1]]+open[idx[t+2]]<2) continue;
    var hit=false;
    for(q=0;q<3&&!hit;q++){ a=idx[t+q]; b=idx[t+(q===2?0:q+1)];
      if(shared(a,b)){ k=a<b?a*nV+b:b*nV+a; if(cnt.get(k)===1) hit=true; } }
    if(hit){ lock[idx[t]]=1; lock[idx[t+1]]=1; lock[idx[t+2]]=1; }
  }
}
// vertex -> triangles CSR
function vertexTriCSR(idx, nV){
  var off=new Uint32Array(nV+1), t, i, nT=idx.length/3;
  for(i=0;i<idx.length;i++) off[idx[i]+1]++;
  for(i=0;i<nV;i++) off[i+1]+=off[i];
  var fill=off.slice(0,nV), tri=new Uint32Array(idx.length);
  for(t=0;t<nT;t++) for(i=0;i<3;i++){ var v=idx[3*t+i]; tri[fill[v]++]=t; }
  return {off:off, tri:tri};
}
// grow `list` by `rings` rings over the triangles; returns the Uint8Array of reached vertices
function growRings(idx, csr, nV, list, rings){
  var hit=new Uint8Array(nV), front=[], k;
  for(k=0;k<list.length;k++){ var v=list[k]; if(!hit[v]){ hit[v]=1; front.push(v); } }
  for(var ring=0; ring<rings; ring++){
    var next=[];
    for(var f=0; f<front.length; f++){
      var u=front[f];
      for(var p=csr.off[u]; p<csr.off[u+1]; p++){ var t=csr.tri[p];
        for(var c=0;c<3;c++){ var w=idx[3*t+c]; if(!hit[w]){ hit[w]=1; next.push(w); } } }
    }
    front=next;
  }
  return hit;
}

function safeSimplify(pos, idx, tol, open, flags, shared, seed, noRing){
  var tm={ring:0, closed0:0, seam0:0, first:0, retryMeshopt:0, closedChk:0, seamChk:0, lockRings:0, calls:0}, tq=_nowMs();
  var lock0=null;
  if(open && !shared) shared=function(a,b){ return open[a]===1 && open[b]===1; };
  if(open){ lock0=new Uint8Array(open); if(!noRing) ringLockFast(idx, open.length, shared, lock0, open); }
  tm.ring=_nowMs()-tq;
  var S=slabMeshopt();
  if(!S || !(tol>0) || idx.length<3) return {idx:idx, retries:0, locked:0, unsafe:false};
  var nV=pos.length/3, nT=idx.length/3;
  var lock=new Uint8Array(nV); if(lock0) lock.set(lock0);
  var tearLock=new Uint8Array(nV), seeded=0;
  if(seed){ for(var si=0;si<nV;si++) if(seed[si]){ tearLock[si]=1; if(!lock[si]){ lock[si]=1; seeded++; } } }
  var attr=new Float32Array(nV), fl=['ErrorAbsolute'].concat(flags||[]);
  tq=_nowMs();
  if(meshClosedReport(pos, idx, false, shared||null).ok===false) return {idx:idx, retries:0, locked:0, unsafe:true};
  tm.closed0=_nowMs()-tq; tq=_nowMs();
  var res=S.simplifyWithAttributes(idx, pos, 3, attr, 1, [0], lock, 6, tol, fl)[0];
  tm.first=_nowMs()-tq; tm.calls=1; tq=_nowMs();
  var retries=0, locked=0, before=(shared&&open)?openEdgeCountsFast(idx, nV, shared, open):(shared?openEdgeCounts(idx, nV, shared):null);
  tm.seam0=_nowMs()-tq;
  function problems(r){
    var t1=_nowMs();
    var rep=meshClosedReport(pos, r, true, shared||null);
    var tr=rep.verts?Array.from(rep.verts):[];
    var t2=_nowMs(); tm.closedChk+=t2-t1;
    var sm=before?(open?openEdgeChangesFast(before, r, nV, shared, open):openEdgeChanges(before, r, nV, shared)):[];
    tm.seamChk+=_nowMs()-t2;
    return {tear:tr, seam:sm};
  }
  var csr=null;
  function lockRings(list, rings){
    if(!list.length) return;
    var tl=_nowMs();
    if(!csr) csr=vertexTriCSR(idx, nV);
    var hit=growRings(idx, csr, nV, list, rings);
    for(var k=0;k<nV;k++) if(hit[k]&&!lock[k]){ lock[k]=1; locked++; if(isTear) tearLock[k]=1; }
    tm.lockRings+=_nowMs()-tl;
  }
  var isTear=false;
  for(; retries<SAFE_SIMPLIFY_RETRIES; retries++){
    var pr=problems(res);
    if(retries===0){ safeSimplify.first={tear:pr.tear.length, seam:pr.seam.length}; }
    if(!pr.tear.length && !pr.seam.length) return {idx:res, retries:retries, locked:locked, seeded:seeded, unsafe:false, tearLock:tearLock, t:tm};
    isTear=true; lockRings(pr.tear, SAFE_SIMPLIFY_RINGS[Math.min(retries, SAFE_SIMPLIFY_RINGS.length-1)]);
    isTear=false; lockRings(pr.seam, 1);
    tq=_nowMs();
    res=S.simplifyWithAttributes(idx, pos, 3, attr, 1, [0], lock, 6, tol, fl)[0];
    tm.retryMeshopt+=_nowMs()-tq; tm.calls++;
  }
  var last=problems(res);
  if(!last.tear.length && !last.seam.length) return {idx:res, retries:retries, locked:locked, seeded:seeded, unsafe:false, tearLock:tearLock, t:tm};
  return {idx:idx, retries:retries, locked:locked, seeded:seeded, unsafe:false, gaveUp:true, tearLock:tearLock, t:tm};
}
