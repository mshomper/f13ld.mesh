/* F13LD.mesh · worker/m24-sdf-wave.js — F13LD.wave SDF builder. */
function buildWaveSDF(json){
  const f=json.field||{};
  const modes=Array.isArray(f.modes)?f.modes:[];
  const SYM={pure:0,anti:1,antisym:1,chladni:1,cubic:2,chiral:3,schoen:4};
  let sym=(typeof f.symmetryId==='number')?f.symmetryId
         :(typeof f.symmetry==='string'?(SYM[f.symmetry.toLowerCase()]??0):0);
  const iso=(typeof f.iso==='number')?f.iso:0;
  const sheet=(f.mode==='sheet');
  const thickness=(typeof f.thickness==='number')?f.thickness:0.2;
  const signFlip=!!f.signFlip;
  const t=(typeof f.phaseTime==='number')?f.phaseTime:0;
  const WS=(json.coordinate&&typeof json.coordinate.worldScale==='number')?json.coordinate.worldScale:(Math.PI/5.0);
  function evalRaw(qx,qy,qz){
    let acc=0;
    for(let i=0;i<modes.length;i++){
      const mm=modes[i];
      const n=mm.n,m=mm.m,pp=mm.p,A=(mm.A!=null?mm.A:1);
      const cphi=Math.cos((mm.phi||0)+t);
      const cnX=Math.cos(n*qx),cmX=Math.cos(m*qx),cpX=Math.cos(pp*qx);
      const cnY=Math.cos(n*qy),cmY=Math.cos(m*qy),cpY=Math.cos(pp*qy);
      const cnZ=Math.cos(n*qz),cmZ=Math.cos(m*qz),cpZ=Math.cos(pp*qz);
      let v;
      if(sym===1){v=cnX*cmY*cpZ+cnY*cmZ*cpX+cnZ*cmX*cpY-cnY*cmX*cpZ-cnX*cmZ*cpY-cnZ*cmY*cpX;}
      else if(sym===2){v=cnX*cmY*cpZ+cnY*cmZ*cpX+cnZ*cmX*cpY+cnY*cmX*cpZ+cnX*cmZ*cpY+cnZ*cmY*cpX;}
      else if(sym===3){v=cnX*cmY*cpZ+cnY*cmZ*cpX+cnZ*cmX*cpY;}
      else if(sym===4){const snX=Math.sin(n*qx),snY=Math.sin(n*qy),snZ=Math.sin(n*qz);v=snX*cmY*cpZ+snY*cmZ*cpX+snZ*cmX*cpY;}
      else{v=cnX*cmY*cpZ;}
      acc+=A*v*cphi;
    }
    return acc;
  }
  return p=>{
    const qx=p[0]*WS,qy=p[1]*WS,qz=p[2]*WS;
    const fr=evalRaw(qx,qy,qz);
    let cym=sheet?(Math.abs(iso-fr)-thickness):(iso-fr);
    if(signFlip)cym=-cym;
    return cym;   // negative-inside (mesh canonical convention)
  };
}
