/* F13LD.mesh · worker/m12-reaction-diffusion.js — Gray-Scott, Brusselator, Schnakenberg grids. */
// ── Gray-Scott reaction-diffusion ────────────────────────────────────────
// Wire-format: rdF=F (feed), rdK=k (kill), rdDu=activator diffusion.
// rdDv is OPTIONAL for GS — handoff §1 specifies legacy GS exports may omit
// it, in which case the historical hardcoded ratio (Du*0.5) is used.
function buildGrayScott(params, N) {
  var rng = mulberry32(params.rngSeed||42);
  var F = params.rdF||0.030, k = params.rdK||0.057;
  var Du = params.rdDu||0.14;
  var Dv = (params.rdDv!==undefined && params.rdDv!==null) ? params.rdDv : Du*0.5;
  var dt = Math.min(1.0, 0.9/(6.0*Du));
  var steps = params.rdSteps||3000;
  var u = new Float32Array(N*N*N), v = new Float32Array(N*N*N);
  for (var i = 0; i < N*N*N; i++) u[i] = 1.0 + (rng()-0.5)*0.02;
  var nS = Math.max(3, Math.floor(N*N/20));
  for (var s = 0; s < nS; s++) {
    var cx=Math.floor(rng()*(N-4))+2, cy=Math.floor(rng()*(N-4))+2, cz=Math.floor(rng()*(N-4))+2;
    for (var dz=-1;dz<=1;dz++) for (var dy=-1;dy<=1;dy++) for (var dx=-1;dx<=1;dx++) {
      var ix=(cx+dx+N)%N, iy=(cy+dy+N)%N, iz=(cz+dz+N)%N, id=ix+iy*N+iz*N*N;
      u[id]=0.5+(rng()-0.5)*0.1; v[id]=0.25+(rng()-0.5)*0.05;
    }
  }
  var u2 = new Float32Array(N*N*N), v2 = new Float32Array(N*N*N), tmp;
  for (var step = 0; step < steps; step++) {
    for (var iz=0;iz<N;iz++) { var izm=(iz-1+N)%N, izp=(iz+1)%N;
      for (var iy=0;iy<N;iy++) { var iym=(iy-1+N)%N, iyp=(iy+1)%N;
        for (var ix=0;ix<N;ix++) { var ixm=(ix-1+N)%N, ixp=(ix+1)%N;
          var idx=ix+iy*N+iz*N*N, uc=u[idx], vc=v[idx];
          var lu=u[ixp+iy*N+iz*N*N]+u[ixm+iy*N+iz*N*N]+u[ix+iyp*N+iz*N*N]+u[ix+iym*N+iz*N*N]+u[ix+iy*N+izp*N*N]+u[ix+iy*N+izm*N*N]-6.0*uc;
          var lv=v[ixp+iy*N+iz*N*N]+v[ixm+iy*N+iz*N*N]+v[ix+iyp*N+iz*N*N]+v[ix+iym*N+iz*N*N]+v[ix+iy*N+izp*N*N]+v[ix+iy*N+izm*N*N]-6.0*vc;
          var uv2=uc*vc*vc, nu=uc+dt*(Du*lu-uv2+F*(1.0-uc)), nv=vc+dt*(Dv*lv+uv2-(F+k)*vc);
          u2[idx]=nu<0?0:nu>1?1:nu; v2[idx]=nv<0?0:nv>1?1:nv;
        }
      }
    }
    tmp=u; u=u2; u2=tmp; tmp=v; v=v2; v2=tmp;
  }
  return u;
}

// ── Brusselator reaction-diffusion ──────────────────────────────────────
// v0.5.0-rc15: added per RD handoff §2.3.
// Wire-format overload: rdF→a, rdK→b. Both Du AND Dv are exposed (no longer
// derived from Du as in GS). Init perturbs ±1% around analytical steady state
// (u0=a, v0=b/a). Reaction terms are unbounded in principle, so we soft-clamp
// to [-100,100] purely as NaN protection (values stay near the steady state).
// CRITICAL: u must be renormalized to [0,1] in-place before return — the
// shader contract assumes iso ∈ [0,1] and geometry.center is interpreted in
// that normalized space.
function buildBrusselator(params, N) {
  var rng = mulberry32(params.rngSeed||42);
  var a = (params.rdF!==undefined ? params.rdF : 1.0);
  var b = (params.rdK!==undefined ? params.rdK : 3.5);
  var Du = (params.rdDu!==undefined ? params.rdDu : 2.0);
  var Dv = (params.rdDv!==undefined && params.rdDv!==null) ? params.rdDv : 16.0;
  var dt = Math.min(0.25, 0.9/(6.0*Math.max(Du, Dv)));
  var steps = params.rdSteps||3000;
  var N3 = N*N*N;
  var u = new Float32Array(N3), v = new Float32Array(N3);
  var u0 = a, v0 = b / Math.max(a, 1e-6);
  for (var i = 0; i < N3; i++) {
    u[i] = u0 + (rng()-0.5)*0.02;
    v[i] = v0 + (rng()-0.5)*0.02;
  }
  var u2 = new Float32Array(N3), v2 = new Float32Array(N3), tmp;
  for (var step = 0; step < steps; step++) {
    for (var iz=0;iz<N;iz++) { var izm=(iz-1+N)%N, izp=(iz+1)%N;
      for (var iy=0;iy<N;iy++) { var iym=(iy-1+N)%N, iyp=(iy+1)%N;
        for (var ix=0;ix<N;ix++) { var ixm=(ix-1+N)%N, ixp=(ix+1)%N;
          var idx=ix+iy*N+iz*N*N, uc=u[idx], vc=v[idx];
          var lu=u[ixp+iy*N+iz*N*N]+u[ixm+iy*N+iz*N*N]+u[ix+iyp*N+iz*N*N]+u[ix+iym*N+iz*N*N]+u[ix+iy*N+izp*N*N]+u[ix+iy*N+izm*N*N]-6.0*uc;
          var lv=v[ixp+iy*N+iz*N*N]+v[ixm+iy*N+iz*N*N]+v[ix+iyp*N+iz*N*N]+v[ix+iym*N+iz*N*N]+v[ix+iy*N+izp*N*N]+v[ix+iy*N+izm*N*N]-6.0*vc;
          var uu=uc*uc, nu=uc+dt*(Du*lu + a - (b+1.0)*uc + uu*vc), nv=vc+dt*(Dv*lv + b*uc - uu*vc);
          u2[idx]=nu<-100?-100:nu>100?100:nu; v2[idx]=nv<-100?-100:nv>100?100:nv;
        }
      }
    }
    tmp=u; u=u2; u2=tmp; tmp=v; v=v2; v2=tmp;
  }
  // Renormalize u to [0,1] in place (handoff §2.3 — shader contract requires this)
  var minV=Infinity, maxV=-Infinity;
  for (var i = 0; i < N3; i++) { var uv=u[i]; if(uv<minV)minV=uv; if(uv>maxV)maxV=uv; }
  var rn = Math.max(maxV-minV, 1e-9);
  for (var i = 0; i < N3; i++) u[i] = (u[i]-minV)/rn;
  return u;
}

// ── Schnakenberg reaction-diffusion ─────────────────────────────────────
// v0.5.0-rc15: added per RD handoff §2.4.
// Wire-format overload: rdF→a, rdK→b. Steady state: u0=a+b, v0=b/(a+b)².
// Soft-clamp to [0,100] (one-sided, since Schnakenberg variables are
// concentration-like and stay non-negative). Same renormalize-then-return
// pattern as Brusselator.
function buildSchnakenberg(params, N) {
  var rng = mulberry32(params.rngSeed||42);
  var a = (params.rdF!==undefined ? params.rdF : 0.1);
  var b = (params.rdK!==undefined ? params.rdK : 0.9);
  var Du = (params.rdDu!==undefined ? params.rdDu : 1.0);
  var Dv = (params.rdDv!==undefined && params.rdDv!==null) ? params.rdDv : 40.0;
  var dt = Math.min(0.5, 0.9/(6.0*Math.max(Du, Dv)));
  var steps = params.rdSteps||4000;
  var N3 = N*N*N;
  var u = new Float32Array(N3), v = new Float32Array(N3);
  var apb = a+b, u0 = apb, v0 = b / Math.max(apb*apb, 1e-6);
  for (var i = 0; i < N3; i++) {
    u[i] = u0 + (rng()-0.5)*0.02;
    v[i] = v0 + (rng()-0.5)*0.02;
  }
  var u2 = new Float32Array(N3), v2 = new Float32Array(N3), tmp;
  for (var step = 0; step < steps; step++) {
    for (var iz=0;iz<N;iz++) { var izm=(iz-1+N)%N, izp=(iz+1)%N;
      for (var iy=0;iy<N;iy++) { var iym=(iy-1+N)%N, iyp=(iy+1)%N;
        for (var ix=0;ix<N;ix++) { var ixm=(ix-1+N)%N, ixp=(ix+1)%N;
          var idx=ix+iy*N+iz*N*N, uc=u[idx], vc=v[idx];
          var lu=u[ixp+iy*N+iz*N*N]+u[ixm+iy*N+iz*N*N]+u[ix+iyp*N+iz*N*N]+u[ix+iym*N+iz*N*N]+u[ix+iy*N+izp*N*N]+u[ix+iy*N+izm*N*N]-6.0*uc;
          var lv=v[ixp+iy*N+iz*N*N]+v[ixm+iy*N+iz*N*N]+v[ix+iyp*N+iz*N*N]+v[ix+iym*N+iz*N*N]+v[ix+iy*N+izp*N*N]+v[ix+iy*N+izm*N*N]-6.0*vc;
          var uu=uc*uc, nu=uc+dt*(Du*lu + a - uc + uu*vc), nv=vc+dt*(Dv*lv + b - uu*vc);
          u2[idx]=nu<0?0:nu>100?100:nu; v2[idx]=nv<0?0:nv>100?100:nv;
        }
      }
    }
    tmp=u; u=u2; u2=tmp; tmp=v; v=v2; v2=tmp;
  }
  // Renormalize u to [0,1] in place (handoff §2.4 — shader contract requires this)
  var minV=Infinity, maxV=-Infinity;
  for (var i = 0; i < N3; i++) { var uv=u[i]; if(uv<minV)minV=uv; if(uv>maxV)maxV=uv; }
  var rn = Math.max(maxV-minV, 1e-9);
  for (var i = 0; i < N3; i++) u[i] = (u[i]-minV)/rn;
  return u;
}

function evalRDField(grid, N, u, v, w) {
  // u,v,w already in [0,1) (post-tile fract applied by caller). The RD grid is
  // periodic: sample i sits at u=i/N and the last sample blends back into the
  // first across the tile face.
  // v0.8.2: was u*(N-1), which never interpolated the N-1 → 0 wrap, leaving a
  // one-cell jump (visible seam) at every tile face.
  var fx=u*N, fy=v*N, fz=w*N;
  var x0=Math.floor(fx), y0=Math.floor(fy), z0=Math.floor(fz);
  var dx=fx-x0, dy=fy-y0, dz=fz-z0;
  x0=((x0%N)+N)%N; y0=((y0%N)+N)%N; z0=((z0%N)+N)%N;
  var x1=(x0+1)%N, y1=(y0+1)%N, z1=(z0+1)%N;
  return grid[x0+y0*N+z0*N*N]*(1-dx)*(1-dy)*(1-dz)
        +grid[x1+y0*N+z0*N*N]*dx*(1-dy)*(1-dz)
        +grid[x0+y1*N+z0*N*N]*(1-dx)*dy*(1-dz)
        +grid[x1+y1*N+z0*N*N]*dx*dy*(1-dz)
        +grid[x0+y0*N+z1*N*N]*(1-dx)*(1-dy)*dz
        +grid[x1+y0*N+z1*N*N]*dx*(1-dy)*dz
        +grid[x0+y1*N+z1*N*N]*(1-dx)*dy*dz
        +grid[x1+y1*N+z1*N*N]*dx*dy*dz;
}

// v0.8.2: trilinear read of a NON-periodic grid baked at voxel centres
// ((i+0.5)/N across the bake box), e.g. the shape-mode hyperuniform field.
// u,v,w in [0,1] across the bake box; reads clamp at the outer half-voxel.
function sampleCenteredGrid(grid, N, u, v, w) {
  var fx=Math.min(Math.max(u*N-0.5,0),N-1), fy=Math.min(Math.max(v*N-0.5,0),N-1), fz=Math.min(Math.max(w*N-0.5,0),N-1);
  var x0=Math.floor(fx), y0=Math.floor(fy), z0=Math.floor(fz);
  var x1=x0+1<N?x0+1:N-1, y1=y0+1<N?y0+1:N-1, z1=z0+1<N?z0+1:N-1;
  var dx=fx-x0, dy=fy-y0, dz=fz-z0, NN=N*N;
  var c00=grid[x0+y0*N+z0*NN]+(grid[x1+y0*N+z0*NN]-grid[x0+y0*N+z0*NN])*dx;
  var c10=grid[x0+y1*N+z0*NN]+(grid[x1+y1*N+z0*NN]-grid[x0+y1*N+z0*NN])*dx;
  var c01=grid[x0+y0*N+z1*NN]+(grid[x1+y0*N+z1*NN]-grid[x0+y0*N+z1*NN])*dx;
  var c11=grid[x0+y1*N+z1*NN]+(grid[x1+y1*N+z1*NN]-grid[x0+y1*N+z1*NN])*dx;
  var c0=c00+(c10-c00)*dy, c1=c01+(c11-c01)*dy;
  return c0+(c1-c0)*dz;
}
