/* ============================================================
   F13LD.mesh · 00-libs.js
   The one ES module. Loads three / loaders / fflate / three-mesh-bvh via
   the import map in index.html and publishes them as globals for the
   numbered classic scripts that follow (same pattern as F13LD.lab).
   ============================================================ */
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import * as fflate from 'fflate';
import { MeshBVH, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

Object.assign(window, {
  THREE, STLLoader, OBJLoader, ThreeMFLoader, mergeVertices,
  fflate, MeshBVH, computeBoundsTree, disposeBoundsTree
});
