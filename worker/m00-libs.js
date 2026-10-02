/* F13LD.mesh · worker/m00-libs.js — Manifold + meshoptimizer loaders, meshoptSimplify. */
let ManifoldAPI=null;
const manifoldReady=(async()=>{
  try{
    const mod=await import('https://cdn.jsdelivr.net/npm/manifold-3d@3.4.1/+esm');
    const wasm=await mod.default();wasm.setup();ManifoldAPI=wasm;
  }catch(e){console.error('[worker] Manifold load failed:',e);}
})();

// ── meshoptimizer — replaces Manifold.simplify for decimation ────────────
// Handles 100M+ triangle meshes without the WASM "table index out of bounds"
// crash that plagued Manifold.simplify above ~10M tris. Edge-collapse based
// quadric error simplifier. Signature:
//   simplify(indices, positions, stride=3, targetIdxCount, targetError, flags)
//     → [Uint32Array, achievedError]
// 'ErrorAbsolute' flag makes targetError an absolute distance (mm), matching
// our existing simplifyTol semantics. targetIdxCount=6 (minimum) lets the
// error budget drive the stopping condition, mirroring Manifold.simplify(tol).
let MeshoptSimplifier=null;
const meshoptReady=(async()=>{
  try{
    const mod=await import('https://cdn.jsdelivr.net/npm/meshoptimizer@1.1.1/+esm');
    MeshoptSimplifier=mod.MeshoptSimplifier;
    await MeshoptSimplifier.ready;
  }catch(e){console.error('[worker] meshoptimizer load failed:',e);}
})();

// ── Helper: run meshopt simplify + compact on a raw indexed mesh ─────────
// Input:  positions Float32Array (xyz×3 stride), indices Uint32Array, tolMm
// Output: {positions, indices, preTris, postTris, error} or null on failure
//
// CRITICAL: MeshoptSimplifier.compactMesh(indices) MUTATES 'indices' in-place
// to hold the new compacted index values (applies remap internally). The
// returned remap table is ONLY for remapping the vertex array — it must NOT
// be applied to the indices again, or every vertex reference gets double-
// looked-up through an unrelated mapping. This was the v0.4.0 bug that
// produced 0xFFFFFFFF (= 4294967295) indices in exported 3MF files and
// triggered Lib3MF Error 5 ("Cannot convert to UTF16") in nTopology.
function meshoptSimplify(positions,indices,tolMm){
  if(!MeshoptSimplifier) return null;
  const preTris=indices.length/3;
  try{
    const [newIdx,achievedError]=MeshoptSimplifier.simplify(
      indices,positions,3, /*targetIdxCount*/ 6, /*targetError*/ tolMm,
      ['ErrorAbsolute']
    );
    // compactMesh mutates newIdx in-place → new compacted index values.
    // Returned remap maps OLD vertex index → NEW vertex index (or 0xFFFFFFFF
    // for unused old vertices). Use it ONLY to build the compacted vertex
    // array, NEVER to re-remap newIdx (which is already compacted).
    const [remap,newVertCount]=MeshoptSimplifier.compactMesh(newIdx);
    // remap.length can be smaller than positions.length/3 if the highest-
    // indexed original vertices got simplified out. Iterate remap.length
    // only — out-of-bounds reads on a TypedArray return undefined, which
    // compares unequal to 0xFFFFFFFF and silently writes to outPos[NaN*3].
    const outPos=new Float32Array(newVertCount*3);
    for(let i=0;i<remap.length;i++){
      const r=remap[i];
      if(r!==0xFFFFFFFF){
        outPos[r*3  ]=positions[i*3  ];
        outPos[r*3+1]=positions[i*3+1];
        outPos[r*3+2]=positions[i*3+2];
      }
    }
    // Validate output: no index can point past the compacted vertex array.
    // Catches any residual contract violation instead of silently writing a
    // corrupt 3MF that fails downstream in slicers/nTop.
    for(let i=0;i<newIdx.length;i++){
      if(newIdx[i]>=newVertCount){
        throw new Error('meshopt output has invalid index '+newIdx[i]+' (vertCount='+newVertCount+')');
      }
    }
    return {positions:outPos,indices:newIdx,preTris,postTris:newIdx.length/3,error:achievedError};
  }catch(e){
    console.warn('[worker] meshopt simplify failed:',e);
    return null;
  }
}
