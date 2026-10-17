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
   flipEdges(...)          edge flips on nearly flat areas for better triangles
                           (v0.16.0); run after each slab / band simplify
   triQuality(pos,idx)     needles and minimum-angle stats, one pass
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
// flip: false skips the edge-flip pass (v0.16.0; tests compare with it).
function simplifySlab(r, tol, flip){
  var S=slabMeshopt();
  if(!S || !(tol>0) || r.idx.length<3) return r;
  var nV=r.pos.length/3, open=new Uint8Array(nV), i;
  for(i=0;i<r.seamV.length;i++) open[r.seamV[i]]=1;
  // Edges between seam vertices that the neighbouring slab also uses
  // (r.nbrA/nbrB, m34) must come out unchanged; the rest are this slab's own.
  var shared=null;
  if(r.nbrA){
    var key=new Map(); for(i=0;i<r.seamV.length;i++) key.set(r.seamV[i], r.seamK[i]);
    var pairs=new Set(); for(i=0;i<r.nbrA.length;i++) pairs.add(r.nbrA[i]+','+r.nbrB[i]);
    shared=function(a,b){ if(open[a]!==1||open[b]!==1) return false; var ka=key.get(a), kb=key.get(b); return pairs.has(ka<kb?ka+','+kb:kb+','+ka); };
  }
  var ss=safeSimplify(r.pos, r.idx, tol, open, null, shared);
  // v0.16.0: edge flips; no edge between two seam vertices is removed or
  // made and no vertex moves, so the slabs still join exactly
  var fr=flip===false?{idx:ss.idx, flips:0, ms:0}:checkedFlip(r.pos, ss.idx, open, shared||open);
  var c=compactIndexed(r.pos, fr.idx);
  var sv=[], sk=[];
  for(i=0;i<r.seamV.length;i++){ var m=c.remap[r.seamV[i]]; if(m>=0){ sv.push(m); sk.push(r.seamK[i]); } }
  return {pos:c.pos, idx:c.idx, seamV:Uint32Array.from(sv), seamK:Float64Array.from(sk), rawTris:r.idx.length/3, evals:r.evals, retries:ss.retries, locked:ss.locked, gaveUp:!!ss.gaveUp, unsafe:!!ss.unsafe, flips:fr.flips, flipMs:fr.ms, flipRejected:!!fr.rejected};
}
// flipEdges opts for the slab / band passes: 'edge' locking lets seam
// vertices take part (their edges to each other and their positions stay),
// which reaches the fans along the seams (about twice the needles fixed)
var SLAB_FLIP_OPTS={lockMode:'edge'};
// flipEdges, kept only if the result is still closed (ignore: as for
// meshClosedReport — the sub-mesh's open edges). Returns {idx, flips, ms,
// rejected}.
function checkedFlip(pos, idx, lockV, ignore){
  var t0=(typeof performance!=='undefined')?performance.now():0;
  var out=flipEdges(pos, idx, lockV, SLAB_FLIP_OPTS), n=flipEdges.last.flips, rej=false;
  if(n && !meshClosedReport(pos, out, false, ignore||null).ok){ out=idx; n=0; rej=true; }
  return {idx:out, flips:n, rejected:rej, ms:((typeof performance!=='undefined')?performance.now():0)-t0};
}

// Second pass over the triangles within bandW of each seam plane (z values
// in seamZ), one band per seam so the bands can be simplified on separate
// cores (v0.15.0). seamBandJobs cuts them out as small local meshes whose
// outer vertices (also used outside the band) are locked; simplifyBandJob
// runs one; joinSeamBands puts the results back. simplifySeamBands does all
// three in this thread.
function seamBandJobs(pos, idx, seamZ, bandW){
  var nV=pos.length/3, nT=idx.length/3, i, t, k;
  var zs=Array.from(seamZ).sort(function(a,b){return a-b;});
  var vb=new Int32Array(nV).fill(-1);
  for(i=0;i<nV;i++){
    var z=pos[3*i+2], lo=0, hi=zs.length-1;
    while(lo<hi){ var mid=(lo+hi)>>1; if(zs[mid]<z) lo=mid+1; else hi=mid; }
    var best=-1, bd=bandW;
    if(Math.abs(zs[lo]-z)<=bd){ best=lo; bd=Math.abs(zs[lo]-z); }
    if(lo>0 && Math.abs(zs[lo-1]-z)<=bd) best=lo-1;
    vb[i]=best;
  }
  var tb=new Int32Array(nT);
  for(t=0;t<nT;t++){ var a0=vb[idx[3*t]], a1=vb[idx[3*t+1]], a2=vb[idx[3*t+2]]; tb[t]=a0>=0?a0:(a1>=0?a1:a2); }
  // a vertex used by triangles of more than one band (or the rest) is outer
  var own=new Int32Array(nV).fill(-2), mixed=new Uint8Array(nV);
  for(t=0;t<nT;t++) for(k=0;k<3;k++){ var v=idx[3*t+k]; if(own[v]===-2) own[v]=tb[t]; else if(own[v]!==tb[t]) mixed[v]=1; }
  var cnt=new Int32Array(zs.length), nRest=0;
  for(t=0;t<nT;t++){ if(tb[t]>=0) cnt[tb[t]]++; else nRest++; }
  var rest=new Uint32Array(nRest*3), or=0, jobs=[], tris=[];
  for(k=0;k<zs.length;k++) tris.push(new Uint32Array(cnt[k]));
  var fill=new Int32Array(zs.length);
  for(t=0;t<nT;t++){ if(tb[t]<0){ rest[or++]=idx[3*t]; rest[or++]=idx[3*t+1]; rest[or++]=idx[3*t+2]; } else tris[tb[t]][fill[tb[t]]++]=t; }
  var map=new Int32Array(nV).fill(-1);
  for(k=0;k<zs.length;k++){
    var T=tris[k]; if(!T.length) continue;
    var gv=[], li=new Uint32Array(T.length*3);
    for(i=0;i<T.length;i++) for(var e=0;e<3;e++){ var g=idx[3*T[i]+e]; if(map[g]<0){ map[g]=gv.length; gv.push(g); } li[3*i+e]=map[g]; }
    var lp=new Float32Array(gv.length*3), outer=new Uint8Array(gv.length);
    for(i=0;i<gv.length;i++){ lp[3*i]=pos[3*gv[i]]; lp[3*i+1]=pos[3*gv[i]+1]; lp[3*i+2]=pos[3*gv[i]+2]; outer[i]=mixed[gv[i]]; map[gv[i]]=-1; }
    jobs.push({k:k, pos:lp, idx:li, outer:outer, gv:Uint32Array.from(gv)});
  }
  return {jobs:jobs, rest:rest, bandTris:nT-nRest};
}
function simplifyBandJob(job, tol, flip){
  var ss=safeSimplify(job.pos, job.idx, tol, job.outer, ['Sparse']);
  // v0.16.0: edge flips, outer edges (both ends outer) kept as they are
  var fr=flip===false?{idx:ss.idx, flips:0, ms:0}:checkedFlip(job.pos, ss.idx, job.outer, job.outer);
  return {idx:fr.idx, retries:ss.retries, locked:ss.locked, gaveUp:!!ss.gaveUp, unsafe:!!ss.unsafe, flips:fr.flips, flipMs:fr.ms, flipRejected:!!fr.rejected};
}
function joinSeamBands(rest, jobs, results){
  var n=rest.length, i, k;
  for(k=0;k<results.length;k++) n+=results[k].idx.length;
  var out=new Uint32Array(n); out.set(rest,0); var o=rest.length;
  for(k=0;k<jobs.length;k++){ var gv=jobs[k].gv, li=results[k].idx; for(i=0;i<li.length;i++) out[o++]=gv[li[i]]; }
  return out;
}
function simplifySeamBands(pos, idx, seamZ, bandW, tol, flip){
  var S=slabMeshopt();
  if(!S || !(tol>0) || !seamZ.length) return idx;
  var cut=seamBandJobs(pos, idx, seamZ, bandW);
  if(!cut.jobs.length) return idx;
  var res=cut.jobs.map(function(j){ return simplifyBandJob(j, tol, flip); });
  var out=joinSeamBands(cut.rest, cut.jobs, res);
  simplifySeamBands.last=bandStats(cut, res, out);
  return out;
}
function bandStats(cut, res, out){
  var r=0, l=0, gu=false, un=false, after=0, fl=0, fr=0;
  for(var k=0;k<res.length;k++){ r+=res[k].retries; l+=res[k].locked; gu=gu||res[k].gaveUp; un=un||res[k].unsafe; after+=res[k].idx.length/3; fl+=res[k].flips||0; if(res[k].flipRejected) fr++; }
  return {bandTris:cut.bandTris, after:after, bands:res.length, retries:r, locked:l, gaveUp:gu, unsafe:un, flips:fl, flipRejected:fr};
}

// Closed, consistently oriented mesh: every directed edge a→b appears once
// and b→a appears once. Returns {ok, bad}; with wantVerts, also verts (the
// vertices of failing edges). ignore: optional Uint8Array; edges with both
// ends marked are not checked (the open seam edges of one slab).
function meshClosedReport(pos, idx, wantVerts, ignore){
  var nV=pos.length/3, f=new Float64Array(idx.length), r=new Float64Array(idx.length), t, q, nE=0;
  for(t=0;t<idx.length;t+=3) for(q=0;q<3;q++){
    var a=idx[t+q], b=idx[t+(q===2?0:q+1)];
    if(ignore && (typeof ignore==='function' ? ignore(a,b) : (ignore[a] && ignore[b]))) continue;
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
function ringLock(idx, nV, shared, lock){
  // open edges: shared edges used once in this sub-mesh
  var cnt=new Map(), t, q, a, b, k;
  for(t=0;t<idx.length;t+=3) for(q=0;q<3;q++){
    a=idx[t+q]; b=idx[t+(q===2?0:q+1)];
    if(!shared(a,b)) continue;
    k=a<b?a*nV+b:b*nV+a; cnt.set(k,(cnt.get(k)||0)+1);
  }
  for(t=0;t<idx.length;t+=3){
    var hit=false;
    for(q=0;q<3&&!hit;q++){ a=idx[t+q]; b=idx[t+(q===2?0:q+1)];
      if(shared(a,b)){ k=a<b?a*nV+b:b*nV+a; if(cnt.get(k)===1) hit=true; } }
    if(hit){ lock[idx[t]]=1; lock[idx[t+1]]=1; lock[idx[t+2]]=1; }
  }
}
// Directed edges with both ends open, counted. A sub-mesh's open edges are
// shared with its neighbour, so simplify must leave every one of them as it
// was: same edges, same counts. Returns the vertices of edges that changed.
function openEdgeCounts(idx, nV, shared){
  var m=new Map(), t, q, a, b, k;
  for(t=0;t<idx.length;t+=3) for(q=0;q<3;q++){
    a=idx[t+q]; b=idx[t+(q===2?0:q+1)];
    if(!shared(a,b)) continue;
    k=a*nV+b; m.set(k,(m.get(k)||0)+1);
  }
  return m;
}
function openEdgeChanges(before, idx, nV, shared){
  var after=openEdgeCounts(idx, nV, shared), vs=[];
  function add(k){ var a=Math.floor(k/nV); vs.push(a, k-a*nV); }
  before.forEach(function(c,k){ if(after.get(k)!==c) add(k); });
  after.forEach(function(c,k){ if(!before.has(k)) add(k); });
  return vs;
}
var SAFE_SIMPLIFY_RETRIES=12;
// rings of lock around a tear, by retry: small first (most tears settle),
// then larger for a tear that creeps along a line a cell per retry
var SAFE_SIMPLIFY_RINGS=[1,1,2,2,3,3,4,6,8,10,12,12];
// shared: optional function(a,b) — true for an edge the neighbouring
// sub-mesh also uses; defaults to "both ends open".
function safeSimplify(pos, idx, tol, open, flags, shared){
  var lock0=null;
  if(open && !shared) shared=function(a,b){ return open[a]===1 && open[b]===1; };
  if(open){ lock0=new Uint8Array(open); ringLock(idx, open.length, shared, lock0); }   // open vertices themselves stay put too
  var S=slabMeshopt();
  if(!S || !(tol>0) || idx.length<3) return {idx:idx, retries:0, locked:0, unsafe:false};
  var nV=pos.length/3, nT=idx.length/3;
  var lock=new Uint8Array(nV); if(lock0) lock.set(lock0);
  var attr=new Float32Array(nV), fl=['ErrorAbsolute'].concat(flags||[]);
  if(meshClosedReport(pos, idx, false, shared||null).ok===false) return {idx:idx, retries:0, locked:0, unsafe:true};
  var res=S.simplifyWithAttributes(idx, pos, 3, attr, 1, [0], lock, 6, tol, fl)[0];
  var retries=0, locked=0, before=shared?openEdgeCounts(idx, nV, shared):null;
  // Two kinds of problem: a tear (closed check) and a changed seam edge.
  // A tear can come from a collapse a few edges away, so its lock grows by
  // SAFE_SIMPLIFY_RINGS; a changed seam edge comes from a collapse next
  // to it, so one ring is enough.
  function problems(r){
    var rep=meshClosedReport(pos, r, true, shared||null);
    return {tear:rep.verts?Array.from(rep.verts):[], seam:before?openEdgeChanges(before, r, nV, shared):[]};
  }
  function lockRings(list, rings){
    if(!list.length) return;
    var hit=new Uint8Array(nV), t, k;
    for(k=0;k<list.length;k++) hit[list[k]]=1;
    for(var ring=0; ring<rings; ring++){
      var nxt=hit.slice();
      for(t=0;t<nT;t++){ var a=idx[3*t], b=idx[3*t+1], c=idx[3*t+2];
        if(hit[a]||hit[b]||hit[c]){ nxt[a]=1; nxt[b]=1; nxt[c]=1; } }
      hit=nxt;
    }
    for(k=0;k<nV;k++) if(hit[k]&&!lock[k]){ lock[k]=1; locked++; }
  }
  for(; retries<SAFE_SIMPLIFY_RETRIES; retries++){
    var pr=problems(res);
    if(retries===0){ safeSimplify.first={tear:pr.tear.length, seam:pr.seam.length}; }
    if(!pr.tear.length && !pr.seam.length) return {idx:res, retries:retries, locked:locked, unsafe:false};
    // locks add up across retries: tears tend to move, so the next try only
    // has to catch the new ones
    lockRings(pr.tear, SAFE_SIMPLIFY_RINGS[Math.min(retries, SAFE_SIMPLIFY_RINGS.length-1)]);
    lockRings(pr.seam, 1);
    res=S.simplifyWithAttributes(idx, pos, 3, attr, 1, [0], lock, 6, tol, fl)[0];
  }
  var last=problems(res);
  if(!last.tear.length && !last.seam.length) return {idx:res, retries:retries, locked:locked, unsafe:false};
  return {idx:idx, retries:retries, locked:locked, unsafe:false, gaveUp:true};
}

// Edge flips (v0.16.0). Simplify leaves long thin triangles on flat areas
// (fans between locked seam points); flipping the shared edge of two
// triangles that lie in one plane changes no shape and can fix them.
// Greedy max-min-angle flips, edges in half-edge order, up to maxPasses
// passes (stops at the first pass without a flip), so the result depends
// only on the inputs. Positions never move; the triangle count stays.
// An edge a→b (triangles abc, bad) becomes c→d (triangles adc, dbc) only if
//   - it is shared by exactly two triangles, once each way
//   - none of a, b, c, d is locked (lockV) or pinched, and a, b keep at
//     least 3 edges. opts.lockMode 'edge': locked vertices may take part,
//     but no edge with both ends locked is removed or made, and they never
//     move — every seam (open) edge stays as it was
//   - c–d is not an edge already (that would be non-manifold)
//   - the two old triangles and both new ones are within maxDihedralDeg
//     (default 1°) of each other, and neither new one is degenerate
//   - Delaunay: the angles at c and d add up to more than 180° (then the
//     quad is convex, and for a flat quad that is the max-min-angle choice; a small margin keeps
//     square grids, whose two diagonals tie, as they are)
// opts: {maxDihedralDeg, maxPasses (6), lockMode ('vertex' | 'edge')}. Returns the new idx (a copy);
// stats in flipEdges.last = {flips, passes}.
function flipEdges(pos, idx, lockV, opts){
  opts=opts||{};
  var maxPasses=opts.maxPasses>0?opts.maxPasses:6;
  var cosT=Math.cos((opts.maxDihedralDeg>0?opts.maxDihedralDeg:1)*Math.PI/180);
  var edgeLock=opts.lockMode==='edge';
  var nV=pos.length/3, nH=idx.length, nT=nH/3, h, g, v, i, k;
  var out=new Uint32Array(idx);
  flipEdges.last={flips:0, passes:0};
  if(nT<2) return out;
  // half-edge h = 3t+q runs out[h] → out[nx(h)]
  function nx(x){ return x%3===2?x-2:x+1; }
  function pv(x){ return x%3===0?x+2:x-1; }
  // outgoing half-edges per vertex (CSR) → opposite half-edges
  var deg=new Int32Array(nV), st=new Int32Array(nV+1), lst=new Int32Array(nH), fill;
  for(h=0;h<nH;h++) deg[out[h]]++;
  for(v=0;v<nV;v++) st[v+1]=st[v]+deg[v];
  fill=st.slice(0,nV);
  for(h=0;h<nH;h++) lst[fill[out[h]]++]=h;
  var opp=new Int32Array(nH).fill(-1);
  for(h=0;h<nH;h++){
    var a=out[h], b=out[nx(h)], m=-1, nf=0, nr=0;
    for(k=st[a];k<st[a+1];k++) if(out[nx(lst[k])]===b) nf++;
    for(k=st[b];k<st[b+1];k++){ g=lst[k]; if(out[nx(g)]===a){ nr++; m=g; } }
    if(nf===1 && nr===1) opp[h]=m;
  }
  lst=null; fill=null;
  // a vertex can take part only if walking its fan (both ways from one
  // half-edge, for an open fan) reaches every one of its half-edges, so
  // hasEdge sees all its neighbours (pinched vertices never do)
  var vh=new Int32Array(nV).fill(-1), bad=new Uint8Array(nV), lk=new Uint8Array(nV);
  for(h=0;h<nH;h++) if(vh[out[h]]<0) vh[out[h]]=h;
  for(v=0;v<nV;v++){
    if(vh[v]<0) continue;
    if(lockV && lockV[v]){ lk[v]=1; if(!edgeLock){ bad[v]=1; continue; } }
    var s=vh[v], c0=0; h=s;
    do{ g=opp[pv(h)]; c0++; h=g; }while(h>=0 && h!==s && c0<=deg[v]);
    if(h<0){ h=opp[s]; while(h>=0 && c0<=deg[v]){ h=nx(h); if(h===s) break; c0++; h=opp[h]; } }
    if(c0!==deg[v]) bad[v]=1;
  }
  function hasEdge(c, d){
    var s2=vh[c], x=s2, n2=0;
    do{ if(out[nx(x)]===d || out[pv(x)]===d) return true; x=opp[pv(x)]; n2++; }while(x!==s2 && x>=0 && n2<=deg[c]);
    if(x<0){ x=opp[s2]; while(x>=0 && n2<=deg[c]){ x=nx(x); if(x===s2) break; if(out[nx(x)]===d || out[pv(x)]===d) return true; n2++; x=opp[x]; } }
    return false;
  }
  // triangle normals (unnormalised) and their lengths, kept up to date
  var P=pos, tn=new Float64Array(3*nT), tl=new Float64Array(nT), t;
  function triN(t){
    var p=3*out[3*t], q=3*out[3*t+1], r=3*out[3*t+2];
    var ux=P[q]-P[p], uy=P[q+1]-P[p+1], uz=P[q+2]-P[p+2];
    var wx=P[r]-P[p], wy=P[r+1]-P[p+1], wz=P[r+2]-P[p+2];
    var x=uy*wz-uz*wy, y=uz*wx-ux*wz, z=ux*wy-uy*wx;
    tn[3*t]=x; tn[3*t+1]=y; tn[3*t+2]=z; tl[t]=Math.sqrt(x*x+y*y+z*z);
  }
  for(t=0;t<nT;t++) triN(t);
  // dirty triangles: pass 0 checks every edge, later passes only edges of
  // triangles a flip touched in the pass before (same fixed order)
  var dirty=new Uint8Array(nT).fill(1), nxt=new Uint8Array(nT);
  var flips=0, pass, eps=1e-6;
  for(pass=0; pass<maxPasses; pass++){
    var nf2=0;
    for(h=0;h<nH;h++){
      g=opp[h]; if(g<h) continue;           // each edge once, and -1 skipped
      var t0=(h/3)|0, t1=(g/3)|0;
      if(!dirty[t0] && !dirty[t1]) continue;
      var h1=nx(h), h2=pv(h), g1=nx(g), g2=pv(g);
      var A0=out[h], B0=out[h1], C0=out[h2], D0=out[g2];
      if(bad[A0]||bad[B0]||bad[C0]||bad[D0] || C0===D0) continue;
      if(deg[A0]<4 || deg[B0]<4) continue;
      if(lk[A0]&&lk[B0] || lk[C0]&&lk[D0]) continue;   // 'edge' mode: locked–locked edges stay
      // nearly flat
      var l0=tl[t0], l1=tl[t1];
      if(!(l0>0&&l1>0)) continue;
      var n0x=tn[3*t0], n0y=tn[3*t0+1], n0z=tn[3*t0+2], n1x=tn[3*t1], n1y=tn[3*t1+1], n1z=tn[3*t1+2];
      if(n0x*n1x+n0y*n1y+n0z*n1z < cosT*l0*l1) continue;
      // Delaunay test (max-min angle for a flat convex quad): flip when the
      // angles at c and d add up to more than 180° (sin(γ+δ) < -eps)
      var pa=3*A0, pb=3*B0, pc=3*C0, pd=3*D0;
      var cax=P[pa]-P[pc], cay=P[pa+1]-P[pc+1], caz=P[pa+2]-P[pc+2];
      var cbx=P[pb]-P[pc], cby=P[pb+1]-P[pc+1], cbz=P[pb+2]-P[pc+2];
      var dax=P[pa]-P[pd], day=P[pa+1]-P[pd+1], daz=P[pa+2]-P[pd+2];
      var dbx=P[pb]-P[pd], dby=P[pb+1]-P[pd+1], dbz=P[pb+2]-P[pd+2];
      var cc=cax*cbx+cay*cby+caz*cbz, dd=dax*dbx+day*dby+daz*dbz;
      var sinS=l0*dd+cc*l1;                 // |ca×cb| = l0, |da×db| = l1
      var Lc=(cax*cax+cay*cay+caz*caz)*(cbx*cbx+cby*cby+cbz*cbz), Ld=(dax*dax+day*day+daz*daz)*(dbx*dbx+dby*dby+dbz*dbz);
      if(!(sinS < -eps*Math.sqrt(Lc*Ld))) continue;
      // new triangles adc, dbc: not degenerate, normals within the limit
      // adc normal = (d-a)×(c-a); dbc normal = (b-d)×(c-d)
      var adx=-dax, ady=-day, adz=-daz, acx=-cax, acy=-cay, acz=-caz;
      var m0x=ady*acz-adz*acy, m0y=adz*acx-adx*acz, m0z=adx*acy-ady*acx;
      var cdx=P[pc]-P[pd], cdy=P[pc+1]-P[pd+1], cdz=P[pc+2]-P[pd+2];
      var m1x=dby*cdz-dbz*cdy, m1y=dbz*cdx-dbx*cdz, m1z=dbx*cdy-dby*cdx;
      var k0=Math.sqrt(m0x*m0x+m0y*m0y+m0z*m0z), k1=Math.sqrt(m1x*m1x+m1y*m1y+m1z*m1z);
      var lm=Math.max(cdx*cdx+cdy*cdy+cdz*cdz, cax*cax+cay*cay+caz*caz, cbx*cbx+cby*cby+cbz*cbz, dax*dax+day*day+daz*daz, dbx*dbx+dby*dby+dbz*dbz);
      if(!(k0>1e-9*lm && k1>1e-9*lm)) continue;
      if(m0x*n0x+m0y*n0y+m0z*n0z < cosT*k0*l0 || m0x*n1x+m0y*n1y+m0z*n1z < cosT*k0*l1 ||
         m1x*n0x+m1y*n0y+m1z*n0z < cosT*k1*l0 || m1x*n1x+m1y*n1y+m1z*n1z < cosT*k1*l1) continue;
      if(hasEdge(C0,D0)) continue;
      // flip: t0 slots h,h1,h2 = c,a,d (edges c→a, a→d, d→c);
      //       t1 slots g,g1,g2 = d,b,c (edges d→b, b→c, c→d)
      var oCA=opp[h2], oBC=opp[h1], oAD=opp[g1], oDB=opp[g2];
      out[h]=C0; out[h1]=A0; out[h2]=D0;
      out[g]=D0; out[g1]=B0; out[g2]=C0;
      opp[h]=oCA; opp[oCA]=h; opp[h1]=oAD; opp[oAD]=h1;
      opp[g]=oDB; opp[oDB]=g; opp[g1]=oBC; opp[oBC]=g1;
      opp[h2]=g2; opp[g2]=h2;
      vh[A0]=h1; vh[B0]=g1; vh[C0]=h; vh[D0]=g;
      deg[A0]--; deg[B0]--; deg[C0]++; deg[D0]++;
      triN(t0); triN(t1);
      // the four outer edges' triangles get another look next pass
      nxt[t0]=1; nxt[t1]=1; nxt[(oCA/3)|0]=1; nxt[(oBC/3)|0]=1; nxt[(oAD/3)|0]=1; nxt[(oDB/3)|0]=1;
      nf2++;
    }
    flips+=nf2;
    if(!nf2){ pass++; break; }
    var sw=dirty; dirty=nxt; nxt=sw; nxt.fill(0);
  }
  flipEdges.last={flips:flips, passes:pass};
  return out;
}

// Triangle quality, one pass: {tris, needles (height / longest edge under
// 5 %, the tests' rule), needlePct, minAngleP5 (5th percentile of each
// triangle's smallest angle, degrees, 0.1° bins), meanMinAngle} (v0.16.0).
function triQuality(pos, idx){
  var nT=idx.length/3, hist=new Float64Array(601), needles=0, sum=0, t;
  for(t=0;t<nT;t++){
    var a=3*idx[3*t], b=3*idx[3*t+1], c=3*idx[3*t+2];
    var ux=pos[b]-pos[a], uy=pos[b+1]-pos[a+1], uz=pos[b+2]-pos[a+2];
    var vx=pos[c]-pos[a], vy=pos[c+1]-pos[a+1], vz=pos[c+2]-pos[a+2];
    var wx=pos[c]-pos[b], wy=pos[c+1]-pos[b+1], wz=pos[c+2]-pos[b+2];
    var nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx, A2=Math.sqrt(nx*nx+ny*ny+nz*nz);
    var C=ux*ux+uy*uy+uz*uz, B=vx*vx+vy*vy+vz*vz, Aa=wx*wx+wy*wy+wz*wz;
    var l2=Math.max(Aa,B,C), ang=0;
    if(l2>0 && A2/l2<0.05) needles++;
    if(Aa>0&&B>0&&C>0){
      // smallest angle is opposite the shortest edge; atan2 keeps it exact
      var s=Math.min(Aa,B,C), p, q;
      if(s===Aa){ p=B; q=C; } else if(s===B){ p=Aa; q=C; } else { p=Aa; q=B; }
      ang=Math.atan2(2*A2, p+q-s)*180/Math.PI;
    }
    sum+=ang; hist[Math.min(600, Math.floor(ang*10))]++;
  }
  var want=0.05*nT, acc=0, p5=0;
  for(var i=0;i<601;i++){ acc+=hist[i]; if(acc>=want){ p5=i/10; break; } }
  return {tris:nT, needles:needles, needlePct:nT?100*needles/nT:0, minAngleP5:p5, meanMinAngle:nT?sum/nT:0};
}

// Loose-piece clean-up (v0.15.0). Splits the mesh into connected pieces
// (shared vertices). mode:
//   'specks'  drop solid pieces smaller than cell·10 (cell = one mesh cell's
//             volume) — unless together they are more than LOOSE_SPECK_CAP of
//             the solid volume: then they are real geometry broken up by a
//             coarse quality, and nothing is dropped (capped)
//   'largest' keep only the largest solid piece and the cavities inside it
//   'keep'    drop nothing
// A piece with negative volume is a sealed cavity — real geometry — and is
// kept unless it is smaller than one cell (or, for 'largest', not inside the
// kept piece). Pieces go whole, so the rest stays closed. Always returns
//   {dropped, pieces, solidPieces, bigPieces, droppedVol, keptVol, capped,
//    vertProperties?, triVerts?}   (the arrays only when dropped > 0)
// bigPieces = solid pieces of at least 10 cells (counted for the warning).
var LOOSE_SPECK_CELLS=10, LOOSE_SPECK_CAP=0.02, LOOSE_WARN_PIECES=20;
function _pointInMesh(px,py,pz, vp, tv, tris){
  // ray along +x with a slight tilt; count crossings
  var dy=1e-7, dz=1.3e-7, hits=0;
  for(var n=0;n<tris.length;n++){
    var t=tris[n], A=3*tv[3*t], B=3*tv[3*t+1], C=3*tv[3*t+2];
    var ay=vp[A+1]-py-dy*(vp[A]-px), az=vp[A+2]-pz-dz*(vp[A]-px);
    var by=vp[B+1]-py-dy*(vp[B]-px), bz=vp[B+2]-pz-dz*(vp[B]-px);
    var cy=vp[C+1]-py-dy*(vp[C]-px), cz=vp[C+2]-pz-dz*(vp[C]-px);
    // does the triangle's projection on the (y,z) plane contain the origin?
    var d1=ay*bz-az*by, d2=by*cz-bz*cy, d3=cy*az-cz*ay;
    if(!((d1>0&&d2>0&&d3>0)||(d1<0&&d2<0&&d3<0))) continue;
    // x of the hit
    var w=d1+d2+d3, x=(d2*vp[A]+d3*vp[B]+d1*vp[C])/w;
    if(x>px) hits++;
  }
  return (hits&1)===1;
}
function removeLoosePieces(vp, tv, mode, cell){
  var nV=vp.length/3, nT=tv.length/3, i, t;
  var none={dropped:0, pieces:nT?1:0, solidPieces:nT?1:0, bigPieces:nT?1:0, droppedVol:0, keptVol:0, capped:false};
  if(nT===0) return none;
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
  var pieces=0, big=-1, solidPieces=0, bigPieces=0, solidVol=0, speckVol=0;
  cell=cell||0;
  for(i=0;i<nC;i++){ if(!used[i]) continue; pieces++; if(big<0||vol[i]>vol[big]) big=i;
    if(vol[i]>=0){ solidPieces++; solidVol+=vol[i]; if(vol[i]>=LOOSE_SPECK_CELLS*cell) bigPieces++; else speckVol+=vol[i]; } }
  var info={dropped:0, pieces:pieces, solidPieces:solidPieces, bigPieces:bigPieces, droppedVol:0, keptVol:solidVol, capped:false};
  if(pieces<2 || mode==='keep') return info;
  var capped = mode==='specks' && speckVol>LOOSE_SPECK_CAP*solidVol;
  info.capped=capped;
  var drop=new Uint8Array(nC), nDrop=0, dropVol=0, keptVol=0, bigTris=null;
  for(i=0;i<nC;i++){ if(!used[i]) continue;
    var gone;
    if(vol[i]<0) gone = -vol[i]<cell;                      // cavity: only if under one cell
    else if(mode==='largest') gone = i!==big;
    else gone = !capped && vol[i]<LOOSE_SPECK_CELLS*cell;
    if(!gone && vol[i]<0 && mode==='largest'){
      // keep a cavity only if it lies inside the kept piece
      if(!bigTris){ bigTris=[]; for(t=0;t<nT;t++) if(root[tv[3*t]]===big) bigTris.push(t); }
      var v0=-1; for(t=0;t<nT&&v0<0;t++) if(root[tv[3*t]]===i) v0=tv[3*t];
      gone = !_pointInMesh(vp[3*v0],vp[3*v0+1],vp[3*v0+2], vp, tv, bigTris);
    }
    if(gone){ drop[i]=1; nDrop++; dropVol+=Math.abs(vol[i]); } else keptVol+=vol[i]; }
  if(!nDrop) return info;
  var keepT=0; for(t=0;t<nT;t++) if(!drop[root[tv[3*t]]]) keepT++;
  var map=new Int32Array(nV).fill(-1), nv=0, otv=new Uint32Array(keepT*3), o=0;
  for(t=0;t<nT;t++){
    if(drop[root[tv[3*t]]]) continue;
    for(var e=0;e<3;e++){ var v=tv[3*t+e]; if(map[v]<0) map[v]=nv++; otv[o++]=map[v]; }
  }
  var ovp=new Float32Array(nv*3);
  for(i=0;i<nV;i++){ var m=map[i]; if(m>=0){ ovp[3*m]=vp[3*i]; ovp[3*m+1]=vp[3*i+1]; ovp[3*m+2]=vp[3*i+2]; } }
  info.vertProperties=ovp; info.triVerts=otv; info.dropped=nDrop; info.droppedVol=dropVol; info.keptVol=keptVol;
  return info;
}
