// A5 check: measure a strut's real radius from buildBeamSDF and compare to the
// radius trim-to-nodes uses, old formula vs new helper.
const fs=require('fs'),vm=require('vm'),path=require('path');
const ROOT=process.argv[2];
const ctx={self:{postMessage(){}},console,Math,Float64Array,Float32Array,Array,Object,isFinite,Number};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT,'worker/m21-sdf-beam.js'),'utf8'),ctx);
const cases=[
 ['new schema, cell 4 mm used at 6 mm', {beams:[[-1,0,0,1,0,0,1]],geometry:{scale_xyz:[4,4,4],cell:4,radius_x:0.5}}, 6],
 ['old schema, cell_scale 2 at 5 mm',    {beams:[[-1,0,0,1,0,0,1]],geometry:{cell_scale:2,radius:0.2}}, 5],
 ['old schema, cell_scale 1 at 3 mm',    {beams:[[-1,0,0,1,0,0,1]],geometry:{cell_scale:1,radius:0.2}}, 3],
];
for(const [name,j,cell] of cases){
  const sdf=ctx.buildBeamSDF(j);
  // march outward along +y from the strut axis (x=0.3 world, z=0) to the zero crossing; world→mm = cell/10
  let lo=0,hi=5; for(let i=0;i<60;i++){const m=(lo+hi)/2; (sdf([0.3,m,0])<0)?lo=m:hi=m;}
  const actual=lo*cell/10;
  const g=j.geometry, isNew=!!g.scale_xyz;
  const oldF=isNew?g.radius_x:(g.radius*cell/2);
  const newF=ctx.beamStrutRadiusMm(g,cell);
  console.log(`${name.padEnd(36)} actual ${actual.toFixed(3)} mm | trim used: old ${oldF.toFixed(3)} mm, new ${newF.toFixed(3)} mm`);
}
