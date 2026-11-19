/* proto/simplify-bench/cand/b1b.js - candidate B1b = B1a + windowed tear repair (OUTPUT CHANGES).
   Evaluate after cand/b1a.js (it reuses its helpers). Same as b1a's safeSimplify except: when the first
   meshopt call leaves a tear (and no seam change), instead of re-running meshopt on the whole slab with the
   tear ring locked, re-simplify only a window of the INPUT mesh around the tear (triangles within
   1 + B1B_MARGIN rings of the tear vertices; the window's boundary vertices, the tear ring and the seam
   locks stay fixed) and splice it into the first result: first-result triangles that touch a window-interior
   vertex, or whose three corners are all window vertices, are replaced by the window's result. The splice is
   accepted only if the whole result then passes the same closed + seam checks as every other result; otherwise
   the ordinary whole-slab retry loop runs (so the output is always closed and keeps the seam edges).
   Deterministic: nothing depends on anything but the input arrays. Licence: MIT (F13LD.mesh). */
'use strict';
var B1B_MARGIN=4;
var B1B_STATS={tried:0, ok:0, ms:0};
function safeSimplify(pos, idx, tol, open, flags, shared, seed, noRing){
  var tm={ring:0, closed0:0, seam0:0, first:0, retryMeshopt:0, closedChk:0, seamChk:0, lockRings:0, calls:0, patch:0, patchTried:0, patchOk:0}, tq=_nowMs();
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
  function ensureCsr(){ if(!csr) csr=vertexTriCSR(idx, nV); return csr; }
  var isTear=false;
  function lockRings(list, rings){
    if(!list.length) return;
    var tl=_nowMs();
    var hit=growRings(idx, ensureCsr(), nV, list, rings);
    for(var k=0;k<nV;k++) if(hit[k]&&!lock[k]){ lock[k]=1; locked++; if(isTear) tearLock[k]=1; }
    tm.lockRings+=_nowMs()-tl;
  }
  // windowed repair of a pure tear; returns the spliced index array when it passes the checks, else null
  function windowRepair(res, pr){
    var tp=_nowMs(); tm.patchTried++; B1B_STATS.tried++;
    var c=ensureCsr(), tearHit=growRings(idx, c, nV, pr.tear, SAFE_SIMPLIFY_RINGS[0]), win=growRings(idx, c, nV, pr.tear, SAFE_SIMPLIFY_RINGS[0]+B1B_MARGIN);
    var inS=new Uint8Array(nT), usedS=new Uint8Array(nV), usedN=new Uint8Array(nV), t, k;
    for(t=0;t<nT;t++){ var a=idx[3*t], b=idx[3*t+1], d=idx[3*t+2]; if(win[a]||win[b]||win[d]){ inS[t]=1; usedS[a]=1; usedS[b]=1; usedS[d]=1; } else { usedN[a]=1; usedN[b]=1; usedN[d]=1; } }
    var map=new Int32Array(nV).fill(-1), gv=[], li=[];
    for(t=0;t<nT;t++) if(inS[t]) for(k=0;k<3;k++){ var g=idx[3*t+k]; if(map[g]<0){ map[g]=gv.length; gv.push(g); } li.push(map[g]); }
    var lp=new Float32Array(gv.length*3), ll=new Uint8Array(gv.length), la=new Float32Array(gv.length);
    for(k=0;k<gv.length;k++){ var v=gv[k]; lp[3*k]=pos[3*v]; lp[3*k+1]=pos[3*v+1]; lp[3*k+2]=pos[3*v+2]; ll[k]=(lock[v]||tearHit[v]||usedN[v])?1:0; }
    var s2=S.simplifyWithAttributes(Uint32Array.from(li), lp, 3, la, 1, [0], ll, 6, tol, fl)[0];
    var out=[], nr=res.length, i;
    for(i=0;i<nr;i+=3){
      var x=res[i], y=res[i+1], z=res[i+2];
      var ix=usedS[x]&&!usedN[x], iy=usedS[y]&&!usedN[y], iz=usedS[z]&&!usedN[z];
      if(ix||iy||iz||(usedS[x]&&usedS[y]&&usedS[z])) continue;
      out.push(x, y, z);
    }
    for(i=0;i<s2.length;i++) out.push(gv[s2[i]]);
    var merged=Uint32Array.from(out), pm=problems(merged), ok=!pm.tear.length && !pm.seam.length;
    tm.patch+=_nowMs()-tp;
    if(!ok) return null;
    tm.patchOk++; B1B_STATS.ok++;
    for(k=0;k<nV;k++) if(tearHit[k]&&!lock[k]){ lock[k]=1; locked++; tearLock[k]=1; }
    return merged;
  }
  for(; retries<SAFE_SIMPLIFY_RETRIES; retries++){
    var pr=problems(res);
    if(retries===0){ safeSimplify.first={tear:pr.tear.length, seam:pr.seam.length}; }
    if(!pr.tear.length && !pr.seam.length) return {idx:res, retries:retries, locked:locked, seeded:seeded, unsafe:false, tearLock:tearLock, t:tm};
    if(retries===0 && pr.tear.length && !pr.seam.length){
      var wr=windowRepair(res, pr);
      if(wr) return {idx:wr, retries:1, locked:locked, seeded:seeded, unsafe:false, tearLock:tearLock, t:tm, patched:true};
    }
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
