/* ============================================================
   F13LD.mesh · 56-dock.js  (v0.12.0; UI refresh stage 2 layout)
   The footer under every section (estimate line, Export 3MF, export progress strip), the
   Export section's controls, and the inspector cards (Estimate, Measured, Homogenization).

   Stage 2: the Configure drawer and the dock tags are gone. Part prep and Export are
   sections of the control pane (index.html: #sec-prep holds #ppBox, #sec-export holds
   #expBody). The inspector stays on the right at 1280 px and wider; below that its cards
   move into Prep (Estimate) and Export (Measured, Homogenization) — dockPlaceInspector.

   Everything is built lazily by dockEnsure() — the first call comes after
   all scripts have loaded — so nothing here reads a later file at load time.
   Element ids kept for the app and the tests:
     Part prep section : #ppBox (53-part-prep.js ppInner)
     Export section    : #qDraft … #qUltra, #qlDraft …, #expDomainMm,
                         #expEstimate, #expFileName, #expCoresNote, #expMesher, #expLoose, #expChecks
     footer            : #expBtn, #dockMeta, progress strip #pgFill #pgStage #pgEta #pgCancel #expElapsed
     inspector cards   : #ppEst (Estimate), #expReport + #ppExact (Measured), homogenization block
   dockRefresh() re-reads state and repaints the estimate line, quality chips and export
   fields; it runs from updateExportEstimate (41) and ppSave (53).
   dockOpen / dockTab / dockClose stay as thin shims over F13UI.showSection (57-layout.js).
   ============================================================ */
'use strict';

const DK_STORE_KEY='f13ld.mesh.dock.v1';
const DK_IC={
  sliders:'<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  chev:'<path d="M6 9l6 6 6-6"/>',
  chevUp:'<path d="M6 15l6-6 6 6"/>',
  export:'<path d="M12 3v12M7 10l5 5 5-5M5 20h14"/>',
  plate:'<path d="M3 18h18"/><path d="M7 18v-3h10v3"/><path d="M9 15V8l3-3 3 3v7"/>',
  orient:'<path d="M12 20V5M7 10l5-5 5 5"/><path d="M5 20h14"/>',
  cube:'<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
  doc:'<path d="M6 3h7l5 5v13H6z"/><path d="M13 3v5h5"/><path d="M9 13h6M9 17h4"/>'
};
function dkIcon(name,size,cls){
  return '<svg width="'+(size||14)+'" height="'+(size||14)+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'+(cls?' class="'+cls+'"':'')+'>'+DK_IC[name]+'</svg>';
}
function _dkMesher(){ return (typeof exportMesherPref==='function')?exportMesherPref():'auto'; }
function _dkLoose(){ return (typeof exportLooseMode==='function')?exportLooseMode():'specks'; }
function _dkChecks(){ return (typeof exportChecksPref==='function')?exportChecksPref():'fast'; }
function _dkEl(id){ return document.getElementById(id); }
function _dkSet(id,t){ const e=_dkEl(id); if(e && e.textContent!==t) e.textContent=t; }

// ── Folded state of the inspector cards (per-viewer convenience) ───────────
const _dkFold=(function(){ let o={}; try{ o=JSON.parse(localStorage.getItem(DK_STORE_KEY)||'{}')||{}; }catch(_){ o={}; } return o; })();
function _dkSaveFold(){ try{ localStorage.setItem(DK_STORE_KEY, JSON.stringify(_dkFold)); }catch(_){} }
const DK_FOLD_DEFAULT={est:false, meas:false, homo:true};
function _dkFolded(k){ return (k in _dkFold)?!!_dkFold[k]:!!DK_FOLD_DEFAULT[k]; }
function dockFold(k, folded){
  const host=_dkEl({est:'inspEst', meas:'inspMeas', homo:'inspHomo'}[k]); if(!host) return;
  host.classList.toggle('collapsed', folded);
  const b=host.querySelector('[data-fold]'); if(b) b.setAttribute('aria-expanded', String(!folded));
  _dkFold[k]=!!folded; _dkSaveFold();
}

// ── Inspector placement ─────────────────────────────────────────────────────
// >= 1280 px: the cards sit in #inspector, right of the viewer. Below: Estimate goes
// under the Prep controls, Measured and Homogenization into Export's Results group.
// Only the three card hosts move (ids and contents unchanged).
const _dkWide=window.matchMedia?window.matchMedia('(min-width:1280px)'):null;
function dockPlaceInspector(){
  const insp=_dkEl('inspector'), est=_dkEl('inspEst'), meas=_dkEl('inspMeas'), homo=_dkEl('inspHomo');
  const hEst=_dkEl('resEst'), hOut=_dkEl('resOut');
  if(!insp||!est||!meas||!homo||!hEst||!hOut) return;
  const wide=!_dkWide||_dkWide.matches;
  if(wide){ for(const h of [est,meas,homo]) if(h.parentNode!==insp) insp.appendChild(h); }
  else{
    if(est.parentNode!==hEst) hEst.appendChild(est);
    if(meas.parentNode!==hOut) hOut.appendChild(meas);
    if(homo.parentNode!==hOut) hOut.appendChild(homo);
  }
  hEst.hidden=wide; hOut.hidden=wide;
}
if(_dkWide){ if(_dkWide.addEventListener) _dkWide.addEventListener('change',dockPlaceInspector); else _dkWide.addListener(dockPlaceInspector); }

// ── Build ───────────────────────────────────────────────────────────────────
let _dkBuilt=false;
function _icard(host, key, label, extra, bodyHtml){
  host.classList.add('ic');
  host.innerHTML='<div class="ic-h"><span class="ic-l">'+label+'</span>'+(extra||'')+
    '<button type="button" class="ic-fold" data-fold="'+key+'" aria-label="Fold or unfold" aria-expanded="true">'+dkIcon('chev',14,'ic-chev')+'</button></div>'+
    '<div class="ic-b">'+bodyHtml+'</div>';
  host.querySelector('[data-fold]').addEventListener('click',()=>dockFold(key, !host.classList.contains('collapsed')));
  host.querySelector('.ic-h').addEventListener('dblclick',()=>dockFold(key, !host.classList.contains('collapsed')));
}
function dockEnsure(){
  if(_dkBuilt) return true;
  const dock=_dkEl('dock'), expBody=_dkEl('expBody'), prog=_dkEl('progRow');
  if(!dock||!expBody) return false;
  _dkBuilt=true;
  // Footer: estimate line + Export 3MF (under every section). #w-run is the stage 3 mount for the progress button.
  dock.innerHTML=
    '<div class="dk-meta" id="dockMeta"></div>'+
    '<div id="w-run"></div>'+
    '<button type="button" id="expBtn" class="dk-run" onclick="triggerExport()">Export 3MF</button>';
  // Export section. Rows are .sc-group; w-* divs are the stage 3 widget mounts.
  expBody.innerHTML=
    '<h3 class="sub-h" style="margin-top:0">Mesh</h3>'+
    '<div class="dr-grid">'+
      '<div class="dr-f sc-group" id="grp-quality"><label>Quality</label><div id="w-quality"></div><div class="dr-chips" id="qualChips">'+
        ['draft','low','med','high','ultra'].map(q=>{ const N=q[0].toUpperCase()+q.slice(1); return '<button type="button" class="dr-chip" id="q'+N+'" onclick="setQual(\''+q+'\')"><span class="dr-ql-n">'+N+'</span><small class="ql" id="ql'+N+'">—</small></button>'; }).join('')+
      '</div><div class="dr-hint">Triangle edge length of the exported mesh.</div></div>'+
      '<div class="dr-f sc-group" id="grp-domain"><label for="expDomainMm">Domain size (open cube)</label><div id="w-domain"></div><div class="dr-pair"><input type="number" id="expDomainMm" class="dr-num" min="1" max="100" step="1" value="'+((typeof exportDomainMm!=='undefined')?exportDomainMm:10)+'" oninput="exportDomainMm=Math.max(1,Math.min(100,parseFloat(this.value)||10));updateExportEstimate()"><span>mm</span></div><div class="dr-hint" id="expDomainHint"></div></div>'+
      '<div class="dr-f sc-group" id="grp-mesher"><label for="expMesher">Mesher</label><div id="w-mesher"></div><select id="expMesher" class="dr-sel" onchange="setExportMesher(this.value)">'+
        [['auto','Auto'],['slab','Slab · every core'],['classic','Classic · Manifold']].map(o=>'<option value="'+o[0]+'"'+(_dkMesher()===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+
      '</select><div class="dr-hint">Auto meshes with Classic and switches to Slab when Classic runs out of memory or its mesh comes out torn. Slab splits the part into layers and meshes them on every core. Welds follow this setting too.</div></div>'+
      '<div class="dr-f sc-group" id="grp-loose"><label for="expLoose">Loose pieces</label><div id="w-loose"></div><select id="expLoose" class="dr-sel" onchange="setExportLoose(this.value)">'+
        [['specks','Remove specks'],['keep','Keep all'],['largest','Largest piece only']].map(o=>'<option value="'+o[0]+'"'+(_dkLoose()===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+
      '</select><div class="dr-hint">Specks are loose pieces under 10 mesh cells, left over from meshing. Woven or separate regions and sealed cavities are kept. Largest piece only keeps the biggest piece and the cavities inside it.</div></div>'+
      // v0.16.5: Simplify (60-export-ui.js exportChecksPref, "fast checks"); helper text in the hover tooltip
      '<div class="dr-f sc-group" id="grp-checks" title="While the slab mesher simplifies, it keeps checking that the mesh has not torn open. Fast (the default) does those checks a quicker way and gives the same mesh; on test parts simplify took about a fifth to a half less time. Standard is the older, slower way, kept for comparison. The classic mesher is not affected."><label for="expChecks">Simplify</label><div id="w-checks"></div><select id="expChecks" class="dr-sel" onchange="setExportChecks(this.value)">'+
        [['standard','Standard'],['fast','Fast']].map(o=>'<option value="'+o[0]+'"'+(_dkChecks()===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+
      '</select></div>'+
    '</div>'+
    '<h3 class="sub-h">File</h3>'+
    '<div class="dr-grid">'+
      '<div class="dr-f sc-group"><label>File name</label><div class="dr-file" id="expFileName"></div></div>'+
      '<div class="dr-f sc-group"><label>Cores</label><div class="dr-hint" id="expCoresNote"></div></div>'+
      '<div class="dr-f sc-group"><label>Estimate</label><div class="dr-est" id="expEstimate"></div></div>'+
    '</div>';
  // Progress strip (above the footer)
  if(prog){
    prog.innerHTML='<div class="pg-bar"><div class="pg-fill" id="pgFill"></div></div>'+
      '<span class="pg-st" id="pgStage"></span>'+
      '<span id="expElapsed" style="display:none"></span>'+
      '<span class="pg-eta" id="pgEta"></span>'+
      '<button type="button" class="pg-cancel" id="pgCancel">Cancel</button>';
    _dkEl('pgCancel').addEventListener('click',()=>{ if(typeof window.cancelMesh==='function') window.cancelMesh(); });
    const sub=_dkEl('coSub');
    if(sub && window.MutationObserver) new MutationObserver(()=>_dkStage()).observe(sub,{childList:true,characterData:true,subtree:true});
  }
  // Inspector cards
  const est=_dkEl('inspEst'), meas=_dkEl('inspMeas'), homo=_dkEl('inspHomo');
  if(est) _icard(est,'est','ESTIMATE <b>&middot; from preview</b>','','<div id="ppEst"></div>');
  if(meas) _icard(meas,'meas','MEASURED <b>&middot; last export</b>','','<div id="expReport"></div><div id="ppExact"></div>');
  if(homo){ _icard(homo,'homo','HOMOGENIZATION','<span class="ic-mini" id="homoMethod"></span>','<div id="homoBody"></div>'); homo.hidden=true; }
  for(const [k,id] of [['est','inspEst'],['meas','inspMeas'],['homo','inspHomo']]){ const h=_dkEl(id); if(h){ h.classList.toggle('collapsed',_dkFolded(k)); const b=h.querySelector('[data-fold]'); if(b) b.setAttribute('aria-expanded',String(!_dkFolded(k))); } }
  dockPlaceInspector();
  // Fill the panels that other modules render into
  if(typeof ppInner==='function') _dkEl('ppBox').innerHTML=ppInner();
  if(typeof ppEstimateHtml==='function') _dkEl('ppEst').innerHTML=ppEstimateHtml();
  if(typeof ppExactHtml==='function') _dkEl('ppExact').innerHTML=ppExactHtml();
  // An export error or fresh result lands in the Measured card: unfold it.
  const rep=_dkEl('expReport');
  if(rep && window.MutationObserver) new MutationObserver(()=>{
    if(!rep.firstChild) return;
    dockFold('meas', false);
    const er=rep.querySelector('.exp-err');
    if(er && typeof meshToast==='function') meshToast(String(er.textContent||'').replace(/^\W+/,'').slice(0,120));
  }).observe(rep,{childList:true});
  return true;
}

// ── Sections (the old Configure drawer) ─────────────────────────────────────
// Shims for callers of the drawer API: 'prep' and 'exp' map to the Prep and Export sections.
function dockTab(p){
  dockEnsure();
  if(window.F13UI && F13UI.showSection) F13UI.showSection(p==='exp'||p==='export'?'export':'prep');
}
function dockOpen(p){ dockTab(p||'prep'); }
function dockClose(){ if(window.F13UI && F13UI.showSection) F13UI.showSection('design'); }
function dockToggle(){ dockTab('prep'); }
window.dockOpen=dockOpen; window.dockClose=dockClose; window.dockTab=dockTab;

// ── Estimate line, quality chips, export fields ─────────────────────────────
function _dkNum(v){ v=+v||0; return String(Math.round(v*100)/100); }
function _dkEdgeStr(mm){ return (mm>=0.1?mm.toFixed(2):mm.toFixed(3))+' mm'; }
// Latest estimate, set by updateExportEstimate (41-quality-estimate.js).
let lastExportEstimate=null;   // {tris, sec, cores, text}
function dockSetEstimate(info){ lastExportEstimate=info||null; dockRefresh(); }
function _dkTris(n){ return n>=1e6?(n/1e6).toFixed(1)+' M':(n>=1e3?Math.round(n/1e3)+' k':String(n)); }
function dockRefresh(){
  if(!dockEnsure()) return;
  // Export quality chips
  const q=(typeof currentExportQual!=='undefined')?currentExportQual:'low';
  for(const k of ['draft','low','med','high','ultra']){ const b=_dkEl('q'+k[0].toUpperCase()+k.slice(1)); if(b){ b.classList.toggle('active',k===q); b.classList.toggle('on',k===q); b.setAttribute('aria-pressed',String(k===q)); } }
  // Domain size applies to the open cube only: hide the row while a bounding shape is loaded (F14)
  const hint=_dkEl('expDomainHint'); if(hint){ const t='Edge of the exported cube; one design cell.'; if(hint.textContent!==t) hint.textContent=t; }
  const dm=_dkEl('expDomainMm'); if(dm) dm.closest('.dr-f').classList.toggle('dr-off', !!(typeof importedShape!=='undefined'&&importedShape));
  // File name and cores
  if(typeof exportFileNamePreview==='function') _dkSet('expFileName', exportFileNamePreview());
  const hc=navigator.hardwareConcurrency||2, use=Math.min(15,Math.max(1,hc-1));
  _dkSet('expCoresNote', 'The field bake runs on '+use+' of your '+hc+' cores (all but one, at most 15). Meshing and simplify use one.');
  // Footer estimate line
  const meta=_dkEl('dockMeta');
  if(meta){
    const e=lastExportEstimate;
    meta.innerHTML=e?('<span>~<b>'+_dkTris(e.tris)+'</b> tris</span><i></i><span>~<b>'+e.sec+' s</b></span><i></i><span>'+e.cores+' core'+(e.cores===1?'':'s')+'</span>'):'';
    meta.title=e?e.text:'';
  }
}
window.dockRefresh=dockRefresh;

// ── Export progress strip ───────────────────────────────────────────────────
let _dkExport=null;   // {t0, estSec, timer}
function _dkStage(){
  if(!_dkExport) return;
  const sub=_dkEl('coSub'), main=_dkEl('coMain');
  const txt=String((sub&&sub.textContent)||(main&&main.textContent)||'working').trim();
  const st=_dkEl('pgStage'); if(!st) return;
  const cut=/\s[—·(]|:\s|\.\.\./.exec(txt);
  st.innerHTML='';
  if(cut){ const b=document.createElement('b'); b.textContent=txt.slice(0,cut.index); st.appendChild(b); st.appendChild(document.createTextNode(txt.slice(cut.index))); }
  else { const b=document.createElement('b'); b.textContent=txt; st.appendChild(b); }
  st.title=txt;
  const m=/(\d{1,3})\s?%/.exec(txt);
  _dkExport.pct=m?Math.min(100,+m[1]):null;
}
function _dkTick(){
  if(!_dkExport) return;
  const el=(performance.now()-_dkExport.t0)/1000, est=_dkExport.estSec;
  let f=(_dkExport.pct!=null)?_dkExport.pct/100:(est>0?Math.min(0.95,el/est):0.3);
  const fill=_dkEl('pgFill'); if(fill) fill.style.width=(Math.max(0.02,f)*100).toFixed(1)+'%';
  const eta=_dkEl('pgEta'); if(eta) eta.textContent=est>0?(el<est?'~'+Math.ceil(est-el)+' s left':'longer than estimated'):'';
}
// Called by triggerExport (61-export.js) when an export starts and when it ends.
function dockExportState(on){
  if(!dockEnsure()) return;
  const prog=_dkEl('progRow');
  if(on){
    const e=lastExportEstimate;
    if(_dkExport&&_dkExport.timer) clearInterval(_dkExport.timer);
    _dkExport={t0:performance.now(), estSec:e?e.sec:0, pct:null, timer:setInterval(_dkTick,250)};
    prog.classList.add('on'); _dkStage(); _dkTick();
  } else {
    if(_dkExport&&_dkExport.timer) clearInterval(_dkExport.timer);
    _dkExport=null;
    prog.classList.remove('on');
    const fill=_dkEl('pgFill'); if(fill) fill.style.width='0';
    const ee=_dkEl('expElapsed'); if(ee) ee.style.display='none';
  }
}
window.dockExportState=dockExportState;

document.addEventListener('DOMContentLoaded',()=>{ dockRefresh(); });
