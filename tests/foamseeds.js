// F13LD.foam ↔ F13LD.mesh checks (v0.9.1).
// Usage: node foamseeds.js <mesh build> <F13LD.foam index.html> [recipe.json …]
//  1. The FoamSeeds block in worker/m25-sdf-foam.js is byte-identical to the
//     one in F13LD.foam, so mesh regenerates the same seeds the tool made.
//  2. For each recipe: regenerated seeds match the embedded positions; the SDF
//     tiles (f(p) = f(p + 10 on any axis)); the field is finite everywhere.
const fs=require('fs'),vm=require('vm'),path=require('path');
const [ROOT, FOAM, ...RECIPES]=process.argv.slice(2);
const block=s=>{const a=s.indexOf('// ==== BEGIN FoamSeeds'),b=s.indexOf('// ==== END FoamSeeds');if(a<0||b<0)return null;return s.slice(a,s.indexOf('\n',b));};
const meshSrc=fs.readFileSync(path.join(ROOT,'worker/m25-sdf-foam.js'),'utf8');
let fails=0;
const ok=(c,msg)=>{console.log((c?'PASS  ':'FAIL  ')+msg);if(!c)fails++;};
const mb=block(meshSrc), fb=block(fs.readFileSync(FOAM,'utf8'));
ok(mb&&fb&&mb===fb, 'FoamSeeds block identical in mesh and F13LD.foam ('+(mb?mb.length:0)+' chars)');
const ctx={self:{postMessage(){}},console,Math,Float64Array,Float32Array,Int32Array,Array,Object,Error,isFinite,Number,JSON};
vm.createContext(ctx);
for(const f of ['m05-sdf-registry.js','m25-sdf-foam.js']) vm.runInContext(fs.readFileSync(path.join(ROOT,'worker',f),'utf8'),ctx,{filename:f});
for(const rp of RECIPES){
  const all=JSON.parse(fs.readFileSync(rp,'utf8'));
  for(const [name,v] of Object.entries(all)){
    const j=v&&v.recipe?v.recipe:v;   // tests/recipes.json wraps each case
    if(!j||j.family!=='foam') continue;
    const s=j.seeds;
    const regen=vm.runInContext('FoamSeeds.generate',ctx)({mode:s.mode,count:s.count,regularity:s.regularity!=null?s.regularity:0.9,lloydIter:s.lloyd_iterations||0,rngSeed:s.rng_seed||0,periodic:true}).seeds;
    let maxd=0; for(let i=0;i<regen.length;i++)for(let k=0;k<3;k++)maxd=Math.max(maxd,Math.abs(regen[i][k]-s.positions[3*i+k]));
    ok(regen.length*3===s.positions.length && maxd<=5.1e-5, name+': regenerated seeds match embedded positions (max diff '+maxd.toExponential(1)+')');
    const f=vm.runInContext('buildFoamSDF',ctx)(j);
    let maxP=0, bad=0, R=1;
    const rnd=()=>{R=(R*1664525+1013904223)>>>0;return R/4294967296;};
    for(let i=0;i<3000;i++){
      const p=[rnd()*10-5,rnd()*10-5,rnd()*10-5], v=f(p);
      if(!isFinite(v)) bad++;
      for(const ax of [0,1,2]){const q=p.slice();q[ax]+=10*(1+Math.floor(rnd()*3));maxP=Math.max(maxP,Math.abs(f(q)-v));}
    }
    ok(bad===0, name+': field finite at 3000 random points');
    ok(maxP<1e-9, name+': tiles seamlessly (max |f(p) − f(p+10k)| = '+maxP.toExponential(1)+')');
  }
}
console.log(fails?fails+' FAILED':'ALL PASS'); process.exit(fails?1:0);
