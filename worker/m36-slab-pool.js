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
  // v0.16.1: every vertex a slab or band simplify locked for a tear, in the
  // joined mesh's ids — seeds the final pass so it doesn't tear and redo there
  const seedJ=new Uint8Array(J.pos.length/3);
  let nSeed=0;
  for(let s=0;s<results.length;s++){ const tv=results[s].tearV, rm=J.remap[s]; if(!tv) continue; for(let i=0;i<tv.length;i++){ const v=rm[tv[i]]; if(v>=0&&!seedJ[v]){ seedJ[v]=1; nSeed++; } } }
  const seamZ=[]; for(let i=1;i<results.length;i++) seamZ.push(slabSeamZ(g, results[i]._La));
  // v0.16.1 final pass (m35 finalBandRounds): two rounds of wide bands on the
  // pool — round A around the even seams, round B around the odd ones — then
  // the one-thread rows pass with everything locked except the rows round B
  // had to lock. Replaces v0.15.0's narrow seam bands and v0.16.0's
  // one-thread simplify of the whole mesh (slow on foams: tears made it redo
  // the whole mesh). Tear locks from the slabs and bands stay locked (seedJ).
  const tF=performance.now();
  let rounds=[], rows=null;
  if(tol>0 && seamZ.length){
    const R=finalBandRounds(seamZ), free=new Uint8Array(J.pos.length/3);
    for(let r=0;r<2;r++){
      if(!R[r].length) continue;
      if(post) post({type:'progress', stage:'final pass, round '+(r?'B':'A')+' ('+R[r].length+' band'+(R[r].length===1?'':'s')+')...'});
      const tRound=performance.now();
      const cut=seamBandJobs(J.pos, idx, R[r], R[2]);
      if(!cut.jobs.length) continue;
      if(nSeed) for(const j of cut.jobs){ const sd=new Uint8Array(j.gv.length); let any=0; for(let i=0;i<j.gv.length;i++) if(seedJ[j.gv[i]]){ sd[i]=1; any=1; } if(any) j.seed=sd; }
      const res=runBands ? await runBands(cut.jobs, tol) : cut.jobs.map(j=>simplifyBandJob(j, tol));
      markBandRows(cut.jobs, res, r===1?free:null, seedJ);
      idx=joinSeamBands(cut.rest, cut.jobs, res);
      const st=bandStats(cut, res, idx); st.round=r?'B':'A'; st.ms=Math.round(performance.now()-tRound); rounds.push(st);
    }
    if(post) post({type:'progress', stage:'final pass, rows...'});
    const tR=performance.now();
    rows=simplifyRows(J.pos, idx, tol, free, seedJ);
    idx=rows.idx; rows={free:rows.free, retries:rows.retries, gaveUp:rows.gaveUp, ms:Math.round(performance.now()-tR)};
  }
  seam=rounds.length?rounds[rounds.length-1]:null;
  const C=compactIndexed(J.pos, idx);
  let finalFlip=null;
  const finalSimp={rounds, rows, ms:Math.round(performance.now()-tF)};
  if(tol>0){ finalFlip=checkedFlip(C.pos, C.idx, null); C.idx=finalFlip.idx; }
  const msSeam=Math.round(performance.now()-tJ);
  let raw=0, retries=0, locked=0, gaveUp=0, evals=0, slowest=0;
  for(const r of results){ raw+=r.rawTris||0; retries+=r.retries||0; locked+=r.locked||0; if(r.gaveUp) gaveUp++; evals+=r.evals||0; slowest=Math.max(slowest, r._ms||0); }
  return {pos:C.pos, idx:C.idx, slabs:results.length, raw, retries, locked, gaveUp, evals, seam,
    finalFlips:finalFlip?finalFlip.flips:0, finalFlipMs:finalFlip?Math.round(finalFlip.ms):0, finalSimp,
    ms:{mesh:Math.round(tJ-t0), seam:msSeam, slowest:Math.round(slowest)}};
}

// v0.16.1: stage times (ms) of a slab result, for the export report and the
// bench: slab mesh + simplify, final-pass rounds A / B, rows pass, flips.
function slabStageTimes(out){
  const t={mesh:0, roundA:0, roundB:0, rows:0, flip:0};
  if(!out) return t;
  t.mesh=(out.ms&&out.ms.mesh)||0; t.flip=out.finalFlipMs||0;
  const f=out.finalSimp;
  if(f){ for(const r of (f.rounds||[])){ if(r.round==='A') t.roundA+=r.ms||0; else t.roundB+=r.ms||0; } if(f.rows) t.rows+=f.rows.ms||0; }
  return t;
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
          results[m.id]={pos:new Float32Array(m.pos), idx:new Uint32Array(m.idx), seamV:new Uint32Array(m.seamV), seamK:new Float64Array(m.seamK), tearV:m.tearV?new Uint32Array(m.tearV):null,
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
    const send=w=>{ if(bn<bjobs.length){ const j=bjobs[bn], id=bn++; const p=j.pos.slice(), ix=j.idx.slice(), o=j.outer.slice(), sd=j.seed?j.seed.slice():null;
      const tr=[p.buffer, ix.buffer, o.buffer]; if(sd) tr.push(sd.buffer);
      w.postMessage({type:'band', id, pos:p.buffer, idx:ix.buffer, outer:o.buffer, seed:sd?sd.buffer:null, tol:btol}, tr); } };
    onBand=(w,m)=>{ bkick(); out[m.id]={idx:new Uint32Array(m.idx), tearV:m.tearV?new Uint32Array(m.tearV):null, retries:m.retries, locked:m.locked, gaveUp:m.gaveUp, unsafe:m.unsafe}; bd++; if(bd===bjobs.length){ end(); return; } send(w); };
    bkick();
    if(post) post({type:'progress', stage:'tidying '+bjobs.length+' seam band'+(bjobs.length===1?'':'s')+' on '+Math.min(workers.length,bjobs.length)+' cores...'});
    for(const w of workers) send(w);
  });
  const out=await _slabFinish(g, results, tol, post, t0, runBands);
  out.workers=nW;
  return out;
  } finally { stopAll(); }
}
