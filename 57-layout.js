/* ============================================================================
   F13LD.mesh · 57-layout.js — sections (one at a time) + phone bottom sheet.
   From the F13LD UI template layout.js (F13LD.tpms v1.4.0). Generic: sections come from
   .sec[data-section] in DOM order (Design, Prep, Export).
   window.F13UI is the hook surface the stage 3 wiring and the widgets use:
     F13UI.sections / active / isPhone() / showSection(id) / scrollToSection(id) (alias)
     F13UI.sectionOf(el) / setSheet('peek'|'full') / peekForViewer() / sheetState()
     F13UI.onSectionChange(id)  set by the wiring (stage 3)
   Loads after 56-dock.js and before 60-export-ui.js. The markup is static in index.html,
   so it only needs the DOM.
   Mesh changes against the template (PER-TOOL):
     - the header is #hdr (no .f13ld-header class);
     - the viewer redraw request is rm._dirty = true.
   ========================================================================== */
(function(){
  const UI=window.F13UI=window.F13UI||{};
  const SECS=[...document.querySelectorAll('.sec[data-section]')].map(s=>s.dataset.section);   // order = DOM order
  const mq=window.matchMedia('(max-width:899px)');
  const scroller=document.getElementById('ctrlScroll');
  const pane=document.getElementById('ctrlPane');
  const secEl=id=>document.getElementById('sec-'+id);
  UI.sections=SECS.slice();
  UI.active=SECS[0];
  UI.isPhone=()=>mq.matches;
  function setActive(id){
    if(!SECS.includes(id)||id===UI.active)return;
    UI.active=id;
    // open dropdown / Recipe overlays are fixed-position and would outlive the section they were opened from
    try{window.dispatchEvent(new Event('f13ui-section'));}catch(e){}
    document.querySelectorAll('.sb-fallback [data-section]').forEach(b=>b.classList.toggle('on',b.dataset.section===id));
    if(UI.onSectionChange)try{UI.onSectionChange(id);}catch(e){console.error(e);}
  }
  function applySections(){
    SECS.forEach(s=>secEl(s).classList.toggle('on',s===UI.active));
    updateFades();
  }
  UI.showSection=function(id){
    if(!SECS.includes(id))return;
    const changed=id!==UI.active;
    setActive(id);applySections();
    if(changed)scroller.scrollTop=0;
  };
  UI.scrollToSection=UI.showSection;
  UI.sectionOf=function(el){const s=el&&el.closest&&el.closest('.sec[data-section]');return s?s.dataset.section:null;};
  // the column scrolls only when the active section is taller than it; fade only the edges that hide content
  function updateFades(){
    const y=scroller.scrollTop,max=scroller.scrollHeight-scroller.clientHeight;
    scroller.classList.toggle('ft',y>1);
    scroller.classList.toggle('fb',max-y>1);
  }
  scroller.addEventListener('scroll',updateFades,{passive:true});
  if(window.ResizeObserver){const ro=new ResizeObserver(updateFades);ro.observe(scroller);SECS.forEach(s=>ro.observe(secEl(s)));}
  document.querySelectorAll('.sb-fallback [data-section]').forEach(b=>b.addEventListener('click',()=>UI.showSection(b.dataset.section)));

  // header height drives the phone viewer height
  const hdr=document.querySelector('.f13ld-header')||document.getElementById('hdr');
  function setHdr(){document.documentElement.style.setProperty('--hdr-h',hdr.offsetHeight+'px');}
  setHdr();if(window.ResizeObserver)new ResizeObserver(setHdr).observe(hdr);

  // phone bottom sheet: drag the handle between peek (~45dvh) and full (~88dvh)
  const handle=document.getElementById('sheetHandle');
  let sheetState='peek';
  const vh=()=>window.innerHeight;
  const snapH=s=>Math.round(vh()*(s==='full'?0.88:0.45));
  function setSheet(s,animate){
    sheetState=s;
    if(!animate)pane.classList.add('dragging');
    pane.style.setProperty('--sheet-h',snapH(s)+'px');
    if(!animate)requestAnimationFrame(()=>pane.classList.remove('dragging'));
  }
  UI.setSheet=s=>{if(s==='peek'||s==='full')setSheet(s,true);};
  // viewer overlays (clip, view menu) lie under a full sheet: anything that targets the viewer collapses it to peek first
  UI.peekForViewer=()=>{if(mq.matches&&sheetState==='full')setSheet('peek',true);};
  UI.sheetState=()=>sheetState;
  // opening the view menu from the button also brings the viewer into view
  document.addEventListener('click',e=>{if(e.target.closest&&e.target.closest('#viewOptsBtn'))UI.peekForViewer();},true);
  let dragY=null,startH=0,lastY=0,lastT=0,vel=0,moved=false;
  handle.addEventListener('pointerdown',e=>{
    if(!mq.matches)return;
    dragY=e.clientY;lastY=e.clientY;lastT=performance.now();vel=0;moved=false;
    startH=pane.getBoundingClientRect().height;
    pane.classList.add('dragging');handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove',e=>{
    if(dragY===null)return;
    const dy=e.clientY-dragY;if(Math.abs(dy)>4)moved=true;
    const h=Math.max(snapH('peek')*0.6,Math.min(snapH('full'),startH-dy));
    pane.style.setProperty('--sheet-h',h+'px');
    const t=performance.now();vel=(e.clientY-lastY)/Math.max(1,t-lastT);lastY=e.clientY;lastT=t;
  });
  function endDrag(){
    if(dragY===null)return;
    dragY=null;pane.classList.remove('dragging');
    if(!moved){setSheet(sheetState==='peek'?'full':'peek',true);return;}
    const h=pane.getBoundingClientRect().height,mid=(snapH('peek')+snapH('full'))/2;
    setSheet(vel<-0.4?'full':vel>0.4?'peek':(h>mid?'full':'peek'),true);
  }
  handle.addEventListener('pointerup',endDrag);
  handle.addEventListener('pointercancel',endDrag);
  handle.addEventListener('click',e=>{if(e.detail===0&&mq.matches)setSheet(sheetState==='peek'?'full':'peek',true);});   // keyboard

  function applyLayout(){
    applySections();
    if(mq.matches)setSheet(sheetState,false);
    else pane.style.removeProperty('--sheet-h');
    if(typeof rm!=='undefined'&&rm)rm._dirty=true;   // PER-TOOL: the viewer redraws (the canvas changed size)
  }
  mq.addEventListener?mq.addEventListener('change',applyLayout):mq.addListener(applyLayout);
  window.addEventListener('resize',()=>{if(mq.matches)setSheet(sheetState,false);});
  applyLayout();
})();
