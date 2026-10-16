/* ============================================================
   F13LD.mesh · 56-dock.js  (v0.12.0)
   The dock (Configure, summary tags, estimate, Export 3MF), the Configure
   drawer (Part prep | Export tabs), the export progress strip and the right
   inspector cards (Estimate, Measured, Homogenization).

   Everything is built lazily by dockEnsure() — the first call comes after
   all scripts have loaded — so nothing here reads a later file at load time.
   The old sidebar panel is gone; its controls keep their element ids:
     drawer, Part prep tab : #ppBox (53-part-prep.js ppInner)
     drawer, Export tab    : #qDraft … #qUltra, #qlDraft …, #expDomainMm,
                             #expEstimate, #expFileName, #expCoresNote
     dock                  : #expBtn, #dockMeta
     progress strip        : #expElapsed, #pgStage, #pgCancel
     inspector             : #ppEst (Estimate), #expReport + #ppExact
                             (Measured), homogenization block (Homogenization)
   dockRefresh() re-reads state and repaints the tags, tab hints and estimate;
   it runs from updateExportEstimate (41) and ppSave (53).
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
  const dock=_dkEl('dock'), drawer=_dkEl('drawer'), prog=_dkEl('progRow');
  if(!dock||!drawer) return false;
  _dkBuilt=true;
  // Dock
  dock.innerHTML=
    '<button type="button" id="cfgBtn" class="dk-cfg" aria-expanded="false" aria-controls="drawer">'+dkIcon('sliders',15)+'<span class="dk-cfg-t">Configure</span>'+dkIcon('chevUp',14,'dk-chev')+'</button>'+
    '<div class="dk-tags" id="dkTags">'+
      '<button type="button" class="dk-tag" data-p="prep" title="Process and material"><span class="dk-ti">'+dkIcon('plate')+'</span><b id="dkProc"></b><span id="dkMat"></span></button>'+
      '<button type="button" class="dk-tag" data-p="prep" title="Build orientation"><span class="dk-ti">'+dkIcon('orient')+'</span><b id="dkOri"></b><span id="dkTilt"></span></button>'+
      '<button type="button" class="dk-tag dk-static" id="dkTagPart" title="Active part"><span class="dk-ti">'+dkIcon('cube')+'</span><b id="dkPart"></b><span id="dkFill"></span></button>'+
      '<button type="button" class="dk-tag" data-p="exp" title="Export quality"><span class="dk-ti">'+dkIcon('export')+'</span><b id="dkQual"></b><span id="dkEdge"></span></button>'+
    '</div>'+
    '<div class="dk-meta" id="dockMeta"></div>'+
    '<button type="button" id="expBtn" class="dk-run" onclick="triggerExport()">Export 3MF</button>';
  // Drawer
  drawer.setAttribute('role','dialog'); drawer.setAttribute('aria-label','Configure');
  drawer.innerHTML=
    '<div class="dr-tabs" id="drTabs" role="tablist">'+
      '<button type="button" class="dr-tab on" data-p="prep" role="tab" aria-selected="true">'+dkIcon('plate')+'<span class="dr-nm">Part prep</span><span class="dr-mv" id="drMvPrep"></span></button>'+
      '<button type="button" class="dr-tab" data-p="exp" role="tab" aria-selected="false">'+dkIcon('export')+'<span class="dr-nm">Export</span><span class="dr-mv" id="drMvExp"></span></button>'+
    '</div>'+
    '<div class="dr-panes">'+
      '<section class="dr-pane on" id="drPrep" data-p="prep">'+
        '<div class="dr-ph"><div class="dr-pt">Part prep</div><div class="dr-ps">Process, material and how the part sits on the plate. Drives the estimate, the Print view and the measured numbers.</div></div>'+
        '<div id="ppBox"></div>'+
      '</section>'+
      '<section class="dr-pane" id="drExp" data-p="exp">'+
        '<div class="dr-ph"><div class="dr-pt">Export</div><div class="dr-ps">Mesh quality and size of the 3MF. The estimate learns from your own exports.</div></div>'+
        '<div class="dr-grid">'+
          '<div class="dr-f"><label>Quality</label><div class="dr-chips" id="qualChips">'+
            ['draft','low','med','high','ultra'].map(q=>{ const N=q[0].toUpperCase()+q.slice(1); return '<button type="button" class="dr-chip" id="q'+N+'" onclick="setQual(\''+q+'\')"><span class="dr-ql-n">'+N+'</span><small class="ql" id="ql'+N+'">—</small></button>'; }).join('')+
          '</div><div class="dr-hint">Triangle edge length of the exported mesh.</div></div>'+
          '<div class="dr-f"><label for="expDomainMm">Domain size (open cube)</label><div class="dr-pair"><input type="number" id="expDomainMm" class="dr-num" min="1" max="100" step="1" value="'+((typeof exportDomainMm!=='undefined')?exportDomainMm:10)+'" oninput="exportDomainMm=Math.max(1,Math.min(100,parseFloat(this.value)||10));updateExportEstimate()"><span>mm</span></div><div class="dr-hint" id="expDomainHint"></div></div>'+
          '<div class="dr-f"><label>File name</label><div class="dr-file" id="expFileName"></div></div>'+
          '<div class="dr-f"><label>Cores</label><div class="dr-hint" id="expCoresNote"></div></div>'+
          '<div class="dr-f dr-wide"><label>Estimate</label><div class="dr-est" id="expEstimate"></div></div>'+
        '</div>'+
      '</section>'+
    '</div>';
  // Progress strip
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
  // Fill the panels that other modules render into
  if(typeof ppInner==='function') _dkEl('ppBox').innerHTML=ppInner();
  if(typeof ppEstimateHtml==='function') _dkEl('ppEst').innerHTML=ppEstimateHtml();
  if(typeof ppExactHtml==='function') _dkEl('ppExact').innerHTML=ppExactHtml();
  // Events
  _dkEl('cfgBtn').addEventListener('click',()=>dockToggle());
  for(const t of dock.querySelectorAll('.dk-tag[data-p]')) t.addEventListener('click',()=>dockOpen(t.dataset.p));
  for(const t of drawer.querySelectorAll('.dr-tab')) t.addEventListener('click',()=>dockTab(t.dataset.p));
  document.addEventListener('keydown',e=>{ if(e.key==='Escape' && drawer.classList.contains('open')) dockClose(); });
  // An export error or fresh result lands in the Measured card: show it.
  const rep=_dkEl('expReport');
  if(rep && window.MutationObserver) new MutationObserver(()=>{
    if(!rep.firstChild) return;
    dockFold('meas', false);
    const er=rep.querySelector('.exp-err');
    if(er && typeof meshToast==='function') meshToast(String(er.textContent||'').replace(/^\W+/,'').slice(0,120));
  }).observe(rep,{childList:true});
  return true;
}

// ── Drawer ──────────────────────────────────────────────────────────────────
function dockTab(p){
  if(!dockEnsure()) return;
  const d=_dkEl('drawer');
  for(const t of d.querySelectorAll('.dr-tab')){ const on=t.dataset.p===p; t.classList.toggle('on',on); t.setAttribute('aria-selected',String(on)); }
  for(const s of d.querySelectorAll('.dr-pane')) s.classList.toggle('on', s.dataset.p===p);
}
function dockOpen(p){
  if(!dockEnsure()) return;
  _dkEl('drawer').classList.add('open'); _dkEl('cfgBtn').classList.add('open'); _dkEl('cfgBtn').setAttribute('aria-expanded','true');
  if(p) dockTab(p);
}
function dockClose(){
  const d=_dkEl('drawer'); if(!d) return;
  d.classList.remove('open'); const b=_dkEl('cfgBtn'); if(b){ b.classList.remove('open'); b.setAttribute('aria-expanded','false'); }
}
function dockToggle(){ const d=_dkEl('drawer'); if(d && d.classList.contains('open')) dockClose(); else dockOpen(); }
window.dockOpen=dockOpen; window.dockClose=dockClose; window.dockTab=dockTab;

// ── Tags, tab hints, estimate ───────────────────────────────────────────────
function _dkNum(v){ v=+v||0; return String(Math.round(v*100)/100); }
function _dkProcShort(p){
  const m=/\(([^)]+)\)/.exec(p.name);
  return m?m[1].split(' ')[0]:p.name.split(' ')[0];
}
function _dkEdgeStr(mm){ return (mm>=0.1?mm.toFixed(2):mm.toFixed(3))+' mm'; }
// The part tag: the active body (name + what fills it), or the open cube.
function _dkPart(){
  try{
    const wg=(typeof activeGroupId==='function')?activeGroupId():null;
    if(activeBodyId!==null && bodies.has(activeBodyId)){
      const b=bodies.get(activeBodyId);
      const name=String((b.meta&&b.meta.name)||'shape').replace(/\.[^.]+$/,'');
      if(wg && groupMembers(wg).length>=2) return {name, fill:'weld '+weldGroupLetter(wg)+' · '+groupMembers(wg).length+' bodies'};
      const rid=assignments.get(activeBodyId);
      if(isSolidAssignment(rid)||!recipes.has(rid)) return {name, fill:'solid'};
      const r=recipes.get(rid);
      const cell=parseFloat(document.getElementById('shapeCellSizeMm')?.value)||b.cellSizeMm||3;
      return {name, fill:String(r.subtype||r.family||'lattice').toLowerCase()+' · '+_dkNum(cell)+' mm'+(b.fill==='skin'?' · skin':'')};
    }
    if(currentRecipe){
      const r=currentRecipe;
      return {name:(FAMILY_LABEL[r.family]||r.family).toLowerCase(), fill:(r.subtype?String(r.subtype).toLowerCase()+' · ':'')+'open cube'};
    }
  }catch(_){}
  return {name:'no part', fill:''};
}
// Latest estimate, set by updateExportEstimate (41-quality-estimate.js).
let lastExportEstimate=null;   // {tris, sec, cores, text}
function dockSetEstimate(info){ lastExportEstimate=info||null; dockRefresh(); }
function _dkTris(n){ return n>=1e6?(n/1e6).toFixed(1)+' M':(n>=1e3?Math.round(n/1e3)+' k':String(n)); }
function dockRefresh(){
  if(!dockEnsure()) return;
  // Part prep tags
  const p=ppProcess(partPrep.proc), m=ppMaterial();
  _dkSet('dkProc', _dkProcShort(p));
  _dkSet('dkMat', (m && m.pp===partPrep.proc)?m.name.replace(/\s*\([^)]*\)/g,'').trim():('custom '+_dkNum(partPrep.customRho)+' g/cm³'));
  _dkSet('dkOri', partPrep.up);
  _dkSet('dkTilt', _dkNum(partPrep.tiltX)+'° · '+_dkNum(partPrep.tiltY)+'°');
  _dkSet('drMvPrep', _dkProcShort(p));
  // Part tag
  const pt=_dkPart(); _dkSet('dkPart', pt.name); _dkSet('dkFill', pt.fill);
  // Export tag, quality chips
  const q=(typeof currentExportQual!=='undefined')?currentExportQual:'low';
  const Q=q[0].toUpperCase()+q.slice(1);
  const edge=(typeof exportEdgeMm==='function')?exportEdgeMm(q):null;
  const dom=(typeof importedShape!=='undefined'&&importedShape)?'shape':((typeof exportDomainMm!=='undefined'?exportDomainMm:10)+' mm');
  _dkSet('dkQual', Q); _dkSet('dkEdge', (edge?_dkEdgeStr(edge)+' · ':'')+dom); _dkSet('drMvExp', Q);
  for(const k of ['draft','low','med','high','ultra']){ const b=_dkEl('q'+k[0].toUpperCase()+k.slice(1)); if(b){ b.classList.toggle('active',k===q); b.classList.toggle('on',k===q); b.setAttribute('aria-pressed',String(k===q)); } }
  const hint=_dkEl('expDomainHint'); if(hint){ const t=(typeof importedShape!=='undefined'&&importedShape)?'Not used while a bounding shape is loaded.':'Edge of the exported cube; one design cell.'; if(hint.textContent!==t) hint.textContent=t; }
  const dm=_dkEl('expDomainMm'); if(dm) dm.closest('.dr-f').classList.toggle('dr-off', !!(typeof importedShape!=='undefined'&&importedShape));
  // File name and cores
  if(typeof exportFileNamePreview==='function') _dkSet('expFileName', exportFileNamePreview());
  const hc=navigator.hardwareConcurrency||2, use=Math.min(15,Math.max(1,hc-1));
  _dkSet('expCoresNote', 'The field bake runs on '+use+' of your '+hc+' cores (all but one, at most 15). Meshing and simplify use one.');
  // Dock estimate
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
  const cut=/\s[—·]\s|:\s/.exec(txt);
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
    dockClose();
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
