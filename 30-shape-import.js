/* ============================================================
   F13LD.mesh · 30-shape-import.js
   Body file intake: STL / OBJ / 3MF / STEP / IGES → flat position + index arrays.
   ============================================================ */
'use strict';

// ── Lazy-load occt-import-js (only when STEP/IGES dropped) ───────────────
async function getOCCT(){
  if(occtModule) return occtModule;
  await new Promise((res, rej)=>{
    const s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/dist/occt-import-js.js';
    s.onload=res; s.onerror=()=>rej(new Error('Failed to load occt-import-js'));
    document.head.appendChild(s);
  });
  // Global is 'occtimportjs' (lowercase) per official docs — not OcctImportJs
  if(typeof window.occtimportjs !== 'function')
    throw new Error('occt-import-js loaded but occtimportjs() not found — check CDN version');
  occtModule = await window.occtimportjs();
  return occtModule;
}

// ── Extract flat position + index arrays from any Three.js geometry ───────
function geometryToArrays(geo){
  if(!geo.attributes.position) return null;
  // STL (and some OBJ) files have unwelded vertices — every triangle owns 3 unique
  // verts with no sharing. Manifold requires welded topology or it throws ManifoldError.
  // mergeVertices() welds coincident vertices and produces a proper indexed geometry.
  const welded = mergeVertices(geo, 1e-6); // 1 micron tolerance
  console.log(`[F13LD.mesh] mergeVertices: ${geo.attributes.position.count} → ${welded.attributes.position.count} verts`);
  const pos = Array.from(welded.attributes.position.array);
  const idx = welded.index ? Array.from(welded.index.array)
    : Array.from({length: pos.length/3}, (_,i) => i);
  return {pos, idx};
}

function mergeArrays(list){
  const allPos=[], allIdx=[];
  let offset=0;
  // v0.8.1: plain loops — push(...array) hits the engine's argument limit
  // and threw "Maximum call stack size exceeded" on meshes with ~60k+ vertices.
  for(const {pos,idx} of list){
    for(let k=0;k<pos.length;k++) allPos.push(pos[k]);
    for(let k=0;k<idx.length;k++) allIdx.push(idx[k]+offset);
    offset += pos.length/3;
  }
  return {pos:allPos, idx:allIdx};
}

function groupToArrays(obj){
  const list=[];
  obj.traverse(child=>{
    if(child.isMesh && child.geometry){
      const r=geometryToArrays(child.geometry);
      if(r) list.push(r);
    }
  });
  return mergeArrays(list);
}

// ── Compute shape bounding box (mm). Returns bbox + a display-only normaliser ──
function computeShapeBbox(pos){
  let mnx=Infinity,mny=Infinity,mnz=Infinity,mxx=-Infinity,mxy=-Infinity,mxz=-Infinity;
  for(let i=0;i<pos.length;i+=3){
    if(pos[i]<mnx)mnx=pos[i]; if(pos[i]>mxx)mxx=pos[i];
    if(pos[i+1]<mny)mny=pos[i+1]; if(pos[i+1]>mxy)mxy=pos[i+1];
    if(pos[i+2]<mnz)mnz=pos[i+2]; if(pos[i+2]>mxz)mxz=pos[i+2];
  }
  const cx=(mnx+mxx)/2, cy=(mny+mxy)/2, cz=(mnz+mxz)/2;
  const dx=mxx-mnx, dy=mxy-mny, dz=mxz-mnz;
  const maxDim=Math.max(dx,dy,dz,0.001);
  const bboxStr=`${dx.toFixed(1)}×${dy.toFixed(1)}×${dz.toFixed(1)} mm`;
  // v0.6.4: pad the sampling box so the surface is strictly interior. A tight
  // box leaves the rounded caps tangent to the boundary plane, where the grid
  // has no outside (positive) sample beyond the surface — trilinear recon then
  // clamps flat to the box face, the side-wall bumps. ~6% margin (>=3 texels at
  // N=48/64) gives the interpolation outside samples on the far side. Only the
  // sampled extents (mnx..mxz, consumed by the bake + shader uvw) are padded;
  // reported dims (dx/dy/dz/maxDim/bboxStr) stay the true geometry size.
  const pad=maxDim*0.06;
  return {mnx:mnx-pad,mny:mny-pad,mnz:mnz-pad,mxx:mxx+pad,mxy:mxy+pad,mxz:mxz+pad,
          cx,cy,cz,dx,dy,dz,maxDim,bboxStr};
}

// (v0.5.0-rc7) buildShapeManifold removed — main-thread Manifold object had
// no downstream consumers. Shape data flows through posArr/idxArr/sdfGrid
// only; marching cubes lives in the worker via Manifold.levelSet.

// ── Main shape file dispatcher ────────────────────────────────────────────
async function handleShapeFile(file){
  const name=file.name, ext=name.split('.').pop().toLowerCase();
  // rc2: enforce MAX_BODIES cap at entry. Reject with toast, no UI change.
  if(!canAddBody()){
    showCapToast();
    return;
  }
  setShapeUI('loading', name);
  clearShapeWire();
  // rc2: no longer clear prior body — bodies accumulate. Raymarcher rebind
  // happens on switchActiveBody / after setActiveBody in the success path.
  if(rm) rm.clearShape();
  showComputing('loading shape…','parsing file');
  try{
    let pos, idx, format;
    if(ext==='stl'){
      format='STL';
      const buf=await file.arrayBuffer();
      const geo = new STLLoader().parse(buf);
      ({pos,idx}=geometryToArrays(geo));
    } else if(ext==='obj'){
      format='OBJ';
      const text=await file.text();
      const group=new OBJLoader().parse(text);
      ({pos,idx}=groupToArrays(group));
    } else if(ext==='3mf'){
      format='3MF';
      const buf=await file.arrayBuffer();
      // ⚠ API UNCERTAIN: ThreeMFLoader may not have parseAsync — if this throws,
      // it may be .parse(buf) only; check console
      console.log('[F13LD.mesh] ThreeMFLoader: calling parseAsync…');
      let group;
      try{
        group=await new ThreeMFLoader().parseAsync(buf);
      }catch(e){
        console.warn('[F13LD.mesh] parseAsync failed, trying sync parse:', e);
        group=new ThreeMFLoader().parse(buf);
      }
      ({pos,idx}=groupToArrays(group));
    } else if(['step','stp'].includes(ext)){
      format='STEP';
      ({pos,idx}=await loadCADFormat(file,'step'));
    } else if(['iges','igs'].includes(ext)){
      format='IGES';
      ({pos,idx}=await loadCADFormat(file,'iges'));
    } else {
      throw new Error('Unsupported format: .'+ext);
    }
    if(!pos||pos.length===0) throw new Error('No geometry found in file.');
    const posArr = new Float32Array(pos);
    const idxArr = new Uint32Array(idx);
    const tris=Math.floor(idxArr.length/3);
    // rc3.5: Multi-body coordinate handling. The first imported body captures
    // its CAD bbox center as sceneCenter — this becomes the world origin for
    // the whole assembly. All subsequent bodies translate by THIS same offset,
    // preserving the spatial relationship between bodies as they sat in CAD.
    //
    // Why not per-body centering: with multi-body, every body self-centered
    // would stack them all at origin, even when they should be touching but
    // separate in CAD space.
    //
    // importCenter still stores the offset for this body so the export path
    // can restore CAD-space vertex coordinates when writing 3MF. With shared
    // sceneCenter, importCenter is the same value across all bodies in a
    // session — they all unshift by the same amount on export, landing back
    // at their original CAD positions.
    const preBbox = computeShapeBbox(posArr);
    // First body of the session: anchor the scene origin to its bbox center.
    if(sceneCenter === null){
      sceneCenter = {x: preBbox.cx, y: preBbox.cy, z: preBbox.cz};
    }
    const importCenter = {x: sceneCenter.x, y: sceneCenter.y, z: sceneCenter.z};
    for(let i=0; i<posArr.length; i+=3){
      posArr[i]   -= importCenter.x;
      posArr[i+1] -= importCenter.y;
      posArr[i+2] -= importCenter.z;
    }
    const bbox=computeShapeBbox(posArr); // now in scene-space (relative to sceneCenter)
    setShapeUI('loading', name, null, 'building shape SDF…');
    showComputing('loading shape…','building shape SDF…');
    // v0.5.0-rc19: import bake at N=64 for snappy preview. The export path
    // re-bakes at higher N when needed (med=128, high=192, ultra=256), so
    // this only affects the live preview boundary smoothness — at 30mm
    // bbox, N=64 gives 0.47mm voxels which is fine for a raymarched preview.
    // Previous default N=128 was 2.1M voxels (~10-30s on typical hardware);
    // N=64 is 262K voxels (~1-3s).
    console.log('[F13LD.mesh] importing '+name+': '+tris.toLocaleString()+' triangles, bbox '+bbox.maxDim.toFixed(2)+'mm');
    console.time('[F13LD.mesh] preview SDF bake');
    const sdfGrid = await computeShapeSDF(posArr, idxArr, bbox, 64);
    console.timeEnd('[F13LD.mesh] preview SDF bake');
    // rc3: bake a low-resolution silhouette SDF for ghost rendering.
    // 48³ provides a smooth boundary while remaining cheap to bake and upload.
    // rc3.6: bumped from 32³ to 48³ to reduce visible voxel banding in the
    // accumulation pass — at 32³ the ~1.5mm voxels were aliasing against the
    // 40-step ray-march, producing horizontal stripe artifacts on tangent-
    // facing surfaces. 48³ × 3.4× the voxel count → still tiny in absolute
    // memory (~220 KB per ghost vs ~65 KB) but bands drop below visibility.
    console.time('[F13LD.mesh] ghost SDF bake');
    const sdfGhost = await computeShapeSDF(posArr, idxArr, bbox, 48);
    console.timeEnd('[F13LD.mesh] ghost SDF bake');
    const suggestedCell=Math.max(0.5, parseFloat((bbox.maxDim/5).toFixed(1)));
    // rc3.7: capture whether this is the first body of the session BEFORE
    // setActiveBody runs. setActiveBody now only auto-activates the first
    // body — subsequent imports leave activeBodyId pointing at whatever the
    // user already had selected.
    const wasFirstBody = (activeBodyId === null);
    // rc3.7.1: setActiveBody returns the NEW body's record, but in rc3.7 it
    // only sets that record as active when wasFirstBody is true. The legacy
    // `importedShape` singleton must continue to point at the ACTIVE body
    // — not the just-imported one. Otherwise downstream code (the scaffold
    // field bake especially) reads `importedShape.bbox` and bakes over the
    // wrong body's region, producing extrusion artifacts where rays inside
    // the active body sample outside the field's bake region.
    const newBodyRecord = setActiveBody({posArr, idxArr, bbox, sdfGrid, sdfGhost, importCenter, meta:{name,format,tris,bbox:bbox.bboxStr}});
    if(wasFirstBody){
      importedShape = newBodyRecord;
    }
    // else: importedShape stays pointing at the still-active body. Don't touch it.
    _assertModeAInvariants('after-shape-import');
    // rc3.5.2: newly-imported bodies default to SOLID. syncCurrentRecipeFromActiveBody
    // is the only path that translates that into rm.setSolidMode(true) on the GPU.
    // Without this call the card chip reads "solid" but the shader still has
    // uSolidMode = 0 from before, so the scaffold renders through. Manually
    // re-picking "solid" from the dropdown worked because assignSolidToBody()
    // calls this same function — we just weren't calling it on import.
    // rc3.7: only sync on first-body imports — subsequent imports don't change
    // which body is active, so the GPU state is already correct for whoever's
    // active. The new body just appears as a ghost.
    if(wasFirstBody){
      syncCurrentRecipeFromActiveBody();
      // Reset structure transform on every new shape (user spec: don't persist).
      resetStructureTransform();
      refreshStructureTransformUI();
    }
    const cellSizeMm=parseFloat(document.getElementById('shapeCellSizeMm')?.value)||3;
    if(rm){
      // rc3.5: pass assembly bbox so viewH spans all bodies, not just the
      // newly-imported one. Without this, importing a second body that lives
      // outside the first's extent would clip into the world cube boundary.
      // rc3.7: on first-body import, bind the new body's SDF as the active
      // shape and reset camera. On subsequent imports, rebind to the STILL-
      // ACTIVE body's SDF (not the new one) and preserve camera framing.
      const asmBbox = computeAssemblyBbox();
      if(wasFirstBody){
        rm.setShapeSDF(sdfGrid, bbox, cellSizeMm, asmBbox, /*preserveCamera=*/false);
      } else {
        // Active body unchanged — its SDF is already bound. Re-call setShapeSDF
        // with the active body's data just to refresh assembly bounds (viewH),
        // and pass preserveCamera so the user's current zoom is kept.
        const activeBody = bodies.get(activeBodyId);
        if(activeBody){
          rm.setShapeSDF(activeBody.sdfGrid, activeBody.bbox, cellSizeMm, asmBbox, /*preserveCamera=*/true);
        }
      }
      // Push (identity) transform so uniforms are initialized correctly.
      if(rm.setStructureTransform) rm.setStructureTransform(structureTransform);
      rm._dirty=true;
    }
    // rc3: refresh ghosts — the new body needs to appear as a ghost (or
    // inactive-solid per default visibility) since active didn't move to it.
    syncGhostsToRaymarcher();
    // suggestedCell is computed but NOT passed to setShapeUI — user's current
    // cell size is preserved across shape loads. Same for render quality:
    // use rm._quality (last quality the user selected) instead of hardcoded
    // 'draft', so a new shape re-bakes at the user's chosen quality and the
    // quality-button UI stays in sync.
    void suggestedCell;
    setShapeUI('ok', name, {format,tris,bbox:bbox.bboxStr}, null);
    updateExportEstimate();
    // rc3.7.2: trigger preview rebake on EVERY import, not just the first.
    // The rc3.7 optimization (only on first-body imports) caused the scaffold
    // field on GPU to go stale relative to updated shape/world uniforms after
    // subsequent imports — visible as directional banding artifacts on the
    // active body's lattice (which cleared the moment the user nudged cell
    // size and forced a re-bake). The active body's lattice geometry, density,
    // and orientation must remain identical across imports; re-baking the
    // field is the only reliable way to guarantee that.
    if(currentRecipe) triggerPreview(rm&&rm._quality||'draft');
    else hideComputing();
  } catch(e){
    // rc2: no clearActiveBody here. The failing import was never added to
    // bodies Map (setActiveBody is only called on success), so there is
    // nothing to clear. A defensive clear would now incorrectly delete a
    // valid prior body. The error UI is the only signal needed.
    _assertModeAInvariants('after-shape-import-fail');
    setShapeUI('err', name, null, e.message||String(e));
    hideComputing();
    console.error(e);
  }
}

async function loadCADFormat(file, type){
  const occt=await getOCCT();
  const buf=await file.arrayBuffer();
  const bytes=new Uint8Array(buf);
  // Result schema (Three.js-compatible per official docs):
  //   result.meshes[i].attributes.position.array — flat vertex positions
  //   result.meshes[i].index.array               — flat triangle indices
  const result=type==='step' ? occt.ReadStepFile(bytes) : occt.ReadIgesFile(bytes);
  console.log('[OCCT] success:',result.success,'meshes:',result.meshes?.length,'keys:',Object.keys(result));
  if(!result.success) throw new Error('OCCT could not parse '+type.toUpperCase()+' file.');
  const allPos=[], allIdx=[];
  let offset=0;
  for(const mesh of result.meshes||[]){
    const pos=mesh.attributes?.position?.array;
    const idx=mesh.index?.array;
    if(!pos||!idx){console.warn('[OCCT] mesh missing position/index, keys:',Object.keys(mesh));continue;}
    for(let i=0;i<pos.length;i++) allPos.push(pos[i]);
    for(let i=0;i<idx.length;i++) allIdx.push(idx[i]+offset);
    offset+=pos.length/3;
  }
  return {pos:allPos, idx:allIdx};
}
