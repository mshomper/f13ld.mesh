/* ============================================================
   F13LD.mesh · 10-state.js
   Imported-shape + multibody (Mode A) state, weld groups, ghost sync.
   ============================================================ */
'use strict';

// ── Imported shape state ──────────────────────────────────────────────────
let importedShape = null;
// importedShape = { posArr, idxArr, bbox, sdfGrid, importCenter, meta }
let occtModule = null;

// ── Mode A state (rc1 · dual-write with legacy singletons) ───────────────
// Promotes importedShape and currentRecipe to Map-keyed collections in
// preparation for multi-body / multi-recipe support (Mode A · Assembly).
//
// rc1 contract: bodies.size ≤ 1 and recipes.size ≤ 1 at all times.
// rc2 contract: bodies.size ≤ MAX_BODIES, recipes still ≤ 1 (recipe library
// arrives in rc2.5). setActiveBody now APPENDS a body rather than replacing
// the prior one; the rc1 single-active invariant is removed.
// The legacy singletons (importedShape, currentRecipe) are kept in sync via
// the set/clear helpers below — all existing read sites are untouched.
// rc2 will begin migrating read sites and remove the singleton-only invariant.
const MAX_BODIES = 8;            // hard cap; drops rejected with toast at cap
const bodies      = new Map();   // bodyId   → BodyRecord
const recipes     = new Map();   // recipeId → RecipeRecord (rc2: ≤1 entry)
const assignments = new Map();   // bodyId   → recipeId | null
const bodyOrder   = [];          // display order, separate from Map iteration
const recipeOrder = [];
let activeBodyId   = null;       // null when no shape is loaded
let activeRecipeId = null;       // null when no recipe is loaded

// rc3.5: Scene-origin coordinate fix for multi-body assemblies.
// The first body imported in a session captures its CAD-space bbox center
// as sceneCenter. Every subsequent body is translated by THIS same offset,
// preserving the spatial relationship between bodies as they sat in CAD.
// Previously each body was self-centered, which caused all bodies to stack
// at the world origin regardless of where they lived in CAD space.
// Reset behavior: cleared by clearAllBodies() and resetToDropzone().
let sceneCenter = null;          // {x,y,z} in mm; null = unset

// 8-char IDs; uuid would be overkill for ≤8 bodies/recipes per session.
function _newId(prefix){
  const u = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g,'').slice(0,8)
    : Math.random().toString(36).slice(2,10);
  return prefix + '_' + u;
}

// Promote a freshly-imported shape into the bodies Map and set as active.
// rc2: appends rather than replaces. Caller is responsible for capacity check
// via canAddBody() before invoking. Returns the same record reference so the
// caller can also assign it to the legacy importedShape singleton.
function setActiveBody(record){
  // rc3.7: only switch the active body when the scene is empty. Once an active
  // body exists, importing a new one keeps the previous active selected — the
  // user has framed and tuned that body, and a new import shouldn't yank focus
  // off of it. The new body appears in the strip and renders as a non-active
  // body (per its visibility state, default inactive-solid).
  const wasEmpty = (activeBodyId === null);
  // rc2: snapshot the prior active body's DOM-bound state into its record
  // before switching active, so we don't lose its cell/xform values.
  if(activeBodyId !== null) snapshotActiveBodyState();
  const id = _newId('body');
  record._id = id;  // stable handle for UI to reference
  // rc3.6: initialize visibility and color override. Visibility default is
  // 'inactive-solid' so non-active bodies render as opaque surfaces (less
  // visually busy than ghost mode). colorHex is null = use family default.
  if(record.visibility === undefined) record.visibility = VIS_DEFAULT;
  if(record.colorHex === undefined) record.colorHex = null;
  // v0.8.3: every body starts with its own settings. A body that had never
  // been active used to inherit the previous body's rotation / offset / iso /
  // trim when first selected (restore skipped undefined fields), and weld
  // groups assumed a 3 mm cell for it. New bodies get an identity structure
  // transform, default trim, and the cell size currently shown.
  if(record.cellSizeMm === undefined) record.cellSizeMm = parseFloat(document.getElementById('shapeCellSizeMm')?.value)||3;
  if(record.structureTransform === undefined) record.structureTransform = {rotXDeg:0,rotYDeg:0,rotZDeg:0,
    spatialOffsetMmX:0,spatialOffsetMmY:0,spatialOffsetMmZ:0,isoOffsetMm:0,rotMat:[1,0,0,0,1,0,0,0,1]};
  if(record.trimToNodes === undefined) record.trimToNodes = true;
  if(record.trimInsetMult === undefined) record.trimInsetMult = 1.0;
  bodies.set(id, record);
  bodyOrder.push(id);
  // rc3.7: only the first body becomes active. Subsequent imports leave
  // activeBodyId untouched.
  if(wasEmpty){
    activeBodyId = id;
  }
  // rc3.5: new bodies default to SOLID. User explicitly picks a recipe from
  // the dropdown to convert a body to lattice. Previously bodies auto-assigned
  // to the most-recently-loaded recipe; that workflow is now reversed since
  // real assemblies are mostly solid with selective lattice regions, and an
  // accidental import shouldn't materialize a scaffold the user didn't ask for.
  assignments.set(id, SOLID_SENTINEL);
  return record;
}

// rc2: returns true if a new body can be added (under the cap).
function canAddBody(){ return bodies.size < MAX_BODIES; }

// rc2: switch the active body to an already-imported one. Snapshots the
// outgoing body's DOM state into its record, then restores the incoming
// body's state to the DOM and re-binds the raymarcher.
function switchActiveBody(newBodyId){
  if(newBodyId === activeBodyId) return;
  if(!bodies.has(newBodyId)) return;
  // Snapshot outgoing body's DOM state.
  if(activeBodyId !== null) snapshotActiveBodyState();
  activeBodyId = newBodyId;
  // Sync legacy singleton to the new active body for unchanged read sites.
  importedShape = bodies.get(newBodyId);
  // rc2.5: Pull the new body's assigned recipe into currentRecipe. This may
  // change which recipe family is showing — if so, the preview pipeline needs
  // a full re-init (handled by reloadActiveRecipeIntoPreview below).
  const priorRecipeId = activeRecipeId;
  syncCurrentRecipeFromActiveBody();
  const recipeChanged = (activeRecipeId !== priorRecipeId);
  // Restore new body's state to the DOM (cell size, structure transform).
  restoreActiveBodyState();
  // Re-bind raymarcher to new body's SDF + cell size + transform.
  if(rm){
    const b = bodies.get(newBodyId);
    const cellMm = parseFloat(document.getElementById('shapeCellSizeMm')?.value)||3;
    // rc3.5: pass assembly bbox so viewH spans all bodies, not just active.
    const asmBbox = computeAssemblyBbox();
    rm.setShapeSDF(b.sdfGrid, b.bbox, cellMm, asmBbox);
    if(rm.setStructureTransform) rm.setStructureTransform(structureTransform);
    rm._dirty = true;
  }
  // Re-render cards + library to update active-state border + usage counts.
  renderBodyCards();
  renderRecipeLibrary();
  // rc2.5: if recipe changed, do a full recipe re-init (re-bakes lattice
  // field for the new family). Otherwise just nudge preview.
  if(recipeChanged && currentRecipe){
    reloadActiveRecipeIntoPreview();
  } else if(currentRecipe){
    triggerPreview(rm && rm._quality || 'low');
  }
  // rc3: refresh ghost list — the body that was active before is now a ghost,
  // and the new active body's ghost slot needs to be freed.
  syncGhostsToRaymarcher();
  _assertModeAInvariants('after-switchActiveBody');
}

// rc2: snapshot the current DOM-bound state (cell size, structure transform,
// trim settings) into the active body's record. Called before swapping active
// and from input change listeners.
function snapshotActiveBodyState(){
  if(activeBodyId === null) return;
  const b = bodies.get(activeBodyId);
  if(!b) return;
  const cellInp = document.getElementById('shapeCellSizeMm');
  if(cellInp) b.cellSizeMm = parseFloat(cellInp.value) || 3;
  // Deep copy of structureTransform so each body has independent state.
  b.structureTransform = {
    rotXDeg: structureTransform.rotXDeg,
    rotYDeg: structureTransform.rotYDeg,
    rotZDeg: structureTransform.rotZDeg,
    spatialOffsetMmX: structureTransform.spatialOffsetMmX,
    spatialOffsetMmY: structureTransform.spatialOffsetMmY,
    spatialOffsetMmZ: structureTransform.spatialOffsetMmZ,
    isoOffsetMm: structureTransform.isoOffsetMm,
    rotMat: structureTransform.rotMat.slice()
  };
  const trimTg = document.getElementById('trimToNodes');
  if(trimTg) b.trimToNodes = trimTg.checked;
  const trimMul = document.getElementById('trimInsetMult');
  if(trimMul) b.trimInsetMult = parseFloat(trimMul.value) || 1.0;
}

// rc2: restore the active body's saved state to the DOM inputs. Inverse of
// snapshotActiveBodyState. Called when active body changes.
function restoreActiveBodyState(){
  if(activeBodyId === null) return;
  const b = bodies.get(activeBodyId);
  if(!b) return;
  const cellInp = document.getElementById('shapeCellSizeMm');
  if(cellInp && b.cellSizeMm !== undefined) cellInp.value = b.cellSizeMm;
  if(b.structureTransform){
    structureTransform.rotXDeg = b.structureTransform.rotXDeg;
    structureTransform.rotYDeg = b.structureTransform.rotYDeg;
    structureTransform.rotZDeg = b.structureTransform.rotZDeg;
    structureTransform.spatialOffsetMmX = b.structureTransform.spatialOffsetMmX;
    structureTransform.spatialOffsetMmY = b.structureTransform.spatialOffsetMmY;
    structureTransform.spatialOffsetMmZ = b.structureTransform.spatialOffsetMmZ;
    structureTransform.isoOffsetMm = b.structureTransform.isoOffsetMm;
    structureTransform.rotMat = b.structureTransform.rotMat.slice();
    if(typeof refreshStructureTransformUI === 'function') refreshStructureTransformUI();
  }
  const trimTg = document.getElementById('trimToNodes');
  if(trimTg && b.trimToNodes !== undefined) trimTg.checked = b.trimToNodes;
  const trimMul = document.getElementById('trimInsetMult');
  if(trimMul && b.trimInsetMult !== undefined) trimMul.value = b.trimInsetMult;
}

// rc2: cap toast — transient warning when drop rejected at MAX_BODIES.
let _capToastTimer = null;
function showCapToast(msg){
  const t = document.getElementById('capToast');
  if(!t) return;
  t.textContent = msg || ('Body limit reached ('+MAX_BODIES+'). Remove a body before adding another.');
  t.classList.add('show');
  if(_capToastTimer) clearTimeout(_capToastTimer);
  _capToastTimer = setTimeout(()=>{ t.classList.remove('show'); }, 2800);
}

// rc2: Remove a body. If called with no argument, removes the active body.
// If called with a bodyId, removes that specific body. If the removed body
// was active, picks a new active (last remaining body, or null if none).
function clearActiveBody(bodyId){
  const targetId = (bodyId !== undefined) ? bodyId : activeBodyId;
  if(targetId === null || targetId === undefined) return;
  if(!bodies.has(targetId)) return;
  const wasActive = (targetId === activeBodyId);
  const priorRecipeId = activeRecipeId;
  let recipeChanged = false;
  bodies.delete(targetId);
  assignments.delete(targetId);
  bodyGroup.delete(targetId);   // v0.8.3: no stale weld membership
  const i = bodyOrder.indexOf(targetId);
  if(i >= 0) bodyOrder.splice(i, 1);
  if(wasActive){
    // Promote the last remaining body to active (most recently added),
    // or null out if no bodies remain.
    if(bodyOrder.length > 0){
      activeBodyId = bodyOrder[bodyOrder.length - 1];
      importedShape = bodies.get(activeBodyId);
      // v0.8.3: pull the promoted body's recipe / solid state onto the GPU.
      // Without this the deleted body's solid flag and recipe stayed live
      // (e.g. deleting a solid active body left the cube preview blank).
      syncCurrentRecipeFromActiveBody();
      recipeChanged = (activeRecipeId !== priorRecipeId);
      restoreActiveBodyState();
      // Re-bind raymarcher to new active body.
      if(rm){
        const b = bodies.get(activeBodyId);
        const cellMm = parseFloat(document.getElementById('shapeCellSizeMm')?.value)||3;
        // rc3.5: pass assembly bbox so viewH spans remaining bodies.
        const asmBbox = computeAssemblyBbox();
        rm.setShapeSDF(b.sdfGrid, b.bbox, cellMm, asmBbox);
        if(rm.setStructureTransform) rm.setStructureTransform(structureTransform);
        rm._dirty = true;
      }
    } else {
      activeBodyId = null;
      importedShape = null;
      syncCurrentRecipeFromActiveBody();
    }
  }
  // v0.8.3: last body gone → release the scene origin (as clearAllBodies does),
  // so the next import isn't offset by the deleted body's centre.
  if(bodyOrder.length === 0) sceneCenter = null;
  // rc3: refresh ghost list after any removal.
  if(typeof syncGhostsToRaymarcher === 'function') syncGhostsToRaymarcher();
  return {recipeChanged};
}

// rc2: Clear every body — used by error recovery paths. NOT called from
// resetToDropzone (bodies persist across recipe changes per Mode A spec).
function clearAllBodies(){
  bodies.clear();
  assignments.clear();
  bodyOrder.length = 0;
  activeBodyId = null;
  importedShape = null;
  // rc3.5: clearing all bodies releases the scene-origin anchor, so the
  // next imported body becomes the new scene origin.
  sceneCenter = null;
}

// rc3.5: setActiveRecipe appends to the library only — no auto-assignment.
// Previously (rc2.5) dropping a recipe assigned it to the active body and
// back-filled unassigned bodies. With the new "bodies default to solid"
// behavior, that auto-assign overrides the user's solid default in a way
// they probably didn't ask for. Users now explicitly pick recipes per body
// via the dropdown — the recipe library is just a palette of choices.
// Caller is responsible for capacity check via canAddRecipe() before invoking.
function setActiveRecipe(recipe){
  // rc2.5: enforce MAX_RECIPES cap. If at cap, show toast and reject.
  if(!canAddRecipe()){
    showCapToast('Recipe limit reached ('+MAX_RECIPES+'). Remove a recipe before adding another.');
    return null;
  }
  const id = _newId('recipe');
  recipe._id = id;
  recipes.set(id, recipe);
  recipeOrder.push(id);
  activeRecipeId = id;
  // No auto-assignment in rc3.5 — bodies stay solid until user picks a recipe.
  // currentRecipe is still tracked for the cube-mode preview when no body is
  // active, and for the assignment-rebuild path when a body's recipe changes.
  syncCurrentRecipeFromActiveBody();
  // rc3: recipe color changes may have affected ghost color.
  if(typeof syncGhostsToRaymarcher === 'function') syncGhostsToRaymarcher();
  return recipe;
}

// rc2.5: returns true if another recipe can be added.
const MAX_RECIPES = 8;
function canAddRecipe(){ return recipes.size < MAX_RECIPES; }

// rc2.5: recompute currentRecipe from activeBody → assignment → recipe lookup.
// This is the dual-write maintained for the 68 read sites that still reference
// the legacy currentRecipe singleton. Call after any change to activeBodyId,
// assignments, or recipes.
function syncCurrentRecipeFromActiveBody(){
  if(activeBodyId === null){
    // No active body — keep the most recently loaded recipe as currentRecipe
    // so the preview can still render a cube even with no shape.
    if(activeRecipeId !== null && recipes.has(activeRecipeId)){
      currentRecipe = recipes.get(activeRecipeId);
    } else if(recipeOrder.length > 0){
      activeRecipeId = recipeOrder[recipeOrder.length-1];
      currentRecipe = recipes.get(activeRecipeId);
    } else {
      activeRecipeId = null;
      currentRecipe = null;
    }
    // Push solid-mode off when no active body.
    if(rm && rm.setSolidMode) rm.setSolidMode(false);
    // rc3.7: clear lattice color override in cube mode.
    if(rm && rm.setBaseColor) rm.setBaseColor(null);
    return;
  }
  const rid = assignments.get(activeBodyId);
  // rc3.5: solid sentinel — body has no recipe, render as opaque solid.
  if(isSolidAssignment(rid)){
    // currentRecipe stays at whatever was last loaded (so the preview's
    // cube-mode visualization remains valid if user switches to a non-solid
    // body later), but the active body should render solid regardless.
    if(rm && rm.setSolidMode){
      // rc3.6: use the body's resolved color (respects per-body palette override).
      rm.setSolidMode(true, _hexToRGB(resolveBodyColor(activeBodyId)));
    }
    activeRecipeId = null;  // no active recipe for a solid body
    return;
  }
  // Normal recipe lookup.
  if(rid && recipes.has(rid)){
    activeRecipeId = rid;
    currentRecipe = recipes.get(rid);
  } else {
    // Active body has no valid assignment — fall back to most recent recipe
    // and assign it to this body (decision 2: "most-recently-loaded recipe").
    if(recipeOrder.length > 0){
      const fallbackId = recipeOrder[recipeOrder.length-1];
      assignments.set(activeBodyId, fallbackId);
      activeRecipeId = fallbackId;
      currentRecipe = recipes.get(fallbackId);
    } else {
      activeRecipeId = null;
      currentRecipe = null;
    }
  }
  // rc3.5: push solid-mode OFF for non-solid bodies. (Set ON above for solid.)
  if(rm && rm.setSolidMode) rm.setSolidMode(false);
  // rc3.7: push the active body's color override into the lattice base-color
  // uniform. If the user has picked a palette color, the lattice tints toward
  // it while keeping iridescent shimmer. If no override (colorHex is null),
  // pass null which sets the no-op sentinel and shader falls back to default.
  if(rm && rm.setBaseColor){
    const b = bodies.get(activeBodyId);
    if(b && b.colorHex){
      rm.setBaseColor(_hexToRGB(b.colorHex));
    } else {
      rm.setBaseColor(null);
    }
  }
}

// ── rc3 · Ghost sync ──────────────────────────────────────────────────────
// Build the ghost list from the current Mode A state and push it to the
// raymarcher. Ghost = any body that (a) isn't the active body, (b) has a
// baked sdfGhost (which all bodies do after rc3), (c) has an assigned recipe
// (so we know its family color). Call after any mutation that changes which
// bodies are ghosts or what color they should be.
function syncGhostsToRaymarcher(){
  if(!rm) return;
  if(!importedShape || !importedShape.shapeData && !(importedShape.sdfGrid)){
    // No active body — no scene to render ghosts against.
    rm.clearGhosts();
    return;
  }
  // Use active body's cell size for world-mm scaling. All bodies share world
  // coordinates because each body's bbox is in absolute CAD mm and the
  // raymarcher converts via cellSizeMm uniformly.
  const cellMm = parseFloat(document.getElementById('shapeCellSizeMm')?.value)||3;
  const ghosts = [];
  const _ag = (typeof activeGroupId==='function') ? activeGroupId() : null;
  for(const bodyId of bodyOrder){
    if(bodyId === activeBodyId) continue;
    // Members of the ACTIVE weld group are baked into the union field — don't
    // also draw them as ghosts (they'd overlap the welded mass). Bodies outside
    // the group still ghost normally, per their visibility.
    if(_ag && bodyGroup.get(bodyId)===_ag) continue;
    const b = bodies.get(bodyId);
    if(!b || !b.sdfGhost) continue;
    // rc3.6: respect per-body visibility state.
    //   'hidden'         → skip entirely
    //   'ghost'          → translucent envelope (today's rc3 behavior)
    //   'inactive-solid' → opaque rendering with body's resolved color
    const vis = b.visibility || VIS_DEFAULT;
    if(vis === VIS_HIDDEN) continue;
    // rc3.6: resolve color via priority chain (user override > family > solid).
    const hex = resolveBodyColor(bodyId);
    const color = _hexToRGB(hex);
    ghosts.push({
      bodyId, sdfGhost: b.sdfGhost, bbox: b.bbox, color,
      // rc3.6: 'solid' here means render the ghost opaquely (no transparency).
      // Distinct from the SOLID_SENTINEL assignment — this is a render-mode
      // flag, not a "this body has no lattice" flag. A ghost-mode body can
      // have a solid assignment, and an inactive-solid render mode is the
      // body-card visibility choice independent of its assignment.
      kind: (vis === VIS_INACTIVE_SOLID) ? 'solid' : 'ghost'
    });
    if(ghosts.length >= (rm.GHOST_MAX||7)) break;
  }
  if(ghosts.length === 0) rm.clearGhosts();
  else rm.setGhosts(ghosts, cellMm);
}

// Tiny hex → [r,g,b] in 0..1 helper for shader uniforms.
function _hexToRGB(hex){
  if(!hex || hex.charAt(0) !== '#') return [0.6,0.6,0.6];
  const h = hex.slice(1);
  if(h.length !== 6) return [0.6,0.6,0.6];
  return [
    parseInt(h.slice(0,2),16)/255,
    parseInt(h.slice(2,4),16)/255,
    parseInt(h.slice(4,6),16)/255
  ];
}

// rc3.5: Compute the bbox that wraps every loaded body in scene-space.
// Used to size the raymarcher's viewH so the world cube encompasses the
// whole assembly, not just the active body. Returns the active body's own
// bbox if only one body is loaded (no expansion needed).
function computeAssemblyBbox(){
  if(bodies.size === 0) return null;
  let mnx=Infinity, mny=Infinity, mnz=Infinity;
  let mxx=-Infinity, mxy=-Infinity, mxz=-Infinity;
  for(const bodyId of bodyOrder){
    const b = bodies.get(bodyId);
    if(!b || !b.bbox) continue;
    if(b.bbox.mnx < mnx) mnx = b.bbox.mnx;
    if(b.bbox.mny < mny) mny = b.bbox.mny;
    if(b.bbox.mnz < mnz) mnz = b.bbox.mnz;
    if(b.bbox.mxx > mxx) mxx = b.bbox.mxx;
    if(b.bbox.mxy > mxy) mxy = b.bbox.mxy;
    if(b.bbox.mxz > mxz) mxz = b.bbox.mxz;
  }
  return {mnx,mny,mnz,mxx,mxy,mxz};
}

// -- Weld groups (v0.7.0) - bodyGroup[bodyId]=groupId welds bodies into one part.
// Absent = standalone (exports as today). weldGroups[groupId]={filletMm}.
const weldGroups = new Map();   // groupId -> { filletMm }
const bodyGroup  = new Map();   // bodyId  -> groupId  (absent = ungrouped)
function activeGroupId(){ return activeBodyId!=null ? (bodyGroup.get(activeBodyId)||null) : null; }
function groupMembers(gid){ return bodyOrder.filter(id=>bodyGroup.get(id)===gid); }
function groupFilletMm(gid){ const g=weldGroups.get(gid); return g?g.filletMm:0; }
function computeGroupBbox(gid){
  let mnx=Infinity,mny=Infinity,mnz=Infinity,mxx=-Infinity,mxy=-Infinity,mxz=-Infinity;
  for(const id of groupMembers(gid)){
    const b=bodies.get(id); if(!b||!b.bbox) continue;
    if(b.bbox.mnx<mnx)mnx=b.bbox.mnx; if(b.bbox.mny<mny)mny=b.bbox.mny; if(b.bbox.mnz<mnz)mnz=b.bbox.mnz;
    if(b.bbox.mxx>mxx)mxx=b.bbox.mxx; if(b.bbox.mxy>mxy)mxy=b.bbox.mxy; if(b.bbox.mxz>mxz)mxz=b.bbox.mxz;
  }
  return isFinite(mnx)?{mnx,mny,mnz,mxx,mxy,mxz}:null;
}
// Build the per-body spec list for a weld group's members. ensureN re-bakes a
// member's shape SDF grid if coarser than ensureN (0 = use whatever exists).
// cloneBuffers=true slices each grid buffer (for transfer on export); false
// passes the live buffer (preview posts without a transfer list, so it is
// structure-cloned and the body's grid survives). v1: identity per-body xform;
// noise/grain lattice members need their own preview-cached fieldMin/Max and
// are not yet covered.
async function gatherGroupSpecs(gid, ensureN, cloneBuffers){
  const specs=[];
  for(const id of groupMembers(gid)){
    const b=bodies.get(id); if(!b||!b.bbox) continue;
    if((b.visibility||VIS_DEFAULT)===VIS_HIDDEN) continue;   // hidden member drops out of the weld
    if(ensureN && (!b.sdfGrid || b.sdfGrid.N<ensureN) && b.posArr && b.idxArr){
      b.sdfGrid=await computeShapeSDF(b.posArr, b.idxArr, b.bbox, ensureN);
    }
    if(!b.sdfGrid) continue;
    const rid=assignments.get(id);
    const isSolid=isSolidAssignment(rid)||!recipes.has(rid);
    const cellSizeMm=(b.cellSizeMm!=null)?b.cellSizeMm
      :((id===activeBodyId)?(parseFloat(document.getElementById('shapeCellSizeMm')?.value)||3):3);
    const buf=cloneBuffers?b.sdfGrid.data.buffer.slice(0):b.sdfGrid.data.buffer;
    // v0.5.1-rc4.1: carry the display name + recipe label (same strings the body
    // card shows) so the feature-ratio guard can name the offending member
    // instead of blaming the whole group. Two short strings per member; the
    // worker ignores them.
    const memRecipe=isSolid?null:recipes.get(rid);
    const memName=String((b.meta&&b.meta.name)||'shape');
    const memRecipeLabel=memRecipe
      ? ((FAMILY_LABEL[memRecipe.family]||memRecipe.family).toLowerCase()+
         (memRecipe.subtype?' \u00b7 '+String(memRecipe.subtype).toLowerCase():''))
      : 'solid';
    specs.push({solid:isSolid, recipe:memRecipe,
      shapeSdfData:buf, shapeN:b.sdfGrid.N,
      bbox:{mnx:b.bbox.mnx,mny:b.bbox.mny,mnz:b.bbox.mnz,mxx:b.bbox.mxx,mxy:b.bbox.mxy,mxz:b.bbox.mxz},
      cellSizeMm, name:memName, recipeLabel:memRecipeLabel});
  }
  return {specs};
}

// rc2.5: assign a specific recipe to a specific body, switch active to that
// body (per decision 3), and refresh preview + UI.
function assignRecipeToBody(bodyId, recipeId){
  if(!bodies.has(bodyId) || !recipes.has(recipeId)) return;
  assignments.set(bodyId, recipeId);
  // Auto-switch active to this body so user sees the result.
  if(bodyId !== activeBodyId){
    switchActiveBody(bodyId);  // handles currentRecipe sync internally
  } else {
    // Already active — just sync currentRecipe and rebuild preview.
    syncCurrentRecipeFromActiveBody();
    if(rm){
      // Recipe change requires preview rebuild. Use the showRecipe pipeline
      // since it does the right initialization across families.
      reloadActiveRecipeIntoPreview();
    }
    renderBodyCards();
    renderRecipeLibrary();
  }
  // rc3: another body's color may have changed; refresh ghost list.
  syncGhostsToRaymarcher();
}

// rc2.5: re-run the preview pipeline for the currently-active recipe WITHOUT
// re-appending it to the library. Used when switching active body or changing
// a body's recipe assignment — we want the full preview-init pipeline minus
// the "add this recipe to the Map" step. Mirrors the UI-update tail of
// showRecipe (typeBadge, summary, trim visibility, triggerPreview).
function reloadActiveRecipeIntoPreview(){
  if(!currentRecipe) return;
  const recipe = currentRecipe;
  // Auto-default cell-size from the family (beam; same as showRecipe).
  applyFamilyDefaultCellMm(recipe);
  // Update the type badge above the canvas.
  if(typeof typeBadge !== 'undefined' && typeBadge) applyTypeBadge(typeBadge, recipe);
  // Update the summary panel.
  if(typeof summaryEl !== 'undefined' && summaryEl && typeof renderSummary === 'function'){
    summaryEl.innerHTML=renderSummary(recipe);
  }
  // Refresh trim-toggle visibility for the new family (beam-only).
  const trimWrap=document.getElementById('trimNodesWrap');
  if(trimWrap){
    const cellOv=document.getElementById('cellOverlay');
    const shapeLoaded=cellOv&&cellOv.style.display!=='none';
    trimWrap.style.display=(shapeLoaded&&familyHasTrim(recipe))?'inline':'none';
    const trimMul=document.getElementById('trimInsetWrap');
    const trimTg=document.getElementById('trimToNodes');
    if(trimMul) trimMul.style.display=(shapeLoaded&&familyHasTrim(recipe)&&trimTg&&trimTg.checked)?'inline-flex':'none';
  }
  // Trigger preview at current quality.
  if(typeof triggerPreview === 'function'){
    triggerPreview(rm && rm._quality || 'low');
  }
  if(typeof updateExportEstimate === 'function') setTimeout(updateExportEstimate,0);
}

// rc2.5: remove a recipe from the library. Bodies assigned to it fall back
// to the most-recently-loaded remaining recipe (decision 2). If this was the
// last recipe, the bodies become unassigned (but stay in the bodies Map).
function removeRecipe(recipeId){
  if(!recipes.has(recipeId)) return;
  recipes.delete(recipeId);
  const i = recipeOrder.indexOf(recipeId);
  if(i >= 0) recipeOrder.splice(i, 1);
  // rc3.5: bodies whose recipe was removed fall back to SOLID — not silently
  // switched to another recipe. The user removed THIS recipe; assuming they
  // want the body re-flavored with an unrelated one is intrusive.
  for(const [bid, rid] of assignments){
    if(rid === recipeId){
      assignments.set(bid, SOLID_SENTINEL);
    }
  }
  // Sync currentRecipe based on the (possibly changed) active body assignment.
  syncCurrentRecipeFromActiveBody();
  // If library is now empty: with no bodies, send back to the dropzone.
  // v0.8.1: with bodies loaded, keep them (all now solid) and show the
  // empty-library state instead of deleting every body and weld group.
  if(recipes.size === 0){
    if(bodies.size === 0){
      if(typeof resetToDropzone === 'function') resetToDropzone();
    } else {
      showNoRecipeState();
    }
    return;
  }
  // Otherwise refresh UI and rebuild preview for new active recipe.
  renderRecipeLibrary();
  renderBodyCards();
  reloadActiveRecipeIntoPreview();
  // rc3: ghost colors may have changed.
  syncGhostsToRaymarcher();
}

// v0.8.1: recipe library emptied while bodies remain. Bodies stay (solid),
// the panel explains how to continue, and solid bodies can still be exported.
function showNoRecipeState(){
  if(typeof typeBadge !== 'undefined' && typeBadge){ typeBadge.className=''; typeBadge.style.cssText=''; typeBadge.textContent='NO RECIPE'; }
  if(typeof summaryEl !== 'undefined' && summaryEl){
    summaryEl.innerHTML='<div class="sec-lbl">no recipe loaded</div>'+
      '<div class="norecipe-note">Your bodies are kept and shown as solid. '+
      'Add a recipe with the <b>+ add recipe</b> tile or drop a recipe JSON anywhere, '+
      'then click its chip to fill the active body.</div>'+
      (typeof exportPanel==='function'?exportPanel():'');
  }
  const trimWrap=document.getElementById('trimNodesWrap'); if(trimWrap) trimWrap.style.display='none';
  renderRecipeLibrary();
  renderBodyCards();
  syncGhostsToRaymarcher();
  if(typeof updateExportEstimate === 'function') setTimeout(updateExportEstimate,0);
}

// rc2.5: count how many bodies have this recipe assigned.
function getRecipeUsageCount(recipeId){
  let n = 0;
  for(const rid of assignments.values()) if(rid === recipeId) n++;
  return n;
}

// rc3.6: set the visibility state of a body (inactive-solid / ghost / hidden).
// No effect on the active body's rendering — the active body always renders
// fully. Triggers a ghost-list refresh.
function setBodyVisibility(bodyId, vis){
  const b = bodies.get(bodyId);
  if(!b) return;
  if(vis !== VIS_INACTIVE_SOLID && vis !== VIS_GHOST && vis !== VIS_HIDDEN) return;
  b.visibility = vis;
  renderBodyCards();
  syncGhostsToRaymarcher();
}

// rc3.6: set a per-body color override. colorHex = null restores the family
// default (recipe family color, or SOLID_COLOR_HEX for solid bodies). Affects
// both active rendering (lattice tint or solid material) and ghost rendering
// (translucent envelope tint or inactive-solid surface color).
function setBodyColor(bodyId, colorHex){
  const b = bodies.get(bodyId);
  if(!b) return;
  b.colorHex = colorHex || null;
  // If this is the active body, the shader's solid color uniform needs to
  // refresh too. syncCurrentRecipeFromActiveBody handles that.
  if(bodyId === activeBodyId){
    syncCurrentRecipeFromActiveBody();
  }
  renderBodyCards();
  syncGhostsToRaymarcher();
}

// rc3.6: resolve the effective color for a body. Priority:
//   1. user-picked override (b.colorHex)
//   2. family color from assigned recipe
//   3. SOLID_COLOR_HEX for solid bodies
//   4. neutral gray fallback for unassigned bodies
function resolveBodyColor(bodyId){
  const b = bodies.get(bodyId);
  if(!b) return '#888888';
  if(b.colorHex) return b.colorHex;
  const rid = assignments.get(bodyId);
  if(isSolidAssignment(rid)) return SOLID_COLOR_HEX;
  if(rid && recipes.has(rid)){
    const r = recipes.get(rid);
    return familyColor(r.family);
  }
  return '#888888';
}

// rc1 verification — assertions gated by ?debug=mode-a URL flag. Cheap when
// the flag is off (one comparison, then return). Strip in rc4 when migration
// is complete and the singletons are gone.
const _modeADebug = (typeof location !== 'undefined' &&
  location.search.indexOf('debug=mode-a') >= 0);

function _assertModeAInvariants(label){
  if(!_modeADebug) return;
  // rc2.5 invariants:
  //   activeBodyId === null  ⇔  importedShape === null
  //   activeBodyId !== null  ⇒  bodies.get(activeBodyId) === importedShape
  //   bodies.size ≤ MAX_BODIES
  //   recipes.size ≤ MAX_RECIPES
  //   currentRecipe === recipes.get(activeRecipeId) (when activeRecipeId set)
  //   if both active: assignments.get(activeBodyId) → recipe matches currentRecipe
  console.assert(
    (activeBodyId === null) === (importedShape === null),
    '['+label+'] activeBodyId/importedShape null-state out of sync',
    { activeBodyId, hasImported: !!importedShape }
  );
  console.assert(
    activeBodyId === null || bodies.get(activeBodyId) === importedShape,
    '['+label+'] activeBodyId does not point to importedShape',
    { activeBodyId, bodiesSize: bodies.size }
  );
  console.assert(
    bodies.size <= MAX_BODIES,
    '['+label+'] bodies.size exceeded MAX_BODIES',
    { bodiesSize: bodies.size, max: MAX_BODIES }
  );
  console.assert(
    recipes.size <= MAX_RECIPES,
    '['+label+'] recipes.size exceeded MAX_RECIPES',
    { recipesSize: recipes.size, max: MAX_RECIPES }
  );
  console.assert(
    activeRecipeId === null || (typeof currentRecipe !== 'undefined' && recipes.get(activeRecipeId) === currentRecipe),
    '['+label+'] activeRecipeId points to a different object than currentRecipe'
  );
}

// Devtools hook — inspect new state during rc1 verification.
// Strip in rc4 when migration is complete.
if(typeof window !== 'undefined'){
  window.__f13ld_modeA = { bodies, recipes, assignments,
    bodyOrder, recipeOrder,
    get activeBodyId(){ return activeBodyId; },
    get activeRecipeId(){ return activeRecipeId; },
    assertInvariants: _assertModeAInvariants };
}
