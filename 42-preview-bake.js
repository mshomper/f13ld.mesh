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
function _bakeFieldSingle(recipe, N, opts){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(getMeshWorkerUrl());
    const t0=performance.now();
    worker.onmessage=e=>{
      const d=e.data;
      if(d.type==='baked'){
        worker.terminate();
        resolve({data:new Float32Array(d.field),N:d.N,
          fieldMin:d.fieldMin,fieldMax:d.fieldMax,
          lipschitz:d.lipschitz,ms:Math.round(performance.now()-t0),
          worldMin:d.worldMin,worldMax:d.worldMax,isPeriodic:d.isPeriodic,topology:d.topology});
      }else if(d.type==='error'){worker.terminate();reject(new Error(d.message));}
    };
    worker.onerror=e=>{worker.terminate();reject(new Error(e.message||'Bake error'));};
    worker.postMessage({mode:'bake',recipe,N,...(opts||{})});
  });
}
// Slab-parallel raw-field bake (HU/noise). Z is the contiguous outer grid axis,
// so each worker bakes a [zStart,zEnd) block that stitches by a single set() at
// offset zStart*N*N. min/max reduce across slabs; the gradient Lipschitz and
// noise pad are computed once on the stitched grid (no kernel evals — cheap),
// reproducing the serial bakeRaw result exactly. Non-raw/SDF bakes and single-
// core machines fall through to _bakeFieldSingle unchanged.
function bakeField(recipe, N, opts){
  opts=opts||{};
  const hc=navigator.hardwareConcurrency||2;
  const K=Math.max(1,Math.min(12,hc-1,N));
  if(!opts.bakeRaw || K<=1) return _bakeFieldSingle(recipe,N,opts);
  return new Promise((resolve,reject)=>{
    const t0=performance.now();
    const per=Math.floor(N/K), extra=N-per*K, slabs=[]; let z=0;
    for(let w=0;w<K;w++){const len=per+(w<extra?1:0); if(len>0)slabs.push({zStart:z,zEnd:z+len}); z+=len;}
    const field=new Float32Array(N*N*N);
    let done=0,minV=Infinity,maxV=-Infinity,topology=null,wMin=null,wMax=null,failed=false;
    const workers=[];
    function cleanup(){workers.forEach(w=>{try{w.terminate();}catch(e){}});}
    function finalize(){
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
      resolve({data:field,N,fieldMin:postMin,fieldMax:postMax,lipschitz:lip,
        ms:Math.round(performance.now()-t0),worldMin:wMin,worldMax:wMax,isPeriodic:false,topology});
    }
    slabs.forEach(sl=>{
      const wk=new Worker(getMeshWorkerUrl()); workers.push(wk);
      wk.onmessage=e=>{
        const d=e.data;
        if(d.type==='slab'){
          field.set(new Float32Array(d.slab), d.zStart*N*N);
          if(d.partialMin<minV)minV=d.partialMin; if(d.partialMax>maxV)maxV=d.partialMax;
          topology=d.topology; wMin=d.worldMin; wMax=d.worldMax;
          wk.terminate(); if(++done===slabs.length && !failed) finalize();
        }else if(d.type==='error'){ if(!failed){failed=true; cleanup(); reject(new Error(d.message));} }
        else if(d.type==='baked'){
          // v0.8.1: the worker only slab-bakes stochastic families; any other family
          // answers with a whole grid. Fail loudly instead of waiting forever.
          if(!failed){failed=true; cleanup(); reject(new Error('Slab bake not supported for '+recipe.family+' recipes.'));}
        }
      };
      wk.onerror=e=>{ if(!failed){failed=true; cleanup(); reject(new Error(e.message||'Bake error'));} };
      wk.postMessage({mode:'bake',recipe,N,...opts,zStart:sl.zStart,zEnd:sl.zEnd});
    });
  });
}
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
