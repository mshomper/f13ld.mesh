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
      const title=lbl.textContent.replace(/^\s*homogenization\s*[·.]?\s*/i,'').trim();
      if(body){ body.innerHTML=''; body.appendChild(row); }
      if(method) method.textContent=title;
      if(hr && hr.tagName==='HR') hr.remove();
      lbl.remove();
      found=true;
      break;
    }
  }
  if(!found && body){ body.innerHTML=''; if(method) method.textContent=''; }
  if(host) host.hidden=!found;
  if(typeof dockRefresh==='function') dockRefresh();
}
