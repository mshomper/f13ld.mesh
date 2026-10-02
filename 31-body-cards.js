/* ============================================================
   F13LD.mesh · 31-body-cards.js
   Shape strip UI: body cards, weld-group drag/drop, recipe library chips.
   ============================================================ */
'use strict';

// ── Shape strip UI state renderer ─────────────────────────────────────────
// rc2: setShapeUI is now a thin wrapper. The real renderer is renderBodyCards,
// which draws all cards from the bodies Map plus an optional "in progress"
// card from _pendingImport (loading/error state that has no body record yet).
//
// The old single-card #shapeCard div is hidden in rc2 — it stays in the DOM
// for backwards compatibility with any code path I might have missed, but
// nothing renders into it. All visible cards live in #shapeCardRow.

let _pendingImport = null;  // { name, state:'loading'|'err', errMsg? }

function setShapeUI(state, name, meta, errMsg, suggestedCell){
  const dz=document.getElementById('shapeDZ');
  if(dz) dz.querySelector('.sdz-sub').textContent =
    (state==='loading') ? 'loading…' : 'drop a shape · or click to browse';

  // Track transient import state — gets cleared on 'ok' (body now in Map)
  // and on 'idle' (no import in flight).
  if(state==='loading'){
    _pendingImport = { name, state:'loading' };
  } else if(state==='err'){
    _pendingImport = { name, state:'err', errMsg: errMsg||'import failed' };
  } else {
    _pendingImport = null;
  }

  // Show/hide cell size + structure transform overlays based on whether
  // any body is loaded (was: based on the single-shape state).
  const cellOv=document.getElementById('cellOverlay');
  const xfOv=document.getElementById('structXformOverlay');
  const anyBody = bodies.size > 0;
  if(anyBody && state!=='err'){
    if(cellOv) cellOv.style.display='flex';
    if(xfOv) xfOv.style.display='flex';
    if(state==='ok'){
      const inp=document.getElementById('shapeCellSizeMm');
      if(inp&&suggestedCell) inp.value=suggestedCell;
      // Beam-family-only trim toggle visibility (unchanged from rc1).
      const trimWrap=document.getElementById('trimNodesWrap');
      if(trimWrap) trimWrap.style.display=(currentRecipe&&currentRecipe.family==='beam')?'inline':'none';
      const trimMul=document.getElementById('trimInsetWrap');
      const trimTg=document.getElementById('trimToNodes');
      if(trimMul) trimMul.style.display=(currentRecipe&&currentRecipe.family==='beam'&&trimTg&&trimTg.checked)?'inline-flex':'none';
    }
  } else if(!anyBody){
    if(cellOv) cellOv.style.display='none';
    if(xfOv) xfOv.style.display='none';
  }
  // Always re-render the card row (handles all card display now).
  renderBodyCards();
  // rc2.5: also refresh library row (usage counts may have changed).
  renderRecipeLibrary();
}

// rc2: The real card renderer. Reads from bodies Map + bodyOrder + activeBodyId
// + _pendingImport and rebuilds #shapeCardRow. Called from setShapeUI, from
// switchActiveBody, and from clearActiveBody when the active body changes.
// rc2.5: now also renders the recipe-chip dropdown trigger on each card.
// ── Build one body card's HTML. Used standalone AND inside a weld group, so
// grouped cards keep every control (recipe chip, visibility, palette, ×). ──
function buildBodyCardHTML(bodyId){
  const b = bodies.get(bodyId);
  if(!b) return '';
  const isActive = (bodyId === activeBodyId);
  const meta = b.meta || {};
  const tris = (meta.tris != null) ? meta.tris.toLocaleString() : '?';
  const chips = `
      <span class="sc-chip">${meta.format||''}</span>
      <span class="sc-chip">tris <b>${tris}</b></span>`;
  const safeName = String(meta.name||'shape').replace(/</g,'&lt;');
  const rid = assignments.get(bodyId);
  const r = (rid && rid !== SOLID_SENTINEL && recipes.has(rid)) ? recipes.get(rid) : null;
  const bodyCol = resolveBodyColor(bodyId);
  let recipeChipHtml;
  if(isSolidAssignment(rid)){
    recipeChipHtml = `
      <span class="shapeCard-recipe" data-body-id="${bodyId}" style="color:${bodyCol};border-color:${bodyCol};background:${bodyCol}11">
        <span class="scr-dot" style="background:${bodyCol}"></span>
        <span class="scr-name">solid</span>
        <span class="scr-caret">▾</span>
      </span>`;
  } else if(r){
    const label = (FAMILY_LABEL[r.family]||r.family).toLowerCase() + ' · ' + String(r.subtype||'').toLowerCase();
    recipeChipHtml = `
      <span class="shapeCard-recipe" data-body-id="${bodyId}" style="color:${bodyCol};border-color:${bodyCol};background:${bodyCol}11">
        <span class="scr-dot" style="background:${bodyCol}"></span>
        <span class="scr-name">${label}</span>
        <span class="scr-caret">▾</span>
      </span>`;
  } else {
    recipeChipHtml = `
      <span class="shapeCard-recipe unassigned" data-body-id="${bodyId}">
        <span class="scr-name">unassigned</span>
        <span class="scr-caret">▾</span>
      </span>`;
  }
  const vis = b.visibility || VIS_DEFAULT;
  const visIcon = vis === VIS_HIDDEN ? '◯' : vis === VIS_GHOST ? '◌' : '◉';
  const visTitle = vis === VIS_HIDDEN
    ? 'Hidden · click to cycle to inactive-solid'
    : vis === VIS_GHOST
    ? 'Ghost (translucent) · click to cycle to hidden'
    : 'Inactive-solid (opaque) · click to cycle to ghost';
  const visExtraClass = isActive ? ' sc-icon-muted' : '';
  const paletteBtnHtml = `
    <button class="sc-palette-btn${visExtraClass}" data-body-id="${bodyId}" title="Pick body color" style="color:${bodyCol}">
      <span class="sc-palette-swatch" style="background:${bodyCol}"></span>
    </button>`;
  const visBtnHtml = `
    <button class="sc-vis-btn${visExtraClass}" data-body-id="${bodyId}" title="${visTitle}">
      ${visIcon}
    </button>`;
  return `
    <div class="shapeCard${isActive?' active':''}" draggable="true" data-body-id="${bodyId}">
      <button class="sc-x" data-body-id="${bodyId}" title="remove">&#10005;</button>
      <span class="sc-name">${safeName}</span>
      <div class="sc-chips">${chips}</div>
      ${recipeChipHtml}
      <div class="sc-card-controls">
        ${visBtnHtml}
        ${paletteBtnHtml}
      </div>
    </div>`;
}

// ── Weld-group UI helpers + drag-to-weld ops (v0.7.0) ───────────────────────
const WELD_COLORS = ['#a78bfa','#2dd4bf','#fbbf24','#fb7185','#38bdf8'];
let _weldColorSeq = 0;
function weldGroupColor(gid){ const g=weldGroups.get(gid); const ci=(g&&g.colorIndex!=null)?g.colorIndex:0; return WELD_COLORS[ci%WELD_COLORS.length]; }
function weldGroupLetter(gid){ const g=weldGroups.get(gid); const ci=(g&&g.colorIndex!=null)?g.colorIndex:0; return String.fromCharCode(65+(ci%26)); }
function newWeldGroup(filletMm){ const used=new Set(); for(const g of weldGroups.values()) used.add(g.colorIndex); let ci=0; while(used.has(ci)) ci++; const gid='wg'+Date.now().toString(36)+ci; weldGroups.set(gid,{filletMm:(filletMm!=null?filletMm:0.4),colorIndex:ci}); return gid; }
function _bodyOrderMoveAfter(id, afterId){ const i=bodyOrder.indexOf(id); if(i>=0) bodyOrder.splice(i,1); const j=bodyOrder.indexOf(afterId); bodyOrder.splice(j<0?bodyOrder.length:j+1,0,id); }
function _bodyOrderMoveEnd(id){ const i=bodyOrder.indexOf(id); if(i>=0) bodyOrder.splice(i,1); bodyOrder.push(id); }
// Signature of the ACTIVE body's preview-relevant state (its group + that
// group's member count). If unchanged across a weld edit, the active body's
// preview doesn't need rebuilding — so we don't thrash the raymarcher when the
// user welds two OTHER bodies.
function _weldActiveSig(){ const g=activeBodyId?(bodyGroup.get(activeBodyId)||null):null; const n=g?groupMembers(g).length:0; return g+'|'+n; }
function _refreshAfterWeld(prevSig){
  renderBodyCards();                       // also dissolves any sub-2 group
  if(_weldActiveSig()===prevSig) return;   // active body's preview is unaffected
  const ag=activeGroupId();
  if(ag && groupMembers(ag).length>=2) triggerPreview(rm&&rm._quality||'draft');         // show the weld
  else if(typeof reloadActiveRecipeIntoPreview==='function') reloadActiveRecipeIntoPreview(); // restore single body
}
function weldDropOnGroup(id, gid){
  if(!weldGroups.has(gid) || bodyGroup.get(id)===gid) return;
  const sig=_weldActiveSig();
  bodyGroup.set(id,gid);
  const others=groupMembers(gid).filter(x=>x!==id);
  _bodyOrderMoveAfter(id, others.length?others[others.length-1]:id);
  _refreshAfterWeld(sig);
}
function weldDropOnBody(id, targetId){
  if(id===targetId) return;
  const tgid=bodyGroup.get(targetId);
  if(tgid){ weldDropOnGroup(id, tgid); return; }   // target already grouped → join it
  const sig=_weldActiveSig();                        // both ungrouped → new weld group
  const gid=newWeldGroup(0.4);
  bodyGroup.set(targetId,gid); bodyGroup.set(id,gid);
  _bodyOrderMoveAfter(id, targetId);
  _refreshAfterWeld(sig);
}
function weldDetach(id){
  if(!bodyGroup.has(id)) return;
  const sig=_weldActiveSig();
  bodyGroup.delete(id);
  _bodyOrderMoveEnd(id);
  _refreshAfterWeld(sig);
}
function weldSetFillet(gid, mm){
  const g=weldGroups.get(gid); if(!g) return;
  g.filletMm=Math.max(0, mm||0);
  if(activeBodyId && bodyGroup.get(activeBodyId)===gid && groupMembers(gid).length>=2)
    triggerPreview(rm&&rm._quality||'draft');
}

function renderBodyCards(){
  const row = document.getElementById('shapeCardRow');
  if(!row) return;
  // Close any open dropdown (will be re-attached fresh on next click).
  _closeRecipeDropdown();
  // Dissolve any weld group that has fallen below 2 members.
  for(const gid of [...weldGroups.keys()]){
    const mem = groupMembers(gid);
    if(mem.length < 2){ for(const id of mem) bodyGroup.delete(id); weldGroups.delete(gid); }
  }
  // Cell size is neutralized while the active body is welded (the union bakes at
  // a fixed scale). Disable the input so it reads as inert rather than ignored.
  const _cellInWeld = !!(activeBodyId && bodyGroup.get(activeBodyId) && groupMembers(bodyGroup.get(activeBodyId)).length>=2);
  const _cellInp = document.getElementById('shapeCellSizeMm');
  if(_cellInp){ _cellInp.disabled = _cellInWeld; _cellInp.title = _cellInWeld ? 'Cell size is locked while welded — un-weld this body to adjust' : ''; }
  const cards = [];
  const emitted = new Set();
  // One card per body in bodyOrder; consecutive members of a weld group are
  // wrapped in a .weldGroup container (rendered once, when first encountered).
  for(const bodyId of bodyOrder){
    const b = bodies.get(bodyId);
    if(!b) continue;
    const gid = bodyGroup.get(bodyId);
    if(gid && weldGroups.has(gid)){
      if(emitted.has(gid)) continue;
      emitted.add(gid);
      const mem = groupMembers(gid);
      const col = weldGroupColor(gid);
      const letter = weldGroupLetter(gid);
      const fillet = (groupFilletMm(gid)||0).toFixed(2);
      const memHtml = mem.map(buildBodyCardHTML).join('');
      cards.push(`
        <div class="weldGroup" data-group="${gid}" style="--wg-rail:${col};--wg-bg:color-mix(in srgb, ${col} 7%, transparent);--wg-border:color-mix(in srgb, ${col} 30%, var(--border))">
          <div class="wg-head">
            <span class="wg-label"><span class="wg-lk">⛓</span>WELD ${letter}</span>
            <span class="wg-count">${mem.length} → 1 part</span>
            <span class="wg-fillet" data-group="${gid}"><span class="wg-arc">⌒</span><input type="text" value="${fillet}" data-group="${gid}"> mm</span>
          </div>
          <div class="wg-members">${memHtml}</div>
        </div>`);
    } else {
      cards.push(buildBodyCardHTML(bodyId));
    }
  }
  // Optional "in progress" card for an import that's loading or errored.
  if(_pendingImport){
    const cls = _pendingImport.state === 'loading' ? 'loading' : 'err';
    const safeName = String(_pendingImport.name||'').replace(/</g,'&lt;');
    const msg = _pendingImport.state === 'loading'
      ? '<div class="sc-status">loading…</div>'
      : `<div class="sc-status err">⚠ ${_pendingImport.errMsg||'failed'}</div>`;
    cards.push(`
      <div class="shapeCard ${cls}">
        <span class="sc-name">${safeName}</span>
        ${msg}
      </div>`);
  }
  // Detach drop target — only present while at least one weld group exists.
  if(weldGroups.size > 0){
    cards.push(`<div class="weldDetach" id="weldDetachTile" title="Drag a body here to pull it out of its weld group">⇲ separate</div>`);
  }
  // "Add another" tile — enabled if under cap, disabled otherwise.
  const atCap = !canAddBody();
  cards.push(`
    <div class="shapeCard-add${atCap?' disabled':''}" id="addBodyTile" title="${atCap?'Body limit reached':'Drop a body file or click to browse'}">
      <span class="sca-icon">⬡</span>
      <span class="sca-lbl">${atCap?'cap reached':'add body'}</span>
      <span class="sca-cap">${bodies.size} / ${MAX_BODIES}</span>
    </div>`);
  row.innerHTML = cards.join('');
  row.style.display = (bodies.size > 0 || _pendingImport) ? 'flex' : 'none';

  // ── Existing per-card handlers (work for grouped + standalone cards) ──
  for(const card of row.querySelectorAll('.shapeCard')){
    const bid = card.getAttribute('data-body-id');
    if(!bid) continue;  // pending/error cards have no bodyId
    card.addEventListener('click', e => {
      if(e.target && e.target.closest && (e.target.closest('.sc-x') || e.target.closest('.shapeCard-recipe'))) return;
      switchActiveBody(bid);
    });
  }
  for(const xbtn of row.querySelectorAll('.sc-x')){
    const bid = xbtn.getAttribute('data-body-id');
    xbtn.addEventListener('click', e => { e.stopPropagation(); window.clearImportedShape(bid); });
  }
  for(const chip of row.querySelectorAll('.shapeCard-recipe')){
    const bid = chip.getAttribute('data-body-id');
    chip.addEventListener('click', e => { e.stopPropagation(); _openRecipeDropdown(chip, bid); });
  }
  for(const vbtn of row.querySelectorAll('.sc-vis-btn')){
    const bid = vbtn.getAttribute('data-body-id');
    vbtn.addEventListener('click', e => {
      e.stopPropagation();
      const b = bodies.get(bid);
      if(!b) return;
      const cur = b.visibility || VIS_DEFAULT;
      const next = cur === VIS_INACTIVE_SOLID ? VIS_GHOST
                 : cur === VIS_GHOST ? VIS_HIDDEN
                 : VIS_INACTIVE_SOLID;
      setBodyVisibility(bid, next);
    });
  }
  for(const pbtn of row.querySelectorAll('.sc-palette-btn')){
    const bid = pbtn.getAttribute('data-body-id');
    pbtn.addEventListener('click', e => { e.stopPropagation(); _openPalettePopover(pbtn, bid); });
  }
  const addTile = document.getElementById('addBodyTile');
  if(addTile && !atCap){
    addTile.addEventListener('click', ()=>{ const inp = document.getElementById('shapeInput'); if(inp) inp.click(); });
  } else if(addTile && atCap){
    addTile.addEventListener('click', ()=> showCapToast());
  }

  // ── Weld drag-and-drop ──
  let _wdrag = null;
  const _clearWeldHover = ()=> row.querySelectorAll('.drop-hover').forEach(el=>el.classList.remove('drop-hover'));
  const _dragId = e => _wdrag || (e.dataTransfer && e.dataTransfer.getData('text/plain')) || null;
  for(const card of row.querySelectorAll('.shapeCard[data-body-id]')){
    card.addEventListener('dragstart', e => {
      _wdrag = card.getAttribute('data-body-id');
      card.classList.add('dragging');
      if(e.dataTransfer){ e.dataTransfer.effectAllowed='move'; try{ e.dataTransfer.setData('text/plain', _wdrag); }catch(_){ } }
    });
    card.addEventListener('dragend', ()=>{ card.classList.remove('dragging'); _clearWeldHover(); _wdrag=null; });
  }
  for(const g of row.querySelectorAll('.weldGroup')){
    g.addEventListener('dragover', e => { e.preventDefault(); _clearWeldHover(); g.classList.add('drop-hover'); });
    g.addEventListener('drop', e => { e.preventDefault(); const d=_dragId(e); if(d) weldDropOnGroup(d, g.getAttribute('data-group')); });
  }
  for(const c of Array.from(row.children).filter(el=>el.classList && el.classList.contains('shapeCard') && el.getAttribute('data-body-id'))){
    c.addEventListener('dragover', e => { if(c.getAttribute('data-body-id')===_wdrag) return; e.preventDefault(); _clearWeldHover(); c.classList.add('drop-hover'); });
    c.addEventListener('drop', e => { e.preventDefault(); const d=_dragId(e); if(d) weldDropOnBody(d, c.getAttribute('data-body-id')); });
  }
  const _det = document.getElementById('weldDetachTile');
  if(_det){
    _det.addEventListener('dragover', e => { e.preventDefault(); _clearWeldHover(); _det.classList.add('drop-hover'); });
    _det.addEventListener('dragleave', ()=> _det.classList.remove('drop-hover'));
    _det.addEventListener('drop', e => { e.preventDefault(); const d=_dragId(e); if(d) weldDetach(d); });
  }
  // Fillet badge editing (click/drag on the input must not start a card drag or select).
  for(const inp of row.querySelectorAll('.wg-fillet input')){
    const gid = inp.getAttribute('data-group');
    inp.addEventListener('mousedown', e=> e.stopPropagation());
    inp.addEventListener('click', e=> e.stopPropagation());
    inp.addEventListener('change', ()=>{ const v=parseFloat(inp.value); if(!isNaN(v)&&v>=0){ weldSetFillet(gid, v); } renderBodyCards(); });
  }
}

// rc2.5: Recipe library row renderer. Reads from recipes Map + recipeOrder.
// Each chip shows family-colored dot, name, and usage count. × removes recipe.
// "+" tile triggers the main file input for JSON drops.
function renderRecipeLibrary(){
  const row = document.getElementById('recipeLibraryRow');
  if(!row) return;
  const chips = [];
  for(const recipeId of recipeOrder){
    const r = recipes.get(recipeId);
    if(!r) continue;
    const col = familyColor(r.family);
    const label = (FAMILY_LABEL[r.family]||r.family).toLowerCase() + ' · ' + String(r.subtype||'').toLowerCase();
    const safeName = String(r.filename||label).replace(/</g,'&lt;');
    const usage = getRecipeUsageCount(recipeId);
    chips.push(`
      <div class="libraryChip" data-recipe-id="${recipeId}" style="border-color:${col}">
        <button class="lc-x" data-recipe-id="${recipeId}" title="remove">&#10005;</button>
        <div class="lc-row">
          <span class="lc-dot" style="background:${col}"></span>
          <span class="lc-name">${label}</span>
        </div>
        <div class="lc-usage" style="color:${col}">used ${usage}×</div>
      </div>`);
  }
  // "+" drop tile — clicking opens the main JSON file input.
  const atCap = !canAddRecipe();
  chips.push(`
    <div class="libraryChip-add${atCap?' disabled':''}" id="addRecipeTile" title="${atCap?'Recipe limit reached':'Drop a JSON recipe or click to browse'}">
      <span class="lca-icon">+</span>
      <span class="lca-lbl">${atCap?'cap':'add recipe'}</span>
    </div>`);
  row.innerHTML = chips.join('');
  row.style.display = (recipes.size > 0) ? 'flex' : 'none';

  // Library chip click → open dropdown that ALSO lets you preview/assign to active body.
  // For now, simple behavior: click the chip body to assign to active body.
  for(const chip of row.querySelectorAll('.libraryChip')){
    const rid = chip.getAttribute('data-recipe-id');
    chip.addEventListener('click', e => {
      if(e.target && e.target.closest && e.target.closest('.lc-x')) return;
      // Assigning to active body switches the preview to that body's recipe.
      if(activeBodyId !== null){
        assignRecipeToBody(activeBodyId, rid);
      }
    });
  }
  for(const xbtn of row.querySelectorAll('.lc-x')){
    const rid = xbtn.getAttribute('data-recipe-id');
    xbtn.addEventListener('click', e => {
      e.stopPropagation();
      removeRecipe(rid);
    });
  }
  const addTile = document.getElementById('addRecipeTile');
  if(addTile && !atCap){
    addTile.addEventListener('click', ()=>{
      const inp = document.getElementById('fileInput');
      if(inp) inp.click();
    });
  }
}

// rc2.5: Open the recipe-selector dropdown anchored to a card's recipe chip.
let _activeDropdownEl = null;
function _closeRecipeDropdown(){
  if(_activeDropdownEl && _activeDropdownEl.parentNode){
    _activeDropdownEl.parentNode.removeChild(_activeDropdownEl);
  }
  _activeDropdownEl = null;
  document.removeEventListener('mousedown', _onDropdownOutsideClick, true);
}
function _onDropdownOutsideClick(e){
  if(_activeDropdownEl && !_activeDropdownEl.contains(e.target)){
    _closeRecipeDropdown();
  }
}
// rc3.5: Reserved assignment value meaning "this body is solid, no lattice."
// Stored in the assignments Map as a string sentinel — code that consumes
// assignments must distinguish it from valid recipeIds. The literal string
// 'solid' is safer than null/undefined because it survives JSON round-trips
// and is unambiguous in logging.
const SOLID_SENTINEL = 'solid';
function isSolidAssignment(rid){ return rid === SOLID_SENTINEL; }
// Color used for solid bodies in both active and ghost rendering. Mid-gray
// reads as "solid material, no scaffold" without being too bright against
// the dark canvas. Was #cccccc in initial rc3.5 — toned down for legibility.
const SOLID_COLOR_HEX = '#a0a0a0';

// rc3.6: Per-body visibility state for inactive bodies. The active body
// always renders fully; non-active bodies render according to this state.
//   'inactive-solid' — opaque rendering (body surface + color, no lattice)
//   'ghost'          — translucent envelope (today's rc3 behavior)
//   'hidden'         — does not render in the canvas at all
// Default for new bodies is 'inactive-solid' (per user decision rc3.6).
const VIS_INACTIVE_SOLID = 'inactive-solid';
const VIS_GHOST          = 'ghost';
const VIS_HIDDEN         = 'hidden';
const VIS_DEFAULT        = VIS_INACTIVE_SOLID;

// rc3.6: 16-swatch palette for per-body color override. Chosen to span hue
// while staying within the brand palette feel — mostly muted, no neons.
// The first swatch (null) is the "reset to family default" option.
const COLOR_PALETTE = [
  null,        // reset → use family / solid color
  '#5ecaa5',   // tpms green (family default)
  '#ea7050',   // noise terracotta (family default)
  '#a8a59a',   // grain warm gray (family default)
  '#b8cf50',   // beam olive (family default)
  '#d97706',   // wave amber (family default)
  '#22d3ee',   // cyan
  '#7c6ff7',   // purple
  '#f59e0b',   // amber
  '#ef4444',   // red
  '#ec4899',   // pink
  '#84cc16',   // lime
  '#06b6d4',   // teal
  '#3b82f6',   // blue
  '#f97316',   // orange
  '#a855f7',   // violet
  '#ffffff'    // white (high contrast)
];

function _openRecipeDropdown(anchor, bodyId){
  _closeRecipeDropdown();
  const dd = document.createElement('div');
  dd.className = 'recipeDropdown';
  const currentRid = assignments.get(bodyId);
  const items = [];
  // rc3.5: "solid" entry at the top of every dropdown. Always available,
  // never depends on the library having recipes. Separated from real recipes
  // by a thin divider when recipes are present.
  const isSolidCurrent = isSolidAssignment(currentRid);
  items.push(`
    <div class="rd-item rd-solid${isSolidCurrent?' current':''}" data-recipe-id="${SOLID_SENTINEL}">
      <span class="rd-dot" style="background:${SOLID_COLOR_HEX}"></span>
      <span class="rd-name" style="color:${SOLID_COLOR_HEX}">solid (no lattice)</span>
    </div>`);
  if(recipes.size > 0){
    items.push('<div class="rd-divider"></div>');
    for(const rid of recipeOrder){
      const r = recipes.get(rid);
      if(!r) continue;
      const col = familyColor(r.family);
      const label = (FAMILY_LABEL[r.family]||r.family).toLowerCase() + ' · ' + String(r.subtype||'').toLowerCase();
      const isCurrent = (rid === currentRid);
      items.push(`
        <div class="rd-item${isCurrent?' current':''}" data-recipe-id="${rid}">
          <span class="rd-dot" style="background:${col}"></span>
          <span class="rd-name" style="color:${col}">${label}</span>
        </div>`);
    }
  }
  dd.innerHTML = items.join('');
  document.body.appendChild(dd);
  // Position the dropdown just below the anchor chip.
  const rect = anchor.getBoundingClientRect();
  dd.style.left = rect.left + 'px';
  dd.style.top  = (rect.bottom + 4) + 'px';
  // Wire clicks. rc3.5: solid entry → assignSolidToBody, recipe → assignRecipeToBody.
  for(const item of dd.querySelectorAll('.rd-item')){
    const rid = item.getAttribute('data-recipe-id');
    item.addEventListener('click', e => {
      e.stopPropagation();
      _closeRecipeDropdown();
      if(rid === SOLID_SENTINEL){
        assignSolidToBody(bodyId);
      } else {
        assignRecipeToBody(bodyId, rid);
      }
    });
  }
  _activeDropdownEl = dd;
  // Close on outside click (next tick so the opening click doesn't fire it).
  setTimeout(()=>{
    document.addEventListener('mousedown', _onDropdownOutsideClick, true);
  }, 0);
}

// rc3.6: 4×4 palette popover anchored to a card's palette button. Clicking
// a swatch sets the body's colorHex override. The first swatch (null) resets
// to family / solid default. Uses the same outside-click close mechanic as
// the recipe dropdown.
function _openPalettePopover(anchor, bodyId){
  _closeRecipeDropdown();
  const dd = document.createElement('div');
  dd.className = 'recipeDropdown palettePopover';
  const b = bodies.get(bodyId);
  const currentHex = b && b.colorHex;
  const swatchesHtml = COLOR_PALETTE.map((hex, idx) => {
    const isReset = (hex === null);
    const isCurrent = (isReset && !currentHex) || (hex && hex.toLowerCase() === (currentHex||'').toLowerCase());
    const bg = isReset ? 'transparent' : hex;
    const border = isCurrent ? '#22d3ee' : (isReset ? 'var(--border)' : 'rgba(255,255,255,0.1)');
    const label = isReset ? '↺' : '';
    return `
      <button class="pp-swatch${isCurrent?' current':''}"
              data-hex="${hex||''}"
              title="${isReset?'Reset to default':hex}"
              style="background:${bg};border-color:${border}">
        ${label}
      </button>`;
  }).join('');
  dd.innerHTML = `<div class="pp-grid">${swatchesHtml}</div>`;
  document.body.appendChild(dd);
  const rect = anchor.getBoundingClientRect();
  dd.style.left = rect.left + 'px';
  dd.style.top  = (rect.bottom + 4) + 'px';
  for(const swatch of dd.querySelectorAll('.pp-swatch')){
    const hex = swatch.getAttribute('data-hex') || null;
    swatch.addEventListener('click', e => {
      e.stopPropagation();
      _closeRecipeDropdown();
      setBodyColor(bodyId, hex);
    });
  }
  _activeDropdownEl = dd;
  setTimeout(()=>{
    document.addEventListener('mousedown', _onDropdownOutsideClick, true);
  }, 0);
}

// rc3.5: Assign the solid sentinel to a body. Same flow as assignRecipeToBody
// but routes through the solid rendering path instead of a recipe lookup.
function assignSolidToBody(bodyId){
  if(!bodies.has(bodyId)) return;
  assignments.set(bodyId, SOLID_SENTINEL);
  // Auto-switch active to this body so user sees the result (per decision 3).
  if(bodyId !== activeBodyId){
    switchActiveBody(bodyId);
  } else {
    // Already active — rebuild preview directly.
    syncCurrentRecipeFromActiveBody();
    if(rm) reloadActiveRecipeIntoPreview();
    renderBodyCards();
    renderRecipeLibrary();
  }
  // Refresh ghost colors (this body's ghost color may have changed).
  syncGhostsToRaymarcher();
}

window.clearImportedShape=function(bodyId){
  // rc2: bodyId is passed from the card × button. If absent (legacy callers),
  // falls back to the active body (matches rc1 behavior).
  clearActiveBody(bodyId);
  _assertModeAInvariants('after-clearImportedShape');
  clearShapeWire();
  // If no bodies remain, hide overlays. Otherwise the surviving active body
  // keeps the overlays visible with its own cell size + transform.
  if(bodies.size === 0){
    const cellOv=document.getElementById('cellOverlay');if(cellOv)cellOv.style.display='none';
    const xfOv=document.getElementById('structXformOverlay');if(xfOv)xfOv.style.display='none';
    resetStructureTransform();
    setShapeUI('idle');
    // Reset raymarcher to cube mode and re-bake the periodic field.
    if(rm) rm.clearShape();
    if(currentRecipe) triggerPreview(rm&&rm._quality||'low');
  } else {
    // A new active body was promoted inside clearActiveBody. Re-render cards.
    renderBodyCards();
    if(currentRecipe) triggerPreview(rm&&rm._quality||'low');
  }
  updateExportEstimate();
};
