/* F13LD.mesh · worker/m11-grain-fields.js — Grain primitives: spinodoid / GRF waves, HU kernels. */
// ── Grain primitives (verbatim port from spinodoid-field-explorer) ─────────
// v0.5.0-rc15: canonical mulberry32 (replaces mislabeled xorshift32). Required
// for bitwise determinism with f13ld.grain v0.9.1+ exports — see RD handoff §2.1
// and §5. Negligible perf cost (~5-15% slower per call, but PRNG is only invoked
// during init, not in the time-stepping loop where 99.9% of bake wall-time lives).
function mulberry32(seed){
  return function(){
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    var t = seed;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function sampleVMF(rng,kappa){
  if(kappa<0.05){var z=2*rng()-1,phi=2*Math.PI*rng(),sr=Math.sqrt(Math.max(0,1-z*z));return[sr*Math.cos(phi),sr*Math.sin(phi),z];}
  var w,iter=0;do{var xi=rng();w=1+Math.log(Math.max(xi+(1-xi)*Math.exp(-2*kappa),1e-30))/kappa;iter++;}while((w<-1||w>1)&&iter<2000);
  if(w<-1)w=-1;if(w>1)w=1;var phi=2*Math.PI*rng(),sr=Math.sqrt(Math.max(0,1-w*w));return[sr*Math.cos(phi),sr*Math.sin(phi),w];
}
function rotateTo(v,mux,muy,muz){
  if(Math.abs(muz+1)<1e-6)return[-v[0],-v[1],-v[2]];if(Math.abs(muz-1)<1e-6)return v.slice();
  var ax=-muy,ay=mux,al=Math.sqrt(ax*ax+ay*ay);ax/=al;ay/=al;
  var angle=Math.acos(Math.min(Math.max(muz,-1),1)),c=Math.cos(angle),s=Math.sin(angle),t=1-c,vx=v[0],vy=v[1],vz=v[2];
  return[(t*ax*ax+c)*vx+(t*ax*ay)*vy+(s*ay)*vz,(t*ax*ay)*vx+(t*ay*ay+c)*vy+(-s*ax)*vz,(-s*ay)*vx+(s*ax)*vy+c*vz];
}
function buildSpinodoidWaves(params){
  var rng=mulberry32(params.rngSeed),N=params.nWaves,freq=params.frequency,kappa=params.kappa,mode=params.dirMode;
  var tRad=params.dirTheta*Math.PI/180,pRad=params.dirPhi*Math.PI/180;
  var mux=Math.sin(tRad)*Math.cos(pRad),muy=Math.sin(tRad)*Math.sin(pRad),muz=Math.cos(tRad);
  var axes=[[1,0,0],[0,1,0],[0,0,1]],weights=[params.wX??.33,params.wY??.33,params.wZ??.34],totalW=Math.max(weights[0]+weights[1]+weights[2],1e-6),waves=[];
  for(var i=0;i<N;i++){
    var dir;
    if(mode==='iso')dir=sampleVMF(rng,0);
    else if(mode==='single')dir=rotateTo(sampleVMF(rng,kappa),mux,muy,muz);
    else{var r=rng()*totalW,cum=0,chosen=0;for(var a=0;a<3;a++){cum+=weights[a];if(r<=cum){chosen=a;break;}}dir=rotateTo(sampleVMF(rng,kappa),axes[chosen][0],axes[chosen][1],axes[chosen][2]);}
    var mag=2*Math.PI*freq*(0.85+0.3*rng()),phase=2*Math.PI*rng();
    waves.push({kx:dir[0]*mag,ky:dir[1]*mag,kz:dir[2]*mag,phase});
  }
  return waves;
}
function buildGRFWaves(params){
  var rng=mulberry32(params.rngSeed),N=params.nWaves,freq=params.frequency,mode=params.dirMode;
  var sigmafrac=params.grfSigma||.45,k0base=2*Math.PI*freq,waves=[];
  var tRad=params.dirTheta*Math.PI/180,pRad=params.dirPhi*Math.PI/180;
  var mux=Math.sin(tRad)*Math.cos(pRad),muy=Math.sin(tRad)*Math.sin(pRad),muz=Math.cos(tRad);
  function randn(){var u=Math.max(rng(),1e-10),v=rng();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}
  for(var i=0;i<N;i++){
    var dir=sampleVMF(rng,0),k0;
    if(mode==='ortho'){var wx=params.wX??.33,wy=params.wY??.33,wz=params.wZ??.34;var tot=Math.max(wx+wy+wz,1e-6);wx/=tot;wy/=tot;wz/=tot;var mW=Math.max(wx,wy,wz);var kS=1/(Math.max(wx*dir[0]*dir[0]+wy*dir[1]*dir[1]+wz*dir[2]*dir[2],.05)/mW);kS=Math.min(Math.max(kS,.3),3);k0=k0base*kS;}
    else if(mode==='single'){var align=Math.abs(dir[0]*mux+dir[1]*muy+dir[2]*muz);k0=k0base*(1.5-align);}
    else k0=k0base;
    var sigma=sigmafrac*k0,mag,tries=0;do{mag=k0+randn()*sigma;tries++;}while(mag<=0&&tries<30);
    if(mag<=0)mag=k0*.1;
    waves.push({kx:dir[0]*mag,ky:dir[1]*mag,kz:dir[2]*mag,phase:2*Math.PI*rng()});
  }
  return waves;
}
function jitteredGrid3D(N,rng){
  var cells=Math.ceil(Math.pow(N,1/3)),cs=1/cells,pts=[];
  for(var ix=0;ix<cells;ix++)for(var iy=0;iy<cells;iy++)for(var iz=0;iz<cells;iz++){
    var px=(ix+.5+(rng()-.5)*.9)*cs,py=(iy+.5+(rng()-.5)*.9)*cs,pz=(iz+.5+(rng()-.5)*.9)*cs;
    pts.push([Math.max(.01,Math.min(.99,px)),Math.max(.01,Math.min(.99,py)),Math.max(.01,Math.min(.99,pz))]);
  }
  for(var i=pts.length-1;i>0;i--){var j=Math.floor(rng()*(i+1));var tmp=pts[i];pts[i]=pts[j];pts[j]=tmp;}
  return pts.slice(0,N);
}
function buildHUKernels(params){
  var rng=mulberry32(params.rngSeed),N=params.huN||80,aspect=params.huAspect||4,bw=params.huWidth||.04;
  var ell=params.huEll||1,sq=Math.sqrt(ell),a=bw*aspect*.5,b=bw*.5,b1=b/sq,b2=b*sq,kappa=params.kappa,mode=params.dirMode,pts=jitteredGrid3D(N,rng);
  var tRad=params.dirTheta*Math.PI/180,pRad=params.dirPhi*Math.PI/180;
  var mux=Math.sin(tRad)*Math.cos(pRad),muy=Math.sin(tRad)*Math.sin(pRad),muz=Math.cos(tRad);
  var axes=[[1,0,0],[0,1,0],[0,0,1]],weights=[params.wX??.33,params.wY??.33,params.wZ??.34];
  var totalW=Math.max(weights[0]+weights[1]+weights[2],1e-6);
  function cross3(a,b){return[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}
  function norm3(v){var l=Math.sqrt(v[0]**2+v[1]**2+v[2]**2)||1;return[v[0]/l,v[1]/l,v[2]/l];}
  var kernels=[],TP=2*Math.PI;
  for(var i=0;i<N;i++){
    var t2;
    if(mode==='iso')t2=sampleVMF(rng,0);
    else if(mode==='single')t2=rotateTo(sampleVMF(rng,kappa),mux,muy,muz);
    else{var r=rng()*totalW,cum=0,ch=0;for(var ax=0;ax<3;ax++){cum+=weights[ax];if(r<=cum){ch=ax;break;}}t2=rotateTo(sampleVMF(rng,kappa),axes[ch][0],axes[ch][1],axes[ch][2]);}
    var arb=(Math.abs(t2[0])<.9)?[1,0,0]:[0,1,0];
    var n1=norm3(cross3(t2,arb)),n2=norm3(cross3(t2,n1));
    kernels.push({px:pts[i][0]*TP-Math.PI,py:pts[i][1]*TP-Math.PI,pz:pts[i][2]*TP-Math.PI,tx:t2[0],ty:t2[1],tz:t2[2],n1x:n1[0],n1y:n1[1],n1z:n1[2],n2x:n2[0],n2y:n2[1],n2z:n2[2],a:a*TP,b1:b1*TP,b2:b2*TP});
  }
  kernels.cross=params.huCross||2;kernels.sharp=params.huSharp||1;kernels.blend=params.huBlend||1;
  return kernels;
}
function evalHUField(kernels,x,y,z){
  x=x*2*Math.PI-Math.PI;y=y*2*Math.PI-Math.PI;z=z*2*Math.PI-Math.PI;
  var p=kernels.cross||2,m=kernels.sharp||1,P=kernels.blend||1,rnd=(p===2),shp=(m===1),bl=(P===1);
  var s=0;
  for(var i=0;i<kernels.length;i++){var k=kernels[i],dx=x-k.px,dy=y-k.py,dz=z-k.pz;var dt=dx*k.tx+dy*k.ty+dz*k.tz,dn1=dx*k.n1x+dy*k.n1y+dz*k.n1z,dn2=dx*k.n2x+dy*k.n2y+dz*k.n2z;var u=dt/k.a,w1=dn1/k.b1,w2=dn2/k.b2,R=u*u+(rnd?(w1*w1+w2*w2):(Math.pow(Math.abs(w1),p)+Math.pow(Math.abs(w2),p))),Rm=shp?R:Math.pow(R,m);s+=bl?Math.exp(-Rm):Math.exp(-P*Rm);}
  if(!bl)s=Math.pow(s,1/P);return s-.3;
}
// Periodic variant: wraps each displacement component to the nearest cell image
// via min-image convention. Kernels near cell boundaries "see" query points on
// the opposite side, eliminating tile seams. Cost: 3 extra Math.round per kernel
// (negligible). Used for HU+shape preview where shader tiles via GL_REPEAT.
function evalHUFieldPeriodic(kernels,x,y,z){
  x=x*2*Math.PI-Math.PI;y=y*2*Math.PI-Math.PI;z=z*2*Math.PI-Math.PI;
  var p=kernels.cross||2,m=kernels.sharp||1,P=kernels.blend||1,rnd=(p===2),shp=(m===1),bl=(P===1);var s=0,TP=2*Math.PI;
  for(var i=0;i<kernels.length;i++){var k=kernels[i],dx=x-k.px,dy=y-k.py,dz=z-k.pz;dx-=Math.round(dx/TP)*TP;dy-=Math.round(dy/TP)*TP;dz-=Math.round(dz/TP)*TP;var dt=dx*k.tx+dy*k.ty+dz*k.tz,dn1=dx*k.n1x+dy*k.n1y+dz*k.n1z,dn2=dx*k.n2x+dy*k.n2y+dz*k.n2z;var u=dt/k.a,w1=dn1/k.b1,w2=dn2/k.b2,R=u*u+(rnd?(w1*w1+w2*w2):(Math.pow(Math.abs(w1),p)+Math.pow(Math.abs(w2),p))),Rm=shp?R:Math.pow(R,m);s+=bl?Math.exp(-Rm):Math.exp(-P*Rm);}
  if(!bl)s=Math.pow(s,1/P);return s-.3;
}
function evalField(waves,x,y,z,kernels){
  if(kernels)return evalHUField(kernels,x,y,z);
  var s=0,N=waves.length;for(var i=0;i<N;i++)s+=Math.cos(waves[i].kx*x+waves[i].ky*y+waves[i].kz*z+waves[i].phase);return s/Math.sqrt(N);
}
