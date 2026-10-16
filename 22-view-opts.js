/* ============================================================
   F13LD.mesh · 22-view-opts.js
   View menu: viewer shading toggles (v0.9.5). v0.12.0: lives in the view
   strip as a drawn-icon pill. Settings live on rm.viewOpts and persist per browser.
   ============================================================ */
'use strict';

(function(){
  var btn=document.getElementById('viewOptsBtn');
  var panel=document.getElementById('viewOptsPanel');
  if(!btn||!panel||typeof rm==='undefined'||!rm||!rm.viewOpts) return;
  // v0.12.0: drawn eye icon + label (index.html carried a glyph here).
  btn.innerHTML='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/></svg><span class="lbl">view</span>';
  btn.setAttribute('aria-haspopup','true');
  var boxes=panel.querySelectorAll('input[data-vo]');
  function sync(){ boxes.forEach(function(b){ b.checked=!!rm.viewOpts[b.dataset.vo]; }); }
  function setOpen(open){ panel.hidden=!open; btn.setAttribute('aria-expanded',open?'true':'false'); }
  btn.addEventListener('click',function(e){ e.stopPropagation(); setOpen(panel.hidden); });
  panel.addEventListener('click',function(e){ e.stopPropagation(); });
  document.addEventListener('click',function(){ if(!panel.hidden) setOpen(false); });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape'&&!panel.hidden){ setOpen(false); btn.focus(); } });
  boxes.forEach(function(b){ b.addEventListener('change',function(){ rm.setViewOption(b.dataset.vo,b.checked); }); });
  document.getElementById('viewOptsReset').addEventListener('click',function(){
    Object.keys(rm.VIEW_DEFAULTS).forEach(function(k){ rm.setViewOption(k,rm.VIEW_DEFAULTS[k]); });
    sync();
  });
  sync();
})();
