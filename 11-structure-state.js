/* ============================================================
   F13LD.mesh · 11-structure-state.js
   Structure SDF transform state (rotate / offset / iso) — v0.5.0 Phase B.
   ============================================================ */
'use strict';

// ── Structure SDF transform (v0.5.0 Phase B) ─────────────────────────────
// User-applied modifier on the periodic structure SDF, evaluated in shape
// coordinates. Lives in UI only — never persisted to the recipe JSON.
// Reset to identity on every new shape import (per user spec).
//
// Transform formula in shape-mm space:
//   localP = R^T × ((p - shapeCenterMm) - spatialOffsetMm)   (R^T = inverse rotation)
//   sc     = sdfFn(localP) - isoOffsetMm                      (negative because +iso → thicker walls)
//
// rotMat is column-major 3x3 (same convention as the camera rotMat).
// spatialOffsetMm and isoOffsetMm are in mm.
let structureTransform = {
  rotXDeg: 0, rotYDeg: 0, rotZDeg: 0,
  spatialOffsetMmX: 0, spatialOffsetMmY: 0, spatialOffsetMmZ: 0,
  isoOffsetMm: 0,
  rotMat: [1,0,0, 0,1,0, 0,0,1] // identity by default
};

// Builds an inverse-rotation (R^T) column-major 3x3 from a rotation vector
// (Rodrigues / exponential coordinates) in degrees.
//
// Interpretation: v = (rxDeg, ryDeg, rzDeg) defines a single rotation by
//   angle = ‖v‖ degrees about axis = v / ‖v‖.
// Single-axis cases reduce to the obvious behavior:
//   (a, 0, 0) → rotate a° about world X
//   (0, a, 0) → rotate a° about world Y
//   (0, 0, a) → rotate a° about world Z
// Composite cases rotate about the resultant axis by its magnitude.
//
// Replaces the v0.5.0 Euler-XYZ parameterization, which had a gimbal-lock
// singularity at rotY = ±90° (rotX and rotZ collapsed to the same axis).
// Rotation-vector / axis-angle is free of gimbal lock at every input.
//
// Returns R^T in column-major order so the matrix can be used directly as
// `M × q` in code (rather than needing per-call transpose). Output contract
// is identical to the prior eulerXYZToInvMat3 — all downstream sites (shader
// uniform, bake bbox math, per-voxel transform, trim-to-nodes) need no change.
function rotVecToInvMat3(rxDeg, ryDeg, rzDeg){
  const vx = rxDeg*Math.PI/180, vy = ryDeg*Math.PI/180, vz = rzDeg*Math.PI/180;
  const th = Math.sqrt(vx*vx + vy*vy + vz*vz);
  if(th < 1e-9){
    // Identity. Avoid the 0/0 in axis normalization.
    return [1,0,0, 0,1,0, 0,0,1];
  }
  const ax = vx/th, ay = vy/th, az = vz/th;
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  // Rodrigues' rotation formula — forward R (rotates p by th about axis).
  const r00 = c + ax*ax*C;
  const r01 = ax*ay*C - az*s;
  const r02 = ax*az*C + ay*s;
  const r10 = ay*ax*C + az*s;
  const r11 = c + ay*ay*C;
  const r12 = ay*az*C - ax*s;
  const r20 = az*ax*C - ay*s;
  const r21 = az*ay*C + ax*s;
  const r22 = c + az*az*C;
  // R^T in column-major (col*3+row): col c, row r of R^T = col r, row c of R.
  return [
    r00, r01, r02,   // col 0 of R^T = row 0 of R
    r10, r11, r12,   // col 1 of R^T = row 1 of R
    r20, r21, r22    // col 2 of R^T = row 2 of R
  ];
}

function recomputeStructureRotMat(){
  structureTransform.rotMat = rotVecToInvMat3(
    structureTransform.rotXDeg,
    structureTransform.rotYDeg,
    structureTransform.rotZDeg
  );
}

function resetStructureTransform(){
  structureTransform.rotXDeg = 0;
  structureTransform.rotYDeg = 0;
  structureTransform.rotZDeg = 0;
  structureTransform.spatialOffsetMmX = 0;
  structureTransform.spatialOffsetMmY = 0;
  structureTransform.spatialOffsetMmZ = 0;
  structureTransform.isoOffsetMm = 0;
  structureTransform.rotMat = [1,0,0, 0,1,0, 0,0,1];
}
// Expose so raymarcher can re-read on cell-size changes (mm→world rescale).
if(typeof window!=='undefined') window.structureTransform = structureTransform;

// (v0.5.0-rc7) Wire-frame overlay of imported shape removed — was rendered
// via the Three.js scene that's now gone. The raymarcher's shape SDF preview
// already shows the bounding shape implicitly (where structure is clipped to).
// clearShapeWire kept as a no-op so callers don't need to be updated.
function clearShapeWire(){ /* no-op */ }
