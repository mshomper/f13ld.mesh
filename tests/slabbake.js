// v0.13.0 preview bake split: for every recipes.json case (and a 3-member weld),
// a bake split into z-slabs and stitched on the main thread must equal the
// one-worker bake exactly — field values, min / max and Lipschitz.
// Node, no browser. Usage: node slabbake.js <build> [N=48] [slabs=5]
const fs=require('fs'), vm=require('vm'), path=require('path');
const ROOT=process.argv[2]||'..', N=+(process.argv[3]||48), K=+(process.argv[4]||5);
const W=path.join(ROOT,'worker');
const ctx={self:{postMessage(){}},console,Math,Float32Array,Float64Array,Uint8Array,Uint16Array,Uint32Array,Int32Array,Int16Array,Int8Array,
  Array,Object,JSON,Error,WeakMap,Map,Set,Number,String,Boolean,isFinite,isNaN,parseFloat,parseInt,Infinity,NaN,ArrayBuffer,
  performance:{now:()=>0}};
vm.createContext(ctx);
for(const f of ['m05-sdf-registry.js','m10-noise.js','m11-grain-fields.js','m12-reaction-diffusion.js','m20-sdf-noise-tpms.js',
  'm21-sdf-beam.js','m22-sdf-grain.js','m23-sdf-bundle.js','m24-sdf-wave.js','m25-sdf-foam.js','m30-sdf-assembly.js',
  'm31-weld-grid.js','m32-export-field.js','m40-preview-bake.js'])
  vm.runInContext(fs.readFileSync(path.join(W,f),'utf8'),ctx,{filename:f});
// Main-thread finishers, taken from 42-preview-bake.js as written.
const src=fs.readFileSync(path.join(ROOT,'42-preview-bake.js'),'utf8');
const grab=name=>{ const a=src.indexOf('function '+name+'('); let i=src.indexOf('{',a), d=0;
  for(;i<src.length;i++){ if(src[i]==='{')d++; else if(src[i]==='}'&&--d===0) break; } return src.slice(a,i+1); };
vm.runInContext(grab('_bakeSdfLipschitz')+'\n'+grab('_finishRaw')+
  '\nfunction familyOf(r){const f=SDF_FAMILIES[r.family];return f&&f.rawRange?{rawRange:(rr,a,b)=>f.rawRange(rr.json,a,b)}:null;}',ctx);

function bake(msg){ let out=null; ctx.runPreviewBake(JSON.parse(JSON.stringify(msg)),m=>{out=m;}); return out; }
function bakeWithBodies(msg){ let out=null; ctx.runPreviewBake(msg,m=>{out=m;}); return out; }
function compare(name,msg,run){
  const whole=run(msg);
  const field=new Float32Array(N*N*N); let mn=Infinity,mx=-Infinity,raw=false,topo=null,wMin,wMax;
  const per=Math.floor(N/K), extra=N-per*K; let z=0;
  for(let w=0;w<K;w++){ const len=per+(w<extra?1:0);
    const d=run(Object.assign({},msg,{zStart:z,zEnd:z+len}));
    if(d.type!=='slab') throw new Error(name+': expected slab, got '+d.type);
    field.set(new Float32Array(d.slab),d.zStart*N*N);
    mn=Math.min(mn,d.partialMin); mx=Math.max(mx,d.partialMax); raw=!!d.raw; topo=d.topology||null; wMin=d.worldMin; wMax=d.worldMax; z+=len; }
  const ref=new Float32Array(whole.field);
  let diff=0; for(let i=0;i<ref.length;i++) if(!(ref[i]===field[i]||(ref[i]!==ref[i]&&field[i]!==field[i]))) diff++;
  let lip,fmin=mn,fmax=mx;
  if(raw){ const f=ctx._finishRaw(msg.recipe,field,N,mn,mx,wMin,wMax,topo); lip=f.lipschitz; fmin=f.fieldMin; fmax=f.fieldMax; }
  else{ const sx=(wMax[0]-wMin[0])/N,sy=(wMax[1]-wMin[1])/N,sz=(wMax[2]-wMin[2])/N; lip=ctx._bakeSdfLipschitz(field,N,sx,sy,sz); }
  const ok=diff===0 && lip===whole.lipschitz && fmin===whole.fieldMin && fmax===whole.fieldMax;
  console.log((ok?'ok  ':'FAIL')+'  '+name.padEnd(34)+(raw?' raw':' sdf')+'  diff '+diff+'  lip '+whole.lipschitz.toFixed(5)+(lip===whole.lipschitz?'':' vs '+lip)+
    '  range '+(fmin===whole.fieldMin&&fmax===whole.fieldMax?'same':(whole.fieldMin+'..'+whole.fieldMax+' vs '+fmin+'..'+fmax)));
  return ok;
}
const cases=JSON.parse(fs.readFileSync(path.join(__dirname,'recipes.json'),'utf8'));
let bad=0;
for(const [name,c] of Object.entries(cases)){
  const json=c.recipe, fam=json.family;
  const recipe={family:fam,json};
  const sdfFam=vm.runInContext('SDF_FAMILIES',ctx)[fam];
  if(!sdfFam){ console.log('skip  '+name+' (no family '+fam+')'); continue; }
  const hasRaw=typeof sdfFam.rawEval==='function' && !!sdfFam.rawEval({recipe,N,worldMin:[-5,-5,-5],worldMax:[5,5,5]});
  try{
    if(!compare(name,{mode:'bake',recipe,N,isPeriodic:true,bakeRaw:false},bake)) bad++;
    if(hasRaw && !compare(name+' (raw)',{mode:'bake',recipe,N,bakeRaw:true,worldMin:[-7,-6,-5],worldMax:[8,6,9]},bake)) bad++;
  }catch(e){ bad++; console.log('FAIL  '+name+'  '+e.message); }
}
// Weld: solid box + gyroid lattice box + beam lattice box, overlapping, 2 mm fillet.
{
  const GN=32;
  const boxGrid=(b)=>{ const d=new Float32Array(GN*GN*GN), sx=(b.mxx-b.mnx)/(GN-1), sy=(b.mxy-b.mny)/(GN-1), sz=(b.mxz-b.mnz)/(GN-1);
    const cx=(b.mnx+b.mxx)/2, cy=(b.mny+b.mxy)/2, cz=(b.mnz+b.mxz)/2, hx=(b.mxx-b.mnx)/2*0.9, hy=(b.mxy-b.mny)/2*0.9, hz=(b.mxz-b.mnz)/2*0.9;
    for(let k=0;k<GN;k++)for(let j=0;j<GN;j++)for(let i=0;i<GN;i++){
      const qx=Math.abs(b.mnx+i*sx-cx)-hx, qy=Math.abs(b.mny+j*sy-cy)-hy, qz=Math.abs(b.mnz+k*sz-cz)-hz;
      const o=Math.hypot(Math.max(qx,0),Math.max(qy,0),Math.max(qz,0))+Math.min(Math.max(qx,qy,qz),0);
      d[i+j*GN+k*GN*GN]=-o; }   // positive inside
    return d.buffer; };
  const gy=cases['tpms-gyroid-sheet'].recipe, bm=cases['beam-bcc'].recipe;
  const bb=[{mnx:-10,mny:-6,mnz:-6,mxx:0,mxy:6,mxz:6},{mnx:-2,mny:-6,mnz:-6,mxx:10,mxy:6,mxz:6},{mnx:8,mny:-4,mnz:-4,mxx:16,mxy:4,mxz:4}];
  const specs=[
    {solid:true,recipe:null,shapeSdfData:boxGrid(bb[0]),shapeN:GN,bbox:bb[0],cellSizeMm:3},
    {solid:false,recipe:{family:'tpms',json:gy},shapeSdfData:boxGrid(bb[1]),shapeN:GN,bbox:bb[1],cellSizeMm:3,rotMat:[0.8,0.6,0,-0.6,0.8,0,0,0,1],isoOffsetMm:0.1},
    {solid:false,recipe:{family:'beam',json:bm},shapeSdfData:boxGrid(bb[2]),shapeN:GN,bbox:bb[2],cellSizeMm:2.5}];
  const s=10/3;
  const msg={mode:'bake',recipe:null,N,isPeriodic:false,bakeRaw:false,worldMin:[-10*s,-6*s,-6*s],worldMax:[16*s,6*s,6*s],mmScale:s,bodies:specs,blendK:2};
  try{ if(!compare('weld solid+gyroid+beam',msg,m=>bakeWithBodies(Object.assign({},m,{bodies:m.bodies.map(b=>Object.assign({},b,{shapeSdfData:b.shapeSdfData.slice(0)}))})))) bad++; }
  catch(e){ bad++; console.log('FAIL  weld  '+e.message); }
}
console.log(bad?('\n'+bad+' case(s) FAILED'):'\nall slab bakes identical');
process.exit(bad?1:0);
