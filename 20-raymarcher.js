/* ============================================================
   F13LD.mesh · 20-raymarcher.js
   MeshRaymarcher — WebGL2 raymarched preview (scaffold + shape + ghosts).
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
MeshRaymarcher.prototype._uploadTexture3D=function(data,N,minV,maxV,slot){
  var gl=this.gl;
  if(slot==='shape'){
    // Shape SDF: R16F stores raw mm distances directly. LINEAR filtering of
    // R16F is core WebGL 2.0 — no extension dependency. Precision is ~0.01mm
    // at SDF=10mm range (vs R8's 0.09mm), which eliminates the gradient step-
    // wise noise responsible for specular speckle on cap surfaces. R16F range
    // (±65504) comfortably exceeds any realistic shape bbox distance.
    if(!this.shapeTex)this.shapeTex=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D,this.shapeTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
    gl.texImage3D(gl.TEXTURE_3D,0,gl.R16F,N,N,N,0,gl.RED,gl.FLOAT,data);
    gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_R,gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_3D,null);
  }else{
    // Scaffold raw field: R8. (A v0.7.x R16F experiment regressed cube/periodic
    // previews — a filterable half-float 3D texture with REPEAT wrap at NPOT grid
    // sizes tiles inconsistently across drivers, whereas R8 UNORM is reliable.
    // Reverted. Field varies smoothly and topology is applied in shader, so 8-bit
    // is fine here.) Any future precision bump must be scoped to the non-tiled
    // assembly field only and validated in isolation.
    var range=Math.max(maxV-minV,1e-6);
    var bytes=new Uint8Array(N*N*N);
    for(var i=0;i<data.length;i++)bytes[i]=Math.round(Math.max(0,Math.min(1,(data[i]-minV)/range))*255);
    if(!this.fieldTex)this.fieldTex=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D,this.fieldTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
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
  }
  this._dirty=true;
};
MeshRaymarcher.prototype.setScaffoldField=function(data,N,fieldMin,fieldMax,lipschitz,topology){
  this._uploadTexture3D(data,N,fieldMin,fieldMax,'field');
  this.fieldMin=fieldMin; this.fieldMax=fieldMax;
  this.lipschitz=lipschitz; this.bakeN=N;
  this.topology=topology||null;
};
MeshRaymarcher.prototype.setShapeSDF=function(sdfGrid,bbox,cellSizeMm,assemblyBbox,preserveCamera){
  var d=sdfGrid;
  this._uploadTexture3D(d.data,d.N,d.sdfMin,d.sdfMax,'shape');
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
MeshRaymarcher.prototype.clearShape=function(){this.hasShape=false;this.viewH=5.0;this.camZoom=16;this.panX=0;this.panY=0;this.worldMin=[-5,-5,-5];this.worldMax=[5,5,5];this.isPeriodic=true;this._structXform=null;this._periodicFitKey=null;this._dirty=true;};

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
// regular shape SDF slot). Texture slots are reused — when the ghost set
// changes (active body swap, body added/removed), we re-upload only the
// slots that are now different.
MeshRaymarcher.prototype.GHOST_MAX = 7;
MeshRaymarcher.prototype._initGhostState = function(){
  if(this._ghostTex) return; // already initialized
  this._ghostTex = new Array(this.GHOST_MAX).fill(null);
  this._ghostMeta = new Array(this.GHOST_MAX).fill(null);
  // _ghostMeta[i] = { bodyId, bboxMin:[3], bboxSize:[3], cellSizeMm, color:[3], N }
  this._ghostCount = 0;
};

// Upload a single ghost SDF into slot i. Mirrors _uploadTexture3D for 'shape'
// (R16F format for mm-precision) but lives in our own slot array.
MeshRaymarcher.prototype._uploadGhostTex = function(slot, sdfGrid){
  var gl = this.gl;
  if(!this._ghostTex[slot]) this._ghostTex[slot] = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, this._ghostTex[slot]);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.R16F, sdfGrid.N, sdfGrid.N, sdfGrid.N, 0, gl.RED, gl.FLOAT, sdfGrid.data);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_3D, null);
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
    var prev = this._ghostMeta[i];
    // Only re-upload texture if the body changed in this slot.
    if(!prev || prev.bodyId !== g.bodyId){
      this._uploadGhostTex(i, g.sdfGhost);
    }
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
    this._ghostMeta[j] = null;
  }
  this._ghostCount = n;
  this._dirty = true;
};

// Drop all ghosts (e.g., when last body removed or going to dropzone).
MeshRaymarcher.prototype.clearGhosts = function(){
  this._initGhostState();
  for(var i = 0; i < this.GHOST_MAX; i++){
    this._ghostMeta[i] = null;
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
};
MeshRaymarcher.prototype.setQuality=function(q){
  if(this._quality===q&&this.prog)return;
  this._quality=q;
  this._submitShader();
};
MeshRaymarcher.prototype._buildShader=function(){
  var steps={draft:'128',low:'256',med:'512',high:'1024',ultra:'2048'}[this._quality]||'256';
  var GHOST_MAX = this.GHOST_MAX;
  return [
    '#version 300 es',
    'precision highp float;precision highp sampler3D;',
    '#define GHOST_MAX ' + GHOST_MAX,
    'out vec4 fragColor;',
    'uniform vec2 res;uniform mat3 rot;uniform float zoom;uniform vec2 pan;',
    'uniform highp sampler3D uField;uniform float uFieldMin;uniform float uFieldMax;uniform float uLipschitz;',
    'uniform highp sampler3D uShapeSDF;',
    'uniform vec3 uBboxMin;uniform vec3 uBboxSize;',
    'uniform float uCellSizeMm;uniform float uHasShape;',
    'uniform float uViewH;',
    'uniform float uIsPeriodic;',
    'uniform vec3 uWorldMin;uniform vec3 uWorldSize;',
    'uniform float uNrmStep;',
    'uniform float uBakeRaw;uniform float uFieldMid;uniform float uFieldHalfR;',
    'uniform float uCenter;uniform float uHalfW;uniform float uTopoMode;uniform float uHalfInvert;',
    // ── Structure SDF transform uniforms (v0.5.0 Phase B) ─────────────────
    'uniform mat3 uStructRotInv;',
    'uniform vec3 uStructPivotWorld;',
    'uniform vec3 uStructOffsetWorld;',
    'uniform float uStructIsoWorld;',
    // ── rc3.5 · Solid mode ────────────────────────────────────────────────
    // When uSolidMode > 0.5, the scaffold SDF returns a deeply-negative
    // constant (always-inside). implicit(p) = max(scaffold, shape) reduces
    // to just sampleShape(p), producing an opaque rendering of the body's
    // surface in a flat material color. uSolidColor is the base color used
    // by the lighting tail.
    'uniform float uSolidMode;',
    'uniform vec3 uSolidColor;',
    // ── rc3.7 · Lattice base color override ───────────────────────────────
    // Body color for the active lattice render: the user's per-body pick,
    // the weld-group color, or (v0.9.5) the recipe family color. Rendered
    // as a flat material color. A negative-R sentinel (-1,0,0) means no
    // color is known; the shader then uses a neutral clay.
    'uniform vec3 uBaseColor;',
    // ── Viewer shading (shared F13LD-SHADE block, 19-f13-shade.js) ─────────
    // The block declares the uF13* view-menu toggles and uF13Interact
    // (1 while orbiting/panning/zooming: shadows pause). uAOCell is the
    // occlusion reach in world units (about one lattice cell).
    'uniform float uAOCell;',
    // ── rc3 · Ghost envelope uniforms ─────────────────────────────────────
    // GHOST_MAX separate sampler3D textures for non-active body silhouettes.
    // Each has its own world-mm bbox and family color. uGhostCount controls
    // the active loop bound (0..GHOST_MAX). cellSizeMm is shared with the
    // active shape since ghosts live in the same world space.
    'uniform highp sampler3D uGhostSDF0;',
    'uniform highp sampler3D uGhostSDF1;',
    'uniform highp sampler3D uGhostSDF2;',
    'uniform highp sampler3D uGhostSDF3;',
    'uniform highp sampler3D uGhostSDF4;',
    'uniform highp sampler3D uGhostSDF5;',
    'uniform highp sampler3D uGhostSDF6;',
    'uniform vec3 uGhostBboxMin[GHOST_MAX];',
    'uniform vec3 uGhostBboxSize[GHOST_MAX];',
    'uniform vec3 uGhostColor[GHOST_MAX];',
    // rc3.6: per-slot render kind. 0.0 = translucent ghost (today's behavior),
    // 1.0 = opaque inactive-solid (renders the body's surface as if it were
    // an active solid body, no transparency). Carried as float because GLSL
    // ES 3.00 uniform arrays of int are awkward to bind.
    'uniform float uGhostKind[GHOST_MAX];',
    'uniform float uGhostCount;',
    'vec3 xformStructure(vec3 p){vec3 q=p-uStructPivotWorld-uStructOffsetWorld;return uStructRotInv*q+uStructPivotWorld;}',
    'float sampleRaw(vec3 p){vec3 uvw;if(uIsPeriodic>0.5)uvw=(p-uWorldMin)/uWorldSize;else uvw=clamp((p-uWorldMin)/uWorldSize,0.0,1.0);float t=texture(uField,uvw).r;return t*(uFieldMax-uFieldMin)+uFieldMin;}',
    'float rawToSDF(float raw){float val;if(uBakeRaw>0.5){float norm=(raw-uFieldMid)/uFieldHalfR;float adj=norm-uCenter;if(uTopoMode<0.5)val=abs(adj)-uHalfW;else if(uTopoMode<1.5)val=uHalfInvert>0.5?adj:-adj;else val=uHalfW-abs(adj);}else val=raw;return val;}',
    'float sampleScaffoldSDF(vec3 p){return rawToSDF(sampleRaw(xformStructure(p)))+uStructIsoWorld;}',
    'float sampleShape(vec3 p){vec3 pm=p*(uCellSizeMm/10.0);vec3 uvw=(pm-uBboxMin)/uBboxSize;if(any(lessThan(uvw,vec3(0.0)))||any(greaterThan(uvw,vec3(1.0)))){vec3 bmax=uBboxMin+uBboxSize;vec3 q=max(uBboxMin-pm,pm-bmax);return length(max(q,vec3(0.0)))*(10.0/uCellSizeMm);}float d_mm=texture(uShapeSDF,uvw).r;return d_mm*(10.0/uCellSizeMm);}',
    // rc3.5: implicit() short-circuits when uSolidMode is on. Returns the
    // shape SDF directly so the raymarch hits the body surface as if it were
    // a filled solid. uHasShape must still be 1.0 for solid mode to render —
    // a solid body without geometry isn't meaningful.
    'float implicit(vec3 p){if(uSolidMode>0.5){return uHasShape>0.5?sampleShape(p):1.0;}float sc=sampleScaffoldSDF(p);if(uHasShape>0.5)return max(sc,sampleShape(p));return sc;}',
    // ── rc3 · Ghost SDF sampler ────────────────────────────────────────────
    // Returns world-units SDF for ghost in slot i; positive outside, negative
    // inside. Uses an AABB fast-reject: outside the world-mm bbox we synthesize
    // distance to bbox edge directly (no texture sample). The slot index is
    // handled by an explicit switch because GLSL ES 3.00 cannot index sampler
    // arrays with a non-constant expression.
    'float sampleGhostSlot(int slot, vec3 p){',
    '  vec3 bmin = uGhostBboxMin[slot]; vec3 bsize = uGhostBboxSize[slot];',
    '  vec3 pm = p * (uCellSizeMm/10.0);',
    '  vec3 uvw = (pm - bmin) / bsize;',
    '  if(any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))){',
    '    vec3 bmax = bmin + bsize; vec3 q = max(bmin - pm, pm - bmax);',
    '    return length(max(q, vec3(0.0))) * (10.0/uCellSizeMm);',
    '  }',
    '  float d_mm = 0.0;',
    '  if(slot == 0) d_mm = texture(uGhostSDF0, uvw).r;',
    '  else if(slot == 1) d_mm = texture(uGhostSDF1, uvw).r;',
    '  else if(slot == 2) d_mm = texture(uGhostSDF2, uvw).r;',
    '  else if(slot == 3) d_mm = texture(uGhostSDF3, uvw).r;',
    '  else if(slot == 4) d_mm = texture(uGhostSDF4, uvw).r;',
    '  else if(slot == 5) d_mm = texture(uGhostSDF5, uvw).r;',
    '  else if(slot == 6) d_mm = texture(uGhostSDF6, uvw).r;',
    '  return d_mm * (10.0/uCellSizeMm);',
    '}',
    'vec3 boxNormal(vec3 pos){vec3 ap=abs(pos)/uViewH;if(ap.x>ap.y&&ap.x>ap.z)return vec3(sign(pos.x),0.0,0.0);if(ap.y>ap.z)return vec3(0.0,sign(pos.y),0.0);return vec3(0.0,0.0,sign(pos.z));}',
    'vec3 nrmScaffold(vec3 p){float e=uNrmStep;return normalize(vec3(sampleScaffoldSDF(p+vec3(e,0,0))-sampleScaffoldSDF(p-vec3(e,0,0)),sampleScaffoldSDF(p+vec3(0,e,0))-sampleScaffoldSDF(p-vec3(0,e,0)),sampleScaffoldSDF(p+vec3(0,0,e))-sampleScaffoldSDF(p-vec3(0,0,e))));}',
    'vec3 nrmShape(vec3 p){float e=uNrmStep;return normalize(vec3(sampleShape(p+vec3(e,0,0))-sampleShape(p-vec3(e,0,0)),sampleShape(p+vec3(0,e,0))-sampleShape(p-vec3(0,e,0)),sampleShape(p+vec3(0,0,e))-sampleShape(p-vec3(0,0,e))));}',
    // rc3.5: In solid mode the surface IS the shape's surface, so the normal
    // must come from the shape SDF. Without this branch the lighting normal
    // could come from the scaffold field gradient and "paint" lattice texture
    // onto an otherwise-correct solid surface.
    'vec3 nrmField(vec3 p){if(uSolidMode>0.5)return nrmShape(p);if(uHasShape>0.5){float sc=sampleScaffoldSDF(p);float sh=sampleShape(p);if(sh>sc)return nrmShape(p);}return nrmScaffold(p);}',
    // ── Lighting (shared F13LD-SHADE block) ───────────────────────────────
    // f13Map: implicit in world units, clipped to the view box so occlusion
    // and shadow rays don't "see" periodic lattice outside the domain.
    'float sdViewBox(vec3 p){vec3 q=abs(p)-vec3(uViewH);return length(max(q,0.0))+min(max(q.x,max(q.y,q.z)),0.0);}',
    'float f13Map(vec3 p){return max(implicit(p)/max(uLipschitz,1e-4),sdViewBox(p));}',
    F13_SHADE_GLSL,
    // Light colors for opaque ghosts (same rig as f13Shade).
    'vec3 keyColV(){return uF13WarmCool>0.5?vec3(1.0,0.93,0.82)*1.35:vec3(1.3);}',
    'vec3 fillColV(){return uF13WarmCool>0.5?vec3(0.30,0.42,0.62)*0.75:vec3(0.5);}',
    // ── rc3 · Ghost accumulation pass ─────────────────────────────────────
    // rc3.6: ghost normal via central differences on the ghost SDF. Used to
    // shade inactive-solid ghosts so they read as real opaque bodies, not
    // flat painted blobs. ~6 extra texture samples per surface hit per slot;
    // only invoked when kind == solid AND ray actually hits the surface.
    'vec3 ghostNormal(int slot, vec3 p, float eps){',
    '  float dx = sampleGhostSlot(slot, p + vec3(eps,0,0)) - sampleGhostSlot(slot, p - vec3(eps,0,0));',
    '  float dy = sampleGhostSlot(slot, p + vec3(0,eps,0)) - sampleGhostSlot(slot, p - vec3(0,eps,0));',
    '  float dz = sampleGhostSlot(slot, p + vec3(0,0,eps)) - sampleGhostSlot(slot, p - vec3(0,0,eps));',
    '  return normalize(vec3(dx, dy, dz));',
    '}',
    // rc3.6: pseudo-random scalar in [0,1] for jitter. Hash from frag coord
    // + slot index. Breaks regular step alignment that produced visible
    // horizontal bands on tangent-facing surfaces in rc3/rc3.5.
    'float hashJ(vec2 p){return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);}',
    // ── rc3 · Ghost accumulation pass ─────────────────────────────────────
    // March the original ray from tEn → effectiveExit, sampling each active
    // ghost at coarse steps. Per slot:
    //   kind == 'ghost'  (uGhostKind < 0.5) → translucent envelope (rc3)
    //   kind == 'solid'  (uGhostKind >= 0.5) → opaque body surface (rc3.6)
    // rc3.6: step start is jittered per-fragment to break voxel banding.
    'vec4 accumulateGhosts(vec3 ro, vec3 rd, float tEn, float tExit){',
    '  if(uGhostCount < 0.5) return vec4(0.0);',
    '  vec3 col = vec3(0.0); float alpha = 0.0;',
    '  const int GHOST_STEPS = 40;',
    '  float dtBase = (tExit - tEn) / float(GHOST_STEPS);',
    '  if(dtBase <= 0.0) return vec4(0.0);',
    '  int nGhosts = int(uGhostCount + 0.5);',
    // Jitter offset in [0, 1): shifts every ray\'s step phase independently
    // so the step pattern decorrelates from the voxel grid. Without this,
    // tangent-facing surfaces show visible stripes from voxel-aligned steps.
    '  float jit = hashJ(gl_FragCoord.xy);',
    // Surface lighting setup for solid ghosts (shared with main scaffold path).
    '  vec3 gKey = f13KeyDir(rot); vec3 gFill = f13FillDir(rot);',
    '  for(int i = 0; i < GHOST_STEPS; i++){',
    '    float t = tEn + (float(i) + jit) * dtBase;',
    '    vec3 p = ro + rd * t;',
    '    for(int g = 0; g < GHOST_MAX; g++){',
    '      if(g >= nGhosts) break;',
    '      float d = sampleGhostSlot(g, p);',
    '      if(d < 0.0){',
    '        vec3 c = uGhostColor[g];',
    '        if(uGhostKind[g] >= 0.5){',
    // ── Inactive-solid path: refine hit via linear interp, then shade ─────
    // rc3.7: re-sample at the previous step position to find where the
    // surface crossed between t_prev (outside, d > 0) and t (inside, d < 0).
    // Linear interp gives sub-step precision so the visible surface lands
    // on the actual geometry rather than the coarse step grid. Also washes
    // out per-fragment jitter on the surface position — jitter still helps
    // translucent ghosts but stops creating dithered edges on solids.
    '          float tPrev = max(t - dtBase, tEn);',
    '          vec3 pPrev = ro + rd * tPrev;',
    '          float dPrev = sampleGhostSlot(g, pPrev);',
    '          float tHit = t;',
    '          if(dPrev > 0.0){',
    // dPrev > 0, d < 0 → valid bracket; linear interp.
    '            float frac = dPrev / (dPrev - d);',
    '            tHit = tPrev + (t - tPrev) * frac;',
    '          }',
    '          vec3 pHit = ro + rd * tHit;',
    '          vec3 n = ghostNormal(g, pHit, uViewH * 0.008);',
    '          if(dot(n, -rd) < 0.0) n = -n;',
    // v0.9.5: same light rig as the active body (no shadows/occlusion here).
    '          vec3 ga = f13Lin(c); float gvf = max(dot(n, -rd), 0.0);',
    '          vec3 gLt = keyColV()*max(dot(n, gKey), 0.0) + fillColV()*max(dot(n, gFill), 0.0) + vec3(0.30)*gvf + vec3(0.15);',
    '          vec3 surf = f13Tone(ga*gLt + vec3(0.35)*pow(max(dot(n, normalize(gKey - rd)), 0.0), 48.0) + (ga*0.6+vec3(0.06))*pow(1.0-gvf,3.0)*0.5);',
    '          col += surf * (1.0 - alpha);',
    '          alpha = 1.0;',
    '          break;',
    '        } else {',
    // ── Translucent ghost path: tiny per-step alpha, rc3 behavior ─────────
    // Jitter is fine here — temporal noise reads as atmosphere.
    '          float surface = 1.0 - smoothstep(0.0, 0.15 * uViewH, abs(d));',
    '          float ai = 0.012 + surface * 0.06;',
    '          col += c * ai * (1.0 - alpha);',
    '          alpha += ai * (1.0 - alpha);',
    '          if(alpha > 0.94) break;',
    '        }',
    '      }',
    '    }',
    '    if(alpha > 0.94) break;',
    '  }',
    '  return vec4(col, alpha);',
    '}',
    'void main(){',
    '  vec2 uv=(gl_FragCoord.xy-res*0.5)/min(res.x,res.y);',
    '  vec3 panW=rot*vec3(pan.x,pan.y,0.0);',
    '  vec3 ro=rot*vec3(0.0,0.0,zoom)+panW;vec3 rd=normalize(rot*vec3(uv.x,uv.y,-1.6));',
    '  float r=clamp(length(uv)*1.1,0.0,1.0);',
    '  vec3 bgCol=mix(vec3(0.07,0.07,0.07),vec3(0.03,0.03,0.03),r*r);',
    '  vec3 H3=vec3(uViewH);',
    '  vec3 iv=vec3(1.0)/rd;vec3 tb=(-H3-ro)*iv,tt=(H3-ro)*iv;',
    '  vec3 tmi=min(tb,tt),tma=max(tb,tt);',
    '  float tEn=max(max(tmi.x,tmi.y),tmi.z);float tEx=min(min(tma.x,tma.y),tma.z);',
    '  if(tEn>tEx||tEx<0.0){fragColor=vec4(bgCol,1.0);return;}',
    '  float t=max(tEn,0.001);bool hit=false;bool nearCap=false;',
    '  float thresh=-0.004;float maxStep=uViewH/10.0;',
    '  if(implicit(ro+rd*t)<thresh)nearCap=true;',
    '  if(!nearCap){for(int i=0;i<'+steps+';i++){if(t>tEx)break;vec3 p=ro+rd*t;float d=implicit(p);if(d<thresh){hit=true;break;}t+=clamp(d/uLipschitz*0.85,0.001,maxStep);}}',
    '  vec3 pos;vec3 n; vec3 finalCol;',
    '  if(nearCap){pos=ro+rd*tEn;n=boxNormal(pos);if(dot(n,-rd)<0.0)n=-n;t=tEn;}',
    '  else if(hit){pos=ro+rd*t;n=nrmField(pos);if(dot(n,-rd)<0.0)n=-n;}',
    '  else{if(implicit(ro+rd*tEx)<thresh){pos=ro+rd*tEx;n=boxNormal(pos);if(dot(n,-rd)<0.0)n=-n;t=tEx;}',
    '    else{',
    // Scaffold ray fully missed — render ghosts in front of bg, then return.
    '      vec4 gh = accumulateGhosts(ro, rd, max(tEn,0.0), tEx);',
    '      finalCol = mix(bgCol, gh.rgb / max(gh.a, 1e-4), gh.a);',
    '      fragColor=vec4(clamp(finalCol,0.0,1.0),1.0); return;',
    '    }',
    '  }',
    // ── v0.9.5 · Surface shading ──────────────────────────────────────────
    // Base color: solid color in solid mode, else the body color (per-body
    // pick, weld-group color, or the recipe family color — all arrive via
    // uBaseColor). Negative-R sentinel → neutral clay fallback.
    // Cut faces (view-box caps, or where the shape clip is the active
    // surface) are drawn slightly lighter/desaturated, like a CAD section.
    '  bool isCut=false;',
    '  if(uSolidMode<0.5){',
    '    if(nearCap||!hit) isCut=true;',
    '    else if(uHasShape>0.5&&sampleShape(pos)>sampleScaffoldSDF(pos)) isCut=true;',
    '  }',
    '  vec3 baseCol;',
    '  if(uSolidMode>0.5) baseCol=uSolidColor;',
    '  else if(uBaseColor.r>=0.0) baseCol=uBaseColor;',
    '  else baseCol=vec3(0.78,0.73,0.67);',
    '  vec3 col=f13Shade(baseCol,pos,n,rd,rot,isCut,uAOCell,uNrmStep,1.6*uViewH);',
    '  col=mix(bgCol,col,exp(-max(t-tEn,0.0)*(0.06/uViewH)));',
    // rc3: After scaffold rendered, accumulate ghost tint for the portion of
    // the ray BEFORE the scaffold hit. Ghosts behind opaque scaffold are
    // correctly occluded by this (we march tEn → t, not tEn → tEx).
    '  vec4 gh = accumulateGhosts(ro, rd, max(tEn,0.0), t);',
    '  vec3 ghCol = gh.rgb / max(gh.a, 1e-4);',
    '  finalCol = mix(col, ghCol, gh.a);',
    '  fragColor=vec4(clamp(finalCol,0.0,1.0),1.0);}',
  ].join('\n');
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
  var gl=this.gl;
  var vs='#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}';
  var fs=this._buildShader();
  var vs_=this._mkShader(gl.VERTEX_SHADER,vs);
  var fs_=this._mkShader(gl.FRAGMENT_SHADER,fs);
  if(!vs_||!fs_)return;
  var prg=gl.createProgram();
  gl.attachShader(prg,vs_);gl.attachShader(prg,fs_);gl.linkProgram(prg);
  gl.deleteShader(vs_);gl.deleteShader(fs_);
  if(this._pendingProg)gl.deleteProgram(this._pendingProg);
  this._pendingProg=prg; this._compiling=true;
};
MeshRaymarcher.prototype._activateUniforms=function(){
  var gl=this.gl,p=this.prog;
  this._uRes=gl.getUniformLocation(p,'res');
  this._uRot=gl.getUniformLocation(p,'rot');
  this._uZoom=gl.getUniformLocation(p,'zoom');
  this._uPan=gl.getUniformLocation(p,'pan');
  this._uField=gl.getUniformLocation(p,'uField');
  this._uFieldMin=gl.getUniformLocation(p,'uFieldMin');
  this._uFieldMax=gl.getUniformLocation(p,'uFieldMax');
  this._uLipschitz=gl.getUniformLocation(p,'uLipschitz');
  this._uShapeSDF=gl.getUniformLocation(p,'uShapeSDF');
  this._uBboxMin=gl.getUniformLocation(p,'uBboxMin');
  this._uBboxSize=gl.getUniformLocation(p,'uBboxSize');

  this._uCellSizeMm=gl.getUniformLocation(p,'uCellSizeMm');
  this._uHasShape=gl.getUniformLocation(p,'uHasShape');
  this._uViewH=gl.getUniformLocation(p,'uViewH');
  this._uNrmStep=gl.getUniformLocation(p,'uNrmStep');
  this._uIsPeriodic=gl.getUniformLocation(p,'uIsPeriodic');
  this._uWorldMin=gl.getUniformLocation(p,'uWorldMin');
  this._uWorldSize=gl.getUniformLocation(p,'uWorldSize');
  this._uBakeRaw=gl.getUniformLocation(p,'uBakeRaw');
  this._uFieldMid=gl.getUniformLocation(p,'uFieldMid');
  this._uFieldHalfR=gl.getUniformLocation(p,'uFieldHalfR');
  this._uCenter=gl.getUniformLocation(p,'uCenter');
  this._uHalfW=gl.getUniformLocation(p,'uHalfW');
  this._uTopoMode=gl.getUniformLocation(p,'uTopoMode');
  this._uHalfInvert=gl.getUniformLocation(p,'uHalfInvert');
  // Structure SDF transform uniforms (v0.5.0 Phase B)
  this._uStructRotInv=gl.getUniformLocation(p,'uStructRotInv');
  this._uStructPivotWorld=gl.getUniformLocation(p,'uStructPivotWorld');
  this._uStructOffsetWorld=gl.getUniformLocation(p,'uStructOffsetWorld');
  this._uStructIsoWorld=gl.getUniformLocation(p,'uStructIsoWorld');
  // rc3.5 · Solid-body uniforms
  this._uSolidMode = gl.getUniformLocation(p, 'uSolidMode');
  this._uSolidColor = gl.getUniformLocation(p, 'uSolidColor');
  // rc3.7 · Lattice base-color override
  this._uBaseColor = gl.getUniformLocation(p, 'uBaseColor');
  // v0.9.5 · viewer shading options
  this._uShadowOn = gl.getUniformLocation(p, 'uF13Shadow');
  this._uAOOn = gl.getUniformLocation(p, 'uF13AO');
  this._uWarmCool = gl.getUniformLocation(p, 'uF13WarmCool');
  this._uCutShade = gl.getUniformLocation(p, 'uF13Cut');
  this._uLimeEdge = gl.getUniformLocation(p, 'uF13Lime');
  this._uInteract = gl.getUniformLocation(p, 'uF13Interact');
  this._uAOCell = gl.getUniformLocation(p, 'uAOCell');
  // rc3 · Ghost envelope uniforms
  this._uGhostSDF = new Array(this.GHOST_MAX).fill(null);
  for(var i = 0; i < this.GHOST_MAX; i++){
    this._uGhostSDF[i] = gl.getUniformLocation(p, 'uGhostSDF' + i);
  }
  this._uGhostBboxMin = gl.getUniformLocation(p, 'uGhostBboxMin');
  this._uGhostBboxSize = gl.getUniformLocation(p, 'uGhostBboxSize');
  this._uGhostColor = gl.getUniformLocation(p, 'uGhostColor');
  // rc3.6: per-slot render kind uniform (translucent vs opaque inactive-solid).
  this._uGhostKind = gl.getUniformLocation(p, 'uGhostKind');
  this._uGhostCount = gl.getUniformLocation(p, 'uGhostCount');
  this._pLoc=gl.getAttribLocation(p,'p');
  this._dirty=true;
};
MeshRaymarcher.prototype.render=function(){
  var gl=this.gl;if(!gl)return;
  // Async compile check
  if(this._compiling&&this._pendingProg){
    var ready=!this._khr||gl.getProgramParameter(this._pendingProg,this._khr.COMPLETION_STATUS_KHR);
    if(ready){
      if(gl.getProgramParameter(this._pendingProg,gl.LINK_STATUS)){
        if(this.prog)gl.deleteProgram(this.prog);
        this.prog=this._pendingProg;
        this._activateUniforms();
      }else{console.error('Link error:',gl.getProgramInfoLog(this._pendingProg));gl.deleteProgram(this._pendingProg);}
      this._pendingProg=null;this._compiling=false;
    }
  }
  if(!this.prog||!this.fieldTex||!this._dirty)return;
  this._dirty=false;
  // Resize canvas
  var area=document.getElementById('previewArea');
  var dpr=Math.min(window.devicePixelRatio||1,1.5);
  var w=Math.round((area?area.clientWidth:400)*dpr);
  var h=Math.round((area?area.clientHeight:300)*dpr);
  if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;}
  gl.viewport(0,0,w,h);
  gl.useProgram(this.prog);
  gl.uniform2f(this._uRes,w,h);
  gl.uniformMatrix3fv(this._uRot,false,new Float32Array(this.rotMat));
  if(this._updateGimbal) this._updateGimbal();
  gl.uniform1f(this._uZoom,this.camZoom);
  gl.uniform2f(this._uPan,this.panX||0,this.panY||0);
  gl.uniform1f(this._uFieldMin,this.fieldMin);
  gl.uniform1f(this._uFieldMax,this.fieldMax);
  var wn=this.worldMin,wx=this.worldMax;
  gl.uniform1f(this._uViewH,this.viewH);
  // nrmStep = half voxel size in world units — matches local surface scale, not global field gradient
  var voxelSize=(wx[0]-wn[0])/Math.max(this.bakeN,1);
  gl.uniform1f(this._uNrmStep,Math.max(voxelSize,0.01));
  // Shape SDF Lipschitz in world units = 10/cellSizeMm (from d_mm*(10/cellSizeMm) scaling).
  // Using 1.0 causes 5× overshoot at 2mm cells, jumping past boundaries into phantom hits.
  var shapeLip=(this.hasShape&&this.shapeData)?(10.0/this.shapeData.cellSizeMm):0.0;
  gl.uniform1f(this._uLipschitz,Math.max(this.lipschitz,shapeLip));
  gl.uniform1f(this._uIsPeriodic,this.isPeriodic?1.0:0.0);
  gl.uniform3f(this._uWorldMin,wn[0],wn[1],wn[2]);
  gl.uniform3f(this._uWorldSize,wx[0]-wn[0],wx[1]-wn[1],wx[2]-wn[2]);
  var topo=this.topology||{};
  gl.uniform1f(this._uBakeRaw,topo.bakeRaw?1.0:0.0);
  var fmid=(this.fieldMin+this.fieldMax)*0.5;
  var fhr=Math.max((this.fieldMax-this.fieldMin)*0.5,0.001);
  gl.uniform1f(this._uFieldMid,fmid);gl.uniform1f(this._uFieldHalfR,fhr);
  gl.uniform1f(this._uCenter,topo.bakeRaw&&topo.rawUnits?(((topo.center??0)-fmid)/fhr):(topo.center!=null?topo.center:0.0));
  gl.uniform1f(this._uHalfW,topo.bakeRaw&&topo.rawUnits?((topo.halfW??0.15)/fhr):(topo.halfW!=null?topo.halfW:0.15));
  var tm=topo.topoMode||'sheet';
  gl.uniform1f(this._uTopoMode,tm==='half'?1.0:tm==='solid'?2.0:0.0);
  gl.uniform1f(this._uHalfInvert,topo.halfInvert?1.0:0.0);
  // ── Structure SDF transform uniforms (v0.5.0 Phase B) ───────────────────
  // Default to identity (R=I, offset=0, pivot=0, iso=0) when no transform
  // has been set — cube mode and untransformed shape mode unchanged.
  // In assembly (weld) mode the active member's structure transform must NOT
  // be applied to the baked union — it would shift/inflate the whole group,
  // solids included. Force identity (iso/offset/rot neutralized).
  var st=this._assemblyMode?null:(this._structXform || null);
  if(st){
    gl.uniformMatrix3fv(this._uStructRotInv,false,new Float32Array(st.rotMat));
    gl.uniform3f(this._uStructPivotWorld,st.pivot[0],st.pivot[1],st.pivot[2]);
    gl.uniform3f(this._uStructOffsetWorld,st.offset[0],st.offset[1],st.offset[2]);
    gl.uniform1f(this._uStructIsoWorld,st.iso);
  } else {
    gl.uniformMatrix3fv(this._uStructRotInv,false,new Float32Array([1,0,0,0,1,0,0,0,1]));
    gl.uniform3f(this._uStructPivotWorld,0.0,0.0,0.0);
    gl.uniform3f(this._uStructOffsetWorld,0.0,0.0,0.0);
    gl.uniform1f(this._uStructIsoWorld,0.0);
  }
  // rc3.5: solid-mode uniforms. Default to off if never set.
  if(this._uSolidMode) gl.uniform1f(this._uSolidMode, this._assemblyMode?0.0:(this._solidMode || 0.0));
  if(this._uSolidColor){
    var sc = this._solidColor || [0.8, 0.8, 0.8];
    gl.uniform3f(this._uSolidColor, sc[0], sc[1], sc[2]);
  }
  // rc3.7: lattice base-color override.
  // v0.9.5: with no override, the lattice renders in its recipe's family
  // color (TPMS mint, Noise coral, Wave amber, …) instead of the old palette.
  if(this._uBaseColor){
    var bc = this._baseColor;
    if(!bc || bc[0] < 0){
      bc = (typeof currentRecipe!=='undefined' && currentRecipe && typeof familyColor==='function')
        ? _hexToRGB(familyColor(currentRecipe.family)) : [-1.0, 0.0, 0.0];
    }
    gl.uniform3f(this._uBaseColor, bc[0], bc[1], bc[2]);
  }
  var vo = this.viewOpts;
  if(this._uShadowOn) gl.uniform1f(this._uShadowOn, vo.shadows?1.0:0.0);
  if(this._uAOOn)     gl.uniform1f(this._uAOOn,     vo.occlusion?1.0:0.0);
  if(this._uWarmCool) gl.uniform1f(this._uWarmCool, vo.warmCool?1.0:0.0);
  if(this._uCutShade) gl.uniform1f(this._uCutShade, vo.cutFaces?1.0:0.0);
  if(this._uLimeEdge) gl.uniform1f(this._uLimeEdge, vo.limeEdges?1.0:0.0);
  if(this._uInteract) gl.uniform1f(this._uInteract, this._interacting?1.0:0.0);
  // Occlusion reach ≈ one lattice cell. Shape/weld mode: a cell is 10 world
  // units. Cube mode: the [-5,5] tile, assume ~1.5 cells across.
  if(this._uAOCell){
    var aoCell = (this.hasShape && this.shapeData) ? Math.min(10.0, this.viewH*1.33) : this.viewH*2.0/1.5;
    gl.uniform1f(this._uAOCell, Math.max(aoCell, 1e-3));
  }
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_3D,this.fieldTex);gl.uniform1i(this._uField,0);
  gl.uniform1f(this._uHasShape, this._assemblyMode?0.0:(this.hasShape&&this.shapeTex?1.0:0.0));
  if(this.hasShape&&this.shapeTex&&this.shapeData){
    var sd=this.shapeData;
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_3D,this.shapeTex);gl.uniform1i(this._uShapeSDF,1);
    gl.uniform3f(this._uBboxMin,sd.bboxMin[0],sd.bboxMin[1],sd.bboxMin[2]);
    gl.uniform3f(this._uBboxSize,sd.bboxSize[0],sd.bboxSize[1],sd.bboxSize[2]);
    gl.uniform1f(this._uCellSizeMm,sd.cellSizeMm);
  }
  // ── rc3 · Ghost texture binding ────────────────────────────────────────
  // Bind each active ghost to texture unit 2..(2+GHOST_MAX-1). Inactive
  // slots still need to bind something — use the field texture as a stand-in
  // since the shader gates ghost sampling on uGhostCount.
  this._initGhostState();
  var ghostCount = Math.max(0, Math.min(this._ghostCount || 0, this.GHOST_MAX));
  var bboxMinFlat = new Float32Array(this.GHOST_MAX * 3);
  var bboxSizeFlat = new Float32Array(this.GHOST_MAX * 3);
  var colorFlat = new Float32Array(this.GHOST_MAX * 3);
  // rc3.6: per-slot render kind. 0.0 = translucent ghost, 1.0 = opaque inactive-solid.
  var kindFlat = new Float32Array(this.GHOST_MAX);
  for(var gi = 0; gi < this.GHOST_MAX; gi++){
    var unit = 2 + gi;
    gl.activeTexture(gl.TEXTURE0 + unit);
    var meta = this._ghostMeta[gi];
    if(meta && this._ghostTex[gi]){
      gl.bindTexture(gl.TEXTURE_3D, this._ghostTex[gi]);
      bboxMinFlat[gi*3+0] = meta.bboxMin[0]; bboxMinFlat[gi*3+1] = meta.bboxMin[1]; bboxMinFlat[gi*3+2] = meta.bboxMin[2];
      bboxSizeFlat[gi*3+0] = meta.bboxSize[0]; bboxSizeFlat[gi*3+1] = meta.bboxSize[1]; bboxSizeFlat[gi*3+2] = meta.bboxSize[2];
      colorFlat[gi*3+0] = meta.color[0]; colorFlat[gi*3+1] = meta.color[1]; colorFlat[gi*3+2] = meta.color[2];
      kindFlat[gi] = (meta.kind === 'solid') ? 1.0 : 0.0;
    } else {
      // Bind a stand-in (the field tex) to keep the sampler valid.
      gl.bindTexture(gl.TEXTURE_3D, this.fieldTex);
      bboxSizeFlat[gi*3+0] = 1.0; bboxSizeFlat[gi*3+1] = 1.0; bboxSizeFlat[gi*3+2] = 1.0;
    }
    if(this._uGhostSDF && this._uGhostSDF[gi]) gl.uniform1i(this._uGhostSDF[gi], unit);
  }
  if(this._uGhostBboxMin)  gl.uniform3fv(this._uGhostBboxMin,  bboxMinFlat);
  if(this._uGhostBboxSize) gl.uniform3fv(this._uGhostBboxSize, bboxSizeFlat);
  if(this._uGhostColor)    gl.uniform3fv(this._uGhostColor,    colorFlat);
  if(this._uGhostKind)     gl.uniform1fv(this._uGhostKind,     kindFlat);
  if(this._uGhostCount)    gl.uniform1f(this._uGhostCount, ghostCount);
  gl.bindBuffer(gl.ARRAY_BUFFER,this.quadBuf);
  gl.enableVertexAttribArray(this._pLoc);
  gl.vertexAttribPointer(this._pLoc,2,gl.FLOAT,false,0,0);
  gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
};
MeshRaymarcher.prototype._startLoop=function(){
  var self=this;
  self._loopRunning=true;
  var lastTs=0;
  function loop(ts){
    var dt=Math.min((ts-lastTs)/1000,0.05);lastTs=ts;
    if(self._dirty||self._compiling){
      self.rotMat=self._orthonorm(self.rotMat);
      self.render();
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
