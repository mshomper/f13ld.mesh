/* ============================================================
   F13LD.mesh · 23-view-strip.js — v0.12.0
   View strip: Design | Print | Section tabs, the Section (clip) plane
   controls, viewport chips, weld "show joins" sync.
   Print view itself lives in 53-part-prep.js (ppTogglePrintView); the
   clip plane lives in 20-raymarcher.js (rm.setClip). This file only drives
   them. Loads after 22-view-opts.js; everything that needs later modules
   (partPrep, weldGroups, bodies) is looked up at call time.
   ============================================================ */
'use strict';

(function(){
  var strip=document.getElementById('vstrip');
  var tabsEl=document.getElementById('vsTabs');
  var area=document.getElementById('previewArea');
  if(!strip||!tabsEl||!area||typeof rm==='undefined'||!rm) return;

  // ── drawn icons (stroke, 24 box) ─────────────────────────────────────────
  function ico(body,size,cls){
    return '<svg width="'+size+'" height="'+size+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"'+(cls?' class="'+cls+'"':'')+' aria-hidden="true">'+body+'</svg>';
  }
  var IC={
    design:'<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
    print:'<path d="M3 18h18"/><path d="M7 18v-3h10v3"/><path d="M9 15V8l3-3 3 3v7"/>',
    section:'<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M8 5.2v13.6" stroke-dasharray="2 2"/>',
    flip:'<path d="M7 4 3 8l4 4"/><path d="M3 8h14"/><path d="M17 12l4 4-4 4"/><path d="M21 16H7"/>',
    refresh:'<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    x:'<path d="M6 6l12 12M18 6 6 18"/>',
    eye:'<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>'
  };
  window.F13_VIEW_ICONS=IC;      // shared with 22-view-opts.js
  window.F13_ico=ico;

  // ── tabs ─────────────────────────────────────────────────────────────────
  var TABS=[
    {id:'design', label:'Design',  icon:IC.design,  tip:'Normal design view'},
    {id:'print',  label:'Print',   icon:IC.print,   tip:'Build plate with overhang colours'},
    {id:'section',label:'Section', icon:IC.section, tip:'Cut plane through the preview (preview only; export unaffected)'}
  ];
  var view='design';
  var sec={axis:0,flip:false,t:0};
  tabsEl.setAttribute('role','tablist');
  tabsEl.setAttribute('aria-label','View');
  tabsEl.innerHTML=TABS.map(function(t){
    return '<button type="button" class="vtab" role="tab" data-v="'+t.id+'" title="'+t.tip+'"><span class="ti">'+ico(t.icon,14)+'</span><span class="vt-l">'+t.label+'</span></button>';
  }).join('');
  var tabBtns=[].slice.call(tabsEl.querySelectorAll('.vtab'));

  function paintTabs(){
    tabBtns.forEach(function(b){
      var on=b.dataset.v===view;
      b.classList.toggle('on',on);
      b.setAttribute('aria-selected',on?'true':'false');
      b.tabIndex=on?0:-1;
    });
    panel.hidden=(view!=='section');
  }

  function printIsOn(){ return (typeof partPrep!=='undefined'&&partPrep&&partPrep.printView)?true:false; }
  function setPrint(on){
    if(printIsOn()===on) return;
    if(typeof ppTogglePrintView==='function') ppTogglePrintView();
  }

  function setView(v){
    if(v===view&&!(v==='print'&&!printIsOn())) { paintTabs(); return; }
    view=v;
    if(v==='print'){ rm.setClip(null); setPrint(true); }
    else if(v==='section'){ setPrint(false); applyClip(); }
    else { rm.setClip(null); setPrint(false); }
    // ppTogglePrintView can fail to take (no part-prep yet): fall back honestly.
    if(view==='print'&&!printIsOn()&&typeof ppTogglePrintView!=='function') view='design';
    paintTabs(); readout();
    rm._dirty=true;
  }
  window.setViewTab=setView;

  tabBtns.forEach(function(b,i){
    b.addEventListener('click',function(){ setView(b.dataset.v); });
    b.addEventListener('keydown',function(e){
      var d=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0; if(!d) return;
      var n=tabBtns[(i+d+tabBtns.length)%tabBtns.length]; n.focus(); setView(n.dataset.v); e.preventDefault();
    });
  });

  // Print view toggled elsewhere (dock button, part-prep) → keep the tab in sync.
  rm.onViewChange=function(){
    var on=printIsOn();
    if(on&&view!=='print'){ view='print'; rm.setClip(null); paintTabs(); }
    else if(!on&&view==='print'){ view='design'; paintTabs(); }
  };

  // ── section controls (viewport bottom-right) ─────────────────────────────
  var panel=document.createElement('div');
  panel.id='secPanel'; panel.hidden=true;
  panel.setAttribute('role','group'); panel.setAttribute('aria-label','Section plane');
  panel.innerHTML=
    '<span class="sp-t">CUT</span>'+
    '<div class="sp-seg" id="secAxis">'+
      '<button type="button" data-ax="0" class="on" title="Plane normal along X" style="--ax:#f87171">X</button>'+
      '<button type="button" data-ax="1" title="Plane normal along Y" style="--ax:#4ade80">Y</button>'+
      '<button type="button" data-ax="2" title="Plane normal along Z" style="--ax:#60a5fa">Z</button>'+
    '</div>'+
    '<input type="range" id="secPos" min="-100" max="100" step="1" value="0" aria-label="Section position">'+
    '<span class="sp-read" id="secRead">0.00 mm</span>'+
    '<button type="button" class="sp-flip" id="secFlip" title="Flip which side is cut away" aria-label="Flip cut side">'+ico(IC.flip,14)+'</button>';
  area.appendChild(panel);
  var posEl=panel.querySelector('#secPos'), readEl=panel.querySelector('#secRead');
  var axBtns=[].slice.call(panel.querySelectorAll('#secAxis button'));

  function applyClip(){ rm.setClip({axis:sec.axis,flip:sec.flip,t:sec.t}); }
  function readout(){
    if(view!=='section'){ return; }
    var c=rm.clipPlane&&rm.clipPlane();
    if(!c){ readEl.textContent=''; return; }
    readEl.textContent='XYZ'.charAt(c.axis).toLowerCase()+' '+c.posMm.toFixed(2)+' mm';
  }
  posEl.addEventListener('input',function(){ sec.t=(+posEl.value)/100; if(view==='section'){ applyClip(); readout(); } });
  axBtns.forEach(function(b){
    b.addEventListener('click',function(){
      sec.axis=+b.dataset.ax;
      axBtns.forEach(function(x){ x.classList.toggle('on',x===b); });
      if(view==='section'){ applyClip(); readout(); }
    });
  });
  panel.querySelector('#secFlip').addEventListener('click',function(){
    sec.flip=!sec.flip; if(view==='section'){ applyClip(); readout(); }
  });

  // ── viewport chips: triPill / seamPill / timingsPill share one row ───────
  var chips=document.createElement('div');
  chips.id='vpChips';
  area.appendChild(chips);
  ['triPill','seamPill','timingsPill'].forEach(function(id){ var e=document.getElementById(id); if(e) chips.appendChild(e); });

  // ── glyph-free buttons that live in index.html ───────────────────────────
  var cancel=document.getElementById('cancelMeshBtn');
  if(cancel){ cancel.innerHTML=ico(IC.x,10,'btn-ico')+'<span>cancel</span>'; cancel.style.display=cancel.style.display||'none'; }
  var stale=document.getElementById('staleRefreshBtn');
  if(stale){ stale.innerHTML=ico(IC.refresh,12,'btn-ico')+'<span>Update preview</span>'; }
  var banner=document.getElementById('staleBanner');
  if(banner){
    // keep the message, drop the nbsp spacing; the button stays the same element
    var txt=document.createElement('span'); txt.className='sb-t'; txt.textContent='Cell size changed. Preview is out of date.';
    while(banner.firstChild&&banner.firstChild!==stale) banner.removeChild(banner.firstChild);
    banner.insertBefore(txt,stale);
  }

  // ── weld "show joins" ─────────────────────────────────────────────────────
  // weldGroups[gid].showJoins (set by the rail) tints the lattice where two or
  // more members of the active weld are within the fillet band of their shapes.
  var lastJoinSig='';
  function joinSig(){
    try{
      var gid=(typeof activeGroupId==='function')?activeGroupId():null;
      var g=gid&&weldGroups.get(gid);
      return [rm._assemblyMode?1:0,gid||'',g&&g.showJoins?1:0,g?g.filletMm:'',gid?groupMembers(gid).join(','):''].join('|');
    }catch(e){ return ''; }
  }
  function syncJoins(){
    lastJoinSig=joinSig();
    if(!rm.setJoins) return;
    var list=[], band=0.5;
    try{
      var gid=(typeof activeGroupId==='function')?activeGroupId():null;
      var g=gid&&weldGroups.get(gid);
      if(g&&g.showJoins&&rm._assemblyMode){
        var ids=groupMembers(gid), vox=0;
        ids.forEach(function(id){
          var b=bodies.get(id);
          if(b&&b.sdfGhost&&b.bbox){
            list.push({sdf:b.sdfGhost,bbox:b.bbox});
            var ext=Math.max(b.bbox.mxx-b.bbox.mnx,b.bbox.mxy-b.bbox.mny,b.bbox.mxz-b.bbox.mnz);
            vox=Math.max(vox,ext/Math.max(b.sdfGhost.N,1));
          }
        });
        band=Math.max((g.filletMm||0)+0.2,0.75*vox);
      }
    }catch(e){ list=[]; }
    rm.setJoins(list.length>=2?list:[],band);
  }
  // Called by triggerPreview (44-preview-trigger.js) after each bake, and by
  // the rail after it flips showJoins. Cheap and idempotent.
  window.viewStripSync=function(){ syncJoins(); readout(); };
  // Skin thickness / fill are drawn live by the shader (no re-bake for a single
  // body): redraw as soon as the rail changes them. Weld rule / grade / anchor
  // re-bake through the rail's own triggerPreview.
  var lastFillSig='';
  function fillSig(){
    try{
      if(typeof activeBodyId==='undefined'||activeBodyId==null) return '';
      var b=bodies.get(activeBodyId);
      return bodyFill(activeBodyId)+'|'+(b?b.skinMm:'')+'|'+(rm.shapeData?rm.shapeData.cellSizeMm:'');
    }catch(e){ return ''; }
  }
  setInterval(function(){
    if(joinSig()!==lastJoinSig) syncJoins();
    var fs=fillSig(); if(fs!==lastFillSig){ lastFillSig=fs; rm._dirty=true; }
  },250);

  // initial state: print view may already be on (persisted part-prep setting)
  document.addEventListener('DOMContentLoaded',function(){
    if(printIsOn()) view='print';
    paintTabs();
  });
  paintTabs();
})();
