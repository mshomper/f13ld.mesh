/* F13LD.mesh · worker/m10-noise.js — Noise library (all F13LD.noise types). */
const Noise=(()=>{
  function mod289(x){return x-Math.floor(x/289)*289;}
  function permute(x){return mod289(((x*34)+1)*x);}
  function tis(r){return 1.79284291400159-0.85373472095314*r;}
  function snoise(vx,vy,vz){
    var C0=1/6,C1=1/3,s=(vx+vy+vz)*C1;
    var ix=Math.floor(vx+s),iy=Math.floor(vy+s),iz=Math.floor(vz+s);
    var t=(ix+iy+iz)*C0,x0x=vx-ix+t,x0y=vy-iy+t,x0z=vz-iz+t;
    var gx=x0x>=x0y?1:0,gy=x0y>=x0z?1:0,gz=x0z>=x0x?1:0,lx=1-gx,ly=1-gy,lz=1-gz;
    var i1x=Math.min(gx,lz),i1y=Math.min(gy,lx),i1z=Math.min(gz,ly);
    var i2x=Math.max(gx,lz),i2y=Math.max(gy,lx),i2z=Math.max(gz,ly);
    var x1x=x0x-i1x+C0,x1y=x0y-i1y+C0,x1z=x0z-i1z+C0;
    var x2x=x0x-i2x+C1,x2y=x0y-i2y+C1,x2z=x0z-i2z+C1;
    var x3x=x0x-0.5,x3y=x0y-0.5,x3z=x0z-0.5;
    ix=mod289(ix);iy=mod289(iy);iz=mod289(iz);
    var p0=permute(permute(permute(iz)+iy)+ix);
    var p1=permute(permute(permute(iz+i1z)+iy+i1y)+ix+i1x);
    var p2=permute(permute(permute(iz+i2z)+iy+i2y)+ix+i2x);
    var p3=permute(permute(permute(iz+1)+iy+1)+ix+1);
    var nx=0.285714285714,ny=-0.928571428571,nz=0.142857142857;
    var j0=p0-49*Math.floor(p0*nz*nz),j1=p1-49*Math.floor(p1*nz*nz);
    var j2=p2-49*Math.floor(p2*nz*nz),j3=p3-49*Math.floor(p3*nz*nz);
    var x0_=Math.floor(j0*nz),y0_=Math.floor(j0-7*x0_);
    var x1_=Math.floor(j1*nz),y1_=Math.floor(j1-7*x1_);
    var x2_=Math.floor(j2*nz),y2_=Math.floor(j2-7*x2_);
    var x3_=Math.floor(j3*nz),y3_=Math.floor(j3-7*x3_);
    function grad(xs,ys){var h=1-Math.abs(xs)-Math.abs(ys),sh=h<=0?-1:0;return[xs+(Math.floor(xs)*2+1)*sh,ys+(Math.floor(ys)*2+1)*sh,h];}
    var g0=grad(x0_*nx+ny,y0_*nx+ny),g1=grad(x1_*nx+ny,y1_*nx+ny),g2=grad(x2_*nx+ny,y2_*nx+ny),g3=grad(x3_*nx+ny,y3_*nx+ny);
    var n0=tis(g0[0]*g0[0]+g0[1]*g0[1]+g0[2]*g0[2]),n1=tis(g1[0]*g1[0]+g1[1]*g1[1]+g1[2]*g1[2]);
    var n2=tis(g2[0]*g2[0]+g2[1]*g2[1]+g2[2]*g2[2]),n3=tis(g3[0]*g3[0]+g3[1]*g3[1]+g3[2]*g3[2]);
    g0[0]*=n0;g0[1]*=n0;g0[2]*=n0;g1[0]*=n1;g1[1]*=n1;g1[2]*=n1;
    g2[0]*=n2;g2[1]*=n2;g2[2]*=n2;g3[0]*=n3;g3[1]*=n3;g3[2]*=n3;
    var m0=Math.max(0.6-(x0x*x0x+x0y*x0y+x0z*x0z),0);m0*=m0;
    var m1=Math.max(0.6-(x1x*x1x+x1y*x1y+x1z*x1z),0);m1*=m1;
    var m2=Math.max(0.6-(x2x*x2x+x2y*x2y+x2z*x2z),0);m2*=m2;
    var m3=Math.max(0.6-(x3x*x3x+x3y*x3y+x3z*x3z),0);m3*=m3;
    return 42*(m0*m0*(g0[0]*x0x+g0[1]*x0y+g0[2]*x0z)+m1*m1*(g1[0]*x1x+g1[1]*x1y+g1[2]*x1z)+
               m2*m2*(g2[0]*x2x+g2[1]*x2y+g2[2]*x2z)+m3*m3*(g3[0]*x3x+g3[1]*x3y+g3[2]*x3z));
  }
  function frac(x){return x-Math.floor(x);}
  // Dave Hoskins hash33 — even, trig-free seed jitter (verbatim port from
  // F13LD.noise v0.9.1). Identical to that tool's JS + GLSL hash33 so geometry agrees.
  function hash33(px,py,pz){
    var qx=frac(px*0.1031),qy=frac(py*0.1030),qz=frac(pz*0.0973);
    var d=qx*(qy+33.33)+qy*(qx+33.33)+qz*(qz+33.33);
    qx+=d;qy+=d;qz+=d;
    return [frac((qx+qy)*qz),frac((qx+qx)*qy),frac((qx+qy)*qx)];
  }
  function cellular(px,py,pz,metric,jitter){
    var pix=Math.floor(px),piy=Math.floor(py),piz=Math.floor(pz),pfx=px-pix,pfy=py-piy,pfz=pz-piz,d1=10,d2=10;
    for(var oz=-1;oz<=1;oz++)for(var oy=-1;oy<=1;oy++)for(var ox=-1;ox<=1;ox++){
      var cx=pix+ox,cy=piy+oy,cz=piz+oz;
      var rp=hash33(cx,cy,cz);var rpx=0.5+jitter*(rp[0]-0.5),rpy=0.5+jitter*(rp[1]-0.5),rpz=0.5+jitter*(rp[2]-0.5);
      var dx=ox+rpx-pfx,dy=oy+rpy-pfy,dz=oz+rpz-pfz;
      var d=metric==='euclidean'?Math.sqrt(dx*dx+dy*dy+dz*dz):metric==='manhattan'?Math.abs(dx)+Math.abs(dy)+Math.abs(dz):Math.max(Math.abs(dx),Math.max(Math.abs(dy),Math.abs(dz)));
      if(d<d1){d2=d1;d1=d;}else if(d<d2)d2=d;
    }
    return Math.max(Math.min((d2-d1)*2-1,1),-1);
  }
  function fbm(px,py,pz,o,l,g){var v=0,a=1,f=1,mx=0;for(var i=0;i<o;i++){v+=snoise(px*f,py*f,pz*f)*a;mx+=a;a*=g;f*=l;}return v/mx;}
  function ridged(px,py,pz,o,l,g){var v=0,a=1,f=1,mx=0;for(var i=0;i<o;i++){v+=(1-Math.abs(snoise(px*f,py*f,pz*f)))*a;mx+=a;a*=g;f*=l;}return(v/mx)*2-1;}
  function billow(px,py,pz,o,l,g){var v=0,a=1,f=1,mx=0;for(var i=0;i<o;i++){v+=Math.abs(snoise(px*f,py*f,pz*f))*a;mx+=a;a*=g;f*=l;}return(v/mx)*2-1;}
  function warp(px,py,pz,strength,o,l,g){var qx=fbm(px,py,pz,o,l,g),qy=fbm(px+5.2,py+1.3,pz+8.1,o,l,g),qz=fbm(px+3.7,py+9.4,pz+2.8,o,l,g);return fbm(px+strength*qx,py+strength*qy,pz+strength*qz,o,l,g);}
  function curl(px,py,pz,step,ps){var s=ps,e=step,psi_x=snoise(px*s,py*s,pz*s),psi_y=snoise(px*s+3.7,py*s+1.5,pz*s+2.8),psi_z=snoise(px*s+1.2,py*s+4.6,pz*s+0.9);var pzy=snoise(px*s+1.2,(py+e)*s+4.6,pz*s+0.9),pyz=snoise(px*s+3.7,py*s+1.5,(pz+e)*s+2.8),pxz=snoise(px*s,py*s,(pz+e)*s),pzx=snoise((px+e)*s+1.2,py*s+4.6,pz*s+0.9),pyx=snoise((px+e)*s+3.7,py*s+1.5,pz*s+2.8),pxy=snoise(px*s,(py+e)*s,pz*s);var cx=(pzy-psi_z)/e-(pyz-psi_y)/e,cy=(pxz-psi_x)/e-(pzx-psi_z)/e,cz=(pyx-psi_y)/e-(pxy-psi_x)/e;return Math.sqrt(cx*cx+cy*cy+cz*cz);}
  // ── New noise types (verbatim port from F13LD.noise v0.9.1) ──────────────
  // Foam — Worley F2 (raw 2nd-nearest). Rounded closed-cell morphology.
  function foam(px, py, pz, metric, jitter) {
    var pix=Math.floor(px), piy=Math.floor(py), piz=Math.floor(pz);
    var pfx=px-pix, pfy=py-piy, pfz=pz-piz;
    var d1=10, d2=10;
    for(var oz=-1;oz<=1;oz++) for(var oy=-1;oy<=1;oy++) for(var ox=-1;ox<=1;ox++){
      var cx=pix+ox, cy=piy+oy, cz=piz+oz;
      var rp=hash33(cx,cy,cz);var rpx=0.5+jitter*(rp[0]-0.5),rpy=0.5+jitter*(rp[1]-0.5),rpz=0.5+jitter*(rp[2]-0.5);
      var dx=ox+rpx-pfx, dy=oy+rpy-pfy, dz=oz+rpz-pfz;
      var d = metric==='euclidean' ? Math.sqrt(dx*dx+dy*dy+dz*dz) :
              metric==='manhattan' ? Math.abs(dx)+Math.abs(dy)+Math.abs(dz) :
              Math.max(Math.abs(dx),Math.max(Math.abs(dy),Math.abs(dz)));
      if(d<d1){d2=d1;d1=d;}else if(d<d2)d2=d;
    }
    return d2;
  }
  // Strut Network — Worley F3-F1. ~0 along Voronoi edges → connected struts
  // (open-cell / trabecular rod morphology).
  function strut(px, py, pz, metric, jitter) {
    var pix=Math.floor(px), piy=Math.floor(py), piz=Math.floor(pz);
    var pfx=px-pix, pfy=py-piy, pfz=pz-piz;
    var d1=10, d2=10, d3=10;
    for(var oz=-1;oz<=1;oz++) for(var oy=-1;oy<=1;oy++) for(var ox=-1;ox<=1;ox++){
      var cx=pix+ox, cy=piy+oy, cz=piz+oz;
      var rp=hash33(cx,cy,cz);var rpx=0.5+jitter*(rp[0]-0.5),rpy=0.5+jitter*(rp[1]-0.5),rpz=0.5+jitter*(rp[2]-0.5);
      var dx=ox+rpx-pfx, dy=oy+rpy-pfy, dz=oz+rpz-pfz;
      var d = metric==='euclidean' ? Math.sqrt(dx*dx+dy*dy+dz*dz) :
              metric==='manhattan' ? Math.abs(dx)+Math.abs(dy)+Math.abs(dz) :
              Math.max(Math.abs(dx),Math.max(Math.abs(dy),Math.abs(dz)));
      if(d<d1){d3=d2;d2=d1;d1=d;}else if(d<d2){d3=d2;d2=d;}else if(d<d3){d3=d;}
    }
    return d3-d1;
  }
  // Veined — turbulence-warped periodic banding (laminar striated sheets).
  function veined(px, py, pz, turb, freq, octaves, lacunarity, gain) {
    return Math.sin(px*freq + turb*fbm(px,py,pz,octaves,lacunarity,gain));
  }
  return{snoise,cellular,fbm,ridged,billow,warp,curl,foam,strut,veined};
})();
