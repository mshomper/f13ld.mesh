/* ============================================================
   F13LD.mesh · 21-gimbal.js
   XYZ orientation gimbal overlay.
   ============================================================ */
'use strict';

// ── XYZ orientation gimbal (v0.5.0) ──────────────────────────────────────
// Projects the three world-basis vectors (X=red, Y=green, Z=blue) through
// the camera rotation into screen coords for the SVG gimbal display.
//
// Convention check: rotMat is column-major with rotMat[c*3+r] giving column
// c, row r. The shader uses rotMat to map camera→world coords:
//   ro = rotMat * (0,0,zoom)     (camera origin in world)
//   rd = rotMat * (uv.x,uv.y,-1.6)  (ray dir; camera looks down -Z)
//
// To project a world-axis vector wA into camera space we need rotMat^T * wA,
// i.e. we read the ROWS of rotMat. For world-X axis [1,0,0], camera-space
// coords are (rotMat[0,0], rotMat[0,1], rotMat[0,2]) = (rotMat[0], rotMat[3], rotMat[6]).
// Likewise world-Y → (rotMat[1], rotMat[4], rotMat[7]),
//          world-Z → (rotMat[2], rotMat[5], rotMat[8]).
//
// Screen mapping: screen_x = camera_x, screen_y = -camera_y (SVG y points down).
// Depth: empirically determined from this shader's coord frame —
//   cz > 0 → axis tip is in front (toward viewer) → filled tip
//   cz < 0 → axis tip is behind (away from viewer) → hollow tip
//
// Front/back distinction is done with binary fill (filled tip = front,
// hollow tip = back) rather than continuous opacity fade — opacity fading
// caused visible "pulsing" as axes cross perpendicular to view (cz≈0).
MeshRaymarcher.prototype._updateGimbal=function(){
  var R=this.rotMat;if(!R) return;
  var L=28; // line length in SVG units
  var axes=[
    {id:'X', cx:R[0], cy:R[3], cz:R[6], color:'#ff5252', lineId:'gimX', tipId:'gimXT', labelId:'gimXL'},
    {id:'Y', cx:R[1], cy:R[4], cz:R[7], color:'#4caf50', lineId:'gimY', tipId:'gimYT', labelId:'gimYL'},
    {id:'Z', cx:R[2], cy:R[5], cz:R[8], color:'#42a5f5', lineId:'gimZ', tipId:'gimZT', labelId:'gimZL'},
  ];
  // Sort back-to-front: smaller cz = behind (drawn first); larger cz = in
  // front (drawn last, on top). Sort ascending by cz.
  axes.sort(function(a,b){return a.cz-b.cz;});
  var svg=document.getElementById('orientGimbal');
  if(!svg) return;
  for(var i=0;i<axes.length;i++){
    var a=axes[i];
    var line=document.getElementById(a.lineId);
    var tip=document.getElementById(a.tipId);
    var label=document.getElementById(a.labelId);
    if(!line||!tip||!label) continue;
    var sx=a.cx*L, sy=-a.cy*L; // SVG y-down → flip
    line.setAttribute('x2',sx.toFixed(2));
    line.setAttribute('y2',sy.toFixed(2));
    tip.setAttribute('cx',sx.toFixed(2));
    tip.setAttribute('cy',sy.toFixed(2));
    label.setAttribute('x',sx.toFixed(2));
    label.setAttribute('y',sy.toFixed(2));
    // Front (cz>0): filled tip with dark label inside.
    // Back  (cz<0): hollow tip (transparent fill, colored stroke), colored label.
    // Sign convention determined empirically — the WebGL "looks down -Z"
    // assumption I started with was inverted for this shader's frame.
    if(a.cz>0){
      tip.setAttribute('fill',a.color);
      label.setAttribute('fill','#06080f');
    } else {
      tip.setAttribute('fill','rgba(6,8,15,0.9)');
      label.setAttribute('fill',a.color);
    }
    // Re-append in sorted order; last-appended renders on top in SVG.
    svg.appendChild(line);
    svg.appendChild(tip);
    svg.appendChild(label);
  }
};
MeshRaymarcher.prototype._setupInteraction=function(){
  var self=this,drag=false,panning=false,lx=0,ly=0;
  // Pan: Ctrl+right-drag, plain right-drag, or middle-drag. Rotate: left-drag.
  // Pan sensitivity scales with zoom so the model tracks the cursor at any
  // distance (panX/panY are in the camera's view-plane units, same scale the
  // shader applies via rot*vec3(pan,0)).
  function panScale(){ return self.camZoom * 0.0016; }
  this.canvas.onmousedown=function(e){
    // Ctrl/Cmd + click (left or right) = pan. Otherwise any button
    // (left/right/middle) = rotate — matches CAD apps where right- or
    // middle-drag orbits. Context menu is suppressed below so right-drag
    // rotate doesn't pop a menu.
    var isPan = (e.ctrlKey||e.metaKey) && (e.button===0 || e.button===2);
    if(isPan){ panning=true; drag=false; e.preventDefault(); }
    else if(e.button===0 || e.button===1 || e.button===2){ drag=true; panning=false; self.autoRot=false; if(e.button!==0) e.preventDefault(); }
    if(drag||panning) self._beginInteract();
    lx=e.clientX; ly=e.clientY;
  };
  // Suppress the browser context menu over the canvas so right-drag (rotate)
  // and Ctrl+right-drag (pan) don't pop a menu mid-gesture.
  this.canvas.addEventListener('contextmenu',function(e){e.preventDefault();});
  window.addEventListener('mouseup',function(){drag=false;panning=false;self._endInteract();});
  window.addEventListener('mousemove',function(e){
    if(panning){
      var k=panScale();
      self.panX -= (e.clientX-lx)*k;   // drag right → model follows cursor
      self.panY += (e.clientY-ly)*k;   // screen y-down → view-plane y-up
      lx=e.clientX; ly=e.clientY; self._dirty=true;
    } else if(drag){
      self._applyDelta(e.clientX-lx,e.clientY-ly); lx=e.clientX; ly=e.clientY;
    }
  });
  this.canvas.addEventListener('touchstart',function(e){
    if(e.touches.length===2){ panning=true; drag=false;
      lx=(e.touches[0].clientX+e.touches[1].clientX)*0.5;
      ly=(e.touches[0].clientY+e.touches[1].clientY)*0.5;
    } else { drag=true; panning=false; self.autoRot=false;
      lx=e.touches[0].clientX; ly=e.touches[0].clientY; }
    self._beginInteract();
    e.preventDefault();
  },{passive:false});
  window.addEventListener('touchend',function(e){drag=false;panning=false;if(!e.touches||e.touches.length===0)self._endInteract();});
  window.addEventListener('touchmove',function(e){
    if(panning && e.touches.length===2){
      var cx=(e.touches[0].clientX+e.touches[1].clientX)*0.5;
      var cy=(e.touches[0].clientY+e.touches[1].clientY)*0.5;
      var k=panScale();
      self.panX -= (cx-lx)*k; self.panY += (cy-ly)*k;
      lx=cx; ly=cy; self._dirty=true; e.preventDefault();
    } else if(drag && e.touches.length===1){
      self._applyDelta(e.touches[0].clientX-lx,e.touches[0].clientY-ly);
      lx=e.touches[0].clientX; ly=e.touches[0].clientY; e.preventDefault();
    }
  },{passive:false});
  this.canvas.addEventListener('wheel',function(e){var maxZ=Math.max(80,self.viewH*8);self.camZoom=Math.max(self.viewH*0.3,Math.min(maxZ,self.camZoom+e.deltaY*0.04));self._dirty=true;self._beginInteract();clearTimeout(self._wheelT);self._wheelT=setTimeout(function(){self._endInteract();},180);e.preventDefault();},{passive:false});
};
// Instantiate global raymarcher
const rm = new MeshRaymarcher(document.getElementById('rmCanvas'));
