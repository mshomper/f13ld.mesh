/* F13LD.mesh · worker/hu-bake-worker.js
   Hyperuniform field Z-slab bake worker. Launched by 13-hu-bake.js.
   (Moved verbatim from the former inline Blob source.) */
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
function buildHUKernelsMM(params,bbox,cellSizeMm){
  var designK=buildHUKernels(params);
  var TP=2*Math.PI,scale=cellSizeMm/TP;
  var aspect=params.huAspect||4,bw=params.huWidth||.04;
  var a_mm=designK.length>0?designK[0].a*scale:(bw*aspect*.5*cellSizeMm);
  var b1_mm=designK.length>0?designK[0].b1*scale:(bw*.5/Math.sqrt(params.huEll||1)*cellSizeMm);
  var b2_mm=designK.length>0?designK[0].b2*scale:(bw*.5*Math.sqrt(params.huEll||1)*cellSizeMm);
  var p_=designK.cross||2,m_=designK.sharp||1,Rc_=Math.pow(12.25,1/m_),reach=Math.max(a_mm*Math.sqrt(Rc_),b1_mm*Math.pow(Rc_,1/p_),b2_mm*Math.pow(Rc_,1/p_));
  var ddx=bbox.mxx-bbox.mnx,ddy=bbox.mxy-bbox.mny,ddz=bbox.mxz-bbox.mnz;
  var nTx=Math.ceil(ddx/cellSizeMm),nTy=Math.ceil(ddy/cellSizeMm),nTz=Math.ceil(ddz/cellSizeMm);
  var pad=Math.max(2,Math.ceil(reach/cellSizeMm));
  var kernels=[];
  for(var tz=-pad;tz<nTz+pad;tz++)for(var ty=-pad;ty<nTy+pad;ty++)for(var tx=-pad;tx<nTx+pad;tx++){
    for(var ki=0;ki<designK.length;ki++){
      var dk=designK[ki];
      kernels.push({
        px:bbox.mnx+(dk.px+Math.PI)/TP*cellSizeMm+tx*cellSizeMm,
        py:bbox.mny+(dk.py+Math.PI)/TP*cellSizeMm+ty*cellSizeMm,
        pz:bbox.mnz+(dk.pz+Math.PI)/TP*cellSizeMm+tz*cellSizeMm,
        tx:dk.tx,ty:dk.ty,tz:dk.tz,
        n1x:dk.n1x,n1y:dk.n1y,n1z:dk.n1z,
        n2x:dk.n2x,n2y:dk.n2y,n2z:dk.n2z,
        a:a_mm,b1:b1_mm,b2:b2_mm});
    }
  }
  var cutoff=reach;
  var cs=Math.max(cutoff,1e-6);
  var hmnx=bbox.mnx-pad*cellSizeMm,hmny=bbox.mny-pad*cellSizeMm,hmnz=bbox.mnz-pad*cellSizeMm;
  var hmxx=bbox.mnx+(nTx+pad)*cellSizeMm,hmxy=bbox.mny+(nTy+pad)*cellSizeMm,hmxz=bbox.mnz+(nTz+pad)*cellSizeMm;
  var hddx=hmxx-hmnx,hddy=hmxy-hmny,hddz=hmxz-hmnz;
  var nx=Math.max(1,Math.ceil(hddx/cs)),ny=Math.max(1,Math.ceil(hddy/cs)),nz=Math.max(1,Math.ceil(hddz/cs));
  var buckets=new Array(nx*ny*nz);
  for(var bi=0;bi<buckets.length;bi++)buckets[bi]=null;
  for(var ki2=0;ki2<kernels.length;ki2++){
    var kk=kernels[ki2];
    var hx=Math.max(0,Math.min(nx-1,Math.floor((kk.px-hmnx)/cs)));
    var hy=Math.max(0,Math.min(ny-1,Math.floor((kk.py-hmny)/cs)));
    var hz=Math.max(0,Math.min(nz-1,Math.floor((kk.pz-hmnz)/cs)));
    var bIdx=hx+hy*nx+hz*nx*ny;
    if(buckets[bIdx]===null)buckets[bIdx]=[];
    buckets[bIdx].push(ki2);
  }
  kernels.cross=designK.cross;kernels.sharp=designK.sharp;kernels.blend=designK.blend;kernels.hash={buckets:buckets,nx:nx,ny:ny,nz:nz,mnx:hmnx,mny:hmny,mnz:hmnz,cs:cs};
  return kernels;
}
function evalHUFieldMM(kernels,x,y,z){
  var h=kernels.hash,p=kernels.cross||2,m=kernels.sharp||1,P=kernels.blend||1,rnd=(p===2),shp=(m===1),bl=(P===1);
  if(!h){
    var s=0;
    for(var i=0;i<kernels.length;i++){
      var k=kernels[i],dx=x-k.px,dy=y-k.py,dz=z-k.pz;
      var dt=dx*k.tx+dy*k.ty+dz*k.tz,dn1=dx*k.n1x+dy*k.n1y+dz*k.n1z,dn2=dx*k.n2x+dy*k.n2y+dz*k.n2z;
      var u=dt/k.a,w1=dn1/k.b1,w2=dn2/k.b2,R=u*u+(rnd?(w1*w1+w2*w2):(Math.pow(Math.abs(w1),p)+Math.pow(Math.abs(w2),p))),Rm=shp?R:Math.pow(R,m);s+=bl?Math.exp(-Rm):Math.exp(-P*Rm);
    }
    if(!bl)s=Math.pow(s,1/P);return s-0.3;
  }
  var cs=h.cs,nx=h.nx,ny=h.ny,nz=h.nz,nxny=nx*ny;
  var ix=Math.floor((x-h.mnx)/cs),iy=Math.floor((y-h.mny)/cs),iz=Math.floor((z-h.mnz)/cs);
  var ix0=ix-1<0?0:ix-1,ix1=ix+1>=nx?nx-1:ix+1;
  var iy0=iy-1<0?0:iy-1,iy1=iy+1>=ny?ny-1:iy+1;
  var iz0=iz-1<0?0:iz-1,iz1=iz+1>=nz?nz-1:iz+1;
  if(ix1<ix0||iy1<iy0||iz1<iz0)return -0.3;
  var sum=0;
  for(var jz=iz0;jz<=iz1;jz++)for(var jy=iy0;jy<=iy1;jy++)for(var jx=ix0;jx<=ix1;jx++){
    var bucket=h.buckets[jx+jy*nx+jz*nxny];
    if(bucket===null)continue;
    for(var bi=0;bi<bucket.length;bi++){
      var k=kernels[bucket[bi]];
      var dx=x-k.px,dy=y-k.py,dz=z-k.pz;
      var dt=dx*k.tx+dy*k.ty+dz*k.tz,dn1=dx*k.n1x+dy*k.n1y+dz*k.n1z,dn2=dx*k.n2x+dy*k.n2y+dz*k.n2z;
      var u=dt/k.a,w1=dn1/k.b1,w2=dn2/k.b2,R=u*u+(rnd?(w1*w1+w2*w2):(Math.pow(Math.abs(w1),p)+Math.pow(Math.abs(w2),p))),Rm=shp?R:Math.pow(R,m);sum+=bl?Math.exp(-Rm):Math.exp(-P*Rm);
    }
  }
  if(!bl)sum=Math.pow(sum,1/P);return sum-0.3;
}
self.onmessage=function(e){
  try{
    const {params,bbox,cellSizeMm,N,zStart,zEnd,workerId}=e.data;
    const kernels=buildHUKernelsMM(params,bbox,cellSizeMm);
    const ddx=bbox.mxx-bbox.mnx,ddy=bbox.mxy-bbox.mny,ddz=bbox.mxz-bbox.mnz;
    const nSlices=zEnd-zStart;
    const slab=new Float32Array(N*N*nSlices);
    let minV=Infinity,maxV=-Infinity,lastReport=performance.now();
    for(let iz=zStart;iz<zEnd;iz++){
      const localZ=iz-zStart;
      for(let iy=0;iy<N;iy++)for(let ix=0;ix<N;ix++){
        const v=evalHUFieldMM(kernels,
          bbox.mnx+(ix+0.5)/N*ddx,
          bbox.mny+(iy+0.5)/N*ddy,
          bbox.mnz+(iz+0.5)/N*ddz);
        slab[ix+iy*N+localZ*N*N]=v;
        if(v<minV)minV=v; if(v>maxV)maxV=v;
      }
      if(performance.now()-lastReport>80){
        self.postMessage({type:'progress',workerId,pct:(iz-zStart+1)/nSlices});
        lastReport=performance.now();
      }
    }
    self.postMessage({type:'done',workerId,slab:slab.buffer,zStart,zEnd,fieldMin:minV,fieldMax:maxV},[slab.buffer]);
  }catch(err){
    self.postMessage({type:'error',message:err.message||String(err)});
  }
};
