/* ============================================================
   F13LD.mesh · 01-config.js
   Version + asset URL helper. Worker files are fetched with ?v=VERSION so a
   deploy never mixes a fresh page with stale cached worker code.
   ============================================================ */
'use strict';

const F13LD_MESH_VERSION='0.9.6';
function meshAssetUrl(path){
  return new URL(path+'?v='+F13LD_MESH_VERSION, document.baseURI).href;
}
