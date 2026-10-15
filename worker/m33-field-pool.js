/* ============================================================
   F13LD.mesh · worker/m33-field-pool.js
   Multi-core field bake for single-body exports (v0.11.0).

   Manifold.levelSet calls the field once per grid point on one thread.
   Weld groups have pre-baked that grid on several cores since v0.9.3
   (14-weld-bake.js on the main thread). This does the same for open-cube
   and shape-clipped exports, from inside the mesh worker: it starts a pool
   of field-bake-worker.js workers, each builds the identical field
   (buildExportField, m32-export-field.js), they evaluate z-layer jobs of
   the exact grid levelSet will ask for (m31-weld-grid.js), and levelSet
   then reads the stored values (makeWeldLookup). Any point the lookup does
   not recognise is evaluated directly, so the mesh never depends on the
   cache: with Float64 storage the mesh is byte-identical to one thread.

   Returns null — caller evaluates directly, as before — when the grid is
   small, there is one core, workers are unavailable, or the pool fails.
   ============================================================ */
'use strict';
const FIELD_BAKE_MIN_POINTS=200000;   // below this the spawn cost outweighs the split
const FIELD_BAKE_F32_POINTS=25e6;     // above this store Float32 (memory), else Float64
const FIELD_BAKE_MAX_POINTS=150e6;    // above this don't pre-bake (memory)
const FIELD_BAKE_COPY_BUDGET=1.5e9;   // bytes of shape / HU grids copied across workers
const FIELD_BAKE_STALL_MS=120000;     // no slab for this long → give up on the pool
const FIELD_BAKE_SPEC_KEYS=['mode','recipe','shapeSdfData','shapeN','bbox','cellSizeMm','relEdgeMm',
  'structXform','pruneToNodes','pruneInsetMult','huGridData','huGridN','huFieldMin','huFieldMax','huBbox','edgeWorld'];

function fieldBakeCores(d){
  let c=+d.cores;
  if(!(c>=1)){ const hc=(self.navigator&&self.navigator.hardwareConcurrency)||2; c=hc-1; }
  return Math.max(1, Math.min(15, Math.floor(c)));
}

// field: the direct callback (used for any point the cache misses).
// Resolves {fn, workers, ms, f32, stats} or null.
async function prebakeExportField(d, field, min, max, edge, post){
  const g=weldGridDims(min, max, edge);
  const total=g.mainCount+g.offCount;
  let nW=Math.min(fieldBakeCores(d), g.layers);
  if(!g.ok || nW<2 || total<FIELD_BAKE_MIN_POINTS || total>FIELD_BAKE_MAX_POINTS) return null;
  if(typeof Worker==='undefined') return null;
  const spec={};
  for(const k of FIELD_BAKE_SPEC_KEYS) if(d[k]!==undefined) spec[k]=d[k];
  const perWorker=(spec.shapeSdfData?spec.shapeSdfData.byteLength:0)+(spec.huGridData?spec.huGridData.byteLength:0);
  nW=Math.min(nW, Math.max(2, Math.floor(FIELD_BAKE_COPY_BUDGET/Math.max(1,perWorker))));
  // F13LD_WORKER_BASE: set by tests/regress.html when it runs a build's
  // worker from a blob (self.location is then a blob: URL).
  let url;
  try{ url=new URL('field-bake-worker.js'+self.location.search, self.F13LD_WORKER_BASE||self.location.href).href; }
  catch(_){ return null; }
  const t0=performance.now();
  const f32=total>FIELD_BAKE_F32_POINTS;
  const Arr=f32?Float32Array:Float64Array;
  const nx1=g.n[0]+1, ny1=g.n[1]+1, nx2=g.n[0]+2, ny2=g.n[1]+2;
  let main, off;
  try{ main=new Arr(g.mainCount); off=new Arr(g.offCount); }catch(_){ return null; }
  // ~6 jobs per worker so a slow (dense) slab doesn't leave the rest idle.
  const per=Math.max(1, Math.ceil(g.layers/(nW*6)));
  const jobs=[]; for(let q=0;q<g.layers;q+=per) jobs.push({id:jobs.length, qa:q, qb:Math.min(g.layers,q+per)});
  let next=0, done=0, lastPost=0;
  const workers=[];
  let settled=false, watchdog=null;
  const stopAll=()=>{ if(watchdog){ clearTimeout(watchdog); watchdog=null; } for(const w of workers){ try{ w.terminate(); }catch(_){} } };
  try{
    await new Promise((resolve,reject)=>{
      const finish=(err)=>{ if(settled) return; settled=true; stopAll(); err?reject(err):resolve(); };
      const kick=()=>{ if(watchdog) clearTimeout(watchdog); watchdog=setTimeout(()=>finish(new Error('field bake stalled')), FIELD_BAKE_STALL_MS); };
      kick();
      const initMsg={type:'init', spec, edge, grid:{min, max, edge}, f32};
      for(let i=0;i<nW;i++){
        let w;
        try{ w=new Worker(url); }catch(err){ finish(err); return; }
        workers.push(w);
        const dispatch=()=>{ if(next<jobs.length){ const j=jobs[next++]; w.postMessage({type:'job', id:j.id, qa:j.qa, qb:j.qb}); } };
        w.onmessage=e=>{
          if(settled) return;
          const m=e.data;
          if(m.type==='ready'){
            if(!m.n || m.n.join(',')!==g.n.join(',')){ finish(new Error('grid mismatch '+m.n+' vs '+g.n)); return; }
            dispatch(); return;
          }
          if(m.type==='error'){ finish(new Error('field bake worker: '+m.message)); return; }
          if(m.type==='slab'){
            kick();
            if(m.kmB>m.kmA) main.set(new Arr(m.main), m.kmA*nx1*ny1);
            if(m.koB>m.koA) off.set(new Arr(m.off), m.koA*nx2*ny2);
            done++;
            const now=performance.now();
            if(post && now-lastPost>250){ lastPost=now; post({type:'progress', stage:'computing field on '+nW+' cores — '+Math.round(100*done/jobs.length)+'%...'}); }
            if(done===jobs.length){ finish(); return; }
            dispatch();
          }
        };
        w.onerror=ev=>{ if(ev&&ev.preventDefault) ev.preventDefault(); finish(new Error('field bake worker failed'+(ev&&ev.message?': '+ev.message:''))); };
        w.postMessage(initMsg);
      }
    });
  }catch(err){
    if(post) post({type:'progress', stage:'multi-core field skipped ('+((err&&err.message)||err)+') — one core...'});
    console.warn('[worker] field pre-bake failed, evaluating directly:', err);
    return null;
  }
  const stats={};
  return {fn:makeWeldLookup(g, main, off, field, stats), workers:nW, ms:Math.round(performance.now()-t0), f32, stats, points:total};
}
