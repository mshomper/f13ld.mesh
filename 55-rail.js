/* ============================================================
   F13LD.mesh · 55-rail.js — v0.12.0
   The left rail: recipe cards, parts list (weld cards + loose parts) and the
   part / weld editor. Renders into #railRecipes, #railParts and #railEditor;
   styles in rail.css.

   State lives elsewhere (10-state.js bodies / assignments / weldGroups,
   31-body-cards.js fill + weld operations); the rail only draws it and turns
   taps, drags and slider moves into those operations. The selected part is
   always the ACTIVE body, the selected weld is a weld the active body belongs
   to, so Export keeps writing "the active body / the active weld group".
   Structure sliders drive the hidden legacy inputs through the handlers in
   45-structure-handlers.js (railSetCellMm / railSetXform / railSetTrim).
   ============================================================ */
'use strict';

// ── Drawn icons (no glyph characters anywhere in the rail) ────────────────
const RL_ICONS={
  file:'<path d="M6 3h7l5 5v13H6z"/><path d="M13 3v5h5"/>',
  part:'<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
  link:'<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  weld:'<circle cx="9" cy="12" r="5"/><circle cx="15" cy="12" r="5"/>',
  unlink:'<path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M10 6H5.5A1.5 1.5 0 0 0 4 7.5v11A1.5 1.5 0 0 0 5.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14"/>',
  eye:'<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>',
  ghost:'<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" stroke-dasharray="2.6 2.4"/><circle cx="12" cy="12" r="2.5" stroke-dasharray="1.6 1.6"/>',
  eyeOff:'<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" opacity=".45"/><path d="M4 20 20 4"/>',
  chev:'<path d="M6 9l6 6 6-6"/>',
  check:'<path d="M5 12.5l4.5 4.5L19 7"/>',
  x:'<path d="M6 6l12 12M18 6 6 18"/>',
  split:'<path d="M12 3v18"/><path d="M8 7 4 12l4 5M16 7l4 5-4 5"/>',
  reset:'<circle cx="12" cy="12" r="8"/><path d="M6.3 6.3l11.4 11.4"/>',
  undo:'<path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 4v4h4"/>',
  trash:'<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>'
};
function rlIc(n, sz, cls){
  sz=sz||14;
  return '<svg class="rl-ic'+(cls?' '+cls:'')+'" width="'+sz+'" height="'+sz+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(RL_ICONS[n]||'')+'</svg>';
}

// ── Rail state ────────────────────────────────────────────────────────────
let railSelWeld=null;                    // gid of the selected weld, or null (a part is selected)
let railTick=false;                      // tick mode: entered by a long-press on a row
const railTicked=new Set();              // ticked rows: body id, or 'w:'+gid for a weld
const railFold={rec:false, parts:false}; // card folds
const railFoldedWelds=new Set();         // folded weld cards
let railDrag=null;                       // {kind:'part'|'recipe', id}
const RL_LONGPRESS_MS=450;
const RL_CELL_MIN_MM=0.05;               // cell size floor (number box has no upper bound)

const $rl=id=>document.getElementById(id);
function rlShort(n){ return String(n||'shape').replace(/\.(stl|obj|3mf|step|stp|iges|igs)$/i,''); }
function rlName(id){ const b=bodies.get(id); return rlShort(b&&b.meta&&b.meta.name); }
function rlRecipeLabel(r){ return (FAMILY_LABEL[r.family]||r.family)+' · '+String(r.subtype||''); }
function rlNum(v){ return String(Math.round((+v||0)*1000)/1000); }
const _rlDeb={};
function rlDeb(key, fn, ms){ clearTimeout(_rlDeb[key]); _rlDeb[key]=setTimeout(()=>{ delete _rlDeb[key]; fn(); }, ms); }

// Selection --------------------------------------------------------------
function railNormalize(){
  if(railSelWeld && !(weldGroups.has(railSelWeld) && activeBodyId && bodyGroup.get(activeBodyId)===railSelWeld)) railSelWeld=null;
  for(const k of [...railTicked]){
    const ok=k.indexOf('w:')===0 ? weldGroups.has(k.slice(2)) : bodies.has(k);
    if(!ok) railTicked.delete(k);
  }
  if(railTick && !railTicked.size) railTick=false;
}
function railSel(){
  if(railSelWeld) return {t:'weld', id:railSelWeld};
  if(activeBodyId!=null && bodies.has(activeBodyId)) return {t:'part', id:activeBodyId};
  return null;
}
function railSelectPart(id){
  if(!bodies.has(id)) return;
  railSelWeld=null;
  if(id!==activeBodyId) switchActiveBody(id); else renderRail();
}
function railSelectWeld(gid){
  if(!weldGroups.has(gid)) return;
  railSelWeld=gid;
  const mem=groupMembers(gid);
  if(mem.length && !mem.includes(activeBodyId)) switchActiveBody(mem[0]); else renderRail();
}
// Debounced preview rebuild for sliders that only change stored settings
// (skin, join rule …). Cheap sliders (cell size, rotation) go through the
// legacy handlers, which rebake by themselves.
let _rlPrevT=0;
// v0.14.0: fill, skin, fillet, join rule, anchor and grade are live in the
// scene shader — redraw next frame, no bake.
function railPreviewSoon(){
  clearTimeout(_rlPrevT);
  if(typeof previewSceneChanged==='function') previewSceneChanged();
}

// ── Recipes card ──────────────────────────────────────────────────────────
const _rlRecInfo=new Map();
// {kv:[[label,value]…], sub:'one-line summary'} from the family's own summary.
function rlRecipeInfo(rid){
  if(_rlRecInfo.has(rid)) return _rlRecInfo.get(rid);
  const r=recipes.get(rid), kv=[];
  try{
    const html=renderSummary(r)||'';
    const tmp=document.createElement('div'); tmp.innerHTML=html;
    for(const mc of tmp.querySelectorAll('.meta-grid .mc')){
      const l=mc.querySelector('.mc-lbl'), v=mc.querySelector('.mc-val');
      const tv=v?v.textContent.trim():'';
      if(!l || !tv) continue;
      kv.push([l.textContent.trim(), tv]);
    }
  }catch(e){ /* a family without a summary: popover shows the title only */ }
  const sub=kv.filter(p=>!/^—/.test(p[1])).slice(0,3)
    .map(p=>/^[-+.\d]/.test(p[1]) ? p[0]+' '+p[1] : p[1]).join(' · ');
  const info={kv, sub};
  _rlRecInfo.set(rid, info);
  return info;
}

function renderRailRecipes(){
  const host=$rl('railRecipes'); if(!host) return;
  const cards=[];
  for(const rid of recipeOrder){
    const r=recipes.get(rid); if(!r) continue;
    const col=familyColor(r.family), info=rlRecipeInfo(rid), use=getRecipeUsageCount(rid);
    cards.push('<div class="rl-rc'+(rid===activeRecipeId?' on':'')+(rlPopFor===rid?' open':'')+'" data-recipe-id="'+esc(rid)+'" draggable="true" tabindex="0" role="button" aria-haspopup="true" style="--fc:'+col+'">'+
      '<span class="rl-rsw"></span>'+
      '<div class="rl-rm"><div class="rl-tt">'+esc(rlRecipeLabel(r))+'</div><div class="rl-st">'+esc(info.sub||r.filename||'')+'</div></div>'+
      (use?'<span class="rl-use" title="Used by '+use+' part'+(use>1?'s':'')+'">'+use+'×</span>':'')+
      '<button type="button" class="rl-ibtn rl-rx" data-act="rmRecipe" title="Remove this recipe" aria-label="Remove recipe">'+rlIc('x',12)+'</button>'+
    '</div>');
  }
  const atCap=!canAddRecipe();
  cards.push('<button type="button" class="rl-add'+(atCap?' disabled':'')+'" data-act="addRecipe" title="'+(atCap?'Recipe limit reached':'Open a recipe JSON file')+'">'+rlIc('file',15)+(atCap?'Recipe limit reached':'Add recipe · JSON')+'</button>');
  host.innerHTML='<div class="rl-card'+(railFold.rec?' collapsed':'')+'">'+
    '<div class="rl-ch"><span class="rl-lbl">RECIPES</span><span class="rl-cnt">'+recipes.size+' / '+MAX_RECIPES+'</span>'+
    '<div class="rl-r"><button type="button" class="rl-ibtn rl-fold" data-act="foldCard" data-card="rec" title="'+(railFold.rec?'Unfold':'Fold')+'" aria-label="Fold recipes">'+rlIc('chev')+'</button></div></div>'+
    '<div class="rl-cb">'+cards.join('')+'</div></div>';
}

// Details popover (hover on mouse, tap on touch) ---------------------------
let rlPopFor=null, rlPopMode=null, rlPopT=0;
function rlPopEl(){
  let el=$rl('rlPop');
  if(!el){
    el=document.createElement('div'); el.id='rlPop'; el.hidden=true; el.setAttribute('role','dialog');
    document.body.appendChild(el);
    el.addEventListener('mouseenter',()=>clearTimeout(rlPopT));
    el.addEventListener('mouseleave',()=>{ if(rlPopMode==='hover') rlPopHide(); });
    el.addEventListener('click',e=>{
      const b=e.target.closest('[data-act]'); if(!b) return;
      const rid=rlPopFor;
      if(b.dataset.act==='useRecipe' && rid){
        rlPopHide();
        if(activeBodyId!=null){ railSelWeld=null; assignRecipeToBody(activeBodyId, rid); }
        else{ activeRecipeId=rid; syncCurrentRecipeFromActiveBody(); if(currentRecipe) reloadActiveRecipeIntoPreview(); renderRail(); }
      }
    });
  }
  return el;
}
function rlPopShow(card, mode){
  const rid=card.dataset.recipeId, r=recipes.get(rid); if(!r) return;
  clearTimeout(rlPopT);
  const el=rlPopEl(), col=familyColor(r.family), info=rlRecipeInfo(rid);
  const target=activeBodyId!=null ? rlName(activeBodyId) : null;
  el.style.borderColor=col;
  el.innerHTML='<div class="rl-pop-t" style="color:'+col+'">'+esc(rlRecipeLabel(r).toUpperCase())+'</div>'+
    (info.kv.length?'<div class="rl-kv">'+info.kv.map(p=>'<span>'+esc(p[0])+'</span><span>'+esc(p[1])+'</span>').join('')+'</div>':'<div class="rl-note">No further settings to show.</div>')+
    '<button type="button" class="rl-sbtn prim rl-pop-use" data-act="useRecipe">'+(target?'Use on '+esc(target):'Preview this recipe')+'</button>';
  el.hidden=false; el.style.visibility='hidden';
  const cr=card.getBoundingClientRect(), vw=window.innerWidth, vh=window.innerHeight;
  const rail=$rl('rail'), rr=(rail||card).getBoundingClientRect();
  let left, top, w;
  if(vw>860){
    w=Math.min(280, vw-16); el.style.width=w+'px';
    left=rr.right+8; top=cr.top;
    if(left+w>vw-8) left=Math.max(8, vw-w-8);
  }else{
    w=vw-16; el.style.width=w+'px'; left=8; top=cr.bottom+6;
  }
  const h=el.offsetHeight;
  if(top+h>vh-8) top=(vw>860)?Math.max(8, vh-h-8):Math.max(8, cr.top-h-6);
  el.style.left=left+'px'; el.style.top=top+'px'; el.style.visibility='';
  rlPopFor=rid; rlPopMode=mode;
  for(const c of document.querySelectorAll('.rl-rc')) c.classList.toggle('open', c.dataset.recipeId===rid);
}
function rlPopHide(){
  clearTimeout(rlPopT);
  const el=$rl('rlPop'); if(el) el.hidden=true;
  rlPopFor=null; rlPopMode=null;
  for(const c of document.querySelectorAll('.rl-rc.open')) c.classList.remove('open');
}

// ── Parts card ────────────────────────────────────────────────────────────
function rlFillText(id){
  const f=bodyFill(id);
  if(f==='solid') return 'solid';
  const r=recipes.get(assignments.get(id)); if(!r) return 'unassigned';
  const b=bodies.get(id), cell=b&&b.cellSizeMm!=null?b.cellSizeMm:3;
  return String(r.subtype||FAMILY_LABEL[r.family]||r.family).toLowerCase()+' · '+rlNum(cell)+' mm'+(f==='skin'?' · skin':'');
}
function rlVisInfo(vis){
  if(vis===VIS_HIDDEN) return {icon:'eyeOff', title:'Hidden · click to show it solid'};
  if(vis===VIS_GHOST)  return {icon:'ghost',  title:'Ghost (translucent) · click to hide it'};
  return {icon:'eye', title:'Solid · click to make it a ghost'};
}
// One state for a whole weld: the members' common visibility, or null when they differ.
function rlGroupVis(gid){
  const vs=groupMembers(gid).map(id=>{ const b=bodies.get(id); return (b&&b.visibility)||VIS_DEFAULT; });
  return vs.length && vs.every(v=>v===vs[0]) ? vs[0] : null;
}
function rlPartRow(id, gid, sel){
  const b=bodies.get(id); if(!b) return '';
  const on=sel&&sel.t==='part'&&sel.id===id, tk=railTicked.has(id);
  const vis=rlVisInfo(b.visibility||VIS_DEFAULT);
  // v0.13.0: every eye works, the selected part's included.
  const mutedVis='';
  const hid=(b.visibility||VIS_DEFAULT)===VIS_HIDDEN;
  return '<div class="rl-part'+(on?' on':'')+(gid?' member':'')+(tk?' tk':'')+(hid?' hid':'')+'" data-body-id="'+esc(id)+'" draggable="true" tabindex="0" role="button" aria-pressed="'+(on?'true':'false')+'">'+
    '<button type="button" class="rl-ck'+(tk?' on':'')+'" data-act="tick" title="Tick" aria-label="Tick '+esc(rlName(id))+'">'+(tk?rlIc('check',11):'')+'</button>'+
    '<span class="rl-fsw" style="background:'+esc(resolveBodyColor(id))+'"></span>'+
    '<div class="rl-pm"><div class="rl-nm">'+esc(rlName(id))+'</div><div class="rl-as">'+esc(rlFillText(id))+(gid&&hid?' · not exported':'')+'</div></div>'+
    '<div class="rl-prb">'+
      (gid?'<button type="button" class="rl-ibtn" data-act="leave" title="Take out of Weld '+weldGroupLetter(gid)+'" aria-label="Take out of weld">'+rlIc('unlink')+'</button>':'')+
      '<button type="button" class="rl-ibtn'+mutedVis+'" data-act="vis" title="'+vis.title+'" aria-label="Visibility">'+rlIc(vis.icon)+'</button>'+
    '</div></div>';
}
function rlWeldCard(gid, sel){
  const g=weldGroups.get(gid), mem=groupMembers(gid);
  const on=sel&&sel.t==='weld'&&sel.id===gid, tk=railTicked.has('w:'+gid), folded=railFoldedWelds.has(gid);
  const rule=weldGroupRule(gid);
  const gv=rlGroupVis(gid), nHid=mem.filter(id=>(bodies.get(id).visibility||VIS_DEFAULT)===VIS_HIDDEN).length;
  const gvi=gv?rlVisInfo(gv):{icon:'eye', title:'Parts differ · click to show them all solid'};
  const gvTitle=gvi.title.replace(/ it /g,' the weld ').replace(/it$/,'the weld');
  return '<div class="rl-wgrp'+(on?' on':'')+(folded?' folded':'')+(tk?' tk':'')+'" data-gid="'+esc(gid)+'">'+
    '<div class="rl-whead" data-gid="'+esc(gid)+'" tabindex="0" role="button" aria-pressed="'+(on?'true':'false')+'">'+
      '<button type="button" class="rl-fold" data-act="foldWeld" title="'+(folded?'Unfold':'Fold')+'" aria-label="Fold weld">'+rlIc('chev')+'</button>'+
      '<span class="rl-wtile">'+rlIc('link',14)+'<i style="background:'+weldGroupColor(gid)+'"></i></span>'+
      '<div class="rl-wm"><div class="rl-wname">Weld '+weldGroupLetter(gid)+'</div><div class="rl-wsub">'+mem.length+' parts · fillet '+rlNum(g.filletMm)+' mm · '+rule+(nHid?' · '+nHid+' hidden':'')+'</div></div>'+
      '<div class="rl-prb">'+
        '<button type="button" class="rl-ibtn'+(gv?'':' rl-muted')+'" data-act="vis" title="'+esc(gvTitle)+'" aria-label="Weld visibility">'+rlIc(gvi.icon)+'</button>'+
        '<button type="button" class="rl-ck'+(tk?' on':'')+'" data-act="tick" title="Tick" aria-label="Tick Weld '+weldGroupLetter(gid)+'">'+(tk?rlIc('check',11):'')+'</button>'+
      '</div>'+
    '</div>'+
    '<div class="rl-wbody">'+mem.map(id=>rlPartRow(id, gid, sel)).join('')+'</div></div>';
}

let _rlDeferred=false;
function renderRailParts(){
  const host=$rl('railParts'); if(!host) return;
  if(railDrag){ _rlDeferred=true; return; }          // never rebuild the rows under a drag in flight
  const sel=railSel();
  let h='';
  if(railTick){
    const n=railTicked.size, ws=[...railTicked].filter(k=>k.indexOf('w:')===0).length;
    h+='<div class="rl-selbar"><span class="rl-sp">'+n+' ticked'+(ws?' · '+ws+' weld'+(ws>1?'s':''):'')+'</span>'+
      '<button type="button" class="rl-sbtn prim" data-act="weldSel"'+(n<2?' disabled title="Tick at least two"':'')+'>'+rlIc('weld')+'Weld</button>'+
      '<button type="button" class="rl-sbtn" data-act="clrSel">Clear</button></div>';
  }
  const gids=[], loose=[];
  for(const id of bodyOrder){
    if(!bodies.has(id)) continue;
    const g=bodyGroup.get(id);
    if(g && weldGroups.has(g)){ if(!gids.includes(g)) gids.push(g); } else loose.push(id);
  }
  h+=gids.map(g=>rlWeldCard(g, sel)).join('');
  h+='<div class="rl-outzone" data-hint="take out">'+rlIc('unlink')+'Drop here to take it out of its weld</div>';
  h+=loose.map(id=>rlPartRow(id, null, sel)).join('');
  if(_pendingImport){
    const err=_pendingImport.state==='err';
    h+='<div class="rl-pending'+(err?' err':'')+'"><span class="rl-spin"></span>'+
      '<div class="rl-pm"><div class="rl-nm">'+esc(rlShort(_pendingImport.name))+'</div><div class="rl-as">'+esc(err?(_pendingImport.errMsg||'import failed'):'loading…')+'</div></div>'+
      (err?'<button type="button" class="rl-ibtn" data-act="dismissErr" title="Dismiss" aria-label="Dismiss">'+rlIc('x',12)+'</button>':'')+'</div>';
  }
  const atCap=!canAddBody();
  h+='<button type="button" class="rl-add rl-dz'+(atCap?' disabled':'')+'" data-act="addPart" title="'+(atCap?'Part limit reached':'Drop a part file or click to browse')+'">'+rlIc('part',15)+
     (atCap?'Part limit reached ('+MAX_BODIES+')':'Drop a part · STL OBJ 3MF STEP')+'</button>';
  if(bodies.size){
    h+='<p class="rl-note">Drag a recipe onto a part to fill it. Drag a part onto another part or a weld to join. Press and hold a row to tick several.</p>';
  }
  host.innerHTML='<div class="rl-card'+(railFold.parts?' collapsed':'')+(railTick?' ticking':'')+'" id="rlPartCard">'+
    '<div class="rl-ch"><span class="rl-lbl">PARTS</span><span class="rl-cnt">'+bodies.size+' / '+MAX_BODIES+'</span>'+
    '<div class="rl-r"><button type="button" class="rl-ibtn rl-fold" data-act="foldCard" data-card="parts" title="'+(railFold.parts?'Unfold':'Fold')+'" aria-label="Fold parts">'+rlIc('chev')+'</button></div></div>'+
    '<div class="rl-cb">'+h+'</div></div>';
}

// Join / leave with the right message ------------------------------------
function rlAfterJoin(gid){
  if(!gid || !weldGroups.has(gid)) return;
  const mem=groupMembers(gid);
  railSelectWeld(gid);
  meshToast('Weld '+weldGroupLetter(gid)+' · '+mem.map(rlName).join(' + '));
}
function rlLeave(id){
  const gid=bodyGroup.get(id); if(!gid) return;
  const nm=rlName(id), letter=weldGroupLetter(gid);
  weldDetach(id);                                   // a weld left with one part says "Weld dissolved"
  if(weldGroups.has(gid)) meshToast(nm+' left Weld '+letter);
}
function rlJoinPartOnPart(src, target){
  if(src===target || !bodies.has(src) || !bodies.has(target)) return;
  if(bodyGroup.get(src) && bodyGroup.get(src)===bodyGroup.get(target)) return;
  weldDropOnBody(src, target);
  rlAfterJoin(bodyGroup.get(src));
}
function rlJoinPartOnWeld(src, gid){
  if(!bodies.has(src) || !weldGroups.has(gid) || bodyGroup.get(src)===gid) return;
  weldDropOnGroup(src, gid);
  rlAfterJoin(bodyGroup.get(src));
}
function rlWeldTicked(){
  const ids=[], gids=[];
  for(const k of railTicked){ if(k.indexOf('w:')===0) gids.push(k.slice(2)); else ids.push(k); }
  if(ids.length+gids.length<2) return;
  railTick=false; railTicked.clear();
  const tgt=weldTogether(ids, gids[0]||null, gids);
  rlAfterJoin(tgt);
}
function rlTickExit(){ railTick=false; railTicked.clear(); renderRailParts(); }
function rlToggleTick(key){
  if(railTicked.has(key)) railTicked.delete(key); else railTicked.add(key);
  if(!railTicked.size) railTick=false;
  renderRailParts();
}

// ── Editor ────────────────────────────────────────────────────────────────
function rlGet(k, gid){
  const b=bodies.get(activeBodyId);
  switch(k){
    case 'cell':  return parseFloat(($rl('shapeCellSizeMm')||{}).value)||3;
    case 'inset': return parseFloat(($rl('trimInsetMult')||{}).value)||1;
    case 'skin':  return b&&b.skinMm!=null ? b.skinMm : SKIN_DEFAULT_MM;
    case 'w.fillet': { const g=weldGroups.get(gid); return g?g.filletMm:0.4; }
    case 'w.anchor': { const g=weldGroups.get(gid); return g&&g.anchorMm!=null?g.anchorMm:0.6; }
    case 'w.grade':  { const g=weldGroups.get(gid); return g&&g.gradeMm!=null?g.gradeMm:1.5; }
    default: return structureTransform[k]||0;
  }
}
// Slider + number box. The slider only covers min..max; the number box has no
// bounds, so a typed value beyond the slider still applies. opts.noRange drops
// the slider (number box alone).
function rlSlider(k, label, min, max, step, gid, sym, opts){
  opts=opts||{};
  const v=rlGet(k, gid);
  const num='<input type="number" class="rl-num" data-k="'+k+'" step="'+step+'" value="'+rlNum(v)+'" aria-label="'+esc(label)+(opts.noRange?'':' value')+'">';
  if(opts.noRange) return '<div class="rl-sl numonly">'+num+'</div>';
  return '<div class="rl-sl'+(sym?'':' one')+'">'+(sym?'<span>'+sym+'</span>':'')+
    '<input type="range" data-k="'+k+'" min="'+min+'" max="'+max+'" step="'+step+'" value="'+rlNum(v)+'" aria-label="'+esc(label)+'">'+num+'</div>';
}
// The three shift sliders: +-one structural period per axis (mm), step period/100.
function rlShiftSliders(r, cell){
  const per=structurePeriodMm(r, cell);
  return ['X','Y','Z'].map((a,i)=>{
    const p=per[i], st=p/100;
    return '<div class="rl-sl" data-period="'+a+'"><span>'+a+'</span>'+
      '<input type="range" data-k="spatialOffsetMm'+a+'" min="'+(-p)+'" max="'+p+'" step="'+st+'" value="'+rlNum(rlGet('spatialOffsetMm'+a))+'" aria-label="Shift '+a+'">'+
      '<input type="number" class="rl-num" data-k="spatialOffsetMm'+a+'" step="'+st+'" value="'+rlNum(rlGet('spatialOffsetMm'+a))+'" aria-label="Shift '+a+' value"></div>';
  }).join('');
}
function rlSeg(name, items, cur){
  return '<div class="rl-seg full" data-seg="'+name+'">'+items.map(it=>'<button type="button" data-act="'+name+'" data-v="'+it[0]+'"'+(it[0]===cur?' class="on"':'')+(it[2]?' disabled':'')+'>'+it[1]+'</button>').join('')+'</div>';
}
const rlHint=t=>'<div class="rl-hint">'+t+'</div>';

function rlTopoKey(){
  return bodyOrder.map(id=>id+':'+(bodyGroup.get(id)||'')).join(',')+'|'+[...weldGroups.keys()].join(',');
}

// 16-swatch colour picker (COLOR_PALETTE; the first, null, resets).
function rlColourRow(act, curHex){
  return '<div class="rl-cols">'+COLOR_PALETTE.map(hex=>{
    const cur=(!hex&&!curHex)||(hex&&curHex&&hex.toLowerCase()===curHex.toLowerCase());
    return hex ? '<button type="button" class="rl-cs'+(cur?' on':'')+'" data-act="'+act+'" data-hex="'+hex+'" style="background:'+hex+'" title="'+hex+'" aria-label="Colour '+hex+'"></button>'
               : '<button type="button" class="rl-cs rl-cs0'+(cur?' on':'')+'" data-act="'+act+'" data-hex="" title="Reset to the default colour" aria-label="Reset colour">'+rlIc('reset',12)+'</button>';
  }).join('')+'</div>';
}

function rlEdPart(id){
  const b=bodies.get(id), fill=bodyFill(id), gid=bodyGroup.get(id)||null;
  const r=fill!=='solid' ? recipes.get(assignments.get(id)) : null;
  const trimOk=!!(r && familyHasTrim(r));
  const trimOn=!!($rl('trimToNodes')&&$rl('trimToNodes').checked);
  const noRec=recipes.size===0;
  const key=['p',id,fill,assignments.get(id),gid,trimOk,trimOn,b.colorHex,gid?weldGroupColor(gid):'',recipeOrder.join(','),rlTopoKey()].join('|');
  let h='<div class="rl-ed"><div class="rl-ch"><span class="rl-lbl">'+esc(rlName(id).toUpperCase())+'</span><div class="rl-r"><span class="rl-mini">'+(r?esc(FAMILY_LABEL[r.family]||r.family):'solid')+'</span></div></div><div class="rl-cb rl-eb">';
  // Weld row
  h+='<div class="rl-erow"><label>Weld</label>';
  if(gid){
    h+='<div class="rl-pair"><span class="rl-in">In Weld '+weldGroupLetter(gid)+'</span><button type="button" class="rl-sbtn" data-act="goWeld">Edit weld</button><button type="button" class="rl-sbtn warn" data-act="leaveMe">'+rlIc('unlink')+'Leave</button></div>';
  }else{
    const opts=[];
    for(const o of bodyOrder){ if(o===id||!bodies.has(o)) continue; const og=bodyGroup.get(o); opts.push(['p:'+o,(og?'Weld '+weldGroupLetter(og)+' · ':'')+rlName(o)]); }
    for(const g of weldGroups.keys()) opts.push(['g:'+g,'Weld '+weldGroupLetter(g)]);
    h+=opts.length ? '<select data-sel="weldWith" aria-label="Weld with"><option value="">Not welded · weld with…</option>'+opts.map(o=>'<option value="'+esc(o[0])+'">'+esc(o[1])+'</option>').join('')+'</select>'
                   : rlHint('Add another part to weld it with this one.');
  }
  h+='</div>';
  // Fill
  h+='<div class="rl-erow"><label>Fill</label>'+rlSeg('fill',[['solid','Solid'],['lattice','Lattice',noRec],['skin','Lattice + skin',noRec]], fill)+'</div>';
  if(fill==='solid'){
    h+=rlHint(noRec?'Add a recipe (left, above) to fill this part with a lattice.':'Exported exactly as imported. Drag a recipe onto this part, or pick Lattice, to fill it.');
  }else{
    h+='<div class="rl-erow"><label>Recipe</label><select data-sel="recipe" aria-label="Recipe">'+recipeOrder.filter(x=>recipes.has(x)).map(x=>'<option value="'+esc(x)+'"'+(x===assignments.get(id)?' selected':'')+'>'+esc(rlRecipeLabel(recipes.get(x)))+'</option>').join('')+'</select></div>';
    if(fill==='skin') h+='<div class="rl-erow"><label>Skin thickness <em>mm</em></label>'+rlSlider('skin','Skin thickness',0.1,2,0.05)+'</div>';
    const cell=rlGet('cell');
    h+='<div class="rl-erow"><label>Cell size <em>mm</em></label>'+rlSlider('cell','Cell size',0,0,0.1,null,null,{noRange:true})+'</div>'+
       '<div class="rl-erow"><label>Wall offset <em>mm</em></label>'+rlSlider('isoOffsetMm','Wall offset',-2,2,0.01)+'</div>'+
       '<div class="rl-erow"><label>Rotation <em>deg</em></label>'+rlSlider('rotXDeg','Rotate X',-180,180,1,null,'X')+rlSlider('rotYDeg','Rotate Y',-180,180,1,null,'Y')+rlSlider('rotZDeg','Rotate Z',-180,180,1,null,'Z')+'</div>'+
       '<div class="rl-erow"><label>Shift <em>mm · one period each way</em></label>'+rlShiftSliders(r, cell)+
         '<button type="button" class="rl-sbtn rl-reset" data-act="xreset">'+rlIc('undo')+'Reset rotation, shift and wall offset</button></div>';
    if(trimOk){
      h+='<div class="rl-erow"><label>Trim to nodes</label><div class="rl-pair"><button type="button" class="rl-sw'+(trimOn?' on':'')+'" data-act="trim" aria-label="Trim struts to nodes" aria-pressed="'+trimOn+'"></button>'+
         (trimOn?'<span class="rl-mini">inset ×</span><input type="number" class="rl-num" data-k="inset" min="1" max="2" step="0.1" value="'+rlNum(rlGet('inset'))+'" aria-label="Trim inset multiplier">':'')+'</div></div>';
    }
  }
  // Colour: a weld member is drawn in its weld's colour (set on the weld)
  if(gid){
    h+='<div class="rl-erow"><label>Viewport colour</label><div class="rl-pair"><span class="rl-fsw rl-fsw-dot" style="background:'+esc(weldGroupColor(gid))+'"></span><span class="rl-hint">Shown in Weld '+weldGroupLetter(gid)+'\'s colour</span><button type="button" class="rl-sbtn" data-act="goWeld">Edit weld</button></div></div>';
  }else{
    h+='<div class="rl-erow"><label>Viewport colour</label>'+rlColourRow('color', b.colorHex)+'</div>';
  }
  // v0.12.0: remove the part (two taps: the first asks, the second removes)
  h+='<button type="button" class="rl-sbtn warn rl-rm" data-act="rmPart">'+rlIc('trash')+'Remove part</button>';
  return {key, html:h+'</div></div>'};
}

function rlEdWeld(gid){
  const g=weldGroups.get(gid), mem=groupMembers(gid), rule=weldGroupRule(gid);
  const key=['w',gid,mem.join(','),rule,!!g.showJoins,g.colorHex||'',rlTopoKey()].join('|');
  const opts=[];
  for(const o of bodyOrder){ if(!bodies.has(o)||mem.includes(o)) continue; const og=bodyGroup.get(o); if(og) continue; opts.push(['p:'+o,rlName(o)]); }
  for(const x of weldGroups.keys()) if(x!==gid) opts.push(['g:'+x,'Weld '+weldGroupLetter(x)+' (merge)']);
  let h='<div class="rl-ed"><div class="rl-ch"><span class="rl-lbl">WELD '+weldGroupLetter(gid)+' · '+mem.length+' PARTS</span><div class="rl-r"><span class="rl-mini">one part on export</span></div></div><div class="rl-cb rl-eb">';
  h+='<div class="rl-erow"><label>Parts in this weld</label><div class="rl-mlist">'+mem.map(id=>{
    const f=bodyFill(id), r=f!=='solid'?recipes.get(assignments.get(id)):null;
    return '<div class="rl-mrow" data-body-id="'+esc(id)+'"><button type="button" class="rl-mname" data-act="pickPart" title="Edit this part">'+esc(rlName(id))+'</button><small>'+(r?esc(FAMILY_LABEL[r.family]||r.family).toLowerCase():'solid')+'</small>'+
      '<button type="button" class="rl-ibtn" data-act="out" title="Take out of the weld" aria-label="Take out of the weld">'+rlIc('unlink')+'</button></div>';
  }).join('')+'</div>'+
    (opts.length?'<select data-sel="addTo" aria-label="Add a part or weld"><option value="">Add a part or weld…</option>'+opts.map(o=>'<option value="'+esc(o[0])+'">'+esc(o[1])+'</option>').join('')+'</select>':'')+'</div>';
  h+='<div class="rl-erow"><label>Fillet radius <em>mm</em></label>'+rlSlider('w.fillet','Fillet radius',0,1.5,0.05,gid)+'</div>';
  h+='<div class="rl-erow"><label>Join rule</label>'+rlSeg('rule',[['union','Union'],['anchor','Anchor'],['graded','Graded']], rule)+
     rlHint(({union:'Plain union with the fillet above.',anchor:'The lattice runs into the solid by the depth below, so it bonds through the joint instead of touching at a face.',graded:'Lattice walls thicken toward the solid over the distance below.'})[rule])+'</div>';
  if(rule==='anchor') h+='<div class="rl-erow"><label>Anchor depth <em>mm</em></label>'+rlSlider('w.anchor','Anchor depth',0,2,0.1,gid)+'</div>';
  if(rule==='graded') h+='<div class="rl-erow"><label>Grade over <em>mm</em></label>'+rlSlider('w.grade','Grade distance',0.2,5,0.1,gid)+'</div>';
  h+='<div class="rl-erow"><label>Show joins</label><div class="rl-pair"><button type="button" class="rl-sw'+(g.showJoins?' on':'')+'" data-act="joins" aria-label="Show joins" aria-pressed="'+!!g.showJoins+'"></button><span class="rl-mini">highlight where parts meet</span></div></div>';
  h+='<div class="rl-erow"><label>Viewport colour</label>'+rlColourRow('wcolor', g.colorHex)+'</div>';
  h+='<button type="button" class="rl-sbtn warn rl-wide" data-act="sepAll">'+rlIc('split')+'Separate all parts</button>';
  return {key, html:h+'</div></div>'};
}

let _rlEdKey='';
function renderRailEditor(){
  const host=$rl('railEditor'); if(!host) return;
  const sel=railSel();
  if(!sel){ if(_rlEdKey!==''){ host.innerHTML=''; _rlEdKey=''; } return; }
  const e = sel.t==='weld' ? rlEdWeld(sel.id) : rlEdPart(sel.id);
  if(e.key===_rlEdKey && host.firstChild){ rlEdSync(host, sel); return; }
  _rlEdKey=e.key;
  host.innerHTML=e.html;
}
// Same structure: refresh the numbers in place (never rebuild under a finger).
function rlEdSync(host, sel){
  if(sel.t==='part'){                              // a new cell size or recipe moves the shift range
    const b=bodies.get(sel.id), r=b&&recipes.get(assignments.get(sel.id));
    if(r&&bodyFill(sel.id)!=='solid'){
      const per=structurePeriodMm(r, rlGet('cell'));
      ['X','Y','Z'].forEach((a,i)=>{
        const rg=host.querySelector('input[type=range][data-k="spatialOffsetMm'+a+'"]'), nb=host.querySelector('input.rl-num[data-k="spatialOffsetMm'+a+'"]');
        if(!rg) return;
        const p=per[i], st=p/100;
        if(rg.max!==String(p)){ rg.min=-p; rg.max=p; rg.step=st; if(nb) nb.step=st; rg.value=rlNum(rlGet('spatialOffsetMm'+a)); }
      });
    }
  }
  for(const el of host.querySelectorAll('input[data-k]')){
    if(el===document.activeElement) continue;
    const v=rlNum(rlGet(el.dataset.k, sel.t==='weld'?sel.id:null));
    if(el.value!==v && parseFloat(el.value)!==parseFloat(v)) el.value=v;
  }
}

// Apply one slider / number edit.
function rlEdit(k, v){
  const sel=railSel(); if(!sel) return;
  if(k==='cell'){ railSetCellMm(v); }
  else if(k==='inset'){ railSetTrimInset(v); }
  else if(k==='skin'){ setBodySkin(activeBodyId, v); }
  else if(k.indexOf('w.')===0){
    const gid=sel.id;
    if(k==='w.fillet') rlDeb('fillet',()=>weldSetFillet(gid, v),120);
    else if(k==='w.anchor') rlDeb('anchor',()=>weldSetAnchor(gid, v),120);
    else if(k==='w.grade') rlDeb('grade',()=>weldSetGrade(gid, v),120);
    const g=weldGroups.get(gid);                  // the summary line reads these at once
    if(g){ if(k==='w.fillet') g.filletMm=Math.max(0,v); else if(k==='w.anchor') g.anchorMm=Math.max(0,v); else g.gradeMm=Math.max(0.05,v); }
  }
  else railSetXform(k, v);
  renderRailParts();                               // fill summary / weld summary follow the slider
  if(k==='cell') renderRailEditor();               // the shift sliders' range follows the cell size
}

// ── Whole rail ────────────────────────────────────────────────────────────
function renderRail(){
  railNormalize();
  renderRailRecipes();
  renderRailParts();
  renderRailEditor();
}

// ── Events ────────────────────────────────────────────────────────────────
let _rlSuppressClick=false, _rlLP=null;
function rlRowKey(el){
  const p=el.closest('.rl-part'); if(p) return p.dataset.bodyId;
  const w=el.closest('.rl-whead'); if(w) return 'w:'+w.dataset.gid;
  return null;
}
function rlDropClear(){
  for(const d of document.querySelectorAll('#railParts .rl-drop, #railParts .rl-dropfile')){ d.classList.remove('rl-drop','rl-dropfile'); d.removeAttribute('data-hint'); }
}
function rlDropMark(el, hint){
  if(el.classList.contains('rl-drop') && el.getAttribute('data-hint')===hint) return;
  rlDropClear(); el.classList.add('rl-drop'); el.setAttribute('data-hint', hint);
}
// What would a drop at this element do?  {el, hint, run()} or null.
function rlDropTarget(t){
  if(!railDrag || !t || !t.closest) return null;
  const card=t.closest('.rl-part'), wg=t.closest('.rl-wgrp'), oz=t.closest('.rl-outzone');
  if(railDrag.kind==='recipe'){
    if(!card) return null;
    const bid=card.dataset.bodyId, rid=railDrag.id;
    return {el:card, hint:'fill with recipe', run(){ railSelWeld=null; assignRecipeToBody(bid, rid); meshToast(rlName(bid)+' filled with '+rlRecipeLabel(recipes.get(rid))); }};
  }
  const src=railDrag.id;
  if(oz){
    if(!bodyGroup.has(src)) return null;
    return {el:oz, hint:'take out', run(){ rlLeave(src); }};
  }
  if(card){
    const bid=card.dataset.bodyId; if(bid===src) return null;
    const tg=bodyGroup.get(bid);
    if(tg && tg===bodyGroup.get(src)) return null;
    return {el:card, hint: tg ? 'join Weld '+weldGroupLetter(tg) : 'weld with '+rlName(bid), run(){ rlJoinPartOnPart(src, bid); }};
  }
  if(wg){
    const gid=wg.dataset.gid; if(bodyGroup.get(src)===gid) return null;
    return {el:wg, hint:'join Weld '+weldGroupLetter(gid), run(){ rlJoinPartOnWeld(src, gid); }};
  }
  return null;
}
function rlDragEnd(){
  railDrag=null; rlDropClear();
  const pc=$rl('rlPartCard'); if(pc) pc.classList.remove('rl-dragmember');
  for(const d of document.querySelectorAll('.rl-dragging')) d.classList.remove('rl-dragging');
  if(_rlDeferred){ _rlDeferred=false; renderRailParts(); }
}

function rlInit(){
  const parts=$rl('railParts'), recs=$rl('railRecipes'), ed=$rl('railEditor');
  if(!parts||!recs||!ed) return;

  // ---- recipes
  recs.addEventListener('click',e=>{
    const act=e.target.closest('[data-act]'), card=e.target.closest('.rl-rc');
    if(act && act.dataset.act==='foldCard'){ railFold.rec=!railFold.rec; renderRailRecipes(); return; }
    if(act && act.dataset.act==='addRecipe'){
      if(!canAddRecipe()){ showCapToast('Recipe limit reached ('+MAX_RECIPES+'). Remove a recipe before adding another.'); return; }
      const f=$rl('fileInput'); if(f) f.click(); return;
    }
    if(act && act.dataset.act==='rmRecipe' && card){ e.stopPropagation(); rlPopHide(); removeRecipe(card.dataset.recipeId); return; }
    if(card){
      if(rlPopFor===card.dataset.recipeId && rlPopMode==='hover'){ rlPopMode='click'; return; }   // pin it
      if(rlPopFor===card.dataset.recipeId) rlPopHide(); else rlPopShow(card,'click');
    }
  });
  recs.addEventListener('keydown',e=>{
    const card=e.target.closest&&e.target.closest('.rl-rc');
    if(card && e.target===card && (e.key==='Enter'||e.key===' ')){ e.preventDefault(); if(rlPopFor===card.dataset.recipeId) rlPopHide(); else rlPopShow(card,'click'); }
    if(e.key==='Escape') rlPopHide();
  });
  const canHover=()=>window.matchMedia&&matchMedia('(hover: hover)').matches;
  recs.addEventListener('mouseover',e=>{
    const card=e.target.closest('.rl-rc'); if(!card||!canHover()) return;
    if(e.relatedTarget && card.contains(e.relatedTarget)) return;
    if(rlPopMode==='click' && rlPopFor!==card.dataset.recipeId) return;   // a pinned card stays
    rlPopShow(card, rlPopFor===card.dataset.recipeId ? rlPopMode : 'hover');
  });
  recs.addEventListener('mouseout',e=>{
    const card=e.target.closest('.rl-rc'); if(!card) return;
    if(e.relatedTarget && card.contains(e.relatedTarget)) return;
    if(rlPopMode==='hover') rlPopT=setTimeout(rlPopHide,160);
  });
  recs.addEventListener('dragstart',e=>{
    const card=e.target.closest&&e.target.closest('.rl-rc'); if(!card) return;
    rlPopHide();
    railDrag={kind:'recipe', id:card.dataset.recipeId};
    if(e.dataTransfer){ e.dataTransfer.effectAllowed='copy'; try{ e.dataTransfer.setData('text/recipe', railDrag.id); }catch(_){} }
  });
  recs.addEventListener('dragend',rlDragEnd);
  document.addEventListener('pointerdown',e=>{
    if(rlPopFor && !e.target.closest('.rl-rc') && !e.target.closest('#rlPop')) rlPopHide();
  });
  window.addEventListener('resize',rlPopHide);
  document.addEventListener('scroll',e=>{ if(rlPopFor && e.target && e.target.id==='rail') rlPopHide(); },true);

  // ---- parts: click / keys
  parts.addEventListener('click',e=>{
    if(_rlSuppressClick){ _rlSuppressClick=false; return; }          // the click that ends a long-press
    const t=e.target, actEl=t.closest('[data-act]'), act=actEl&&actEl.dataset.act;
    const row=t.closest('.rl-part'), head=t.closest('.rl-whead');
    if(act==='foldCard'){ railFold.parts=!railFold.parts; renderRailParts(); return; }
    if(act==='foldWeld'){ const gid=head.dataset.gid; if(railFoldedWelds.has(gid)) railFoldedWelds.delete(gid); else railFoldedWelds.add(gid); renderRailParts(); return; }
    if(act==='tick'){ e.stopPropagation(); const k=rlRowKey(actEl); if(k) rlToggleTick(k); return; }
    if(act==='weldSel'){ rlWeldTicked(); return; }
    if(act==='clrSel'){ rlTickExit(); return; }
    if(act==='dismissErr'){ _pendingImport=null; renderRailParts(); return; }
    if(act==='addPart'){
      if(!canAddBody()){ showCapToast(); return; }
      const f=$rl('shapeInput'); if(f) f.click(); return;
    }
    if(act==='leave' && row){ rlLeave(row.dataset.bodyId); return; }
    if(act==='vis' && head && !row){                                 // the weld card's own eye: every member
      const gid=head.dataset.gid, cur=rlGroupVis(gid);
      setGroupVisibility(gid, cur===VIS_INACTIVE_SOLID ? VIS_GHOST : cur===VIS_GHOST ? VIS_HIDDEN : VIS_INACTIVE_SOLID);
      return;
    }
    if(act==='vis' && row){
      const id=row.dataset.bodyId, b=bodies.get(id); if(!b) return;
      const cur=b.visibility||VIS_DEFAULT;
      setBodyVisibility(id, cur===VIS_INACTIVE_SOLID ? VIS_GHOST : cur===VIS_GHOST ? VIS_HIDDEN : VIS_INACTIVE_SOLID);
      return;
    }
    if(row){
      if(railTick) rlToggleTick(row.dataset.bodyId); else railSelectPart(row.dataset.bodyId);
      return;
    }
    if(head){
      const gid=head.dataset.gid;
      if(railTick) rlToggleTick('w:'+gid); else railSelectWeld(gid);
    }
  });
  parts.addEventListener('keydown',e=>{
    if(e.key!=='Enter' && e.key!==' ') return;
    if(e.target.closest('button')) return;
    const row=e.target.closest('.rl-part'), head=e.target.closest('.rl-whead');
    if(row && e.target===row){ e.preventDefault(); if(railTick) rlToggleTick(row.dataset.bodyId); else railSelectPart(row.dataset.bodyId); }
    else if(head && e.target===head){ e.preventDefault(); if(railTick) rlToggleTick('w:'+head.dataset.gid); else railSelectWeld(head.dataset.gid); }
  });
  document.addEventListener('keydown',e=>{ if(e.key==='Escape' && railTick) rlTickExit(); });

  // ---- parts: long-press enters tick mode
  parts.addEventListener('contextmenu',e=>{ if(e.target.closest('.rl-part,.rl-whead')) e.preventDefault(); });
  parts.addEventListener('pointerdown',e=>{
    _rlSuppressClick=false;
    if(e.pointerType==='mouse' && e.button!==0) return;
    if(e.target.closest('button')) return;                      // the buttons are taps, not rows
    const row=e.target.closest('.rl-part,.rl-whead'); if(!row) return;
    const key=rlRowKey(row);
    clearTimeout(_rlLP&&_rlLP.timer);
    _rlLP={x:e.clientX, y:e.clientY, timer:setTimeout(()=>{
      _rlLP=null; _rlSuppressClick=true;
      if(navigator.vibrate){ try{ navigator.vibrate(12); }catch(_){} }
      railTick=true; railTicked.add(key);
      renderRailParts();
    }, RL_LONGPRESS_MS)};
  });
  const lpCancel=()=>{ if(_rlLP){ clearTimeout(_rlLP.timer); _rlLP=null; } };
  parts.addEventListener('pointermove',e=>{ if(_rlLP && Math.hypot(e.clientX-_rlLP.x, e.clientY-_rlLP.y)>8) lpCancel(); });
  parts.addEventListener('pointerup',lpCancel);
  parts.addEventListener('pointercancel',lpCancel);
  parts.addEventListener('pointerleave',lpCancel);

  // ---- parts: drag and drop
  parts.addEventListener('dragstart',e=>{
    lpCancel();
    const row=e.target.closest&&e.target.closest('.rl-part'); if(!row){ e.preventDefault(); return; }
    const id=row.dataset.bodyId;
    railDrag={kind:'part', id};
    if(e.dataTransfer){ e.dataTransfer.effectAllowed='move'; try{ e.dataTransfer.setData('text/part', id); }catch(_){} }
    // Layout changes inside dragstart can cancel the drag in some browsers; defer.
    setTimeout(()=>{
      if(!railDrag) return;
      row.classList.add('rl-dragging');
      if(bodyGroup.has(id)){ const pc=$rl('rlPartCard'); if(pc) pc.classList.add('rl-dragmember'); }
    },0);
  });
  parts.addEventListener('dragend',rlDragEnd);
  parts.addEventListener('dragover',e=>{
    if(railDrag && e.dataTransfer && [...(e.dataTransfer.types||[])].indexOf('Files')>=0) rlDragEnd();   // stale drag state
    if(!railDrag){                                          // a file from the desktop: the page-level handler imports it
      const dz=e.target.closest&&e.target.closest('.rl-dz');
      if(dz && e.dataTransfer && [...(e.dataTransfer.types||[])].indexOf('Files')>=0){ rlDropClear(); dz.classList.add('rl-dropfile'); }
      return;
    }
    const tgt=rlDropTarget(e.target);
    if(!tgt){ rlDropClear(); return; }
    e.preventDefault(); e.stopPropagation();
    if(e.dataTransfer) e.dataTransfer.dropEffect=railDrag.kind==='recipe'?'copy':'move';
    rlDropMark(tgt.el, tgt.hint);
  });
  parts.addEventListener('dragleave',e=>{
    if(!parts.contains(e.relatedTarget)) rlDropClear();
  });
  parts.addEventListener('drop',e=>{
    if(!railDrag){ rlDropClear(); return; }                // files fall through to the page handler
    const tgt=rlDropTarget(e.target);
    e.preventDefault(); e.stopPropagation();
    rlDropClear();
    const run=tgt&&tgt.run;
    rlDragEnd();
    if(run) run();
  });

  // ---- editor
  ed.addEventListener('input',e=>{
    const el=e.target, k=el.dataset&&el.dataset.k; if(!k) return;
    const v=parseFloat(el.value); if(isNaN(v)) return;
    if(k==='cell' && v<RL_CELL_MIN_MM) return;       // mid-typing ("0." on the way to 0.5); the change event clamps
    for(const tw of ed.querySelectorAll('[data-k="'+k+'"]')) if(tw!==el && el.type!==tw.type) tw.value=el.value;
    rlEdit(k, v);
  });
  ed.addEventListener('change',e=>{
    const kk=e.target.dataset&&e.target.dataset.k;
    if(kk==='cell'){                                  // cell size: any value above zero, never below the floor
      let v=parseFloat(e.target.value); if(isNaN(v)||v<RL_CELL_MIN_MM) v=isNaN(v)?rlGet('cell'):RL_CELL_MIN_MM;
      e.target.value=rlNum(v); rlEdit('cell', v); return;
    }
    const el=e.target, sel=el.dataset&&el.dataset.sel; if(!sel) return;
    const s=railSel(); if(!s) return;
    const v=el.value;
    if(sel==='recipe'){ if(v) assignRecipeToBody(s.id, v); }
    else if(sel==='weldWith'){
      if(!v) return;
      if(v.indexOf('p:')===0) rlJoinPartOnPart(s.id, v.slice(2));
      else rlJoinPartOnWeld(s.id, v.slice(2));
    }else if(sel==='addTo'){
      if(!v) return;
      if(v.indexOf('p:')===0){ weldDropOnGroup(v.slice(2), s.id); rlAfterJoin(s.id); }
      else{ const t=weldTogether([], s.id, [v.slice(2)]); rlAfterJoin(t); }
    }
  });
  ed.addEventListener('click',e=>{
    const b=e.target.closest('[data-act]'); if(!b || b.disabled) return;
    const s=railSel(); if(!s) return;
    switch(b.dataset.act){
      case 'fill':  setBodyFill(s.id, b.dataset.v); break;
      case 'rule':  weldSetRule(s.id, b.dataset.v); renderRail(); break;
      case 'trim':  railSetTrim(!($rl('trimToNodes')&&$rl('trimToNodes').checked)); renderRailEditor(); break;
      case 'joins': { const g=weldGroups.get(s.id); if(g){ weldSetShowJoins(s.id, !g.showJoins); renderRailEditor(); } break; }
      case 'xreset': window.onStructXformReset&&window.onStructXformReset(); break;
      case 'color': setBodyColor(s.id, b.dataset.hex||null); break;
      case 'wcolor': setWeldColor(s.id, b.dataset.hex||null); break;
      case 'goWeld': { const g=bodyGroup.get(s.id); if(g) railSelectWeld(g); break; }
      case 'leaveMe': rlLeave(s.id); break;
      case 'rmPart': {
        if(!b.classList.contains('confirm')){ b.classList.add('confirm'); b.lastChild.textContent='Tap again to remove '+rlName(s.id); setTimeout(()=>{ if(b.isConnected){ b.classList.remove('confirm'); b.lastChild.textContent='Remove part'; } },3000); break; }
        const nm=rlName(s.id); window.clearImportedShape&&window.clearImportedShape(s.id); renderRail(); meshToast(nm+' removed'); break;
      }
      case 'out': { const row=b.closest('.rl-mrow'); if(row) rlLeave(row.dataset.bodyId); break; }
      case 'pickPart': { const row=b.closest('.rl-mrow'); if(row) railSelectPart(row.dataset.bodyId); break; }
      case 'sepAll': { const letter=weldGroupLetter(s.id); const n=weldSeparateAll(s.id); railSelWeld=null; renderRail(); meshToast('Weld '+letter+' separated into '+n+' parts'); break; }
    }
  });

  renderRail();
}
rlInit();
