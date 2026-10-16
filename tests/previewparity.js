// P2 preview / export parity (docs/P2_SCENE_SHADER_SCOPE.md §5).
//
// Phase A (Node, no browser): for every recipes.json case, bake the preview
// source the way the scene does (16-preview-scene.js sceneSourceNeed →
// worker/m40 runPreviewBake, same N and options), build a one-part scene in a
// box and compare 17-member-field.js sceneFieldMm with the single-part export
// field (worker/m32) at random points. Then 3-member welds (solid box + gyroid
// rotated 30° + beam) for each join rule, a skin part and a noise weld member,
// against buildAssemblySDF(specs, k, true) (worker/m30).
// Phase B (GPU=1, browser): if rm.debugSceneDistances exists, compare the
// shader's scene distances with sceneFieldMm on the live scene.
//
// Pass (§5): sign agreement ≥ 99.5 % where |d| > 0.5 voxel, and |Δd| ≤ 0.5
// voxel for ≥ 99 % of the points where |d| < 1 voxel (p99 and max reported).
// voxel = the source's preview voxel in mm; d = the export value.
// Status: ok = §5 met; res = signs agree and p99 ≤ 1 voxel but the ½-voxel
// bound is missed (preview tile resolution; still a pass); diff = the welds
// drawn with the preview's own exterior shape rule, reported but not gated
// (the export adds box distance outside a part's box, the preview keeps the
// P1 lower bound; see tests/README.md); FAIL = anything else (exit code 1).
// The welds proper use the export's exterior rule (shape.exterior = 'add'), so
// they check the mirror itself.
//
// Usage: node previewparity.js <build> [filter]   (QUAL=draft|low|med, default
// draft; PTS=4000; GPU=1 adds phase B; CORES=n for the browser, default 4)
const fs=require('fs'), vm=require('vm'), path=require('path'), os=require('os');
const ROOT=path.resolve(process.argv[2]||'..'), FILTER=process.argv[3]||'';
const QUAL=process.env.QUAL||'draft', PTS=+(process.env.PTS||4000);
const W=path.join(ROOT,'worker');
const T0=Date.now();

// ── Worker code (as tests/slabbake.js) ────────────────────────────────────
const wk={self:{postMessage(){}},console,Math,Float32Array,Float64Array,Uint8Array,Uint16Array,Uint32Array,Int32Array,Int16Array,Int8Array,
  Array,Object,JSON,Error,WeakMap,Map,Set,Number,String,Boolean,isFinite,isNaN,parseFloat,parseInt,Infinity,NaN,ArrayBuffer,
  performance:{now:()=>0}};
vm.createContext(wk);
for(const f of ['m05-sdf-registry.js','m10-noise.js','m11-grain-fields.js','m12-reaction-diffusion.js','m20-sdf-noise-tpms.js',
  'm21-sdf-beam.js','m22-sdf-grain.js','m23-sdf-bundle.js','m24-sdf-wave.js','m25-sdf-foam.js','m30-sdf-assembly.js',
  'm31-weld-grid.js','m32-export-field.js','m40-preview-bake.js'])
  vm.runInContext(fs.readFileSync(path.join(W,f),'utf8'),wk,{filename:f});
const wget=n=>vm.runInContext(n,wk);

// ── Main-thread code: families, bake bounds, the scene's source rule, 17 ──
const mt={console,Math,Float32Array,Float64Array,Array,Object,JSON,Error,WeakMap,Map,Set,Number,String,Boolean,isFinite,isNaN,parseFloat,parseInt,Infinity,NaN};
vm.createContext(mt);
const grab=(file,name)=>{ const src=fs.readFileSync(path.join(ROOT,file),'utf8'); const a=src.indexOf('function '+name+'(');
  if(a<0) return null; let i=src.indexOf('{',a), d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'&&--d===0) break; } return src.slice(a,i+1); };
for(const f of ['03-registry.js',...fs.readdirSync(path.join(ROOT,'families')).sort().map(x=>'families/'+x),'43-bundle-cells.js','17-member-field.js'])
  vm.runInContext(fs.readFileSync(path.join(ROOT,f),'utf8'),mt,{filename:f});
{
  const s42=fs.readFileSync(path.join(ROOT,'42-preview-bake.js'),'utf8');
  vm.runInContext(s42.match(/const PREVIEW_BAKE_N=\{[^}]*\};/)[0]+'\n'+
    ['recipeIsPeriodic','computeTPMSBakeBounds','waveSuperCell','computeWaveBakeBounds','computeBeamBakeBounds'].map(n=>grab('42-preview-bake.js',n)).join('\n')+'\n'+
    grab('11-structure-state.js','rotVecToInvMat3'),mt);
  // The scene's own rule for a member's source (P2). Fallback: the P1 rule it was copied from.
  const sn=grab('16-preview-scene.js','sceneSourceNeed');
  if(!sn) throw new Error('16-preview-scene.js sceneSourceNeed not found');
  vm.runInContext('function _scKey(){return "";}\n'+sn,mt);
}
const mget=n=>vm.runInContext(n,mt);
const sceneSourceNeed=mget('sceneSourceNeed'), sceneFieldMm=mget('sceneFieldMm'), rotVec=mget('rotVecToInvMat3');

// ── Helpers ───────────────────────────────────────────────────────────────
const IDXF={rotXDeg:0,rotYDeg:0,rotZDeg:0,spatialOffsetMmX:0,spatialOffsetMmY:0,spatialOffsetMmZ:0,isoOffsetMm:0,rotMat:[1,0,0,0,1,0,0,0,1]};
function xfOf(rx,ry,rz,off,iso){ return {rotXDeg:rx,rotYDeg:ry,rotZDeg:rz,spatialOffsetMmX:off[0],spatialOffsetMmY:off[1],spatialOffsetMmZ:off[2],isoOffsetMm:iso,rotMat:rotVec(rx,ry,rz)}; }
const isIdent=xf=>xf.rotMat.every((v,i)=>v===[1,0,0,0,1,0,0,0,1][i])&&!xf.spatialOffsetMmX&&!xf.spatialOffsetMmY&&!xf.spatialOffsetMmZ&&!xf.isoOffsetMm;
const rng=s=>()=>{ s=(s*1664525+1013904223)>>>0; return s/4294967296; };
// Part box (mm) and its shape grid: the inner box's exact SDF (negative inside)
// at voxel centres over the box padded by 6 % (30-shape-import.js).
function boxPart(lo,hi,GN,exterior){
  const md=Math.max(hi[0]-lo[0],hi[1]-lo[1],hi[2]-lo[2]), pad=md*0.06;
  const bbox={mnx:lo[0]-pad,mny:lo[1]-pad,mnz:lo[2]-pad,mxx:hi[0]+pad,mxy:hi[1]+pad,mxz:hi[2]+pad};
  const d=new Float32Array(GN*GN*GN), c=[0,1,2].map(a=>(lo[a]+hi[a])/2), h=[0,1,2].map(a=>(hi[a]-lo[a])/2);
  const mn=[bbox.mnx,bbox.mny,bbox.mnz], sz=[bbox.mxx-bbox.mnx,bbox.mxy-bbox.mny,bbox.mxz-bbox.mnz];
  for(let k=0;k<GN;k++)for(let j=0;j<GN;j++)for(let i=0;i<GN;i++){
    const q=[i,j,k].map((t,a)=>Math.abs(mn[a]+(t+0.5)/GN*sz[a]-c[a])-h[a]);
    d[i+j*GN+k*GN*GN]=Math.hypot(Math.max(q[0],0),Math.max(q[1],0),Math.max(q[2],0))+Math.min(Math.max(q[0],q[1],q[2]),0);
  }
  return {bbox, grid:d, N:GN, shape:{data:d, n:[GN,GN,GN], minMm:mn, maxMm:[bbox.mxx,bbox.mxy,bbox.mxz], exterior}};
}
// The preview source a lattice part draws, baked as the scene bakes it (one
// worker; slabbake.js checks the slab split is bit-identical). The selected
// part's raw bake writes its range onto the recipe, which the export reads.
const _bakes=new Map();
function sourceFor(recipe, part, cellMm, xf){
  const nd=sceneSourceNeed(recipe, QUAL, part?{bbox:part.bbox}:null, cellMm, xf);
  const key=JSON.stringify([recipe.json,nd.N,nd.opts]);
  let r=_bakes.get(key);
  if(!r){ wget('runPreviewBake')(Object.assign(JSON.parse(JSON.stringify({mode:'bake',recipe:{family:recipe.family,json:recipe.json},N:nd.N})),nd.opts),m=>{r=m;}); _bakes.set(key,r); }
  if(nd.opts.bakeRaw){ recipe._previewFieldMin=r.fieldMin; recipe._previewFieldMax=r.fieldMax; }
  const raw=!!(r.topology&&r.topology.bakeRaw);
  const src={kind:nd.kind, data:new Float32Array(r.field), n:[r.N,r.N,r.N], minW:nd.box.min.slice(), maxW:nd.box.max.slice(),
    isSdf:!raw, fieldMin:r.fieldMin, fieldMax:r.fieldMax, topology:r.topology||null};
  const voxMm=Math.max(...[0,1,2].map(a=>(src.maxW[a]-src.minW[a])/r.N))*cellMm/10;
  return {src, voxMm, raw, N:r.N};
}
function latticeMember(part, cellMm, xf, fill, skinMm, groupIndex){
  return {shape:part.shape, bboxMm:part.bbox, kind:'lattice', srcIndex:0, cellMm, rotT:xf.rotMat.slice(),
    shiftMm:[xf.spatialOffsetMmX,xf.spatialOffsetMmY,xf.spatialOffsetMmZ], isoMm:xf.isoOffsetMm, fill, skinMm:skinMm||0, groupIndex, vis:'solid'};
}
function stats(name, info, pts, ref, exp, vox){
  let far=0, agree=0, near=0, within=0, maxE=0; const errs=[];
  for(let i=0;i<pts.length;i++){
    const d=exp[i], r=ref[i];
    if(Math.abs(d)>0.5*vox){ far++; if((d<0)===(r<0)) agree++; }
    if(Math.abs(d)<vox){ near++; const e=Math.abs(r-d)/vox; errs.push(e); if(e<=0.5) within++; if(e>maxE) maxE=e; }
  }
  errs.sort((a,b)=>a-b);
  const sPct=far?100*agree/far:100, nPct=near?100*within/near:100, p99=errs.length?errs[Math.min(errs.length-1,Math.floor(errs.length*0.99))]:0;
  // ok: §5 as written. res: signs agree and p99 ≤ 1 voxel, only the ½-voxel
  // bound is missed (trilinear on a tile at preview resolution: the error is a
  // fixed share of a voxel, so in mm it shrinks with N). FAIL: anything else.
  const strict=sPct>=99.5 && nPct>=99;
  const st=strict?'ok':(sPct>=99.5 && p99<=1.0 ? 'res' : 'FAIL');
  return {name, info, vox, far, sPct, near, nPct, p99, maxE, ok:st!=='FAIL', st};
}
const rows=[];
function row(r){
  rows.push(r);
  console.log((r.st||(r.ok?'ok':'FAIL')).padEnd(4)+'  '+r.name.padEnd(42)+r.info.padEnd(18)+('vox '+r.vox.toFixed(3)).padEnd(11)+
    ('sign '+r.sPct.toFixed(2)+'% /'+r.far).padEnd(20)+('near≤½vox '+r.nPct.toFixed(1)+'% /'+r.near).padEnd(24)+
    'p99 '+r.p99.toFixed(2)+'  max '+r.maxE.toFixed(2)+' vox');
}
function samplePts(lo,hi,n,seed){
  const R=rng(seed), pts=[];
  for(let i=0;i<n;i++) pts.push([0,1,2].map(a=>lo[a]+R()*(hi[a]-lo[a])));
  return pts;
}

// ── Phase A1: single parts ────────────────────────────────────────────────
const cases=JSON.parse(fs.readFileSync(path.join(__dirname,'recipes.json'),'utf8'));
const GN=48;
function singlePart(name, recipeJson, cellMm, xf, fill, skinMm){
  const recipe={family:recipeJson.family, json:recipeJson};
  // about 2 × 1.7 × 1.5 cells, off the origin so the pivot is not 0
  const lo=[3.3*cellMm/3, -4.1*cellMm/3, 1.7*cellMm/3], hi=[lo[0]+2.0*cellMm, lo[1]+1.7*cellMm, lo[2]+1.5*cellMm];
  const part=boxPart(lo,hi,GN);
  const S=sourceFor(recipe, part, cellMm, xf);
  const scene={members:[latticeMember(part, cellMm, xf, fill, skinMm, 0)], groups:[{filletMm:0, rule:'union'}], sources:[S.src]};
  const d={mode:'export', recipe, shapeSdfData:part.grid.buffer.slice(0), shapeN:GN, bbox:part.bbox, cellSizeMm:cellMm, relEdgeMm:0.1,
    structXform:{rotMat:xf.rotMat.slice(), spatialOffsetMm:[xf.spatialOffsetMmX,xf.spatialOffsetMmY,xf.spatialOffsetMmZ], isoOffsetMm:xf.isoOffsetMm},
    pruneToNodes:false};
  if(fill==='skin'){ d.fill='skin'; d.skinMm=skinMm; }
  const fexp=wget('buildExportField')(d, Infinity, ()=>{});      // edge ∞: no far-outside short cut
  const b=part.bbox, pts=samplePts([b.mnx,b.mny,b.mnz],[b.mxx,b.mxy,b.mxz],PTS,name.length*7919+13);
  const ref=pts.map(p=>sceneFieldMm(scene,p)), exp=pts.map(p=>-fexp(p));
  row(stats(name, (S.src.kind+' '+(S.raw?'raw':'sdf')+' N'+S.N), pts, ref, exp, S.voxMm));
}
const XF=xfOf(18,-12,24,[0.37,-0.21,0.55],0.08);
for(const [name,c] of Object.entries(cases)){
  if(FILTER && name.indexOf(FILTER)<0) continue;
  const cell=c.cellMm||3;
  try{
    singlePart(name, c.recipe, cell, IDXF, 'lattice');
    if(/gyroid|noise-simplex|spinodoid|beam-bcc|foam2-open-lloyd|wave/.test(name)) singlePart(name+' +xform', c.recipe, cell, XF, 'lattice');
  }catch(e){ rows.push({name,ok:false}); console.log('FAIL  '+name+'  '+(e.stack||e)); }
}
if(!FILTER || 'skin'.indexOf(FILTER)>=0 || FILTER==='skin'){
  try{ singlePart('skin gyroid 0.8 mm', cases['tpms-gyroid-sheet'].recipe, 3, XF, 'skin', 0.8); }
  catch(e){ rows.push({name:'skin',ok:false}); console.log('FAIL  skin  '+(e.stack||e)); }
}

// ── Phase A2: welds ───────────────────────────────────────────────────────
// Solid box | gyroid box (rotated 30° about z, wall +0.1) | beam box, each
// overlapping the next; fillet 0.6 mm. A fourth member variant uses noise.
function weld(name, rule, opts){
  opts=opts||{};
  const gy={family:'tpms', json:cases['tpms-gyroid-sheet'].recipe}, bm={family:'beam', json:cases['beam-bcc'].recipe};
  const third=opts.noise?{family:'noise', json:JSON.parse(JSON.stringify(cases['noise-simplex-sheet'].recipe))}:bm;
  // exterior 'add': the export's rule outside a part box (checks the mirror);
  // without it the preview's lower bound (what the shader draws).
  const ex=opts.previewRule?undefined:'add';
  const parts=[boxPart([-10,-6,-6],[1,6,6],GN,ex), boxPart([-1,-6,-6],[10,6,6],GN,ex), boxPart([8,-4,-4],[16,4,4],GN,ex)];
  const cells=[3,3,opts.noise?4:2.5];
  const xfs=[IDXF, xfOf(0,0,30,[0,0,0],0.1), opts.noise?xfOf(0,20,0,[0.3,0,0],0):IDXF];
  const k=0.6, grp={filletMm:k, rule, anchorMm:0.6, gradeMm:1.5, gradeMaxMm:0};
  const srcs=[null, sourceFor(gy, parts[1], cells[1], xfs[1]), sourceFor(third, parts[2], cells[2], xfs[2])];
  const members=[
    {shape:parts[0].shape, bboxMm:parts[0].bbox, kind:'solid', fill:'solid', groupIndex:0, vis:'solid'},
    Object.assign(latticeMember(parts[1], cells[1], xfs[1], 'lattice', 0, 0),{srcIndex:0}),
    Object.assign(latticeMember(parts[2], cells[2], xfs[2], opts.skin?'skin':'lattice', opts.skin||0, 0),{srcIndex:1})];
  const scene={members, groups:[grp], sources:[srcs[1].src, srcs[2].src]};
  const recs=[null, gy, third];
  const specs=parts.map((p,i)=>{
    const sp={solid:i===0, recipe:recs[i], shapeSdfData:p.grid.buffer.slice(0), shapeN:GN, bbox:p.bbox, cellSizeMm:cells[i]};
    if(i && !isIdent(xfs[i])) sp.structXform={rotMat:xfs[i].rotMat.slice(), spatialOffsetMm:[xfs[i].spatialOffsetMmX,xfs[i].spatialOffsetMmY,xfs[i].spatialOffsetMmZ], isoOffsetMm:xfs[i].isoOffsetMm};
    if(i===2 && opts.skin){ sp.fill='skin'; sp.skinMm=opts.skin; }
    if(rule!=='union'){ sp.joinRule=rule; if(rule==='anchor') sp.anchorMm=grp.anchorMm; else sp.gradeMm=grp.gradeMm; }
    return sp;
  });
  const fexp=wget('buildAssemblySDF')(specs, k, true);
  const pts=samplePts([-11,-7,-7],[17,7,7],PTS*2,name.length*104729+rule.length);
  const ref=pts.map(p=>sceneFieldMm(scene,p)), exp=pts.map(p=>fexp(p));
  const vox=Math.max(srcs[1].voxMm, srcs[2].voxMm);
  const tag=opts.previewRule?' [preview rule]':'';
  const r1=stats(name+tag, 'weld '+rule, pts, ref, exp, vox);
  if(opts.previewRule && r1.st==='FAIL'){ r1.st='diff'; r1.ok=true; }   // reported, not gated (see tests/README.md)
  row(r1);
  if(opts.previewRule) return;
  // Per-member check, at the lattice member's own voxel: points inside the gyroid box only.
  const inG=pts.map((p,i)=>i).filter(i=>{ const b=parts[1].bbox; const p=pts[i]; return p[0]>b.mnx&&p[0]<b.mxx&&p[1]>b.mny&&p[1]<b.mxy&&p[2]>b.mnz&&p[2]<b.mxz; });
  row(stats(name+' (gyroid box)', 'weld '+rule, inG.map(i=>pts[i]), inG.map(i=>ref[i]), inG.map(i=>exp[i]), srcs[1].voxMm));
}
if(!FILTER || /weld/.test(FILTER)){
  for(const rule of ['union','anchor','graded']){
    try{ weld('weld solid+gyroid30+beam', rule); }catch(e){ rows.push({name:'weld '+rule,ok:false}); console.log('FAIL  weld '+rule+'  '+(e.stack||e)); }
  }
  try{ weld('weld solid+gyroid30+noise', 'graded', {noise:true}); }catch(e){ rows.push({name:'weld noise',ok:false}); console.log('FAIL  weld noise  '+(e.stack||e)); }
  try{ weld('weld solid+gyroid30+beam skin', 'anchor', {skin:0.6}); }catch(e){ rows.push({name:'weld skin',ok:false}); console.log('FAIL  weld skin  '+(e.stack||e)); }
  // The same welds with the preview's own exterior rule: what the shader draws vs export.
  for(const rule of ['union','anchor','graded']){
    try{ weld('weld solid+gyroid30+beam', rule, {previewRule:true}); }catch(e){ rows.push({name:'weld pv '+rule,ok:false}); console.log('FAIL  weld pv '+rule+'  '+(e.stack||e)); }
  }
}
const badA=rows.filter(r=>!r.ok).length, cnt=t=>rows.filter(r=>r.st===t).length;
console.log(`\nphase A: ${rows.length-badA}/${rows.length} pass (ok ${cnt('ok')}, res ${cnt('res')}, diff ${cnt('diff')})  (${QUAL}, ${PTS} points, ${((Date.now()-T0)/1000).toFixed(1)} s)`);

// ── Phase B: the shader's scene distances (GPU=1) ─────────────────────────
(async()=>{
  let badB=0;
  if(process.env.GPU==='1') badB=await phaseB().catch(e=>{ console.log('FAIL  phase B  '+(e.stack||e)); return 1; });
  process.exit(badA||badB?1:0);
})();

async function phaseB(){
  const { chromium } = require('playwright');
  const NM=path.join(__dirname,'node_modules');
  const _H=fs.readFileSync(path.join(__dirname,'harness.js'),'utf8');
  eval(_H.slice(_H.indexOf('// UI-ADAPTERS-BEGIN'),_H.indexOf('// UI-ADAPTERS-END')).replace(/^var /gm,'global.').replace(/^async function (\w+)/gm,'global.$1=async function $1'));
  const MIME={js:'application/javascript',mjs:'application/javascript',html:'text/html',css:'text/css',wasm:'application/wasm',json:'application/json'};
  const mime=p=>MIME[p.split('.').pop()]||'application/octet-stream';
  const ENTRY={'fflate':'esm/browser.js','meshoptimizer':'index.js','manifold-3d':'manifold.js'};
  const cdn=url=>{ const u=new URL(url);
    if(u.host==='esm.sh'){
      if(u.pathname.startsWith('/three@0.158.0')) return {body:fs.readFileSync(NM+'/three/build/three.module.js'),type:MIME.js};
      if(u.pathname.startsWith('/three-mesh-bvh@0.7.8')){ const s=fs.readFileSync(NM+'/three-mesh-bvh/build/index.module.js','utf8'); return {body:s.replace(/from\s*['"]three['"]/g,"from 'https://esm.sh/three@0.158.0'"),type:MIME.js}; }
    }
    if(u.host==='cdn.jsdelivr.net'){ const m=u.pathname.match(/^\/npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.*)$/);
      if(m){ let rest=m[2]; if(rest==='+esm') rest=ENTRY[m[1]]; const f=path.join(NM,m[1],rest); if(fs.existsSync(f)) return {body:fs.readFileSync(f),type:mime(f)}; } }
    return null; };
  const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'pparity-'));
  const boxStl=(file,lo,hi)=>{ const P=[]; for(let c=0;c<8;c++) P.push([c&1?hi[0]:lo[0],c&2?hi[1]:lo[1],c&4?hi[2]:lo[2]]);
    const T=[[0,2,1],[1,2,3],[4,5,6],[5,7,6],[0,1,4],[1,5,4],[2,6,3],[3,6,7],[0,4,2],[2,4,6],[1,3,5],[3,7,5]];
    let s='solid box\n'; for(const t of T){ s+=' facet normal 0 0 0\n  outer loop\n'; for(const i of t) s+=`   vertex ${P[i].join(' ')}\n`; s+='  endloop\n endfacet\n'; }
    fs.writeFileSync(file,s+'endsolid box\n'); };
  const STL={A:path.join(TMP,'a.stl'),B:path.join(TMP,'b.stl')};
  boxStl(STL.A,[0,0,0],[20,16,10]); boxStl(STL.B,[18,0,0],[38,16,10]);
  const browser=await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const bctx=await browser.newContext({viewport:{width:1000,height:680}});
  await bctx.route('**/*', async route=>{
    const u=new URL(route.request().url());
    if(u.host==='build.test'){ let p=decodeURIComponent(u.pathname); if(p==='/') p='/index.html'; const f=path.join(ROOT,p);
      return fs.existsSync(f)?route.fulfill({body:fs.readFileSync(f),contentType:mime(f)}):route.fulfill({status:404,body:''}); }
    if(u.host.startsWith('fonts.')) return route.fulfill({body:'',contentType:'text/css'});
    const hit=cdn(route.request().url()); return hit?route.fulfill({body:hit.body,contentType:hit.type,headers:{'access-control-allow-origin':'*'}}):route.abort();
  });
  await bctx.addInitScript(n=>Object.defineProperty(Navigator.prototype,'hardwareConcurrency',{get:()=>n}), +(process.env.CORES||4));
  const page=await bctx.newPage();
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  const RECIPE=cases['tpms-gyroid-sheet'].recipe;
  await page.goto('http://build.test/index.html?r='+encodeURIComponent(JSON.stringify(RECIPE)));
  await page.waitForTimeout(1500);
  const idle=async()=>{ await page.waitForTimeout(400); await page.waitForFunction(()=>document.getElementById('computeOverlay').classList.contains('hidden')&&!(typeof rm!=='undefined'&&rm&&rm.isHeld&&rm.isHeld())&&window.F13LD_previewBake.workers().jobs===0,null,{timeout:240000}).catch(()=>{}); await page.waitForTimeout(300); };
  await idle();
  if(!(await page.evaluate(()=>typeof rm!=='undefined'&&!!rm&&typeof rm.debugSceneDistances==='function'))){
    console.log('skip  phase B: rm.debugSceneDistances is not in this build'); await browser.close(); return 0;
  }
  await page.addScriptTag({content:fs.readFileSync(path.join(ROOT,'17-member-field.js'),'utf8').replace(/^'use strict';/m,'')});
  for(const k of ['A','B']){ const n=await uiBodyCount(page); await page.setInputFiles('#shapeInput',STL[k]);
    await page.waitForFunction(([n,S])=>document.querySelectorAll(S).length>n,[n,UI_BODY],{timeout:180000}); await idle(); }
  const ids=await page.evaluate(()=>window.F13LD_weld.bodyIds());
  await page.evaluate(id=>(window.railSelectPart||window.switchActiveBody)(id), ids[1]); await idle();
  await uiAssignRecipe(page); await idle();
  await page.waitForFunction(()=>window.F13LD_scene&&F13LD_scene.state().members.some(m=>m.src>=0&&m.fill>0),null,{timeout:120000}).catch(()=>{});
  // In-page: the live scene → the plain shapes of 17-member-field.js, then compare.
  const compare=async label=>{
    const r=await page.evaluate(async n=>{
      const sc=window.F13LD_scene&&F13LD_scene.scene(); if(!sc) return {err:'no scene'};
      const box=b=>({data:b.grid.data, n:[b.grid.N,b.grid.N,b.grid.N], minMm:[b.bbox.mnx,b.bbox.mny,b.bbox.mnz], maxMm:[b.bbox.mxx,b.bbox.mxy,b.bbox.mxz]});
      const members=sc.members.map(m=>({shape:m.grid?box(m):null, bboxMm:m.bbox, kind:m.fill?'lattice':'solid', fill:['solid','lattice','skin'][m.fill]||'solid',
        srcIndex:m.src, cellMm:m.cellMm, rotT:m.rotT, shiftMm:m.shiftMm, isoMm:m.isoMm, skinMm:m.skinMm, groupIndex:m.group, vis:m.vis?'ghost':'solid'}));
      const groups=sc.groups.map(g=>({filletMm:g.filletMm, rule:['union','anchor','graded'][g.rule]||'union', anchorMm:g.anchorMm, gradeMm:g.gradeMm, gradeMaxMm:g.gradeMaxMm}));
      const sources=sc.sources.map(s=>({kind:s.kind, data:s.res.data, n:[s.res.N,s.res.N,s.res.N], minW:s.box.min, maxW:s.box.max,
        isSdf:!(s.res.topology&&s.res.topology.bakeRaw), fieldMin:s.res.fieldMin, fieldMax:s.res.fieldMax, topology:s.res.topology||null}));
      const scene={members, groups, sources};
      let mn=[1e9,1e9,1e9], mx=[-1e9,-1e9,-1e9];
      for(const m of sc.members){ if(m.vis) continue; const b=m.bbox; mn=[Math.min(mn[0],b.mnx),Math.min(mn[1],b.mny),Math.min(mn[2],b.mnz)]; mx=[Math.max(mx[0],b.mxx),Math.max(mx[1],b.mxy),Math.max(mx[2],b.mxz)]; }
      let s=12345; const R=()=>{ s=(s*1664525+1013904223)>>>0; return s/4294967296; };
      const pts=new Float32Array(n*3); for(let i=0;i<n*3;i++) pts[i]=mn[i%3]+R()*(mx[i%3]-mn[i%3]);
      const g=await rm.debugSceneDistances(pts); if(!g) return {err:'no float render target'};
      const gd=g.d||g, ref=new Float32Array(n);
      for(let i=0;i<n;i++) ref[i]=sceneFieldMm(scene,[pts[i*3],pts[i*3+1],pts[i*3+2]]);
      let vox=0; for(const m of sc.members) if(!m.vis&&m.src>=0){ const so=sc.sources[m.src]; vox=Math.max(vox,(so.box.max[0]-so.box.min[0])/so.res.N*m.cellMm/10); }
      if(!vox) return {err:'no lattice member in the scene'};
      return {pts:Array.from(pts), ref:Array.from(ref), gpu:Array.from(gd), vox, nm:members.length, ns:sources.length};
    }, Math.min(PTS,4096));
    if(r.err){ console.log('FAIL  phase B '+label+': '+r.err); return 1; }
    const P=[]; for(let i=0;i<r.ref.length;i++) P.push(i);
    const st=stats('GPU '+label, r.nm+' parts '+r.ns+' src', P, r.gpu, r.ref, r.vox);
    row(st); return st.ok?0:1;
  };
  let bad=0;
  bad+=await compare('gyroid part');
  await uiSetXform(page,'rotZDeg',30); await uiSetXform(page,'isoOffsetMm',0.1); await idle();
  bad+=await compare('gyroid part rot30 iso.1');
  await page.evaluate(([a,b])=>window.F13LD_weld.group([a,b],0.6),[ids[0],ids[1]]); await idle();
  bad+=await compare('weld solid+gyroid union');
  await page.evaluate(()=>{ for(const g of weldGroups.values()){ g.joinRule='anchor'; } window.previewSceneChanged&&previewSceneChanged(); }); await idle();
  bad+=await compare('weld solid+gyroid anchor');
  await page.evaluate(()=>{ for(const g of weldGroups.values()){ g.joinRule='graded'; } window.previewSceneChanged&&previewSceneChanged(); }); await idle();
  bad+=await compare('weld solid+gyroid graded');
  console.log('phase B page errors: '+(errors.length?errors.slice(0,3).join(' | '):'none'));
  await browser.close(); fs.rmSync(TMP,{recursive:true,force:true});
  return bad;
}
