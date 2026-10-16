/* ============================================================
   F13LD.mesh · worker/m36-slab-pool.js
   Parallel slab export (v0.15.0) for open-cube and shape-clipped parts.

   The same pool of field-bake-worker.js workers as the multi-core field
   (m33-field-pool.js), but each job is a z slab that the worker evaluates,
   meshes (slabMeshLayers, m34) and simplifies with its seam locked
   (simplifySlab, m35), sending back triangles instead of field values. The
   mesh worker joins the slabs in order (joinSlabs), runs the light seam-band
   pass and checks the result is closed. With one core, no Worker, or a
   small grid, the same steps run here as a single slab.

   slabMeshExport(d, field, min, max, edge, tol, post)
     field  the levelSet callback for this pass (positive inside); used only
            when meshing in this thread
   Resolves {pos, idx, workers, slabs, ms:{mesh, seam}, raw, retries} or
   throws (the caller then meshes the classic way).
   ============================================================ */
'use strict';
const SLAB_MIN_POINTS=150000;     // below this, one slab in this thread
const SLAB_JOB_LAYERS=24;         // smallest slab, in grid layers (halo is 2 each side)
const SLAB_JOBS_PER_WORKER=3;     // so a dense slab doesn't leave the rest idle
const SLAB_STALL_MS=180000;

function slabSeamZ(g, L){ return L&1 ? g.min[2]+g.s[2]*((L-1)/2) : g.min[2]+g.s[2]*(L/2-0.5); }

function slabJobs(g, nW){
  const Lmax=g.layers-2;
  const want=Math.max(1, Math.min(nW*SLAB_JOBS_PER_WORKER, Math.floor(Lmax/SLAB_JOB_LAYERS)));
  const jobs=[];
  for(let s=0;s<want;s++){ const a=Math.round(Lmax*s/want), b=Math.round(Lmax*(s+1)/want); if(b>a) jobs.push({id:jobs.length, La:a, Lb:b}); }
  return jobs;
}

function _slabFinish(g, results, tol, post, t0){
  const tJ=performance.now();
  const J=joinSlabs(results);
  let idx=J.idx, seam=null;
  const seamZ=[]; for(let i=1;i<results.length;i++) seamZ.push(slabSeamZ(g, results[i]._La));
  if(tol>0 && seamZ.length){
    if(post) post({type:'progress', stage:'tidying '+seamZ.length+' seam'+(seamZ.length===1?'':'s')+'...'});
    idx=simplifySeamBands(J.pos, idx, seamZ, 4*Math.max(g.s[0],g.s[1],g.s[2]), tol);
    seam=simplifySeamBands.last||null;
  }
  const C=compactIndexed(J.pos, idx);
  const msSeam=Math.round(performance.now()-tJ);
  let raw=0, retries=0, locked=0, gaveUp=0, evals=0, slowest=0;
  for(const r of results){ raw+=r.rawTris||0; retries+=r.retries||0; locked+=r.locked||0; if(r.gaveUp) gaveUp++; evals+=r.evals||0; slowest=Math.max(slowest, r._ms||0); }
  return {pos:C.pos, idx:C.idx, slabs:results.length, raw, retries, locked, gaveUp, evals, seam,
    ms:{mesh:Math.round(tJ-t0), seam:msSeam, slowest:Math.round(slowest)}};
}

async function slabMeshExport(d, field, min, max, edge, tol, post){
  const t0=performance.now();
  await slabMeshoptReady;
  const g=weldGridDims(min, max, edge);
  if(!g.ok) throw new Error('grid too small for the slab mesher');
  const total=g.mainCount+g.offCount;
  let nW=Math.min(fieldBakeCores(d), Math.max(1, Math.floor((g.layers-2)/SLAB_JOB_LAYERS)));
  let url=null;
  if(nW>=2 && total>=SLAB_MIN_POINTS && typeof Worker!=='undefined'){
    try{ url=new URL('field-bake-worker.js'+self.location.search, self.F13LD_WORKER_BASE||self.location.href).href; }catch(_){ url=null; }
  }
  // ── this thread: one slab ──
  if(!url){
    if(post) post({type:'progress', stage:'slab mesher on 1 core ('+(total/1e6).toFixed(1)+'M points)...'});
    const ts=performance.now();
    let r=slabMeshLayers(field, g, 0, g.layers-2);
    if(tol>0){ if(post) post({type:'progress', stage:'simplifying '+(r.idx.length/3/1e6).toFixed(2)+'M tris...'}); r=simplifySlab(r, tol); }
    else r.rawTris=r.idx.length/3;
    r._La=0; r._ms=performance.now()-ts;
    const out=_slabFinish(g, [r], tol, post, t0);
    out.workers=1;
    return out;
  }
  // ── pool ──
  const spec={};
  for(const k of FIELD_BAKE_SPEC_KEYS) if(d[k]!==undefined) spec[k]=d[k];
  const perWorker=(spec.shapeSdfData?spec.shapeSdfData.byteLength:0)+(spec.huGridData?spec.huGridData.byteLength:0);
  nW=Math.min(nW, Math.max(2, Math.floor(FIELD_BAKE_COPY_BUDGET/Math.max(1,perWorker))));
  const jobs=slabJobs(g, nW);
  nW=Math.min(nW, jobs.length);
  const results=new Array(jobs.length);
  let next=0, done=0, lastPost=0, settled=false, watchdog=null;
  const workers=[];
  const stopAll=()=>{ if(watchdog){ clearTimeout(watchdog); watchdog=null; } for(const w of workers){ try{ w.terminate(); }catch(_){} } };
  await new Promise((resolve,reject)=>{
    const finish=(err)=>{ if(settled) return; settled=true; stopAll(); err?reject(err):resolve(); };
    const kick=()=>{ if(watchdog) clearTimeout(watchdog); watchdog=setTimeout(()=>finish(new Error('slab mesher stalled')), SLAB_STALL_MS); };
    kick();
    const initMsg={type:'init', spec, edge, grid:{min, max, edge}, f32:false};
    if(post) post({type:'progress', stage:'meshing '+jobs.length+' slabs on '+nW+' cores...'});
    for(let i=0;i<nW;i++){
      let w;
      try{ w=new Worker(url); }catch(err){ finish(err); return; }
      workers.push(w);
      const dispatch=()=>{ if(next<jobs.length){ const j=jobs[next++]; w.postMessage({type:'mesh', id:j.id, La:j.La, Lb:j.Lb, tol}); } };
      w.onmessage=e=>{
        if(settled) return;
        const m=e.data;
        if(m.type==='ready'){
          if(!m.n || m.n.join(',')!==g.n.join(',')){ finish(new Error('grid mismatch '+m.n+' vs '+g.n)); return; }
          dispatch(); return;
        }
        if(m.type==='error'){ finish(new Error('slab worker: '+m.message)); return; }
        if(m.type==='meshslab'){
          kick();
          const j=jobs[m.id];
          results[m.id]={pos:new Float32Array(m.pos), idx:new Uint32Array(m.idx), seamV:new Uint32Array(m.seamV), seamK:new Float64Array(m.seamK),
            rawTris:m.rawTris, retries:m.retries, locked:m.locked, gaveUp:m.gaveUp, evals:m.evals, _La:j.La, _ms:m.ms};
          done++;
          const now=performance.now();
          if(post && now-lastPost>250){ lastPost=now; post({type:'progress', stage:'meshing on '+nW+' cores — '+Math.round(100*done/jobs.length)+'%...'}); }
          if(done===jobs.length){ finish(); return; }
          dispatch();
        }
      };
      w.onerror=ev=>{ if(ev&&ev.preventDefault) ev.preventDefault(); finish(new Error('slab worker failed'+(ev&&ev.message?': '+ev.message:''))); };
      w.postMessage(initMsg);
    }
  });
  const out=_slabFinish(g, results, tol, post, t0);
  out.workers=nW;
  return out;
}
