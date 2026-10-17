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
const SLAB_BAND_EDGES=3;          // seam band half-width, in grid spacings

function slabSeamZ(g, L){ return L&1 ? g.min[2]+g.s[2]*((L-1)/2) : g.min[2]+g.s[2]*(L/2-0.5); }

function slabJobs(g, nW){
  const Lmax=g.layers-2;
  const want=Math.max(1, Math.min(nW*SLAB_JOBS_PER_WORKER, Math.floor(Lmax/SLAB_JOB_LAYERS)));
  const jobs=[];
  for(let s=0;s<want;s++){ const a=Math.round(Lmax*s/want), b=Math.round(Lmax*(s+1)/want); if(b>a) jobs.push({id:jobs.length, La:a, Lb:b}); }
  return jobs;
}

// Join the slabs, tidy each seam band (on the pool when runBands is given,
// else here), compact.
async function _slabFinish(g, results, tol, post, t0, runBands){
  const tJ=performance.now();
  const J=joinSlabs(results);
  let idx=J.idx, seam=null;
  const seamZ=[]; for(let i=1;i<results.length;i++) seamZ.push(slabSeamZ(g, results[i]._La));
  if(tol>0 && seamZ.length){
    if(post) post({type:'progress', stage:'tidying '+seamZ.length+' seam'+(seamZ.length===1?'':'s')+'...'});
    const cut=seamBandJobs(J.pos, idx, seamZ, SLAB_BAND_EDGES*Math.max(g.s[0],g.s[1],g.s[2]));
    if(cut.jobs.length){
      const res=runBands ? await runBands(cut.jobs, tol) : cut.jobs.map(j=>simplifyBandJob(j, tol));
      idx=joinSeamBands(cut.rest, cut.jobs, res);
      seam=bandStats(cut, res, idx);
    }
  }
  const C=compactIndexed(J.pos, idx);
  // v0.16.0 final pass over the joined mesh, nothing locked: the seams no
  // longer have to match anything. The slab and band passes leave the rows of
  // vertices they had to lock, which split flat areas into strips of long thin
  // triangles (a box cap: thousands of triangles instead of 12). One
  // tear-safe simplify of the whole, already-simplified mesh (cheap next to
  // the slab simplify), then a flip pass (near-flat only, positions never
  // move, kept only if still closed).
  let finalFlip=null, finalSimp=null;
  if(tol>0 && results.length>1){
    if(post) post({type:'progress', stage:'final pass over '+(C.idx.length/3/1e6).toFixed(2)+'M tris...'});
    const tF=performance.now();
    const ss=safeSimplify(C.pos, C.idx, tol);
    if(ss.idx!==C.idx){ const C2=compactIndexed(C.pos, ss.idx); C.pos=C2.pos; C.idx=C2.idx; }
    finalSimp={retries:ss.retries||0, gaveUp:!!ss.gaveUp, ms:Math.round(performance.now()-tF)};
  }
  if(tol>0){ finalFlip=checkedFlip(C.pos, C.idx, null); C.idx=finalFlip.idx; }
  const msSeam=Math.round(performance.now()-tJ);
  let raw=0, retries=0, locked=0, gaveUp=0, evals=0, slowest=0;
  for(const r of results){ raw+=r.rawTris||0; retries+=r.retries||0; locked+=r.locked||0; if(r.gaveUp) gaveUp++; evals+=r.evals||0; slowest=Math.max(slowest, r._ms||0); }
  return {pos:C.pos, idx:C.idx, slabs:results.length, raw, retries, locked, gaveUp, evals, seam,
    finalFlips:finalFlip?finalFlip.flips:0, finalFlipMs:finalFlip?Math.round(finalFlip.ms):0, finalSimp,
    ms:{mesh:Math.round(tJ-t0), seam:msSeam, slowest:Math.round(slowest)}};
}

async function slabMeshExport(d, field, min, max, edge, tol, post, opts){
  opts=opts||{};
  const t0=performance.now();
  // v0.16.0 weld regions: opts.lookup = {main, off} holds the field already
  // baked at every grid point (14-weld-bake.js); each slab worker is sent only
  // the layers its slab reads and builds no field. A weld region without a
  // bake meshes in this thread (field = the weld field).
  const lookup=opts.lookup||null;
  await slabMeshoptReady;
  const g=weldGridDims(min, max, edge);
  if(!g.ok) throw new Error('grid too small for the slab mesher');
  const total=g.mainCount+g.offCount;
  let nW=Math.min(fieldBakeCores(d), Math.max(1, Math.floor((g.layers-2)/SLAB_JOB_LAYERS)));
  let url=null;
  if(nW>=2 && total>=SLAB_MIN_POINTS && typeof Worker!=='undefined' && (lookup || !(d.bodies&&d.bodies.length))){
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
    const out=await _slabFinish(g, [r], tol, post, t0, null);
    out.workers=1;
    return out;
  }
  // ── pool ──
  const spec={};
  if(!lookup){
    for(const k of FIELD_BAKE_SPEC_KEYS) if(d[k]!==undefined) spec[k]=d[k];
    const perWorker=(spec.shapeSdfData?spec.shapeSdfData.byteLength:0)+(spec.huGridData?spec.huGridData.byteLength:0);
    nW=Math.min(nW, Math.max(2, Math.floor(FIELD_BAKE_COPY_BUDGET/Math.max(1,perWorker))));
  }
  // Layers a job [La, Lb) reads: its tets L..L+2 plus the neighbours' tets two
  // layers each side (m34) → [La−2, Lb+4).
  const plane1=(g.n[0]+1)*(g.n[1]+1), plane2=(g.n[0]+2)*(g.n[1]+2);
  const jobMsg=j=>{
    const m={type:'mesh', id:j.id, La:j.La, Lb:j.Lb, tol}, tr=[];
    if(lookup){
      const r=weldLayerKRange(g, Math.max(0,j.La-2), Math.min(g.layers,j.Lb+4));
      m.main=lookup.main.slice(r.kmA*plane1, r.kmB*plane1); m.off=lookup.off.slice(r.koA*plane2, r.koB*plane2);
      m.kmA=r.kmA; m.koA=r.koA; tr.push(m.main.buffer, m.off.buffer);
    }
    return [m, tr];
  };
  const jobs=slabJobs(g, nW);
  nW=Math.min(nW, jobs.length);
  const results=new Array(jobs.length);
  let next=0, done=0, lastPost=0, settled=false, watchdog=null;
  const workers=[];
  let onBand=null;                         // set during the seam-band stage
  const stopAll=()=>{ if(watchdog){ clearTimeout(watchdog); watchdog=null; } for(const w of workers){ try{ w.terminate(); }catch(_){} } };
  let failBands=null;
  try{
  await new Promise((resolve,reject)=>{
    const finish=(err)=>{ if(settled) return; settled=true; if(watchdog){ clearTimeout(watchdog); watchdog=null; } err?reject(err):resolve(); };
    const kick=()=>{ if(watchdog) clearTimeout(watchdog); watchdog=setTimeout(()=>finish(new Error('slab mesher stalled')), SLAB_STALL_MS); };
    kick();
    const initMsg=lookup ? {type:'init', lookupOnly:true, edge, grid:{min, max, edge}} : {type:'init', spec, edge, grid:{min, max, edge}, f32:false};
    if(post) post({type:'progress', stage:'meshing '+jobs.length+' slabs on '+nW+' cores...'});
    for(let i=0;i<nW;i++){
      let w;
      try{ w=new Worker(url); }catch(err){ finish(err); return; }
      workers.push(w);
      const dispatch=()=>{ if(next<jobs.length){ const [m,tr]=jobMsg(jobs[next++]); w.postMessage(m, tr); } };
      w.onmessage=e=>{
        const m=e.data;
        if(m.type==='band'){ if(onBand) onBand(w, m); return; }
        if(m.type==='error'){ if(onBand){ failBands(new Error('seam band worker: '+m.message)); return; } finish(new Error('slab worker: '+m.message)); return; }
        if(settled) return;
        if(m.type==='ready'){
          if(!m.n || m.n.join(',')!==g.n.join(',')){ finish(new Error('grid mismatch '+m.n+' vs '+g.n)); return; }
          dispatch(); return;
        }
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
      w.onerror=ev=>{ if(ev&&ev.preventDefault) ev.preventDefault(); const err=new Error('slab worker failed'+(ev&&ev.message?': '+ev.message:'')); if(onBand) failBands(err); else finish(err); };
      w.postMessage(initMsg);
    }
  });
  // ── seam bands, one job per seam, on the same workers ──
  const runBands=(bjobs, btol)=>new Promise((resolve,reject)=>{
    const out=new Array(bjobs.length); let bn=0, bd=0, bdog=null;
    const end=(err)=>{ if(bdog) clearTimeout(bdog); onBand=null; err?reject(err):resolve(out); };
    failBands=end;
    const bkick=()=>{ if(bdog) clearTimeout(bdog); bdog=setTimeout(()=>end(new Error('seam bands stalled')), SLAB_STALL_MS); };
    const send=w=>{ if(bn<bjobs.length){ const j=bjobs[bn], id=bn++; const p=j.pos.slice(), ix=j.idx.slice(), o=j.outer.slice();
      w.postMessage({type:'band', id, pos:p.buffer, idx:ix.buffer, outer:o.buffer, tol:btol}, [p.buffer, ix.buffer, o.buffer]); } };
    onBand=(w,m)=>{ bkick(); out[m.id]={idx:new Uint32Array(m.idx), retries:m.retries, locked:m.locked, gaveUp:m.gaveUp, unsafe:m.unsafe}; bd++; if(bd===bjobs.length){ end(); return; } send(w); };
    bkick();
    if(post) post({type:'progress', stage:'tidying '+bjobs.length+' seam band'+(bjobs.length===1?'':'s')+' on '+Math.min(workers.length,bjobs.length)+' cores...'});
    for(const w of workers) send(w);
  });
  const out=await _slabFinish(g, results, tol, post, t0, runBands);
  out.workers=nW;
  return out;
  } finally { stopAll(); }
}
