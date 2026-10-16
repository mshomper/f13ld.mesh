/* ============================================================
   F13LD.mesh · 20-raymarcher.js
   MeshRaymarcher — WebGL2 raymarched preview (scaffold + shape + ghosts).
   v0.12.0: preview-only section (clip) plane and weld join tint.
   ============================================================ */
'use strict';

// ── MeshRaymarcher — WebGL2 raymarcher for combined scaffold + shape preview ──
// Adapted from F13LD Grain tool. Two TEXTURE_3D slots:
//   unit 0 → scaffold SDF baked to N³ grid in world [-5,5]³
//   unit 1 → shape SDF baked to N³ grid in mm (from three-mesh-bvh)
function MeshRaymarcher(canvas){
  this.canvas=canvas;
  this.gl=canvas.getContext('webgl2');
  if(!this.gl){console.error('[MeshRaymarcher] WebGL2 not available');return;}
  var gl=this.gl;
  this._khr=gl.getExtension('KHR_parallel_shader_compile')||null;
  this._pendingProg=null; this._compiling=false;
  this.prog=null; this.quadBuf=null;
  this.camZoom=16; this._dirty=false;
  this.panX=0; this.panY=0; // view-plane pan offset (Ctrl+right-drag)
  this.rotMat=this._mat3Mul(this._rotAA(0,1,0,0.7),this._rotAA(1,0,0,0.5));
  this.fieldTex=null; this.shapeTex=null;
  this.fieldMin=0; this.fieldMax=1; this.lipschitz=1.0; this.bakeN=64;
  this.topology=null;
  this.hasShape=false; this.shapeData=null; this.viewH=5.0;
  // v0.7.0: weld-group assembly render mode. When true, implicit() renders the
  // baked scaffold field DIRECTLY (no active-body shape clip, no solid short-
  // circuit, no ghosts) — the field already holds the fully-composed union.
  this._assemblyMode=false;
  this.worldMin=[-5,-5,-5]; this.worldMax=[5,5,5]; this.isPeriodic=true;
  this._quality='draft';
  // v0.13.0: grid textures by grid object, keyed field textures (LRU), scratch
  // field textures for setScaffoldField, held / last-frame scene snapshots.
  this._gridTex=new Map(); this._fieldTexLRU=new Map(); this._fieldScratch=[];
  this._held=null; this._heldAt=0; this._holdTimer=null; this._lastFrame=null;
  // v0.9.5: viewer shading options, persisted per browser.
  this.viewOpts=this._loadViewOpts(); this._interacting=false;
  this.quadBuf=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,this.quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
  this._setupInteraction();
  this._startLoop();
}
// ── v0.9.5 · Viewer shading options ───────────────────────────────────────
MeshRaymarcher.prototype.VIEW_DEFAULTS={shadows:true,occlusion:true,warmCool:true,cutFaces:true,limeEdges:false};
MeshRaymarcher.prototype._loadViewOpts=function(){
  var o=Object.assign({},this.VIEW_DEFAULTS);
  try{var j=JSON.parse(localStorage.getItem('f13ld.mesh.view')||'null');if(j&&typeof j==='object'){for(var k in o){if(typeof j[k]==='boolean')o[k]=j[k];}}}catch(e){}
  return o;
};
MeshRaymarcher.prototype.setViewOption=function(key,on){
  if(!(key in this.VIEW_DEFAULTS))return;
  this.viewOpts[key]=!!on; this._dirty=true;
  try{localStorage.setItem('f13ld.mesh.view',JSON.stringify(this.viewOpts));}catch(e){}
};
// Interaction state: soft shadows pause while orbiting/panning/zooming.
MeshRaymarcher.prototype._beginInteract=function(){this._interacting=true;};
MeshRaymarcher.prototype._endInteract=function(){if(this._interacting){this._interacting=false;this._dirty=true;}};
// v0.13.0: mm-distance grid {N, data} (shape / ghost / join SDF) as a texture,
// cached by the grid OBJECT and uploaded on first use only. A grid's data must
// not be rewritten in place (bodies replace sdfGrid / sdfGhost with new objects).
// Shape SDF: R16F stores raw mm distances directly. LINEAR filtering of
// R16F is core WebGL 2.0 — no extension dependency. Precision is ~0.01mm
// at SDF=10mm range (vs R8's 0.09mm), which eliminates the gradient step-
// wise noise responsible for specular speckle on cap surfaces. R16F range
// (±65504) comfortably exceeds any realistic shape bbox distance.
MeshRaymarcher.prototype._texForGrid=function(grid){
  var gl=this.gl; if(!gl||!grid) return null;
  if(!this._gridTex) this._gridTex=new Map();
  var t=this._gridTex.get(grid); if(t) return t;
  var N=grid.N; t=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D,t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
  gl.texImage3D(gl.TEXTURE_3D,0,gl.R16F,N,N,N,0,gl.RED,gl.FLOAT,grid.data);
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_R,gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_3D,null);
  this._gridTex.set(grid,t);
  return t;
};
// v0.13.0: drop cached grid textures whose grid is no longer owned by a body
// (liveGrids: Set of grid objects) and that nothing live or snapshotted draws.
MeshRaymarcher.prototype.pruneGridTextures=function(liveGrids){
  var gl=this.gl, m=this._gridTex; if(!gl||!m) return 0;
  var used=new Set();
  function addArr(a){ if(a) for(var i=0;i<a.length;i++) if(a[i]) used.add(a[i]); }
  function addState(o){ if(!o) return; if(o.shapeTex) used.add(o.shapeTex); addArr(o._ghostTex); addArr(o._joinTex); }
  addState(this); addState(this._held); addState(this._lastFrame);
  var drop=[];
  m.forEach(function(t,g){ if(!(liveGrids&&liveGrids.has(g))&&!used.has(t)) drop.push(g); });
  for(var i=0;i<drop.length;i++){ gl.deleteTexture(m.get(drop[i])); m.delete(drop[i]); }
  return drop.length;
};
// v0.13.0: scaffold raw field to R8 bytes (the one place for this conversion).
// Scaffold raw field: R8. (A v0.7.x R16F experiment regressed cube/periodic
// previews — a filterable half-float 3D texture with REPEAT wrap at NPOT grid
// sizes tiles inconsistently across drivers, whereas R8 UNORM is reliable.
// Reverted. Field varies smoothly and topology is applied in shader, so 8-bit
// is fine here.) Any future precision bump must be scoped to the non-tiled
// assembly field only and validated in isolation.
MeshRaymarcher.prototype._fieldToR8=function(data,N,minV,maxV){
  var range=Math.max(maxV-minV,1e-6);
  var bytes=new Uint8Array(N*N*N);
  for(var i=0;i<data.length;i++)bytes[i]=Math.round(Math.max(0,Math.min(1,(data[i]-minV)/range))*255);
  return bytes;
};
// v0.13.0: upload a field into tex (created when null); returns the texture.
// hi16: weld (assembly) fields only — stored normalized in R16F with clamped
// edges, so thin walls over a large weld box survive the precision the 8-bit
// tiled path loses (the shader decodes both the same way, t*(max-min)+min).
MeshRaymarcher.prototype._uploadFieldTex=function(tex,data,N,minV,maxV,hi16){
  var gl=this.gl;
  if(!tex) tex=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D,tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);   // rows of any width (8-bit rows of N bytes)
  if(hi16){
    var range=Math.max(maxV-minV,1e-6), f=new Float32Array(N*N*N);
    for(var q=0;q<f.length;q++) f[q]=(data[q]-minV)/range;
    gl.texImage3D(gl.TEXTURE_3D,0,gl.R16F,N,N,N,0,gl.RED,gl.FLOAT,f);
    gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_R,gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_3D,null);
    return tex;
  }
  var bytes=this._fieldToR8(data,N,minV,maxV);
  gl.texImage3D(gl.TEXTURE_3D,0,gl.R8,N,N,N,0,gl.RED,gl.UNSIGNED_BYTE,bytes);
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  // REPEAT so hardware LINEAR filtering interpolates continuously across
  // period boundaries. Periodic scaffolds pass raw uvw to the sampler (no
  // fract()); non-periodic scaffolds clamp uvw to [0,1] in the shader so
  // REPEAT here is a no-op for them. Using CLAMP_TO_EDGE would flatten the
  // field in the half-voxel skin along each boundary plane and create a
  // discontinuity the ray marcher can't traverse cleanly.
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_S,gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_T,gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_R,gl.REPEAT);
  gl.bindTexture(gl.TEXTURE_3D,null);
  return tex;
};
// v0.13.0: true when the held or last-frame snapshot draws this field texture.
MeshRaymarcher.prototype._snapHasField=function(t){
  return !!t&&((this._held&&this._held.fieldTex===t)||(this._lastFrame&&this._lastFrame.fieldTex===t));
};
// v0.13.0: make tex the scaffold field and set everything that goes with it.
MeshRaymarcher.prototype._applyField=function(tex,data,N,fieldMin,fieldMax,lipschitz,topology){
  this.fieldTex=tex; this._dirty=true;
  // v0.10.0: kept for the part-prep live estimate (53-part-prep.js).
  this._fieldData=data;
  if(typeof ppScheduleEstimate==='function') ppScheduleEstimate();
  this.fieldMin=fieldMin; this.fieldMax=fieldMax;
  this.lipschitz=lipschitz; this.bakeN=N;
  this.topology=topology||null;
};
MeshRaymarcher.prototype.setScaffoldField=function(data,N,fieldMin,fieldMax,lipschitz,topology){
  // v0.13.0: alternate scratch textures, never one the live or a snapshot frame
  // draws. If both are busy, the not-yet-drawn current one is rewritten in
  // place; a third is made only when that one is snapshotted too.
  var sc=this._fieldScratch||(this._fieldScratch=[]), tex=null, i;
  for(i=0;i<sc.length&&!tex;i++){ if(sc[i]!==this.fieldTex&&!this._snapHasField(sc[i])) tex=sc[i]; }
  if(!tex&&sc.length>=2){ for(i=0;i<sc.length&&!tex;i++){ if(sc[i]===this.fieldTex&&!this._snapHasField(sc[i])) tex=sc[i]; } }
  if(tex) this._uploadFieldTex(tex,data,N,fieldMin,fieldMax);
  else { tex=this._uploadFieldTex(null,data,N,fieldMin,fieldMax); sc.push(tex); }
  this._applyField(tex,data,N,fieldMin,fieldMax,lipschitz,topology);
};
// v0.13.0: keyed field cache. r = {data,N,fieldMin,fieldMax,lipschitz,topology,hi16?}.
// A cached key binds without re-upload; LRU over FIELD_TEX_MAX textures.
MeshRaymarcher.prototype.FIELD_TEX_MAX=12;
MeshRaymarcher.prototype.useField=function(key,r){
  if(!this.gl||!r) return;
  var lru=this._fieldTexLRU||(this._fieldTexLRU=new Map());
  key=String(key);
  var tex=lru.get(key);
  if(tex){ lru.delete(key); lru.set(key,tex); }
  else { tex=this._uploadFieldTex(null,r.data,r.N,r.fieldMin,r.fieldMax,!!r.hi16); lru.set(key,tex); }
  this._applyField(tex,r.data,r.N,r.fieldMin,r.fieldMax,r.lipschitz,r.topology);
  this._evictFields();
};
// Oldest first; skips the live field and snapshot fields (cache may run over then).
MeshRaymarcher.prototype._evictFields=function(){
  var lru=this._fieldTexLRU, gl=this.gl; if(!lru||!gl) return;
  var over=lru.size-this.FIELD_TEX_MAX; if(over<=0) return;
  var self=this, drop=[];
  lru.forEach(function(t,k){ if(drop.length<over&&t!==self.fieldTex&&!self._snapHasField(t)) drop.push(k); });
  for(var i=0;i<drop.length;i++){ gl.deleteTexture(lru.get(drop[i])); lru.delete(drop[i]); }
};
MeshRaymarcher.prototype.setShapeSDF=function(sdfGrid,bbox,cellSizeMm,assemblyBbox,preserveCamera){
  var d=sdfGrid;
  this.shapeTex=this._texForGrid(d); this._dirty=true;
  // rc3.5: viewH sizes from the assembly union bbox if provided, otherwise
  // from the single-body bbox (legacy single-body / single-active behavior).
  // The cube the raymarcher renders into must encompass every body in the
  // scene, not just the active one — otherwise ghosts outside the active
  // body's extent get clipped.
  var sizeBbox = assemblyBbox || bbox;
  // reach-from-origin (not half-span): the render cube is hard-centered on the
  // origin, and a multi-body assembly's centroid is generally NOT at the origin
  // (sceneCenter pins the FIRST body's center there). Sizing by half-span lets
  // the far body overflow the cube and get sliced flat by a cube face. Using the
  // max absolute coordinate guarantees the origin-centered cube contains every
  // body wherever it sits. No geometry is moved — export positions are intact.
  var _reach = Math.max(Math.abs(sizeBbox.mnx),Math.abs(sizeBbox.mxx),
                        Math.abs(sizeBbox.mny),Math.abs(sizeBbox.mxy),
                        Math.abs(sizeBbox.mnz),Math.abs(sizeBbox.mxz));
  var maxDim = 2*_reach;   // effective span so downstream maxDim/2 == reach
  var newViewH = Math.ceil(maxDim/2*(10/cellSizeMm)*1.05); // 5% padding
  // rc3.7: preserveCamera = true means "user is already framed at a comfortable
  // zoom; don't reset to fit-the-new-shape." Used when importing a second+
  // body in a multi-body assembly — the user has tuned the view and we
  // shouldn't yank it. The viewH itself still updates (the world cube must
  // still encompass everything), but camZoom is left at the user's current
  // value, scaled proportionally if viewH grew so the framing stays valid.
  if(preserveCamera && this.hasShape){
    if(this.viewH > 0 && newViewH > 0){
      var oldViewH = this.viewH;
      // Scale current zoom so framing stays relative — if viewH grew 20%,
      // zoom also grows 20% so the user keeps the same view at the same
      // visual scale.
      this.camZoom = this.camZoom * (newViewH / oldViewH);
      // Pan offset lives in the same view-plane scale as zoom, so scale it
      // proportionally too — otherwise a tuned multi-body view drifts on import.
      this.panX = (this.panX||0) * (newViewH / oldViewH);
      this.panY = (this.panY||0) * (newViewH / oldViewH);
    }
    this.viewH = newViewH;
  } else {
    this.viewH = newViewH;
    this.camZoom = this.viewH * 3.2;
    this.panX = 0; this.panY = 0; // fresh fit — recenter
  }
  this.shapeData={
    N:d.N, sdfMin:d.sdfMin, sdfMax:d.sdfMax,
    bboxMin:[bbox.mnx,bbox.mny,bbox.mnz],
    bboxSize:[bbox.mxx-bbox.mnx,bbox.mxy-bbox.mny,bbox.mxz-bbox.mnz],
    // rc3.5: cache the assembly maxDim so setCellSize can rescale viewH
    // without needing the caller to re-supply the assembly bbox.
    assemblyMaxDim: maxDim,
    cellSizeMm:cellSizeMm
  };
  this.hasShape=true;
};
MeshRaymarcher.prototype.setCellSize=function(cellSizeMm){
  // Live update when the user changes the cell-size input. No SDF re-bake —
  // the grid is in mm and doesn't depend on cell size; only the world↔mm
  // scaling (uCellSizeMm), the ray-march volume extent (viewH), and the
  // shape-SDF Lipschitz change. Camera zoom is scaled proportionally so the
  // user's current framing survives the rescale.
  if(!this.hasShape||!this.shapeData)return;
  var sd=this.shapeData;
  if(!(cellSizeMm>0)||cellSizeMm===sd.cellSizeMm)return;
  sd.cellSizeMm=cellSizeMm;
  // rc3.5: use cached assembly maxDim if present (multi-body case); otherwise
  // fall back to active body's own bbox (single-body case).
  var maxDim = (sd.assemblyMaxDim != null)
    ? sd.assemblyMaxDim
    : Math.max(sd.bboxSize[0],sd.bboxSize[1],sd.bboxSize[2]);
  var oldViewH=this.viewH;
  this.viewH=Math.ceil(maxDim/2*(10/cellSizeMm)*1.05);
  var zoomLo=this.viewH*0.3,zoomHi=Math.max(80,this.viewH*8);
  this.camZoom=Math.min(zoomHi,Math.max(zoomLo,this.camZoom*(this.viewH/oldViewH)));
  if(oldViewH>0){ var _pr=this.viewH/oldViewH; this.panX=(this.panX||0)*_pr; this.panY=(this.panY||0)*_pr; }
  // If a structure transform is active, recompute world-unit values since
  // mmToWorld depends on cellSizeMm.
  if(this._structXform && typeof window!=='undefined' && window.structureTransform){
    this.setStructureTransform(window.structureTransform);
  }
  this._dirty=true;
};
// v0.13.0: also releases any held view.
MeshRaymarcher.prototype.clearShape=function(){this.releaseView();this.hasShape=false;this.viewH=5.0;this.camZoom=16;this.panX=0;this.panY=0;this.worldMin=[-5,-5,-5];this.worldMax=[5,5,5];this.isPeriodic=true;this._structXform=null;this._periodicFitKey=null;this._dirty=true;};

// rc3.5: Set whether the active body renders as solid (no lattice). When
// solid is true, color is a Float32Array(3) of [r,g,b] in 0..1. Defaults
// to off (lattice rendering) until explicitly enabled.
MeshRaymarcher.prototype.setSolidMode=function(isSolid, color){
  this._solidMode = isSolid ? 1.0 : 0.0;
  this._solidColor = color || [0.8, 0.8, 0.8];
  this._dirty = true;
};
// v0.7.0: toggle weld-group assembly render mode. On = force uHasShape/
// uSolidMode/uGhostCount to 0 at draw time so the baked union field renders
// as-is. Leaves the active body's shape texture binding intact, so returning
// to a single-body preview is immediate (no re-upload).
// v0.13.0: visibility of the selected part outside a weld ('solid' draws it,
// 'ghost' / 'hidden' leave it out; syncGhostsToRaymarcher adds the ghost shell).
MeshRaymarcher.prototype.setActiveVis=function(v){
  v=(v==='ghost'||v==='hidden')?v:'solid';
  if(v!==this._activeVis){ this._activeVis=v; this._dirty=true; }
};
MeshRaymarcher.prototype.setAssemblyMode=function(on){
  this._assemblyMode = !!on;
  this._dirty = true;
};

// rc3.7: Set per-body color override for the active lattice render. Pass
// null/undefined to clear the override (v0.9.5: render falls back to the
// recipe's family color). Color is [r,g,b] in 0..1.
MeshRaymarcher.prototype.setBaseColor=function(color){
  if(color === null || color === undefined){
    // Sentinel value with negative red — shader detects this as "no override"
    // and render() substitutes the recipe family color.
    this._baseColor = [-1.0, 0.0, 0.0];
  } else {
    this._baseColor = color;
  }
  this._dirty = true;
};

// rc3 ─ Ghost envelope rendering ────────────────────────────────────────────
// Ghosts are translucent silhouettes of non-active bodies. Each ghost holds
// its own 3D texture, world-mm bbox, and family color. Up to GHOST_MAX active
// ghosts at once (one less than MAX_BODIES, since the active body uses the
// regular shape SDF slot). v0.13.0: slot textures come from the grid cache
// (_texForGrid), so a body's ghost grid is uploaded once, whatever its slot.
MeshRaymarcher.prototype.GHOST_MAX = 7;
MeshRaymarcher.prototype._initGhostState = function(){
  if(this._ghostTex) return; // already initialized
  this._ghostTex = new Array(this.GHOST_MAX).fill(null);
  this._ghostMeta = new Array(this.GHOST_MAX).fill(null);
  // _ghostMeta[i] = { bodyId, bboxMin:[3], bboxSize:[3], cellSizeMm, color:[3], N }
  this._ghostCount = 0;
};

// Set the active ghost list. Called from main thread on any change to the
// non-active body set (add, remove, swap active). ghosts is an array of
// { bodyId, sdfGhost, bbox, color:[r,g,b] (0..1) }.
// cellSizeMm is the active body's cell size — ghosts share world coords with
// the active body, so this is consistent across the scene.
MeshRaymarcher.prototype.setGhosts = function(ghosts, cellSizeMm){
  this._initGhostState();
  var n = Math.min(ghosts.length, this.GHOST_MAX);
  for(var i = 0; i < n; i++){
    var g = ghosts[i];
    this._ghostTex[i] = this._texForGrid(g.sdfGhost);
    this._ghostMeta[i] = {
      bodyId: g.bodyId,
      bboxMin: [g.bbox.mnx, g.bbox.mny, g.bbox.mnz],
      bboxSize: [g.bbox.mxx-g.bbox.mnx, g.bbox.mxy-g.bbox.mny, g.bbox.mxz-g.bbox.mnz],
      cellSizeMm: cellSizeMm,
      color: g.color,
      // rc3.6: 'ghost' (translucent) or 'solid' (opaque inactive body).
      kind: g.kind || 'ghost',
      N: g.sdfGhost.N
    };
  }
  // Clear unused slots.
  for(var j = n; j < this.GHOST_MAX; j++){
    this._ghostMeta[j] = null; this._ghostTex[j] = null; // v0.13.0: let prune free it
  }
  this._ghostCount = n;
  this._dirty = true;
};

// Drop all ghosts (e.g., when last body removed or going to dropzone).
MeshRaymarcher.prototype.clearGhosts = function(){
  this._initGhostState();
  for(var i = 0; i < this.GHOST_MAX; i++){
    this._ghostMeta[i] = null; this._ghostTex[i] = null; // v0.13.0: let prune free it
  }
  this._ghostCount = 0;
  this._dirty = true;
};
MeshRaymarcher.prototype.setWorldBounds=function(wMin,wMax,isPeriodic){this.worldMin=wMin;this.worldMax=wMax;this.isPeriodic=isPeriodic!==false;this._dirty=true;};
// Fit the view cube to a periodic bake box (no-shape recipe preview). Fresh-fit
// when the cell bounds change (new recipe import); preserve the user's zoom/pan
// on re-previews of the same cell (e.g. quality changes). Shape-mode framing is
// handled separately in setShapeSDF and never calls this.
MeshRaymarcher.prototype.fitPeriodicBounds=function(wMin,wMax){
  var hx=(wMax[0]-wMin[0])*0.5,hy=(wMax[1]-wMin[1])*0.5,hz=(wMax[2]-wMin[2])*0.5;
  var newViewH=Math.max(hx,hy,hz); if(!(newViewH>0))return;
  var key=hx.toFixed(3)+','+hy.toFixed(3)+','+hz.toFixed(3);
  if(key!==this._periodicFitKey){this.viewH=newViewH;this.camZoom=newViewH*3.2;this.panX=0;this.panY=0;this._periodicFitKey=key;}
  else{this.viewH=newViewH;}
  this._dirty=true;
};
// Like fitPeriodicBounds, but sizes the (origin-centered) cube to the bounds'
// max ABSOLUTE coordinate rather than half-span — so an off-center box (e.g. a
// weld group whose centroid isn't on the origin) is fully contained instead of
// clipped by a cube face. Used by the weld preview. Geometry is not moved.
MeshRaymarcher.prototype.fitReachBounds=function(wMin,wMax){
  var rx=Math.max(Math.abs(wMin[0]),Math.abs(wMax[0]));
  var ry=Math.max(Math.abs(wMin[1]),Math.abs(wMax[1]));
  var rz=Math.max(Math.abs(wMin[2]),Math.abs(wMax[2]));
  var newViewH=Math.max(rx,ry,rz)*1.05; if(!(newViewH>0))return;
  var key='reach:'+rx.toFixed(3)+','+ry.toFixed(3)+','+rz.toFixed(3);
  if(key!==this._periodicFitKey){this.viewH=newViewH;this.camZoom=newViewH*3.2;this.panX=0;this.panY=0;this._periodicFitKey=key;}
  else{this.viewH=newViewH;}
  this._dirty=true;
};
// ── Structure SDF transform setter (v0.5.0 Phase B) ──────────────────────
// Accepts the main-thread structureTransform object (mm units, raw user iso
// sign) and converts to world units / SDF-correct iso sign for shader use.
// rotMat is passed through verbatim (no unit conversion needed for rotation).
// Pivot is the shape center in world units.
MeshRaymarcher.prototype.setStructureTransform=function(st){
  if(!this.hasShape || !this.shapeData){
    this._structXform = null;
    return;
  }
  var sd=this.shapeData;
  var mmToWorld = 10.0 / sd.cellSizeMm;
  // Pivot: shape center in mm → world units.
  var cx_mm = sd.bboxMin[0] + sd.bboxSize[0]*0.5;
  var cy_mm = sd.bboxMin[1] + sd.bboxSize[1]*0.5;
  var cz_mm = sd.bboxMin[2] + sd.bboxSize[2]*0.5;
  // Iso sign: shader does (sc + uStructIsoWorld). rawToSDF now returns
  // canonical NEGATIVE-INSIDE in both branches (v0.5.0-rc9 audit). UI says
  // +iso = thicker walls, which in canonical convention means pushing zero-
  // crossing outward, i.e. SUBTRACT iso from a negative-inside SDF. So the
  // shader uniform is -iso_mm × mmToWorld. No functional change from rc8
  // since rc8's -raw already produced negative-inside downstream of the
  // shader math; this comment block just documents the now-canonical path.
  this._structXform = {
    rotMat: st.rotMat.slice(),  // copy 9-element array
    pivot:  [cx_mm * mmToWorld, cy_mm * mmToWorld, cz_mm * mmToWorld],
    offset: [st.spatialOffsetMmX * mmToWorld,
             st.spatialOffsetMmY * mmToWorld,
             st.spatialOffsetMmZ * mmToWorld],
    iso: -st.isoOffsetMm * mmToWorld
  };
  this._dirty=true;
  if(typeof ppScheduleEstimate==='function') ppScheduleEstimate();
};
// ── v0.10.0 · Print view (53-part-prep.js → ppApplyView) ──────────────────
// cfg = null (off) or {rtColMajor (part←print rotation, column-major),
// buildDir, plateU, plateV (part-frame unit vectors), plateLevel (world),
// critCos, tint, gridStep (world units per grid line)}. The camera orbits
// in the print frame: the uploaded rot is Rᵀ·rotMat, so the part appears
// as it sits on the build plate, +Z up. snap = jump to a Z-up 3/4 view.
MeshRaymarcher.prototype.setPrintView=function(cfg,snap){
  this._printView=cfg||null;
  if(cfg && snap){
    var z=[0.9,-1.25,0.85], zl=Math.hypot(z[0],z[1],z[2]); z=[z[0]/zl,z[1]/zl,z[2]/zl];
    var y=[-z[0]*z[2],-z[1]*z[2],1-z[2]*z[2]], yl=Math.hypot(y[0],y[1],y[2]); y=[y[0]/yl,y[1]/yl,y[2]/yl];
    var x=[y[1]*z[2]-y[2]*z[1], y[2]*z[0]-y[0]*z[2], y[0]*z[1]-y[1]*z[0]];
    this.rotMat=[x[0],x[1],x[2],y[0],y[1],y[2],z[0],z[1],z[2]];
    this.panX=0; this.panY=0; this.autoRot=false;
    // pull back far enough that the plate around the part is in frame
    this.camZoom=Math.max(this.camZoom||0,(this.viewH||5)*4.6);
  }
  this._dirty=true;
  if(this.onViewChange) this.onViewChange();   // 23-view-strip.js keeps its tabs in sync
};
// ── v0.12.0 · Section (clip) plane — preview only, export never sees it ───
// cfg = null (off) or {axis:0|1|2, flip:bool, t:-1..1}. The plane is axis-
// aligned in the part frame; t slides it across the extent of the content.
// Everything on the +axis side of the plane is cut away (flip: the -axis side).
MeshRaymarcher.prototype.setClip=function(cfg){
  this._clip=cfg?{axis:cfg.axis|0,flip:!!cfg.flip,t:Math.max(-1,Math.min(1,+cfg.t||0))}:null;
  this._dirty=true;
};
// World units per mm for the current scene (cube: export domain; shape/weld: cell size).
MeshRaymarcher.prototype._worldPerMm=function(){
  if(this.hasShape&&this.shapeData&&this.shapeData.cellSizeMm>0) return 10.0/this.shapeData.cellSizeMm;
  var dm=(typeof exportDomainMm!=='undefined'&&exportDomainMm>0)?exportDomainMm:10;
  return 10.0/dm;
};
// Slider extent along an axis, in world units.
MeshRaymarcher.prototype.clipRange=function(axis){
  var H=this.viewH||5, lo=-H, hi=H, wpm=this._worldPerMm();
  // v0.14.0: one part drawn → its own box; several → the whole view box.
  var multi=!!(this._sceneGpu&&this._sceneGpu.nMembers>1);
  if(this.hasShape&&this.shapeData&&!multi){
    var sd=this.shapeData, k=10.0/sd.cellSizeMm; lo=sd.bboxMin[axis]*k; hi=(sd.bboxMin[axis]+sd.bboxSize[axis])*k;
  }
  lo=Math.max(lo,-H); hi=Math.min(hi,H);
  if(!(hi>lo)){ lo=-H; hi=H; }
  return {lo:lo,hi:hi,perMm:wpm};
};
// Plane for the shader: keep dot(p,n) <= d.  pos/posMm = plane position on the axis.
MeshRaymarcher.prototype.clipPlane=function(){
  var c=this._clip; if(!c) return null;
  var r=this.clipRange(c.axis), pos=r.lo+(c.t+1)*0.5*(r.hi-r.lo);
  var n=[0,0,0]; n[c.axis]=c.flip?-1:1;
  return {n:n,d:c.flip?-pos:pos,axis:c.axis,pos:pos,posMm:pos/r.perMm,loMm:r.lo/r.perMm,hiMm:r.hi/r.perMm};
};
// ── v0.12.0 · Weld joins tint ─────────────────────────────────────────────
// members = [{key, sdf (the body's 48³ ghost grid), bbox}], up to JOIN_MAX.
// Lattice surface where two or more members are within bandMm of their shape
// surface is tinted in the Mesh colour (assembly mode only). Pass [] to clear.
MeshRaymarcher.prototype.JOIN_MAX=4;
MeshRaymarcher.prototype.setJoins=function(members,bandMm){
  var gl=this.gl; if(!gl) return;
  members=(members||[]).slice(0,this.JOIN_MAX);
  if(!this._joinTex){ this._joinTex=new Array(this.JOIN_MAX).fill(null); this._joinMeta=new Array(this.JOIN_MAX).fill(null); }
  var changed=members.length!==(this._joinCount||0)||bandMm!==this._joinBand;
  for(var i=0;i<members.length;i++){
    var m=members[i], prev=this._joinMeta[i];
    this._joinTex[i]=this._texForGrid(m.sdf);
    if(!prev||prev.sdf!==m.sdf) changed=true;
    this._joinMeta[i]={sdf:m.sdf,bboxMin:[m.bbox.mnx,m.bbox.mny,m.bbox.mnz],
      bboxSize:[m.bbox.mxx-m.bbox.mnx,m.bbox.mxy-m.bbox.mny,m.bbox.mxz-m.bbox.mnz]};
  }
  for(var j=members.length;j<this.JOIN_MAX;j++){ this._joinMeta[j]=null; this._joinTex[j]=null; }
  this._joinCount=members.length>=2?members.length:0;
  this._joinBand=bandMm;
  if(changed) this._dirty=true;
};
MeshRaymarcher.prototype.setQuality=function(q){
  if(this._quality===q&&this.prog)return;
  this._quality=q;
  this._submitShader();
};
// ── v0.14.0 · Scene shader (P2) ───────────────────────────────────────────
// Every visible part is a MEMBER of one scene, drawn by one shader from a small
// table (std140 uniform block `Scene`, laid out in vec4s so the same bytes map
// onto a WGSL struct array later):
//   M[i*MS+0]  bbox min (mm), fill (0 solid, 1 lattice, 2 lattice + skin)
//   M[i*MS+1]  bbox max (mm), vis (0 drawn, 1 ghost shell)
//   M[i*MS+2]  Rᵀ column 0, cell (mm)          M[i*MS+3]  Rᵀ column 1, iso (mm, + = thicker)
//   M[i*MS+4]  Rᵀ column 2, skin (mm)          M[i*MS+5]  pivot P (mm), source index (-1 none)
//   M[i*MS+6]  shift (mm), cull pad (mm)        M[i*MS+7]  colour, selected (outline)
//   M[i*MS+8]  shape voxel (mm), has shape, normal step (world), group index
//   M[i*MS+9]  shape atlas offset (texels), shape grid N
//   G[g*GS+0]  fillet k (mm), rule (0 union, 1 anchor, 2 graded), anchor (mm), grade (mm)
//   G[g*GS+1]  first member, member count, grade max (mm, 0 = 0.15 × cell), show joins
//   S[j*SS+0]  box min (lattice world), atlas (0 tile, 1 region)
//   S[j*SS+1]  box size (lattice world), N      S[j*SS+2]  atlas offset (texels), Lipschitz
//   S[j*SS+3]  fieldMin, fieldMax, mid, half range
//   S[j*SS+4]  centre, half width (normalised), topology mode, half invert
//   S[j*SS+5]  raw (normalised) bake, voxel (lattice world), -, -
//   C[0] drawn members, groups, reference cell (mm), outline on
//   C[1] tile atlas size (texels), base normal step (world)
//   C[2] region atlas size (texels), total members (drawn + ghost shells)
//   C[3] join band (mm), shape atlas size (texels)
// Members [0, drawn) are ordered by group; ghost shells follow. Shapes (mm
// distance grids) live in a third atlas (R16F), one lookup per sample. Every distance is evaluated in absolute mm (as
// worker/m30 does) and converted to the scene world (mm × 10 / refCell) at the
// end, so the camera, view box, section plane and print view are unchanged.
// Sources (the bakes that remain, one per recipe tile or aperiodic region)
// live in two atlases: tiles R8 with a one-voxel wrapped border (hardware
// LINEAR filtering stays continuous across the period, like REPEAT did),
// regions R16F (clamped).
MeshRaymarcher.prototype.SC_MAXM=8;
MeshRaymarcher.prototype.SC_MAXG=8;
MeshRaymarcher.prototype.SC_MAXS=8;
MeshRaymarcher.prototype.SC_MS=10;
MeshRaymarcher.prototype.SC_GS=2;
MeshRaymarcher.prototype.SC_SS=6;
MeshRaymarcher.prototype._sceneFloats=function(){
  return (this.SC_MAXM*this.SC_MS+this.SC_MAXG*this.SC_GS+this.SC_MAXS*this.SC_SS+4)*4;
};
// variant 'single': one drawn part, no shells, no outline — the member and
// group are read at constant indices (much cheaper on drivers that unroll the
// member loops). 'multi': any scene. Both compile once per quality.
MeshRaymarcher.prototype._buildShader=function(variant){
  var steps={draft:'128',low:'256',med:'512',high:'1024',ultra:'2048'}[this._quality]||'256';
  return [
    '#version 300 es',
    'precision highp float;precision highp sampler3D;',
    '#define MAXM '+this.SC_MAXM,'#define MAXG '+this.SC_MAXG,'#define MAXS '+this.SC_MAXS,
    '#define MS '+this.SC_MS,'#define GS '+this.SC_GS,'#define SS '+this.SC_SS,
    '#define SINGLE '+(variant==='single'?1:0),
    'out vec4 fragColor;',
    'uniform vec2 res;uniform mat3 rot;uniform float zoom;uniform vec2 pan;',
    'uniform highp sampler3D uTileAtlas;uniform highp sampler3D uRegAtlas;uniform highp sampler3D uShapeAtlas;',
    'layout(std140) uniform Scene{vec4 M[MAXM*MS];vec4 G[MAXG*GS];vec4 S[MAXS*SS];vec4 C[4];};',
    'uniform float uLipschitz;uniform float uViewH;uniform float uAOCell;uniform float uPixK;',
    // ── v0.10.0 · Print view: build plate + overhang tint ─────────────────
    'uniform float uPrintOn;uniform float uTintOn;uniform vec3 uBuildDir;uniform vec3 uPlateU;uniform vec3 uPlateV;',
    'uniform float uPlateLevel;uniform float uCritCos;uniform float uWarnCos;uniform float uGridStep;uniform float uPlateAlpha;uniform float uLifted;',
    // ── v0.12.0 · Section plane ───────────────────────────────────────────
    'uniform float uClipOn;uniform vec3 uClipN;uniform float uClipD;',
    'float smooth01(float t){t=clamp(t,0.0,1.0);return t*t*(3.0-2.0*t);}',
    'float sminK(float a,float b,float k){float h=max(k-abs(a-b),0.0)/k;return min(a,b)-h*h*k*0.25;}',
    'float shapeTex(int i,vec3 uvw){vec4 a=M[i*MS+9];vec3 tc=a.xyz+clamp(uvw*a.w,vec3(0.5),vec3(a.w-0.5));return texture(uShapeAtlas,tc/C[3].yzw).r;}',
    // Member shape distance (mm, negative inside). Outside the part's box the
    // P1 lower bound max(boxDist, clampedTex - boxDist) keeps marching safe.
    'float shapeMm(int i,vec3 pm){vec3 bmn=M[i*MS].xyz,bmx=M[i*MS+1].xyz;vec3 uvw=(pm-bmn)/(bmx-bmn);',
    '  if(any(lessThan(uvw,vec3(0.0)))||any(greaterThan(uvw,vec3(1.0)))){vec3 q=max(bmn-pm,pm-bmx);float bd=length(max(q,vec3(0.0)));float dc=shapeTex(i,clamp(uvw,0.0,1.0));return max(bd,dc-bd);}',
    '  return shapeTex(i,uvw);}',
    // Lattice value of source j at lattice-world point x (decoded like the
    // P1 sampleRaw + rawToSDF), lattice-world units, negative inside.
    'float srcVal(int j,vec3 x){',
    '  vec4 s0=S[j*SS],s1=S[j*SS+1],s2=S[j*SS+2],s3=S[j*SS+3],s4=S[j*SS+4],s5=S[j*SS+5];',
    '  vec3 u=(x-s0.xyz)/s1.xyz;float N=s1.w;float t;',
    '  if(s0.w<0.5){vec3 tc=s2.xyz+1.0+fract(u)*N;t=texture(uTileAtlas,tc/C[1].xyz).r;}',
    '  else{vec3 tc=s2.xyz+clamp(clamp(u,0.0,1.0)*N,vec3(0.5),vec3(N-0.5));t=texture(uRegAtlas,tc/C[2].xyz).r;}',
    '  float raw=t*(s3.y-s3.x)+s3.x;',
    '  if(s5.x>0.5){float adj=(raw-s3.z)/s3.w-s4.x;if(s4.z<0.5)return abs(adj)-s4.y;if(s4.z<1.5)return s4.w>0.5?adj:-adj;return s4.y-abs(adj);}',
    '  return raw;}',
    // gSel: smallest shape distance (mm) over the selected members, written by
    // every scene evaluation (read right after the march's call).
    'float gSel;',
    // Member i's value (mm). term: 0 shape surface, 1 cut face of a lattice
    // (the shape clips it), 2 lattice, 3 culled (lower bound).
    'float memberF(int i,vec3 pm,float ds,vec4 g0,vec4 g1,out int term){',
    '  vec4 m0=M[i*MS],m1=M[i*MS+1],m6=M[i*MS+6],m7=M[i*MS+7],m8=M[i*MS+8];',
    '  float fill=m0.w;int rule=int(g0.y+0.5);',
    '  float aA=(rule==1&&fill>0.5)?g0.z:0.0;',
    '  float sh=-1e4;',
    '  if(m8.y>0.5){',
    '    vec3 q=max(m0.xyz-pm,pm-m1.xyz);float bd=length(max(q,vec3(0.0)));',
    '    if(bd>m6.w){term=3;if(m7.w>0.5)gSel=min(gSel,bd);return bd-aA;}',
    '    sh=shapeMm(i,pm);if(m7.w>0.5)gSel=min(gSel,sh);',
    '  }',
    '  if(fill<0.5){term=0;return sh;}',
    '  if(rule==1&&ds<-0.25*g0.z)sh-=g0.z*smooth01((-ds-0.25*g0.z)/(0.25*g0.z));',
    '  vec4 m2=M[i*MS+2],m3=M[i*MS+3],m4=M[i*MS+4],m5=M[i*MS+5];',
    '  vec3 q=pm-m5.xyz-m6.xyz;vec3 l=mat3(m2.xyz,m3.xyz,m4.xyz)*q;float cell=m2.w;',
    '  float v=srcVal(SINGLE==1?0:int(m5.w+0.5),(l+m5.xyz)*(10.0/cell));',
    '  float sm=v*cell*0.1-m3.w;',
    '  if(!(abs(sm)<1e20))sm=1e3;',
    '  if(rule==2&&ds<g0.w){float gm=g1.z>0.0?g1.z:0.15*cell;sm-=gm*smooth01(1.0-max(ds,0.0)/g0.w);}',
    '  if(fill>1.5){float f=max(sh,min(sm,-(m4.w+sh)));term=(f<=sh)?0:2;return f;}',
    '  term=(sh>=sm)?1:2;return max(sm,sh);',
    '}',
    // Scene distance (mm): smooth union inside each weld group (a standalone
    // part is a group of one), plain min between groups. hm / ht = the member
    // and term the surface belongs to.
    '#if SINGLE',
    'float sceneMm(vec3 pm,out int hm,out int ht){gSel=1e9;int tm;float f=memberF(0,pm,1e9,G[0],G[1],tm);hm=0;ht=tm;return f;}',
    '#else',
    'float sceneMm(vec3 pm,out int hm,out int ht){',
    '  float best=1e9;hm=-1;ht=0;gSel=1e9;',
    '  int nG=int(C[0].y+0.5);',
    '  for(int g=0;g<MAXG;g++){if(g>=nG)break;',
    '    vec4 g0=G[g*GS],g1=G[g*GS+1];int st=int(g1.x+0.5),cnt=int(g1.y+0.5);float k=g0.x;int rule=int(g0.y+0.5);',
    '    float ds=1e9;',
    '    if(rule>0){float reach=g0.z+g0.w+1.0;for(int a=0;a<MAXM;a++){if(a>=cnt)break;int i=st+a;if(M[i*MS].w>0.5)continue;',
    // Distance to the nearest solid member feeds the join rules only (never
    // marched), so outside a part's box it uses the export's rule (clamped
    // grid value + box distance, worker/m30) instead of the lower bound.
    '      vec3 bmn=M[i*MS].xyz,bmx=M[i*MS+1].xyz;vec3 q=max(bmn-pm,pm-bmx);float bd=length(max(q,vec3(0.0)));',
    '      ds=min(ds,bd>reach?bd:(bd>0.0?shapeTex(i,clamp((pm-bmn)/(bmx-bmn),0.0,1.0))+bd:shapeMm(i,pm)));}}',
    '    float acc=1e9,bm=1e9;int bi=-1,bt=0;',
    '    for(int a=0;a<MAXM;a++){if(a>=cnt)break;int i=st+a;int tm;float f=memberF(i,pm,ds,g0,g1,tm);',
    '      if(f<bm){bm=f;bi=i;bt=tm;}acc=(k<=1e-6)?min(acc,f):sminK(acc,f,k);}',
    '    if(acc<best){best=acc;hm=bi;ht=bt;}',
    '  }',
    '  return best;}',
    '#endif',
    'float wpm(){return 10.0/C[0].z;}',
    'float sceneW(vec3 p,out int hm,out int ht){return sceneMm(p*(C[0].z*0.1),hm,ht)*wpm();}',
    'float implicit0(vec3 p){int a,b;return sceneW(p,a,b);}',
    'float clipD(vec3 p){return uClipOn>0.5?dot(p,uClipN)-uClipD:-1e4;}',
    'float implicit(vec3 p){return max(implicit0(p),clipD(p));}',
    '//@@SCENE-END',
    'vec3 boxNormal(vec3 pos){vec3 ap=abs(pos)/uViewH;if(ap.x>ap.y&&ap.x>ap.z)return vec3(sign(pos.x),0.0,0.0);if(ap.y>ap.z)return vec3(0.0,sign(pos.y),0.0);return vec3(0.0,0.0,sign(pos.z));}',
    // Normals: a part on its own uses the gradient of the term that made the
    // surface (shape or lattice), as P1 did; welded parts use the whole scene
    // (fillets).
    'float shapeW(int i,vec3 p){return shapeMm(i,p*(C[0].z*0.1))*wpm();}',
    // Central differences in loops: one call site per field, so drivers that
    // inline every call (ANGLE / D3D, SwiftShader) keep the shader small.
    'vec3 dOff(int k,float e){vec3 o=vec3(0.0);o[k>>1]=(k&1)==0?e:-e;return o;}',
    'vec3 gradOf(float v[6]){return normalize(vec3(v[0]-v[1],v[2]-v[3],v[4]-v[5]));}',
    'vec3 nrmShapeM(int i,vec3 p,float e){float v[6];for(int k=0;k<6;k++)v[k]=shapeW(i,p+dOff(k,e));return gradOf(v);}',
    'float latW(int i,vec3 p){vec3 pm=p*(C[0].z*0.1);vec4 m2=M[i*MS+2],m3=M[i*MS+3],m4=M[i*MS+4],m5=M[i*MS+5],m6=M[i*MS+6];vec3 l=mat3(m2.xyz,m3.xyz,m4.xyz)*(pm-m5.xyz-m6.xyz);return (srcVal(SINGLE==1?0:int(m5.w+0.5),(l+m5.xyz)*(10.0/m2.w))*m2.w*0.1-m3.w)*wpm();}',
    'vec3 nrmLatM(int i,vec3 p,float e){float v[6];for(int k=0;k<6;k++)v[k]=latW(i,p+dOff(k,e));return gradOf(v);}',
    'vec3 nrmScene(vec3 p,float e){float v[6];for(int k=0;k<6;k++)v[k]=implicit0(p+dOff(k,e));return gradOf(v);}',
    'float nrmStepM(int i){return i<0?C[1].w:max(M[i*MS+8].z,0.01);}',
    'vec3 nrmHit(vec3 p,int hm,int ht){float e=nrmStepM(hm);int mode=0;',
    '  if(hm>=0){int g=int(M[hm*MS+8].w+0.5);if(G[g*GS+1].y<1.5){float fill=M[hm*MS].w;',
    '    if((fill<0.5||ht==1)&&M[hm*MS+8].y>0.5)mode=1;else if(fill>0.5&&fill<1.5&&ht==2)mode=2;}}',
    '  if(mode==1)return nrmShapeM(hm,p,e);if(mode==2)return nrmLatM(hm,p,e);return nrmScene(p,e);}',
    // f13Map: scene in world units, clipped to the view box so occlusion and
    // shadow rays don't "see" periodic lattice outside the domain.
    'float sdViewBox(vec3 p){vec3 q=abs(p)-vec3(uViewH);return length(max(q,0.0))+min(max(q.x,max(q.y,q.z)),0.0);}',
    'float f13Map(vec3 p){return max(implicit(p)/max(uLipschitz,1e-4),sdViewBox(p));}',
    F13_SHADE_GLSL,
    'float hashJ(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}',
    // Ghost shells: members with eye = ghost, translucent, from their shape.
    'vec4 accumulateGhosts(vec3 ro,vec3 rd,float tEn,float tExit){',
    '  int g0=int(C[0].x+0.5),g1=int(C[2].w+0.5);',
    '  if(SINGLE==1||g1<=g0)return vec4(0.0);',
    '  vec3 col=vec3(0.0);float alpha=0.0;',
    '  const int GHOST_STEPS=40;',
    '  float dtBase=(tExit-tEn)/float(GHOST_STEPS);',
    '  if(dtBase<=0.0)return vec4(0.0);',
    '  float jit=hashJ(gl_FragCoord.xy);',
    '  for(int s=0;s<GHOST_STEPS;s++){',
    '    float t=tEn+(float(s)+jit)*dtBase;vec3 p=ro+rd*t;',
    '    if(uClipOn>0.5&&dot(p,uClipN)>uClipD)continue;',
    '    for(int i=0;i<MAXM;i++){if(i<g0)continue;if(i>=g1)break;',
    '      float d=shapeW(i,p);',
    '      if(d<0.0){vec3 c=M[i*MS+7].rgb;float surface=1.0-smoothstep(0.0,0.15*uViewH,abs(d));float ai=0.012+surface*0.06;',
    '        col+=c*ai*(1.0-alpha);alpha+=ai*(1.0-alpha);if(alpha>0.94)break;}',
    '    }',
    '    if(alpha>0.94)break;',
    '  }',
    '  return vec4(col,alpha);',
    '}',
    // v0.10.0: build plate under the part in print view.
    'vec4 plateLayer(vec3 ro,vec3 rd,out float tp){',
    '  tp=-1.0;',
    '  float den=dot(rd,uBuildDir);',
    '  float tq=(uPlateLevel-dot(ro,uBuildDir))/(abs(den)<1e-6?1e-6:den);',
    '  vec3 q=ro+rd*tq;',
    '  vec2 g=vec2(dot(q,uPlateU),dot(q,uPlateV))/max(uGridStep,1e-4);',
    '  vec2 fw=fwidth(g);',
    '  if(uPrintOn<0.5||tq<=0.0)return vec4(0.0);',
    '  float ext=uViewH*1.8;vec2 a=abs(g)*uGridStep;float m=max(a.x,a.y);',
    '  if(m>ext)return vec4(0.0);',
    '  vec2 d=abs(fract(g+0.5)-0.5)/max(fw,vec2(1e-4));',
    '  float line=(1.0-min(min(d.x,d.y),1.0))*clamp(1.5-max(fw.x,fw.y)*2.0,0.0,1.0);',
    '  float fade=1.0-smoothstep(ext*0.72,ext,m);',
    '  tp=tq;',
    '  return vec4(mix(vec3(0.075,0.09,0.11),vec3(0.22,0.27,0.33),line),uPlateAlpha*fade);',
    '}',
    // Weld join tint: two or more members of the hit member's group within the band.
    'float joinZone(vec3 p,int hm){if(hm<0)return 0.0;int g=int(M[hm*MS+8].w+0.5);vec4 g1=G[g*GS+1];if(g1.w<0.5||g1.y<1.5)return 0.0;',
    '  vec3 pm=p*(C[0].z*0.1);int st=int(g1.x+0.5),cnt=int(g1.y+0.5),c=0;',
    '  for(int a=0;a<MAXM;a++){if(a>=cnt)break;if(shapeMm(st+a,pm)<C[3].x)c++;}return c>=2?1.0:0.0;}',
    // Soft lime outline around the selected part(s): the ray passed within a
    // few pixels of the selected envelope without entering it.
    'vec3 outlineMix(vec3 col,float minSel){if(C[0].w<0.5||minSel>=1e8||minSel<=0.0)return col;float a=1.0-smoothstep(1.0,3.0,minSel);return mix(col,vec3(0.784,0.961,0.259),a*0.9);}',
    'void main(){',
    '  vec2 uv=(gl_FragCoord.xy-res*0.5)/min(res.x,res.y);',
    '  vec3 panW=rot*vec3(pan.x,pan.y,0.0);',
    '  vec3 ro=rot*vec3(0.0,0.0,zoom)+panW;vec3 rd=normalize(rot*vec3(uv.x,uv.y,-1.6));',
    '  float r=clamp(length(uv)*1.1,0.0,1.0);',
    '  vec3 bgCol=mix(vec3(0.07,0.07,0.07),vec3(0.03,0.03,0.03),r*r);',
    '  float tP;vec4 pl=plateLayer(ro,rd,tP);bgCol=mix(bgCol,pl.rgb,pl.a);',
    '  vec3 H3=vec3(uViewH);',
    '  vec3 iv=vec3(1.0)/rd;vec3 tb=(-H3-ro)*iv,tt=(H3-ro)*iv;',
    '  vec3 tmi=min(tb,tt),tma=max(tb,tt);',
    '  float tEn=max(max(tmi.x,tmi.y),tmi.z);float tEx=min(min(tma.x,tma.y),tma.z);',
    '  if(tEn>tEx||tEx<0.0){fragColor=vec4(bgCol,1.0);return;}',
    '  float t=max(tEn,0.001);bool hit=false;bool nearCap=false;bool exitCap=false;',
    '  float thresh=-0.004;float maxStep=uViewH/10.0;float minSel=1e9;bool outl=C[0].w>0.5;',
    // One loop: step 0 tests the entry cap, the last step the exit cap.
    '  for(int i=0;i<='+steps+';i++){bool last=(t>tEx)||(i=='+steps+');vec3 p=ro+rd*(last?tEx:t);float d=implicit(p);',
    '    if(i==0&&d<thresh){nearCap=true;break;}',
    '    if(last){exitCap=d<thresh;break;}',
    '    float st=clamp(d/uLipschitz*0.85,0.001,maxStep);',
    '    if(outl){float sw=max(gSel*wpm(),clipD(p));float fp=t*uPixK;minSel=min(minSel,sw/fp);if(sw>0.0)st=min(st,max(sw*0.9,fp));}',
    '    if(d<thresh){hit=true;break;}t+=st;}',
    '  vec3 finalCol;',
    '  if(!nearCap&&!hit&&!exitCap){',
    '    vec4 gh=accumulateGhosts(ro,rd,max(tEn,0.0),tEx);',
    '    finalCol=mix(bgCol,gh.rgb/max(gh.a,1e-4),gh.a);',
    '    fragColor=vec4(clamp(outlineMix(finalCol,minSel),0.0,1.0),1.0);return;',
    '  }',
    '  if(nearCap)t=tEn;else if(exitCap)t=tEx;',
    '  vec3 pos=ro+rd*t;int hm=-1,ht=0;float d0=sceneW(pos,hm,ht);',
    // No outline where the ray lands on a selected part, or on a fillet / join
    // within reach of one (gSel is now the selected envelope distance here).
    '  if(outl&&hit&&hm>=0){float fk=G[int(M[hm*MS+8].w+0.5)*GS].x*wpm();if(M[hm*MS+7].w>0.5||gSel*wpm()<fk+t*uPixK*3.0)minSel=1e9;}',
    '  vec3 nO=(hit)?nrmHit(pos,hm,ht):boxNormal(pos);',
    '  vec3 n=nO;if(dot(n,-rd)<0.0)n=-n;',
    '  bool onClip=false;',
    '  if(uClipOn>0.5&&hit){',
    '    float cdp=dot(pos,uClipN)-uClipD;',
    '    if(cdp>d0-0.0005){onClip=true;pos-=uClipN*cdp;n=uClipN;nO=uClipN;if(dot(n,-rd)<0.0)n=-n;}',
    '  }',
    '  float fillH=hm>=0?M[hm*MS].w:1.0;',
    '  bool isCut=false;',
    '  if(fillH>0.5){if(nearCap||!hit)isCut=true;else if(ht==1)isCut=true;}',
    '  if(onClip)isCut=true;',
    '  vec3 baseCol=hm>=0?M[hm*MS+7].rgb:vec3(0.78,0.73,0.67);',
    '  if(uPrintOn>0.5){',
    '    float dn=dot(nO,-uBuildDir);float hh=dot(pos,uBuildDir)-uPlateLevel;',
    '    if(uLifted<0.5&&dn>0.866&&hh<nrmStepM(hm)*2.5)baseCol=mix(baseCol,vec3(0.11,0.62,0.46),0.85);',
    '    else if(uTintOn>0.5&&dn>uCritCos)baseCol=mix(baseCol,vec3(0.95,0.26,0.26),0.85);',
    '    else if(uTintOn>0.5&&dn>uWarnCos)baseCol=mix(baseCol,vec3(0.96,0.62,0.04),0.7);',
    '  }',
    '  if(!onClip&&joinZone(pos,hm)>0.5)baseCol=mix(baseCol,vec3(0.894,0.42,0.69),0.8);',
    '  if(onClip)baseCol=mix(baseCol,vec3(0.80,0.27,0.56),0.82);',
    '  float sEps=nrmStepM(hm);',
    '  if(hm>=0&&M[hm*MS+8].y>0.5&&(fillH<0.5||ht==1||(fillH>1.5&&abs(shapeW(hm,pos))<M[hm*MS+4].w*wpm()*1.2)))sEps=max(sEps,M[hm*MS+8].x*wpm());',
    '  vec3 col=f13Shade(baseCol,pos,n,rd,rot,isCut,uAOCell,sEps,1.6*uViewH);',
    '  col=mix(bgCol,col,exp(-max(t-tEn,0.0)*(0.06/uViewH)));',
    '  vec4 gh=accumulateGhosts(ro,rd,max(tEn,0.0),t);',
    '  finalCol=mix(col,gh.rgb/max(gh.a,1e-4),gh.a);',
    '  if(pl.a>0.0&&tP>0.0&&tP<t)finalCol=mix(finalCol,pl.rgb,pl.a*0.75);',
    '  finalCol=outlineMix(finalCol,minSel);',
    '  fragColor=vec4(clamp(finalCol,0.0,1.0),1.0);}',
  ].join('\n');
};
// v0.14.0: debug program for the preview / export parity test
// (tests/previewparity.js): evaluates the scene function (mm) at points read
// from a float texture, one per fragment, into a float target.
MeshRaymarcher.prototype._buildDebugShader=function(){
  var src=this._buildShader('multi');
  var head=src.slice(0,src.indexOf('//@@SCENE-END'));
  return head+'\nuniform highp sampler2D uPts;\n'+
    'void main(){ivec2 c=ivec2(gl_FragCoord.xy);vec3 pm=texelFetch(uPts,c,0).xyz;int a,b;float d=sceneMm(pm,a,b);fragColor=vec4(d,float(a),float(b),gSel);}';
};
// pts: Float32Array of xyz (mm). Resolves to {d, member, term} per point, or
// null when float render targets are unavailable. Uses the live scene.
MeshRaymarcher.prototype.debugSceneDistances=function(pts){
  var gl=this.gl, sc=this._sceneGpu, self=this;
  if(!gl||!sc) return Promise.resolve(null);
  if(!gl.getExtension('EXT_color_buffer_float')) return Promise.resolve(null);
  if(!this._dbgProg){
    var vs=this._mkShader(gl.VERTEX_SHADER,'#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}');
    var fs=this._mkShader(gl.FRAGMENT_SHADER,this._buildDebugShader());
    if(!vs||!fs) return Promise.resolve(null);
    var pr=gl.createProgram(); gl.attachShader(pr,vs); gl.attachShader(pr,fs); gl.linkProgram(pr);
    if(!gl.getProgramParameter(pr,gl.LINK_STATUS)){ console.error(gl.getProgramInfoLog(pr)); return Promise.resolve(null); }
    var bi=gl.getUniformBlockIndex(pr,'Scene'); if(bi!==gl.INVALID_INDEX) gl.uniformBlockBinding(pr,bi,0);
    this._dbgProg=pr;
  }
  var n=pts.length/3, W=Math.min(n,1024), H=Math.ceil(n/W);
  var inp=new Float32Array(W*H*4);
  for(var i=0;i<n;i++){ inp[i*4]=pts[i*3]; inp[i*4+1]=pts[i*3+1]; inp[i*4+2]=pts[i*3+2]; }
  var ti=gl.createTexture(); gl.activeTexture(gl.TEXTURE10); gl.bindTexture(gl.TEXTURE_2D,ti);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,W,H,0,gl.RGBA,gl.FLOAT,inp);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  var to=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,to);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,W,H,0,gl.RGBA,gl.FLOAT,null);
  var fb=gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER,fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,to,0);
  var pr2=this._dbgProg; gl.useProgram(pr2); gl.viewport(0,0,W,H);
  var dummy=this._dummyTex();
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D,sc.tileTex||dummy); gl.uniform1i(gl.getUniformLocation(pr2,'uTileAtlas'),0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D,sc.regTex||dummy); gl.uniform1i(gl.getUniformLocation(pr2,'uRegAtlas'),1);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_3D,sc.shapeAtlas||dummy); gl.uniform1i(gl.getUniformLocation(pr2,'uShapeAtlas'),2);
  gl.activeTexture(gl.TEXTURE10); gl.bindTexture(gl.TEXTURE_2D,ti); gl.uniform1i(gl.getUniformLocation(pr2,'uPts'),10);
  gl.uniform1f(gl.getUniformLocation(pr2,'uClipOn'),0.0);
  gl.bindBuffer(gl.UNIFORM_BUFFER,this._ubo); gl.bufferSubData(gl.UNIFORM_BUFFER,0,sc.floats); gl.bindBufferBase(gl.UNIFORM_BUFFER,0,this._ubo);
  gl.bindBuffer(gl.ARRAY_BUFFER,this.quadBuf);
  var pl=gl.getAttribLocation(pr2,'p'); gl.enableVertexAttribArray(pl); gl.vertexAttribPointer(pl,2,gl.FLOAT,false,0,0);
  gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
  var out=new Float32Array(W*H*4); gl.readPixels(0,0,W,H,gl.RGBA,gl.FLOAT,out);
  gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.deleteFramebuffer(fb); gl.deleteTexture(ti); gl.deleteTexture(to);
  gl.activeTexture(gl.TEXTURE0); this._dirty=true;
  var d=new Float32Array(n), mem=new Int8Array(n), term=new Int8Array(n);
  for(var j=0;j<n;j++){ d[j]=out[j*4]; mem[j]=out[j*4+1]; term[j]=out[j*4+2]; }
  return Promise.resolve({d:d, member:mem, term:term});
};
MeshRaymarcher.prototype._mkShader=function(type,src){
  var gl=this.gl,s=gl.createShader(type);
  gl.shaderSource(s,src);gl.compileShader(s);
  if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){
    console.error('Shader error:',gl.getShaderInfoLog(s));return null;
  }
  return s;
};
MeshRaymarcher.prototype._submitShader=function(){
  var gl=this.gl, self=this;
  var vs='#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}';
  if(this._pending) this._pending.forEach(function(q){ gl.deleteProgram(q.prog); });
  this._pending=[];
  ['multi','single'].forEach(function(variant){
    var vs_=self._mkShader(gl.VERTEX_SHADER,vs), fs_=self._mkShader(gl.FRAGMENT_SHADER,self._buildShader(variant));
    if(!vs_||!fs_) return;
    var prg=gl.createProgram();
    gl.attachShader(prg,vs_);gl.attachShader(prg,fs_);gl.linkProgram(prg);
    gl.deleteShader(vs_);gl.deleteShader(fs_);
    self._pending.push({variant:variant, prog:prg});
  });
  this._pendingProg=this._pending.length?this._pending[0].prog:null;
  this._compiling=this._pending.length>0; this._compileT0=performance.now();
};
// Uniform locations of program p (one set per variant).
MeshRaymarcher.prototype._activateUniforms=function(p){
  var gl=this.gl,L={};
  function U(n){ return gl.getUniformLocation(p,n); }
  ['res','rot','zoom','pan','uTileAtlas','uRegAtlas','uShapeAtlas','uLipschitz','uViewH','uAOCell','uPixK',
   'uF13Shadow','uF13AO','uF13WarmCool','uF13Cut','uF13Lime','uF13Interact',
   'uPrintOn','uTintOn','uBuildDir','uPlateU','uPlateV','uPlateLevel','uCritCos','uWarnCos','uGridStep','uPlateAlpha','uLifted',
   'uClipOn','uClipN','uClipD'].forEach(function(n){ L[n]=U(n); });
  var bi=gl.getUniformBlockIndex(p,'Scene');
  if(bi!==gl.INVALID_INDEX) gl.uniformBlockBinding(p,bi,0);
  if(!this._ubo){ this._ubo=gl.createBuffer(); gl.bindBuffer(gl.UNIFORM_BUFFER,this._ubo); gl.bufferData(gl.UNIFORM_BUFFER,this._sceneFloats()*4,gl.DYNAMIC_DRAW); gl.bindBuffer(gl.UNIFORM_BUFFER,null); }
  L.p=gl.getAttribLocation(p,'p');
  this.compileMs=this._compileT0?Math.round(performance.now()-this._compileT0):null;
  this._dirty=true;
  return L;
};
// ── Scene upload ─────────────────────────────────────────────────────────
// desc = {refCell, members:[…], groups:[…], sources:[…], outline, joinBand,
// baseStep} built by 16-preview-scene.js (buildPreviewScene). Members:
// {grid, bbox, fill (0/1/2), vis (0/1), rotT[9], cellMm, isoMm, skinMm,
// shiftMm[3], src (index or -1), color[3], selected, group, padMm, nrmStep,
// shapeVoxMm, hasShape}. Groups: {start, count, filletMm, rule (0/1/2),
// anchorMm, gradeMm, gradeMaxMm, showJoins}. Sources: {key, kind 'tile'|'region',
// res (bake result)}. Builds a NEW immutable GPU scene object (held / last
// frames keep theirs) and makes it the live one.
MeshRaymarcher.prototype.setScene=function(desc){
  var gl=this.gl; if(!gl||!desc) return null;
  var MS=this.SC_MS, GS=this.SC_GS, SS=this.SC_SS, MAXM=this.SC_MAXM, MAXG=this.SC_MAXG, MAXS=this.SC_MAXS;
  var f=new Float32Array(this._sceneFloats());
  var oG=MAXM*MS*4, oS=oG+MAXG*GS*4, oC=oS+MAXS*SS*4;
  var srcs=(desc.sources||[]).slice(0,MAXS);
  var tiles=[], regs=[];
  srcs.forEach(function(s){ (s.kind==='region'?regs:tiles).push(s); });
  var tA=this._atlasFor('tile',tiles), rA=this._atlasFor('region',regs);
  var lip=0, anyShape=false;
  for(var j=0;j<srcs.length;j++){
    var s=srcs[j], r=s.res, o=oS+j*SS*4, A=(s.kind==='region')?rA:tA, slot=A&&A.slots.get(s.key);
    var wMin=(s.box&&s.box.min)||r.worldMin||[-5,-5,-5], wMax=(s.box&&s.box.max)||r.worldMax||[5,5,5], N=r.N;
    f[o]=wMin[0]; f[o+1]=wMin[1]; f[o+2]=wMin[2]; f[o+3]=(s.kind==='region')?1:0;
    f[o+4]=wMax[0]-wMin[0]; f[o+5]=wMax[1]-wMin[1]; f[o+6]=wMax[2]-wMin[2]; f[o+7]=N;
    if(slot){ f[o+8]=slot[0]; f[o+9]=slot[1]; f[o+10]=slot[2]; }
    f[o+11]=r.lipschitz||1;
    var fmid=(r.fieldMin+r.fieldMax)*0.5, fhr=Math.max((r.fieldMax-r.fieldMin)*0.5,0.001);
    f[o+12]=r.fieldMin; f[o+13]=r.fieldMax; f[o+14]=fmid; f[o+15]=fhr;
    var topo=r.topology||{};
    f[o+16]=topo.bakeRaw&&topo.rawUnits?(((topo.center??0)-fmid)/fhr):(topo.center!=null?topo.center:0.0);
    f[o+17]=topo.bakeRaw&&topo.rawUnits?((topo.halfW??0.15)/fhr):(topo.halfW!=null?topo.halfW:0.15);
    var tm=topo.topoMode||'sheet';
    f[o+18]=tm==='half'?1:tm==='solid'?2:0; f[o+19]=topo.halfInvert?1:0;
    f[o+20]=topo.bakeRaw?1:0; f[o+21]=(wMax[0]-wMin[0])/Math.max(N,1);
  }
  var mem=(desc.members||[]).slice(0,MAXM), nDrawn=0, shapeTex=[];
  var shapeEntries=[], self2=this;
  mem.forEach(function(m){ if(m.hasShape&&m.grid) shapeEntries.push({key:self2._gridKey(m.grid), res:{N:m.grid.N, data:m.grid.data, raw:true}}); });
  var sA=this._atlasFor('shape',shapeEntries);
  for(var i=0;i<mem.length;i++){
    var m=mem[i], o2=i*MS*4, b=m.bbox, R=m.rotT||[1,0,0,0,1,0,0,0,1], sh=m.shiftMm||[0,0,0];
    if(m.vis===0) nDrawn=i+1;
    f[o2]=b.mnx; f[o2+1]=b.mny; f[o2+2]=b.mnz; f[o2+3]=m.fill;
    f[o2+4]=b.mxx; f[o2+5]=b.mxy; f[o2+6]=b.mxz; f[o2+7]=m.vis;
    f[o2+8]=R[0]; f[o2+9]=R[1]; f[o2+10]=R[2]; f[o2+11]=m.cellMm;
    f[o2+12]=R[3]; f[o2+13]=R[4]; f[o2+14]=R[5]; f[o2+15]=m.isoMm||0;
    f[o2+16]=R[6]; f[o2+17]=R[7]; f[o2+18]=R[8]; f[o2+19]=m.skinMm||0;
    f[o2+20]=(b.mnx+b.mxx)*0.5; f[o2+21]=(b.mny+b.mxy)*0.5; f[o2+22]=(b.mnz+b.mxz)*0.5; f[o2+23]=(m.src!=null)?m.src:-1;
    f[o2+24]=sh[0]; f[o2+25]=sh[1]; f[o2+26]=sh[2]; f[o2+27]=m.padMm||0;
    var c=m.color||[0.78,0.73,0.67];
    f[o2+28]=c[0]; f[o2+29]=c[1]; f[o2+30]=c[2]; f[o2+31]=m.selected?1:0;
    f[o2+32]=m.shapeVoxMm||0; f[o2+33]=m.hasShape?1:0; f[o2+34]=m.nrmStep||0.1; f[o2+35]=m.group||0;
    if(m.hasShape&&m.grid&&sA){ var so=sA.slots.get(this._gridKey(m.grid)); f[o2+36]=so[0]; f[o2+37]=so[1]; f[o2+38]=so[2]; f[o2+39]=m.grid.N; }
    shapeTex.push(m.hasShape&&m.grid?m.grid:null);
    if(m.hasShape) anyShape=true;
    if(m.vis===0&&m.fill>0&&m.src!=null&&m.src>=0&&srcs[m.src]){
      var sl=srcs[m.src].res.lipschitz||1, gr=(desc.groups||[])[m.group];
      if(gr&&gr.rule===2&&gr.gradeMm>0){ var gm=gr.gradeMaxMm>0?gr.gradeMaxMm:0.15*m.cellMm; sl+=1.5*gm/gr.gradeMm; }
      lip=Math.max(lip,sl);
    }
  }
  var grp=(desc.groups||[]).slice(0,MAXG);
  for(var g=0;g<grp.length;g++){
    var G=grp[g], o3=oG+g*GS*4;
    f[o3]=G.filletMm||0; f[o3+1]=G.rule||0; f[o3+2]=G.anchorMm||0; f[o3+3]=G.gradeMm||0;
    f[o3+4]=G.start; f[o3+5]=G.count; f[o3+6]=G.gradeMaxMm||0; f[o3+7]=G.showJoins?1:0;
  }
  f[oC]=nDrawn; f[oC+1]=grp.length; f[oC+2]=desc.refCell||10; f[oC+3]=desc.outline?1:0;
  f[oC+4]=tA?tA.size[0]:1; f[oC+5]=tA?tA.size[1]:1; f[oC+6]=tA?tA.size[2]:1; f[oC+7]=desc.baseStep||0.2;
  f[oC+8]=rA?rA.size[0]:1; f[oC+9]=rA?rA.size[1]:1; f[oC+10]=rA?rA.size[2]:1; f[oC+11]=mem.length;
  f[oC+12]=desc.joinBand||0.5;
  f[oC+13]=sA?sA.size[0]:1; f[oC+14]=sA?sA.size[1]:1; f[oC+15]=sA?sA.size[2]:1;
  if(anyShape) lip=Math.max(lip,1.0);
  if(!(lip>0)) lip=1.0;
  this._sceneGpu={floats:f, tileTex:tA?tA.tex:null, regTex:rA?rA.tex:null, shapeAtlas:sA?sA.tex:null, shapeTex:shapeTex,
    lipschitz:lip, nDrawn:nDrawn, nMembers:mem.length, desc:desc,
    single:(mem.length===1&&nDrawn===1&&grp.length===1&&!desc.outline)};
  this._dirty=true;
  this._pruneAtlases();
  return this._sceneGpu;
};
// One atlas per kind. entries = [{key, res}]. Reused as is when it already
// holds exactly these keys; otherwise a new texture is built (the old one stays
// alive while a held or last frame still draws it).
MeshRaymarcher.prototype._atlasFor=function(kind,entries){
  if(!entries.length) return null;
  var gl=this.gl, cur=this._atlas&&this._atlas[kind];
  var keys=entries.map(function(e){return e.key;}).sort().join('|');
  if(cur&&cur.keys===keys) return cur;
  var tile=(kind==='tile'), maxD=Math.min(gl.getParameter(gl.MAX_3D_TEXTURE_SIZE)||256,2048);
  var side=0; entries.forEach(function(e){ side=Math.max(side,e.res.N+(tile?2:0)); });
  // Column layout: stack slots along z, start a new column in x when full.
  var slots=new Map(), x=0, z=0, depth=0, cols=1;
  entries.forEach(function(e){
    if(slots.has(e.key)) return;
    var s=e.res.N+(tile?2:0);
    if(z+s>maxD){ x+=side; z=0; cols++; }
    slots.set(e.key,[x,0,z]); z+=s; depth=Math.max(depth,z);
  });
  var size=[side*cols,side,Math.max(depth,1)];
  var tex=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D,tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
  if(tile) gl.texImage3D(gl.TEXTURE_3D,0,gl.R8,size[0],size[1],size[2],0,gl.RED,gl.UNSIGNED_BYTE,null);
  else gl.texImage3D(gl.TEXTURE_3D,0,gl.R16F,size[0],size[1],size[2],0,gl.RED,gl.FLOAT,null);
  var self=this, done=new Set();
  entries.forEach(function(e){
    if(done.has(e.key)) return; done.add(e.key);
    var o=slots.get(e.key), N=e.res.N;
    if(tile) gl.texSubImage3D(gl.TEXTURE_3D,0,o[0],o[1],o[2],N+2,N+2,N+2,gl.RED,gl.UNSIGNED_BYTE,self._paddedR8(e.res));
    else gl.texSubImage3D(gl.TEXTURE_3D,0,o[0],o[1],o[2],N,N,N,gl.RED,gl.FLOAT,e.res.raw?e.res.data:self._normF32(e.res));
  });
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_R,gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_3D,null);
  var A={tex:tex,size:size,slots:slots,keys:keys,bytes:size[0]*size[1]*size[2]*(tile?1:2)};
  if(!this._atlas) this._atlas={};
  if(!this._atlasOld) this._atlasOld=[];
  if(cur) this._atlasOld.push(cur);
  this._atlas[kind]=A;
  return A;
};
// Tile bytes with a one-voxel wrapped border: padded index j holds original
// index (j - 1) mod N on every axis. Same 8-bit conversion as _fieldToR8.
MeshRaymarcher.prototype._paddedR8=function(res){
  if(!this._padCache) this._padCache=new WeakMap();
  var hit=this._padCache.get(res); if(hit) return hit;
  var N=res.N, P=N+2, d=res.data, mn=res.fieldMin, range=Math.max(res.fieldMax-res.fieldMin,1e-6);
  var out=new Uint8Array(P*P*P), wrap=new Int32Array(P);
  for(var j=0;j<P;j++) wrap[j]=((j-1)%N+N)%N;
  for(var z=0;z<P;z++){ var sz=wrap[z]*N*N;
    for(var y=0;y<P;y++){ var sy=sz+wrap[y]*N, o=(z*P+y)*P;
      for(var x=0;x<P;x++){ var v=(d[sy+wrap[x]]-mn)/range; out[o+x]=Math.round(v<0?0:v>1?255:v*255); } } }
  this._padCache.set(res,out);
  return out;
};
MeshRaymarcher.prototype._normF32=function(res){
  if(!this._normCache) this._normCache=new WeakMap();
  var hit=this._normCache.get(res); if(hit) return hit;
  var d=res.data, mn=res.fieldMin, range=Math.max(res.fieldMax-res.fieldMin,1e-6), out=new Float32Array(d.length);
  for(var i=0;i<d.length;i++) out[i]=(d[i]-mn)/range;
  this._normCache.set(res,out);
  return out;
};
// Free retired atlases no live, held or last frame draws.
MeshRaymarcher.prototype._pruneAtlases=function(){
  var old=this._atlasOld, gl=this.gl; if(!old||!old.length||!gl) return;
  var used=new Set();
  [this._sceneGpu,this._held&&this._held._sceneGpu,this._lastFrame&&this._lastFrame._sceneGpu].forEach(function(s){ if(s){ if(s.tileTex)used.add(s.tileTex); if(s.regTex)used.add(s.regTex); if(s.shapeAtlas)used.add(s.shapeAtlas); } });
  this._atlasOld=old.filter(function(A){ if(used.has(A.tex)) return true; gl.deleteTexture(A.tex); return false; });
};
MeshRaymarcher.prototype.atlasBytes=function(){
  var n=0, a=this._atlas||{}; for(var k in a) if(a[k]) n+=a[k].bytes; return n;
};
MeshRaymarcher.prototype._gridKey=function(g){
  if(!this._gridIds) { this._gridIds=new WeakMap(); this._gridNext=1; }
  var id=this._gridIds.get(g); if(!id){ id='g'+(this._gridNext++); this._gridIds.set(g,id); } return id;
};
MeshRaymarcher.prototype._dummyTex=function(){
  if(this._dummy) return this._dummy;
  var gl=this.gl, t=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D,t);
  gl.texImage3D(gl.TEXTURE_3D,0,gl.R16F,1,1,1,0,gl.RED,gl.FLOAT,new Float32Array([1]));
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.bindTexture(gl.TEXTURE_3D,null);
  this._dummy=t; return t;
};
MeshRaymarcher.prototype.render=function(){
  var gl=this.gl;if(!gl)return;
  // Async compile check
  if(this._compiling&&this._pending){
    var left=[], self=this;
    this._pending.forEach(function(q){
      var ready=!self._khr||gl.getProgramParameter(q.prog,self._khr.COMPLETION_STATUS_KHR);
      if(!ready){ left.push(q); return; }
      if(gl.getProgramParameter(q.prog,gl.LINK_STATUS)){
        if(!self._progs) self._progs={};
        var old=self._progs[q.variant]; if(old) gl.deleteProgram(old.prog);
        self._progs[q.variant]={prog:q.prog, L:self._activateUniforms(q.prog)};
        if(q.variant==='multi') self.prog=q.prog;
      }else{console.error('Link error:',gl.getProgramInfoLog(q.prog));gl.deleteProgram(q.prog);}
    });
    this._pending=left; this._compiling=left.length>0; this._pendingProg=left.length?left[0].prog:null;
  }
  if(!this.prog||!this._sceneGpu||!this._dirty)return;
  this._dirty=false;
  var held=this._held;
  if(!held){
    this._drawFrame();
    this._lastFrame=this._captureState();
    return;
  }
  // v0.13.0: held view. Draw the held scene with the live camera, rescaled to
  // the held view box; everything is restored afterwards.
  var keys=this.HOLD_KEYS, saved={}, i;
  for(i=0;i<keys.length;i++) saved[keys[i]]=this[keys[i]];
  var cz=this.camZoom, px=this.panX, py=this.panY;
  var k=(this.viewH>0&&held.viewH>0)?held.viewH/this.viewH:1;
  try{
    for(i=0;i<keys.length;i++) this[keys[i]]=held[keys[i]];
    this.camZoom=cz*k; this.panX=(px||0)*k; this.panY=(py||0)*k;
    this._drawFrame();
  }finally{
    for(i=0;i<keys.length;i++) this[keys[i]]=saved[keys[i]];
    this.camZoom=cz; this.panX=px; this.panY=py;
  }
};
// Scene state a frame is drawn from (camera and view options excluded).
// v0.14.0: the GPU scene object carries members, groups, sources and atlases.
MeshRaymarcher.prototype.HOLD_KEYS=['_sceneGpu','viewH','hasShape','shapeData'];
MeshRaymarcher.prototype._captureState=function(){
  var s={};
  for(var i=0;i<this.HOLD_KEYS.length;i++) s[this.HOLD_KEYS[i]]=this[this.HOLD_KEYS[i]];
  s.shapeData=this.shapeData?Object.assign({},this.shapeData):null;
  return s;
};
// v0.13.0: keep drawing the last correct frame until releaseView() (or 20 s).
MeshRaymarcher.prototype.holdView=function(){
  var self=this;
  if(!this._held&&this._lastFrame){ this._held=this._lastFrame; this._heldAt=performance.now(); }
  if(this._held){
    if(this._holdTimer) clearTimeout(this._holdTimer);
    this._holdTimer=setTimeout(function(){ self._holdTimer=null; self.releaseView(); },20000);
  }
  return !!this._held;
};
MeshRaymarcher.prototype.releaseView=function(){
  if(this._holdTimer){ clearTimeout(this._holdTimer); this._holdTimer=null; }
  this._held=null; this._dirty=true;
};
MeshRaymarcher.prototype.isHeld=function(){ return !!this._held; };
// rc3.7: lattice base-color override (kept for callers; the scene carries
// every member's colour, 16-preview-scene.js).
MeshRaymarcher.prototype._resolveBaseColor=function(){
  var bc = this._baseColor;
  if(!bc || bc[0] < 0){
    bc = (typeof currentRecipe!=='undefined' && currentRecipe && typeof familyColor==='function')
      ? _hexToRGB(familyColor(currentRecipe.family)) : [-1.0, 0.0, 0.0];
  }
  return bc;
};
// The draw itself, from this._sceneGpu.
MeshRaymarcher.prototype._drawFrame=function(){
  var gl=this.gl, sc=this._sceneGpu, self=this;
  var P=(sc.single&&this._progs&&this._progs.single)||(this._progs&&this._progs.multi);
  if(!P) return;
  var L=P.L; this.drawVariant=(P===(this._progs&&this._progs.single))?'single':'multi';
  var area=document.getElementById('previewArea');
  var dpr=Math.min(window.devicePixelRatio||1,1.5);
  var w=Math.round((area?area.clientWidth:400)*dpr);
  var h=Math.round((area?area.clientHeight:300)*dpr);
  if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;}
  gl.viewport(0,0,w,h);
  gl.useProgram(P.prog);
  function u1(n,v){ var l=L[n]; if(l) gl.uniform1f(l,v); }
  function u3(n,a,b,c){ var l=L[n]; if(l) gl.uniform3f(l,a,b,c); }
  if(L.res) gl.uniform2f(L.res,w,h);
  u1('uPixK',1.0/(1.6*Math.max(1,Math.min(w,h))));
  var pv=this._printView;
  if(L.rot) gl.uniformMatrix3fv(L.rot,false,new Float32Array(pv?this._mat3Mul(pv.rtColMajor,this.rotMat):this.rotMat));
  u1('uPrintOn',pv?1.0:0.0);
  u1('uTintOn',pv&&pv.tint?1.0:0.0);
  var bd=pv?pv.buildDir:[0,0,1], pu=pv?pv.plateU:[1,0,0], pw=pv?pv.plateV:[0,1,0];
  u3('uBuildDir',bd[0],bd[1],bd[2]); u3('uPlateU',pu[0],pu[1],pu[2]); u3('uPlateV',pw[0],pw[1],pw[2]);
  u1('uPlateLevel',pv?pv.plateLevel:-5.0);
  var cc=pv?pv.critCos:2.0; u1('uCritCos',cc);
  // amber band: up to 10° above the limit
  var wc=2.0; if(pv&&cc<=1.0){ var ang=Math.acos(Math.max(-1,Math.min(1,cc)))+10*Math.PI/180; wc=ang>=Math.PI/2?0.0:Math.cos(ang); }
  u1('uWarnCos',wc);
  u1('uGridStep',pv?pv.gridStep:1.0);
  u1('uPlateAlpha',pv&&pv.plateAlpha!=null?pv.plateAlpha:0.9);
  u1('uLifted',pv&&pv.lifted?1.0:0.0);
  if(this._updateGimbal) this._updateGimbal();
  u1('zoom',this.camZoom);
  if(L.pan) gl.uniform2f(L.pan,this.panX||0,this.panY||0);
  u1('uViewH',this.viewH);
  u1('uLipschitz',Math.max(sc.lipschitz,1e-3));
  var vo=this.viewOpts;
  u1('uF13Shadow',vo.shadows?1.0:0.0); u1('uF13AO',vo.occlusion?1.0:0.0); u1('uF13WarmCool',vo.warmCool?1.0:0.0);
  u1('uF13Cut',vo.cutFaces?1.0:0.0); u1('uF13Lime',vo.limeEdges?1.0:0.0); u1('uF13Interact',this._interacting?1.0:0.0);
  // Occlusion reach ≈ one lattice cell. Shape/weld mode: a cell is 10 world
  // units. Cube mode: the [-5,5] tile, assume ~1.5 cells across.
  var aoCell=(this.hasShape&&this.shapeData)?Math.min(10.0,this.viewH*1.33):this.viewH*2.0/1.5;
  u1('uAOCell',Math.max(aoCell,1e-3));
  var cpl=this._clip?this.clipPlane():null;
  u1('uClipOn',cpl?1.0:0.0);
  u3('uClipN',cpl?cpl.n[0]:0,cpl?cpl.n[1]:0,cpl?cpl.n[2]:0);
  u1('uClipD',cpl?cpl.d:0.0);
  // Textures: 0 tile atlas, 1 region atlas, 2 + i member i's shape.
  var dummy=this._dummyTex();
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D,sc.tileTex||dummy); if(L.uTileAtlas) gl.uniform1i(L.uTileAtlas,0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D,sc.regTex||dummy); if(L.uRegAtlas) gl.uniform1i(L.uRegAtlas,1);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_3D,sc.shapeAtlas||dummy); if(L.uShapeAtlas) gl.uniform1i(L.uShapeAtlas,2);
  gl.bindBuffer(gl.UNIFORM_BUFFER,this._ubo);
  gl.bufferSubData(gl.UNIFORM_BUFFER,0,sc.floats);
  gl.bindBufferBase(gl.UNIFORM_BUFFER,0,this._ubo);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindBuffer(gl.ARRAY_BUFFER,this.quadBuf);
  gl.enableVertexAttribArray(L.p);
  gl.vertexAttribPointer(L.p,2,gl.FLOAT,false,0,0);
  gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
};
MeshRaymarcher.prototype._startLoop=function(){
  var self=this;
  self._loopRunning=true;
  var lastTs=0;
  function loop(ts){
    var dt=Math.min((ts-lastTs)/1000,0.05);lastTs=ts;
    if(self._dirty||self._compiling){
      // v0.14.0: the scene is pulled from the app state (16-preview-scene.js)
      // on every dirty frame; it returns at once when nothing changed.
      if(self._dirty&&self._sceneProvider){ try{ self._sceneProvider(); }catch(e){ console.error('[scene]',e); } }
      self.rotMat=self._orthonorm(self.rotMat);
      var t0=performance.now();
      var drew=self._dirty&&!!self.prog&&!!self._sceneGpu;
      self.render();
      if(drew){
        // frame time of back-to-back dirty frames (dev overlay, weak-GPU fallback)
        if(self._prevDirtyTs&&ts-self._prevDirtyTs<250){ var ft=ts-self._prevDirtyTs; self._frameEma=self._frameEma?self._frameEma*0.85+ft*0.15:ft; self._emaN=(self._emaN||0)+1; }
        self._prevDirtyTs=ts; self._lastDrawMs=performance.now()-t0;
      }
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  new ResizeObserver(function(){self._dirty=true;}).observe(document.getElementById('previewArea'));
};
MeshRaymarcher.prototype._rotAA=function(ax,ay,az,angle){var c=Math.cos(angle),s=Math.sin(angle),t2=1-c;var l=Math.sqrt(ax*ax+ay*ay+az*az)||1;ax/=l;ay/=l;az/=l;return[t2*ax*ax+c,t2*ax*ay+s*az,t2*ax*az-s*ay,t2*ax*ay-s*az,t2*ay*ay+c,t2*ay*az+s*ax,t2*ax*az+s*ay,t2*ay*az-s*ax,t2*az*az+c];};
MeshRaymarcher.prototype._mat3Mul=function(A,B){var r=new Array(9);for(var c=0;c<3;c++)for(var row=0;row<3;row++)r[c*3+row]=A[0*3+row]*B[c*3+0]+A[1*3+row]*B[c*3+1]+A[2*3+row]*B[c*3+2];return r;};
MeshRaymarcher.prototype._orthonorm=function(m){function dot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}function scl(a,s){return[a[0]*s,a[1]*s,a[2]*s];}function sub(a,b){return[a[0]-b[0],a[1]-b[1],a[2]-b[2]];}function nrm(a){var l=Math.sqrt(dot(a,a))||1;return[a[0]/l,a[1]/l,a[2]/l];}var x=[m[0],m[1],m[2]],y=[m[3],m[4],m[5]],z=[m[6],m[7],m[8]];x=nrm(x);y=nrm(sub(y,scl(x,dot(y,x))));z=nrm(sub(sub(z,scl(x,dot(z,x))),scl(y,dot(z,y))));return[x[0],x[1],x[2],y[0],y[1],y[2],z[0],z[1],z[2]];};
MeshRaymarcher.prototype._applyDelta=function(dx,dy){if(Math.abs(dx)>0.001){var ux=this.rotMat[3],uy=this.rotMat[4],uz=this.rotMat[5];this.rotMat=this._mat3Mul(this._rotAA(ux,uy,uz,-dx*0.007),this.rotMat);this._dirty=true;}if(Math.abs(dy)>0.001){var rx=this.rotMat[0],ry=this.rotMat[1],rz=this.rotMat[2];this.rotMat=this._mat3Mul(this._rotAA(rx,ry,rz,-dy*0.007),this.rotMat);this._dirty=true;}};
