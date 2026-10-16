/* ============================================================
   F13LD.mesh · 05-ui-chrome.js
   Preview spinner orb, BVH prototype patch, status indicator.
   ============================================================ */
'use strict';


// ── Centre loader: the F13LD robot, "Centrifuge" (v0.12.0) ─────────────────
// Ported from Matt's robot animation sampler. The robot spins up, flings its
// eyes and teeth outward on trailing spirals, then spins down and snaps back.
// Same API as the old orb: _orbStart() / _orbStop().
(function(){
  const host=document.getElementById('orbSpinner');
  if(!host) return;
  const NS='http://www.w3.org/2000/svg';
  const BODY_D='M 50,5 C 91,5 95,9 95,50 C 95,91 91,95 50,95 C 9,95 5,91 5,50 C 5,9 9,5 50,5 Z';
  const LIME='#c8f542', TEAL='#1D9E75', DARK='#080e0b';
  const PARTS=[{cx:32,cy:40,r:14},{cx:68,cy:40,r:14},{cx:26,cy:68,r:5},{cx:42,cy:68,r:5},{cx:58,cy:68,r:5},{cx:74,cy:68,r:5}];
  const clamp=(v,a,b)=>Math.min(b==null?1:b,Math.max(a||0,v)), seg=(u,a,b)=>clamp((u-a)/(b-a));
  const eOut=t=>1-Math.pow(1-t,3), eIO=t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
  const eBack=t=>{const c1=1.70158,c3=c1+1;return 1+c3*Math.pow(t-1,3)+c1*Math.pow(t-1,2);};
  const mk=(tag,at,par)=>{const e=document.createElementNS(NS,tag);for(const k in at)e.setAttribute(k,at[k]);if(par)par.appendChild(e);return e;};
  const xf=(g,cx,cy,s)=>{const x=s.x||0,y=s.y||0,r=s.r||0,sx=s.sx==null?1:s.sx,sy=s.sy==null?sx:s.sy;
    g.setAttribute('transform','translate('+(cx+x).toFixed(2)+' '+(cy+y).toFixed(2)+') rotate('+r.toFixed(2)+') scale('+sx.toFixed(3)+' '+sy.toFixed(3)+') translate('+(-cx)+' '+(-cy)+')');};
  const svg=mk('svg',{viewBox:'-22 -22 144 144',width:'100%',height:'100%','aria-hidden':'true'},host);
  svg.style.overflow='visible';
  const root=mk('g',{},svg), bodyG=mk('g',{},root);
  mk('path',{d:BODY_D,fill:DARK,stroke:TEAL,'stroke-width':5},bodyG);
  const parts=PARTS.map(p=>{const g=mk('g',{},root); mk('circle',{cx:p.cx,cy:p.cy,r:p.r,fill:LIME},g); return Object.assign({g},p);});
  const DUR=3.0, REST=0.9;
  function frame(u){
    let rot=eIO(seg(u,0,0.88))*1080;
    const w=seg(u,0.86,1); rot+=10*Math.sin(w*Math.PI*3)*(1-w);
    xf(root,50,50,{r:rot});
    const f=eOut(seg(u,0.34,0.56))*(1-eBack(seg(u,0.62,0.86)));
    xf(bodyG,50,50,{sx:1-0.08*f});
    parts.forEach((p,i)=>{
      const dx=p.cx-50, dy=p.cy-50, L=Math.hypot(dx,dy)||1, ux=dx/L, uy=dy/L;
      const big=p.r>10, dist=f*(big?34:50), trail=f*(big?10:22);
      xf(p.g,p.cx,p.cy,{x:ux*dist+uy*trail, y:uy*dist-ux*trail, r:f*(i%2?-220:220)});
    });
  }
  const still=matchMedia('(prefers-reduced-motion: reduce)');
  let running=false, raf=null, t0=0;
  function loop(now){
    if(!running) return;
    const t=((now-t0)/1000)%(DUR+REST);
    frame(Math.min(1,t/DUR));
    raf=requestAnimationFrame(loop);
  }
  frame(1);
  window._orbStart=function(){ if(running) return; running=true; if(still.matches){ frame(1); return; } t0=performance.now(); raf=requestAnimationFrame(loop); };
  window._orbStop=function(){ running=false; if(raf){ cancelAnimationFrame(raf); raf=null; } frame(1); };
})();
// Extend THREE prototypes for BVH
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

// ── Status indicator (kept; reused by other init paths if needed) ────────
const mdot = document.getElementById('mdot'), mLabel = document.getElementById('mLabel');
function setMS(s,t){if(mdot)mdot.className='mdot '+s;if(mLabel)mLabel.textContent=t;}
// v0.12.0: the F13LD mark in the status pill ripples while the tool works
// (setMS state 'loading'); header actions open the recipe / part pickers.
(function(){
  const pill=document.getElementById('statusPill');
  const _set=setMS;
  setMS=function(s,t){ _set(s,t); if(pill) pill.classList.toggle('busy', s==='loading'); };
  const or=document.getElementById('hdrOpenRecipe'), ap=document.getElementById('hdrAddPart');
  if(or) or.addEventListener('click',()=>{ const f=document.getElementById('fileInput'); if(f) f.click(); });
  if(ap) ap.addEventListener('click',()=>{ const f=document.getElementById('shapeInput'); if(f) f.click(); });
})();
// v0.12.0: short status message above the dock (welds joined / dissolved …).
let _toastT=0;
function meshToast(msg){ const t=document.getElementById('toast'); if(!t) return; t.textContent=msg; t.classList.add('on'); clearTimeout(_toastT); _toastT=setTimeout(()=>t.classList.remove('on'),2600); }
// Manifold no longer loaded on main thread (v0.5.0-rc7) — used only inside
// the mesh worker for marching cubes (Manifold.levelSet). All shape/mesh
// downstream operations go through Float32Array buffers and SDF grids.
setMS('ready','ready');


// (v0.5.0-rc7) Three.js scene + displayMesh removed — was used for the
// post-clear "extracted Three.js mesh" view triggered by triggerMesh().
// Both that flow and the underlying triggerMesh() are gone now; the
// raymarcher's cube preview is the sole post-clear display.
