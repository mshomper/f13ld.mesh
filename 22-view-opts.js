/* ============================================================
   F13LD.mesh · 22-view-opts.js
   Viewport "view" menu: viewer shading toggles (v0.9.5).
   Settings live on rm.viewOpts and persist per browser.
   ============================================================ */
'use strict';

(function(){
  var btn=document.getElementById('viewOptsBtn');
  var panel=document.getElementById('viewOptsPanel');
  if(!btn||!panel||typeof rm==='undefined'||!rm||!rm.viewOpts) return;
  var boxes=panel.querySelectorAll('input[data-vo]');
  function sync(){ boxes.forEach(function(b){ b.checked=!!rm.viewOpts[b.dataset.vo]; }); }
  function setOpen(open){ panel.hidden=!open; btn.setAttribute('aria-expanded',open?'true':'false'); }
  btn.addEventListener('click',function(e){ e.stopPropagation(); setOpen(panel.hidden); });
  panel.addEventListener('click',function(e){ e.stopPropagation(); });
  document.addEventListener('click',function(){ if(!panel.hidden) setOpen(false); });
  boxes.forEach(function(b){ b.addEventListener('change',function(){ rm.setViewOption(b.dataset.vo,b.checked); }); });
  document.getElementById('viewOptsReset').addEventListener('click',function(){
    Object.keys(rm.VIEW_DEFAULTS).forEach(function(k){ rm.setViewOption(k,rm.VIEW_DEFAULTS[k]); });
    sync();
  });
  sync();
})();
