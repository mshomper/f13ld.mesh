/* ============================================================
   F13LD.mesh · 42-preview-bake.js
   Field baking via worker, raymarcher preview, wave seam diagnosis.
   ============================================================ */
'use strict';

// ── Field baking via worker ──────────────────────────────────────────────────

// v0.9.0: each family descriptor decides (families/fam-*.js → isPeriodic).
function recipeIsPeriodic(recipe){
  if(!recipe) return false;
  const d=familyOf(recipe);
  return !!(d && typeof d.isPeriodic==='function' && d.isPeriodic(recipe));
}
// ── v0.13.0 · preview bake pool, slab split, cancel, cache ──────────────────
// Preview bakes run in worker/preview-bake-worker.js (SDF families only, no
// Manifold), kept warm between bakes. Every bake that is big enough is split
// into z-slabs over the pool, SDF and raw alike; the stitched grid and its
// Lipschitz are bit-identical to a one-worker bake (tests/slabbake.js). A new
// preview cancels every bake still running (cancelPreviewBakes, called by
// triggerPreview): its workers are terminated, not left to finish. Results are
// cached by content (recipe, grid size, bake options, weld member grids) so a
// part or weld that was baked before comes back without a bake.
const _pb={idle:[], busy:new Set(), jobs:new Set(), grids:new Map(), gridIds:new WeakMap(), nextGrid:1};
function _pbMax(){ const hc=navigator.hardwareConcurrency||2; return Math.max(1,Math.min(12,hc-1)); }
function _pbUrl(){ return meshAssetUrl('worker/preview-bake-worker.js'); }
function _pbAcquire(){
  const w=_pb.idle.pop()||new Worker(_pbUrl());
  _pb.busy.add(w); return w;
}
function _pbRelease(w){
  _pb.busy.delete(w); w.onmessage=null; w.onerror=null;
  if(_pb.idle.length<_pbMax()) _pb.idle.push(w); else _pbKill(w);
}
function _pbKill(w){ _pb.busy.delete(w); _pb.grids.delete(w); try{ w.terminate(); }catch(e){} }
// Warm the pool once the page is idle, so the first preview doesn't pay for
// worker start-up (script parse of the SDF families).
function previewPoolWarm(n){
  n=Math.min(n||_pbMax(), _pbMax());
  for(let i=_pb.idle.length+_pb.busy.size;i<n;i++){ try{ _pb.idle.push(new Worker(_pbUrl())); }catch(e){ break; } }
}
function _gridIdOf(buf){
  let id=_pb.gridIds.get(buf); if(id==null){ id=_pb.nextGrid++; _pb.gridIds.set(buf,id); } return id;
}
// Per-worker copy of the message: weld member grids the worker already holds go
// by id only. The worker keeps exactly keepGrids (24 most recent per worker).
function _pbMessage(w, msg){
  if(!msg.bodies || !msg.bodies.length) return msg;
  let held=_pb.grids.get(w); if(!held){ held=new Map(); _pb.grids.set(w,held); }
  const bodies=msg.bodies.map(sp=>{
    if(!sp.shapeSdfData) return sp;
    const id=_gridIdOf(sp.shapeSdfData);
    const c=Object.assign({},sp,{shapeGridId:id});
    if(held.has(id)){ delete c.shapeSdfData; held.delete(id); }
    held.set(id,true);
    return c;
  });
  while(held.size>24) held.delete(held.keys().next().value);
  return Object.assign({},msg,{bodies, keepGrids:[...held.keys()]});
}
function cancelPreviewBakes(){
  for(const job of [..._pb.jobs]){ job.cancel(); if(typeof _bakeStats!=='undefined') _bakeStats.cancelled++; }
}
window.cancelPreviewBakes=cancelPreviewBakes;
// Run one bake job over `parts` worker messages. Resolves with the replies in
// order. A failed or cancelled job terminates its workers (a terminated worker
// never replies); a finished one returns them to the pool.
function _pbRun(parts){
  return new Promise((resolve,reject)=>{
    const ws=[], out=new Array(parts.length); let left=parts.length, over=false;
    const job={cancel(){ finish(new Error('cancelled')); }};
    function finish(err){
      if(over) return; over=true; _pb.jobs.delete(job);
      if(err){ ws.forEach(_pbKill); reject(err); }
      else{ ws.forEach(_pbRelease); resolve(out); }
    }
    _pb.jobs.add(job);
    parts.forEach((msg,i)=>{
      const w=_pbAcquire(); ws.push(w);
      w.onmessage=e=>{
        const d=e.data;
        if(d.type==='error') return finish(new Error(d.message));
        if(d.type!=='baked' && d.type!=='slab') return;
        out[i]=d; if(--left===0) finish(null);
      };
      w.onerror=e=>{ if(e&&e.preventDefault) e.preventDefault(); finish(new Error((e&&e.message)||'Bake error')); };
      try{ w.postMessage(_pbMessage(w,msg)); }
      catch(err){ finish(err); }
    });
  });
}
// Main-thread copy of worker/m40 bakeSdfLipschitz, for stitched SDF slabs.
function _bakeSdfLipschitz(field,N,sx,sy,sz){
  let maxG=0;
  for(let iz=1;iz<N-1;iz++)for(let iy=1;iy<N-1;iy++)for(let ix=1;ix<N-1;ix++){
    const i=ix+iy*N+iz*N*N;
    const gx=(field[i+1]-field[i-1])/(2*sx);
    const gy=(field[i+N]-field[i-N])/(2*sy);
    const gz=(field[i+N*N]-field[i-N*N])/(2*sz);
    const g=Math.sqrt(gx*gx+gy*gy+gz*gz);if(g>maxG)maxG=g;
  }
  let lipRobust=maxG;
  if(maxG>0){
    const BINS=256, hist=new Int32Array(BINS), invB=BINS/maxG;
    let cnt=0;
    for(let iz=1;iz<N-1;iz++)for(let iy=1;iy<N-1;iy++)for(let ix=1;ix<N-1;ix++){
      const i=ix+iy*N+iz*N*N;
      const gx=(field[i+1]-field[i-1])/(2*sx);
      const gy=(field[i+N]-field[i-N])/(2*sy);
      const gz=(field[i+N*N]-field[i-N*N])/(2*sz);
      const g=Math.sqrt(gx*gx+gy*gy+gz*gz);
      let b=(g*invB)|0; if(b>=BINS)b=BINS-1; else if(b<0)b=0;
      hist[b]++; cnt++;
    }
    const target=cnt*0.98;
    let acc=0,bin=BINS-1;
    for(let b=0;b<BINS;b++){acc+=hist[b];if(acc>=target){bin=b;break;}}
    lipRobust=(bin+1)/invB;
  }
  return Math.max(lipRobust*1.1,0.05);
}
// Raw (normalized) slabs: the gradient Lipschitz and noise pad are computed
// once on the stitched grid, reproducing the serial bakeRaw result exactly.
function _finishRaw(recipe, field, N, minV, maxV, wMin, wMax, topology){
  const sx=(wMax[0]-wMin[0])/N, sy=(wMax[1]-wMin[1])/N, sz=(wMax[2]-wMin[2])/N;
  let maxG=0;
  for(let iz=1;iz<N-1;iz++)for(let iy=1;iy<N-1;iy++)for(let ix=1;ix<N-1;ix++){
    const i=ix+iy*N+iz*N*N;
    const gx=(field[i+1]-field[i-1])/(2*sx),gy=(field[i+N]-field[i-N])/(2*sy),gz=(field[i+N*N]-field[i-N*N])/(2*sz);
    const g=Math.sqrt(gx*gx+gy*gy+gz*gz); if(g>maxG)maxG=g;
  }
  const halfR=Math.max((maxV-minV)*0.5,0.001), lip=Math.max(maxG/halfR*1.1,0.05);
  let postMin=minV, postMax=maxV;
  const _fd=familyOf(recipe);
  if(_fd && typeof _fd.rawRange==='function'){const rr=_fd.rawRange(recipe,minV,maxV); postMin=rr.min; postMax=rr.max;}
  return {fieldMin:postMin,fieldMax:postMax,lipschitz:lip,isPeriodic:false,topology};
}
// Should this bake be split over the pool? Raw (stochastic) bakes always were;
// SDF bakes are once the grid is big enough to pay for the extra messages, and
// weld unions always are (they are the slow case).
function _bakeSlabs(N, opts){
  const K=Math.min(_pbMax(), Math.floor(N/4));
  if(K<=1) return 1;
  if(opts.bakeRaw || (opts.bodies && opts.bodies.length) || N>=64) return K;
  return 1;
}
async function _bakeFieldUncached(recipe, N, opts){
  const t0=performance.now();
  const base=Object.assign({mode:'bake',recipe,N},opts);
  const K=_bakeSlabs(N,opts);
  if(K<=1){
    const [d]=await _pbRun([base]);
    if(d.type!=='baked') throw new Error('Preview bake: unexpected reply');
    return {data:new Float32Array(d.field),N:d.N,fieldMin:d.fieldMin,fieldMax:d.fieldMax,
      lipschitz:d.lipschitz,ms:Math.round(performance.now()-t0),
      worldMin:d.worldMin,worldMax:d.worldMax,isPeriodic:d.isPeriodic,topology:d.topology};
  }
  const per=Math.floor(N/K), extra=N-per*K, parts=[]; let z=0;
  for(let w=0;w<K;w++){ const len=per+(w<extra?1:0); if(len>0) parts.push(Object.assign({},base,{zStart:z,zEnd:z+len})); z+=len; }
  const replies=await _pbRun(parts);
  const field=new Float32Array(N*N*N);
  let minV=Infinity,maxV=-Infinity,topology=null,wMin=null,wMax=null,raw=false,isPer=false;
  for(const d of replies){
    if(d.type!=='slab') throw new Error('Slab bake not supported for '+(recipe&&recipe.family)+' recipes.');
    field.set(new Float32Array(d.slab), d.zStart*N*N);
    if(d.partialMin<minV)minV=d.partialMin; if(d.partialMax>maxV)maxV=d.partialMax;
    topology=d.topology||null; wMin=d.worldMin; wMax=d.worldMax; isPer=!!d.isPeriodic;
    if(d.raw) raw=true;
  }
  let fin;
  if(raw) fin=_finishRaw(recipe, field, N, minV, maxV, wMin, wMax, topology);
  else{
    const sx=(wMax[0]-wMin[0])/N, sy=(wMax[1]-wMin[1])/N, sz=(wMax[2]-wMin[2])/N;
    fin={fieldMin:minV,fieldMax:maxV,lipschitz:_bakeSdfLipschitz(field,N,sx,sy,sz),isPeriodic:isPer,topology:undefined};
  }
  return Object.assign({data:field,N,ms:Math.round(performance.now()-t0),worldMin:wMin,worldMax:wMax},fin);
}
// ── Content-keyed result cache ──────────────────────────────────────────────
const _bakeCache=new Map();   // key -> result (Map order = least recent first)
let _bakeCacheBytes=0;
const BAKE_CACHE_BYTES=256*1024*1024, BAKE_CACHE_MAX=32;
function _cyrb53(str){
  let h1=0xdeadbeef, h2=0x41c6ce57;
  for(let i=0;i<str.length;i++){ const ch=str.charCodeAt(i); h1=Math.imul(h1^ch,2654435761); h2=Math.imul(h2^ch,1597334677); }
  h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);
  h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);
  return (4294967296*(2097151&h2)+(h1>>>0)).toString(36);
}
function previewBakeKey(recipe, N, opts){
  const rk=r=>r?{f:r.family,s:r.subtype,j:r.json,pm:r._previewFieldMin,px:r._previewFieldMax}:null;
  const o=Object.assign({},opts);
  if(o.bodies) o.bodies=o.bodies.map(sp=>Object.assign({},sp,{recipe:rk(sp.recipe),shapeSdfData:sp.shapeSdfData?('#'+_gridIdOf(sp.shapeSdfData)):null}));
  // A raw (normalized) bake measures its own range, so the recipe's cached
  // preview range doesn't change it; every SDF build reads it (normOverride).
  const top=rk(recipe); if(top && opts.bakeRaw){ delete top.pm; delete top.px; }
  const s=JSON.stringify({r:top,N,o},(k,v)=>(v instanceof ArrayBuffer||ArrayBuffer.isView(v))?('#'+_gridIdOf(v.buffer||v)):v);
  return _cyrb53(s)+'.'+s.length;
}
function _bakeCachePut(key,res){
  const bytes=res.data.byteLength;
  if(bytes>BAKE_CACHE_BYTES/2) return;
  if(_bakeCache.has(key)){ _bakeCacheBytes-=_bakeCache.get(key).data.byteLength; _bakeCache.delete(key); }
  _bakeCache.set(key,res); _bakeCacheBytes+=bytes;
  while(_bakeCache.size>BAKE_CACHE_MAX || _bakeCacheBytes>BAKE_CACHE_BYTES){
    const k=_bakeCache.keys().next().value; _bakeCacheBytes-=_bakeCache.get(k).data.byteLength; _bakeCache.delete(k);
  }
}
function previewBakeCached(key){
  const r=_bakeCache.get(key); if(!r) return null;
  _bakeCache.delete(key); _bakeCache.set(key,r);   // most recent
  return r;
}
function clearPreviewBakeCache(){ _bakeCache.clear(); _bakeCacheBytes=0; }
window.clearPreviewBakeCache=clearPreviewBakeCache;
// bakeField(recipe, N, opts) → {data, N, fieldMin, fieldMax, lipschitz, ms,
// worldMin, worldMax, isPeriodic, topology, key, cached}. Same contract as
// before v0.13.0, plus the cache key and whether it came from the cache.
const _bakeStats={hits:0,bakes:0,cancelled:0};
// Cached result for these bake inputs (marked cached, ms 0), or null.
function previewBakeLookup(recipe, N, opts){
  const key=previewBakeKey(recipe,N,opts||{});
  const hit=previewBakeCached(key);
  if(!hit) return null;
  _bakeStats.hits++;
  return Object.assign({},hit,{key,cached:true,ms:0});
}
async function bakeField(recipe, N, opts){
  opts=opts||{};
  const key=previewBakeKey(recipe,N,opts);
  const hit=previewBakeCached(key);
  if(hit){ _bakeStats.hits++; return Object.assign({},hit,{key,cached:true,ms:0}); }
  _bakeStats.bakes++;
  const res=await _bakeFieldUncached(recipe,N,opts);
  res.key=key; res.cached=false;
  _bakeCachePut(key,res);
  return res;
}
// Preview-bake stats for the bench and tests.
window.F13LD_previewBake={
  cacheSize:()=>_bakeCache.size, cacheBytes:()=>_bakeCacheBytes,
  workers:()=>({idle:_pb.idle.length,busy:_pb.busy.size,jobs:_pb.jobs.size}),
  slabsFor:(N,opts)=>_bakeSlabs(N,opts||{}),
  stats:()=>Object.assign({},_bakeStats)
};
// ── Preview via Raymarcher (no Manifold, instant) ────────────────────────────
const PREVIEW_BAKE_N={draft:48,low:64,med:96,high:128,ultra:192};

// Integer-period preview bake bounds for a TPMS recipe — preview-only fix for
// non-integer cell_scale_x/y/z. The raymarcher's field texture uses GL_REPEAT,
// which only tiles seamlessly when the bake span along each axis is a whole
// number of periods: per axis, K = max(1, round(cs)) periods, half-span 5·K/cs.
// Integer cs → [±5,±5,±5]. Export is unaffected (analytic SDF, no texture).
// Called by triggerPreview to set bakeOpts.worldMin/worldMax.
function computeTPMSBakeBounds(recipe){
  const g=recipe?.json?.geometry||{};
  const csX=g.cell_scale_x??g.cell_scale??1;
  const csY=g.cell_scale_y??g.cell_scale??1;
  const csZ=g.cell_scale_z??g.cell_scale??1;
  if(!(csX>0)||!(csY>0)||!(csZ>0))
    return {wMin:[-5,-5,-5],wMax:[5,5,5]};
  const Kx=Math.max(1,Math.round(csX));
  const Ky=Math.max(1,Math.round(csY));
  const Kz=Math.max(1,Math.round(csZ));
  const halfX=5*Kx/csX, halfY=5*Ky/csY, halfZ=5*Kz/csZ;
  return {wMin:[-halfX,-halfY,-halfZ],wMax:[+halfX,+halfY,+halfZ]};
}

// Wave analog of computeTPMSBakeBounds — preview-only fix for the GL_REPEAT
// seam that appears when a wave recipe contains a NON-integer mode index.
//
// buildWaveSDF maps world [-5,+5] → q [-pi,+pi] via worldScale=pi/5, so one
// cell is 2pi of phase. cos(k*q)/sin(k*q) only return to the same value after
// q advances by 2pi when k is an INTEGER — so the field repeats over one cell
// (world span 10) only when every n,m,p is whole. A half-integer index (e.g.
// 0.5) is anti-periodic over one cell: f(+pi) = -f(-pi). Its true period is
// 4pi = a 2x2x2 supercell (world span 20). Baking a single [-5,+5] cell and
// tiling it with GL_REPEAT then stamps a field discontinuity at every cell
// face → the visible seams.
//
// Fix: bake one full SUPERCELL. S = smallest integer that makes S*n, S*m, S*p
// whole for every mode (0.5→2, 0.25→4, integers→1; capped at 8). Bake half-
// span = 5*S so REPEAT tiles a seamless unit. Each sub-cell keeps its physical
// size (the mesh cell-size input still owns scale). S=1 returns [±5,±5,±5],
// identical to current behaviour for integer recipes.
//
// If the recipe carries coordinate.cellRepeat (written by F13LD.wave), that
// value is trusted directly — the exporter computed S the same way.
//
// Export path is unaffected: Manifold.levelSet evaluates the analytic SDF at
// every voxel with no texture, no wrap — already seamless for any recipe.
function waveSuperCell(recipe){
  const j=recipe&&recipe.json||{};
  const ann=j.coordinate&&j.coordinate.cellRepeat;
  if(typeof ann==='number'&&isFinite(ann)&&ann>=1) return Math.max(1,Math.min(8,Math.round(ann)));
  const modes=(j.field&&Array.isArray(j.field.modes))?j.field.modes:[];
  const MAXD=8, TOL=1e-4;
  // smallest d in 1..MAXD that turns v into a (near-)integer; MAXD if none
  function denom(v){ if(v==null||!isFinite(v))return 1; v=Math.abs(v);
    for(let d=1;d<=MAXD;d++){ if(Math.abs(d*v-Math.round(d*v))<TOL) return d; } return MAXD; }
  function gcd(a,b){ while(b){ const t=a%b; a=b; b=t; } return a; }
  function lcm(a,b){ return a/gcd(a,b)*b; }
  let S=1;
  for(let i=0;i<modes.length;i++){ const mm=modes[i]; if(!mm)continue;
    S=lcm(S, lcm(denom(mm.n), lcm(denom(mm.m), denom(mm.p))));
    if(S>=MAXD){ S=MAXD; break; } }
  return Math.max(1,Math.min(8,S));
}
function computeWaveBakeBounds(recipe){
  const S=waveSuperCell(recipe);
  // v0.9.8 — a stretched cell (field.stretch) is 10·s_i wide along axis i
  const st0=recipe&&recipe.json&&recipe.json.field&&recipe.json.field.stretch;
  const st=(Array.isArray(st0)&&st0.length===3&&st0.every(v=>typeof v==='number'&&isFinite(v)&&v>0))?st0:[1,1,1];
  const hx=5*S*st[0],hy=5*S*st[1],hz=5*S*st[2];
  return {wMin:[-hx,-hy,-hz],wMax:[+hx,+hy,+hz],S:S};
}

// ── Wave tiling diagnosis (preview-only "seams" badge) ─────────────────────
// The supercell tile (computeWaveBakeBounds) is seamless only when every mode
// index reduces to a denominator ≤ 8 (LCM ≤ 8). Outside that, the tiled GL_
// REPEAT preview shows seams — but the 3MF export is always exact (it samples
// the analytic SDF directly, no tiling). These helpers classify *why* a recipe
// can't tile cleanly so the badge can say something useful instead of leaving
// a silent seam.
function _waveGcd(x,y){x=Math.abs(x);y=Math.abs(y);while(y){const t=x%y;x=y;y=t;}return x;}
// Classify a single index value. Returns {ok:true} when it tiles within the
// 8-cell cap, else a reason describing the cleanest interpretation.
function classifyWaveIndex(v){
  if(v==null||!isFinite(v)) return {ok:true};
  const a=Math.abs(v);
  if(Math.abs(a-Math.round(a))<1e-9) return {ok:true};        // whole number
  // Exact-ish rational with denominator up to 64?
  let bq=0,bp=0,bErr=1;
  for(let q=2;q<=64;q++){ const p=Math.round(a*q), err=Math.abs(a-p/q);
    if(err<bErr){bErr=err;bp=p;bq=q;} if(err<1e-9) break; }
  if(bErr<1e-4){
    const g=_waveGcd(bp,bq)||1, p=bp/g, q=bq/g;
    if(q<=8) return {ok:true};                                 // tiles within cap
    return {kind:'overcap', frac:p+'/'+q, q};                  // exact but too big
  }
  // Not an exact small rational — is it a truncated repeating decimal that the
  // user clearly meant (e.g. 0.333 → 1/3)? Snap to nearest q≤8 within 5e-3.
  let tq=0,tp=0,tErr=1;
  for(let q=2;q<=8;q++){ const p=Math.round(a*q), err=Math.abs(a-p/q);
    if(err<tErr){tErr=err;tp=p;tq=q;} }
  if(tErr<5e-3){
    const g=_waveGcd(tp,tq)||1, p=tp/g, q=tq/g;
    return {kind:'trunc', frac:p+'/'+q, q, dec:(p/q).toFixed(6)};
  }
  return {kind:'irrational'};                                  // quasi-periodic
}
// Walk every mode index; report the first offender (+count of any others).
function analyzeWaveTiling(recipe){
  const j=recipe&&recipe.json||{};
  const modes=(j.field&&Array.isArray(j.field.modes))?j.field.modes:[];
  const S=waveSuperCell(recipe);
  let first=null, extra=0;
  for(let i=0;i<modes.length;i++){ const mm=modes[i]; if(!mm)continue;
    const params=[['n',mm.n],['m',mm.m],['p',mm.p]];
    for(let k=0;k<params.length;k++){
      const c=classifyWaveIndex(params[k][1]);
      if(!c.ok){ if(!first) first={mode:i+1,param:params[k][0],val:params[k][1],c:c}; else extra++; }
    }
  }
  if(!first) return {exact:true, S};
  return {exact:false, S, first, extra};
}
// Build the hover-tooltip text for an inexact recipe.
function waveSeamTooltip(a){
  const f=a.first, v=parseFloat((+f.val).toPrecision(6));
  const who='Mode '+f.mode+' '+f.param+'='+v;
  let head;
  if(f.c.kind==='trunc')
    head=who+' \u2248 '+f.c.frac+'. Type '+f.c.dec+' (more digits) for a clean '+f.c.q+'\u00d7'+f.c.q+'\u00d7'+f.c.q+' tile.';
  else if(f.c.kind==='overcap')
    head=who+' = '+f.c.frac+' needs a '+f.c.q+'\u00d7'+f.c.q+'\u00d7'+f.c.q+' tile \u2014 beyond the preview\u2019s 8-cell limit.';
  else
    head=who+' isn\u2019t a simple fraction \u2014 this lattice never repeats (quasi-periodic), so no tiled preview can be seamless.';
  if(a.extra>0) head+=' (+'+a.extra+' more)';
  return head+'\nThe exported 3MF samples the field directly and is seam-free.';
}
// Show/hide the seam badge for the current recipe (v0.9.0: the family's
// seamWarning decides; today only wave with inexact mode ratios shows it).
function updateSeamPill(recipe){
  if(!seamPill) return;
  const d=familyOf(recipe);
  const w=(d && typeof d.seamWarning==='function') ? d.seamWarning(recipe) : null;
  if(!w){ seamPill.style.display='none'; return; }
  seamPill.textContent=w.text;
  seamPill.title=w.title;
  seamPill.style.display='block';
}

// v0.5.0-rc26: Beam analog of computeTPMSBakeBounds.
//
// Anisotropic beam cells (scale_xyz != isotropic) need per-axis bake spans
// matching the cell period in world units, or GL_REPEAT introduces seams
// at the cube faces in shape mode. Cube mode is unaffected (camera stays
// inside [-5,+5]) and export is unaffected (Manifold.levelSet calls the
// SDF closure directly with no texture wrap involved).
//
// The cellScale used here must mirror buildBeamSDF's schema resolution:
//   New schema (sxyz + cell present): cellScale_i = cell / sxyz[i]
//   Legacy schema: cellScale_i = cell_scale (scalar, isotropic)
// where sxyz comes from either geometry.scale_xyz (canonical) or
// geometry.cell_scale_x/y/z (sweep's actual emission — same names as TPMS
// but with mm semantics; the disambiguator is the presence of geometry.cell).
//
// Note: TPMS's cell_scale_x is a unitless frequency multiplier (already a
// cellScale), but beam's cell_scale_x is a per-axis mm size (needs
// cell/cell_scale_x to derive cellScale). That's why this can't reuse
// computeTPMSBakeBounds directly.
function computeBeamBakeBounds(recipe){
  const g=recipe?.json?.geometry||{};
  // Schema-resolved sxyz (per-axis mm cell size).
  let sxyz=null;
  if(Array.isArray(g.scale_xyz)&&g.scale_xyz.length===3
     &&isFinite(g.scale_xyz[0])&&isFinite(g.scale_xyz[1])&&isFinite(g.scale_xyz[2])
     &&g.scale_xyz[0]>0&&g.scale_xyz[1]>0&&g.scale_xyz[2]>0){
    sxyz=g.scale_xyz;
  } else if(typeof g.cell_scale_x==='number'&&g.cell_scale_x>0
         && typeof g.cell_scale_y==='number'&&g.cell_scale_y>0
         && typeof g.cell_scale_z==='number'&&g.cell_scale_z>0){
    sxyz=[g.cell_scale_x, g.cell_scale_y, g.cell_scale_z];
  }
  const cellMm=g.cell;
  const hasCell=(typeof cellMm==='number')&&isFinite(cellMm)&&cellMm>0;
  // Derive per-axis cellScale (cells per world half-span).
  let csX, csY, csZ;
  if(sxyz!==null && hasCell){
    csX = cellMm / sxyz[0];
    csY = cellMm / sxyz[1];
    csZ = cellMm / sxyz[2];
  } else {
    const cs = (typeof g.cell_scale==='number'&&g.cell_scale>0) ? g.cell_scale : 1;
    csX = csY = csZ = cs;
  }
  if(!(csX>0)||!(csY>0)||!(csZ>0))
    return {wMin:[-5,-5,-5],wMax:[5,5,5]};
  const Kx=Math.max(1,Math.round(csX));
  const Ky=Math.max(1,Math.round(csY));
  const Kz=Math.max(1,Math.round(csZ));
  const halfX=5*Kx/csX, halfY=5*Ky/csY, halfZ=5*Kz/csZ;
  return {wMin:[-halfX,-halfY,-halfZ],wMax:[+halfX,+halfY,+halfZ]};
}
