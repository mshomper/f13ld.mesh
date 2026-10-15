/* ============================================================
   F13LD.mesh · 54-sidebar.js  (v0.10.0)
   Compact sidebar. Runs on the summary panel after every render
   (sidebarEnhance, called where summaryEl.innerHTML is set):
   - The recipe's title + settings cards become one small card in the
     family colour with a one-line summary (first four settings). The
     full settings open in a details card beside the sidebar on hover
     (mouse) or tap (touch).
   - Every later "hr.div + sec-lbl + content" section becomes a group
     with a drawn chevron; click the header to collapse it. Open/closed
     state is remembered per browser. Homogenization and Measured start
     collapsed. A collapsed group can show a one-line readout (peek).
   The family summary builders are unchanged; this only rearranges the
   DOM they produce, so element ids and inline handlers keep working.
   ============================================================ */
'use strict';

const SB_STORE_KEY='f13ld.mesh.sidebar.v1';
const SB_DEFAULT_COLLAPSED={homogenization:true, measured:true};
const _sbState=(function(){ try{ return JSON.parse(localStorage.getItem(SB_STORE_KEY)||'{}')||{}; }catch(_){ return {}; } })();
function _sbSave(){ try{ localStorage.setItem(SB_STORE_KEY, JSON.stringify(_sbState)); }catch(_){} }
function _sbCollapsed(key){ return (key in _sbState)?!!_sbState[key]:!!SB_DEFAULT_COLLAPSED[key]; }
function _sbKey(label){ return String(label||'').split('·')[0].trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'group'; }

const SB_CHEVRON='<svg class="sb-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SB_INFO='<svg class="sb-info" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 7.2v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="4.9" r=".9" fill="currentColor"/></svg>';

function _sbHexRgba(hex, a){
  const m=/^#?([0-9a-f]{6})$/i.exec(String(hex||'')); if(!m) return 'rgba(136,136,136,'+a+')';
  const n=parseInt(m[1],16); return 'rgba('+((n>>16)&255)+','+((n>>8)&255)+','+(n&255)+','+a+')';
}

function sidebarEnhance(root){
  root=root||document.getElementById('summaryContent');
  if(!root) return;
  _sbCloseDetails();
  const kids=[...root.children];
  let i=0;
  // ── Recipe card ────────────────────────────────────────────────────────
  if(kids[0] && kids[0].classList.contains('sec-lbl') && kids[1] && kids[1].classList.contains('meta-grid')){
    const title=kids[0], grid=kids[1];
    const fam=(typeof currentRecipe!=='undefined'&&currentRecipe)?currentRecipe.family:null;
    const col=(fam&&typeof familyColor==='function')?familyColor(fam):'#888888';
    // First four settings with a value; numbers carry their label ("cells 20").
    const vals=[];
    for(const mc of grid.querySelectorAll('.mc')){
      if(vals.length>=4) break;
      const v=mc.querySelector('.mc-val'), l=mc.querySelector('.mc-lbl');
      const tv=v?v.textContent.trim():'';
      if(!tv || /^—/.test(tv)) continue;
      vals.push(/^[-+.\d]/.test(tv) && l ? l.textContent.trim()+' '+tv : tv);
    }
    const card=document.createElement('div');
    card.className='sb-card'; card.tabIndex=0;
    card.setAttribute('role','button'); card.setAttribute('aria-haspopup','true'); card.setAttribute('aria-expanded','false');
    card.style.borderColor=_sbHexRgba(col,.35); card.style.background=_sbHexRgba(col,.07);
    const t=document.createElement('div'); t.className='sb-card-t'; t.style.color=col;
    t.innerHTML='<span></span>'+SB_INFO; t.firstChild.textContent=title.textContent;
    const sub=document.createElement('div'); sub.className='sb-card-s'; sub.textContent=vals.join(' · ');
    card.appendChild(t); card.appendChild(sub);
    const pop=document.createElement('div'); pop.className='sb-pop'; pop.id='sbDetails'; pop.hidden=true;
    pop.style.borderColor=_sbHexRgba(col,.45);
    const ph=document.createElement('div'); ph.className='sb-pop-t'; ph.style.color=col; ph.textContent=title.textContent+' · details';
    grid.classList.add('sb-kv');
    pop.appendChild(ph); pop.appendChild(grid);
    root.insertBefore(card, title); root.insertBefore(pop, title); title.remove();
    _sbWireCard(card, pop);
    i=2;
  }
  // ── Collapsible groups ─────────────────────────────────────────────────
  const rest=[...root.children];
  for(let k=0;k<rest.length;k++){
    const hr=rest[k];
    if(!(hr.tagName==='HR' && hr.classList.contains('div'))) continue;
    const lbl=rest[k+1];
    if(!lbl || !lbl.classList.contains('sec-lbl')) continue;
    const body=document.createElement('div'); body.className='sb-gb';
    let j=k+2;
    while(j<rest.length && !(rest[j].tagName==='HR' && rest[j].classList.contains('div'))){ body.appendChild(rest[j]); j++; }
    const key=_sbKey(lbl.textContent);
    const grp=document.createElement('div'); grp.className='sb-group'; grp.dataset.key=key;
    const head=document.createElement('button'); head.type='button'; head.className='sb-gh';
    head.innerHTML='<span class="sb-gl"></span><span class="sb-peek" id="sbPeek-'+key+'"></span>'+SB_CHEVRON;
    head.firstChild.textContent=lbl.textContent;
    const collapsed=_sbCollapsed(key);
    if(collapsed) grp.classList.add('collapsed');
    head.setAttribute('aria-expanded', String(!collapsed));
    head.addEventListener('click', ()=>{
      const c=!grp.classList.contains('collapsed');
      grp.classList.toggle('collapsed', c); head.setAttribute('aria-expanded', String(!c));
      _sbState[key]=c; _sbSave();
    });
    grp.appendChild(head); grp.appendChild(body);
    root.insertBefore(grp, hr); hr.remove(); lbl.remove();
    k=j-1;
  }
  void i;
  if(typeof ppPeeks==='function') ppPeeks();
}
function sidebarPeek(key, text){
  const el=document.getElementById('sbPeek-'+key); if(el) el.textContent=text||'';
}

// ── Details card (hover on mouse, tap on touch) ───────────────────────────
let _sbHideT=null, _sbOpenBy=null;
function _sbPlace(card, pop){
  const panel=document.getElementById('panel');
  const pr=(panel||card).getBoundingClientRect(), cr=card.getBoundingClientRect();
  pop.style.visibility='hidden'; pop.hidden=false;
  const w=pop.offsetWidth, h=pop.offsetHeight, vw=window.innerWidth, vh=window.innerHeight;
  let left=pr.left-w-8, top=cr.top;
  if(left<8){ left=Math.max(8,Math.min(vw-w-8,cr.left)); top=cr.bottom+6; }
  top=Math.max(8,Math.min(top, vh-h-8));
  pop.style.left=left+'px'; pop.style.top=top+'px'; pop.style.visibility='';
}
function _sbShow(card, pop, by){ clearTimeout(_sbHideT); _sbOpenBy=by; _sbPlace(card,pop); card.setAttribute('aria-expanded','true'); card.classList.add('open'); }
function _sbHide(card, pop){ pop.hidden=true; _sbOpenBy=null; card.setAttribute('aria-expanded','false'); card.classList.remove('open'); }
function _sbCloseDetails(){ const p=document.getElementById('sbDetails'); if(p) p.hidden=true; _sbOpenBy=null; }
function _sbWireCard(card, pop){
  let lastPointer='mouse';
  card.addEventListener('pointerdown', e=>{ lastPointer=e.pointerType||'mouse'; });
  card.addEventListener('mouseenter', ()=>{ if(lastPointer==='mouse' || matchMedia('(hover: hover)').matches) _sbShow(card,pop,'hover'); });
  card.addEventListener('mouseleave', ()=>{ if(_sbOpenBy==='hover'){ _sbHideT=setTimeout(()=>_sbHide(card,pop),160); } });
  pop.addEventListener('mouseenter', ()=>clearTimeout(_sbHideT));
  pop.addEventListener('mouseleave', ()=>{ if(_sbOpenBy==='hover') _sbHide(card,pop); });
  card.addEventListener('click', ()=>{
    if(lastPointer==='mouse' && _sbOpenBy==='hover'){ _sbOpenBy='click'; return; }   // pin it
    if(pop.hidden) _sbShow(card,pop,'click'); else _sbHide(card,pop);
  });
  card.addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); if(pop.hidden) _sbShow(card,pop,'click'); else _sbHide(card,pop); } else if(e.key==='Escape') _sbHide(card,pop); });
}
document.addEventListener('pointerdown', e=>{
  const pop=document.getElementById('sbDetails'); if(!pop||pop.hidden) return;
  if(e.target.closest('.sb-card')||e.target.closest('#sbDetails')) return;
  pop.hidden=true; _sbOpenBy=null;
  const c=document.querySelector('.sb-card'); if(c){ c.classList.remove('open'); c.setAttribute('aria-expanded','false'); }
});
window.addEventListener('resize', _sbCloseDetails);
document.addEventListener('scroll', e=>{ if(e.target&&e.target.id==='panel') _sbCloseDetails(); }, true);
