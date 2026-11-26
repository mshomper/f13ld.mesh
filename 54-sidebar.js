/* ============================================================
   F13LD.mesh · 54-sidebar.js  (v0.12.0)
   Post-render hook for the (hidden) summary panel.

   The right sidebar of earlier versions is gone: part prep and export live
   in the dock drawer, the estimate and measured numbers in the inspector
   (56-dock.js). Every summary render still calls sidebarEnhance(root); it now
   moves the homogenization block (hr + section label + stat row, made by
   homoSection() and the beam summary in 51-summaries.js) out of the summary
   and into the Homogenization card (#inspHomo, collapsed by default). The
   recipe title and settings grid stay in the summary for the left rail.
   ============================================================ */
'use strict';

function sidebarEnhance(root){
  root=root||document.getElementById('summaryContent');
  if(typeof dockEnsure==='function') dockEnsure();
  const host=document.getElementById('inspHomo');
  const body=document.getElementById('homoBody');
  const method=document.getElementById('homoMethod');
  let found=false;
  if(root){
    for(const lbl of [...root.querySelectorAll('.sec-lbl')]){
      if(!/^\s*homogenization/i.test(lbl.textContent)) continue;
      let row=lbl.nextElementSibling;
      while(row && !row.classList.contains('homo-row') && !row.classList.contains('sec-lbl')) row=row.nextElementSibling;
      if(!row || !row.classList.contains('homo-row')) continue;
      const hr=lbl.previousElementSibling;
      const title=lbl.textContent.replace(/^\s*homogenization\s*[·.]?\s*/i,'').replace(/\s*·\s*/g,' · ').trim();
      if(body){ body.innerHTML=''; body.appendChild(row); }
      if(method) method.textContent=title;
      if(hr && hr.tagName==='HR') hr.remove();
      lbl.remove();
      found=true;
      break;
    }
  }
  if(!found && body){ body.innerHTML=''; if(method) method.textContent=''; }
  if(host){ host.dataset.has=found?'1':''; homoSync(); }
  if(typeof dockRefresh==='function') dockRefresh();
}
// UI refresh stage 4 (audit F4): the card describes the recipe as the design
// tool analysed it. It hides while the selected part's wall offset or rotation
// is not 0, or its fill is Lattice + skin, and shows again when they are back.
function homoDesignChanged(){
  try{
    if(!importedShape || activeBodyId==null || !bodies.has(activeBodyId)) return false;
    const xf=(typeof structureTransform!=='undefined')?structureTransform:null;
    if(xf){
      if(Math.abs(+xf.isoOffsetMm||0)>1e-9) return true;
      if(Math.abs(+xf.rotXDeg||0)>1e-9||Math.abs(+xf.rotYDeg||0)>1e-9||Math.abs(+xf.rotZDeg||0)>1e-9) return true;
    }
    return typeof bodyFill==='function' && bodyFill(activeBodyId)==='skin';
  }catch(e){ return false; }
}
function homoSync(){
  const host=document.getElementById('inspHomo'); if(!host) return;
  const hide=host.dataset.has!=='1' || homoDesignChanged();
  if(host.hidden!==hide){ host.hidden=hide; if(typeof dockRefresh==='function') dockRefresh(); }
}
