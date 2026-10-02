/* ============================================================
   F13LD.mesh · 05-ui-chrome.js
   Preview spinner orb, BVH prototype patch, status indicator.
   ============================================================ */
'use strict';


// ── Preview spinner orb ──────────────────────────────────────────────────────
(function(){
  const cv=document.getElementById('orbSpinner');
  if(!cv)return;
  const ctx=cv.getContext('2d');
  const W=64,H=64,cx=32,cy=32,R=16,STEPS=220;
  const harmonics=[[2,.7,4.2],[3,.6,6.1],[5,.5,8.7],[7,.4,5.5],[11,.3,9.3]];
  let t=0,running=false,raf=null;
  function draw(){
    ctx.clearRect(0,0,W,H);
    ctx.beginPath();ctx.arc(cx,cy,R,0,Math.PI*2);
    ctx.strokeStyle='#c8f542';ctx.globalAlpha=.12;ctx.lineWidth=.7;ctx.stroke();
    ctx.beginPath();
    for(let i=0;i<=STEPS;i++){
      const theta=(i/STEPS)*Math.PI*2;
      let r=R;harmonics.forEach(([f,a,ps])=>{r+=a*Math.sin(f*theta+ps*t);});
      const x=cx+r*Math.cos(theta),y=cy+r*Math.sin(theta);
      i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
    }
    ctx.closePath();ctx.strokeStyle='#c8f542';ctx.globalAlpha=.85;ctx.lineWidth=1.2;ctx.stroke();
    ctx.beginPath();
    for(let i=0;i<=STEPS;i++){
      const theta=(i/STEPS)*Math.PI*2;
      let r=R;harmonics.forEach(([f,a,ps])=>{r+=a*Math.sin(f*theta+ps*t+.6);});
      r-=5;
      const x=cx+r*Math.cos(theta),y=cy+r*Math.sin(theta);
      i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
    }
    ctx.closePath();ctx.strokeStyle='#a5d8c8';ctx.globalAlpha=.22;ctx.lineWidth=.7;ctx.stroke();
    ctx.globalAlpha=1;
    t+=0.014;
    if(running)raf=requestAnimationFrame(draw);
  }
  window._orbStart=function(){if(running)return;running=true;draw();};
  window._orbStop=function(){running=false;if(raf){cancelAnimationFrame(raf);raf=null;}ctx.clearRect(0,0,W,H);};
})();
// Extend THREE prototypes for BVH
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

// ── Status indicator (kept; reused by other init paths if needed) ────────
const mdot = document.getElementById('mdot'), mLabel = document.getElementById('mLabel');
function setMS(s,t){if(mdot)mdot.className='mdot '+s;if(mLabel)mLabel.textContent=t;}
// Manifold no longer loaded on main thread (v0.5.0-rc7) — used only inside
// the mesh worker for marching cubes (Manifold.levelSet). All shape/mesh
// downstream operations go through Float32Array buffers and SDF grids.
setMS('ready','ready');


// (v0.5.0-rc7) Three.js scene + displayMesh removed — was used for the
// post-clear "extracted Three.js mesh" view triggered by triggerMesh().
// Both that flow and the underlying triggerMesh() are gone now; the
// raymarcher's cube preview is the sole post-clear display.
