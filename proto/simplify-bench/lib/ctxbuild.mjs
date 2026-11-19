// proto/simplify-bench/lib/ctxbuild.mjs - browser-safe version of the Node vm loader: the worker scripts and the
// candidate scripts are concatenated into one function scope (a fresh scope per method) and the names the bench
// needs are returned. The scripts are the same text that Node evaluates in a vm context.
export const EXPORTS = ['weldGridDims', 'slabMeshLayers', 'joinSlabs', 'simplifySlab', '_slabFinish', 'triQuality', 'safeSimplify', 'meshClosedReport', 'compactIndexed', 'checkedFlip', 'B1B_STATS'];
export function buildCtx(sources, patches, MeshoptSimplifier) {
  const body = '"use strict";\n' + [...sources, ...patches].map(s => s.replace(/^\s*'use strict';?/m, '')).join('\n;\n') +
    '\nreturn {' + EXPORTS.map(n => `${n}:typeof ${n}==='undefined'?undefined:${n}`).join(',') + '};';
  // eslint-disable-next-line no-new-func
  return new Function('MeshoptSimplifier', 'meshoptReady', 'performance', 'self', 'console', body)(MeshoptSimplifier, Promise.resolve(), performance, {}, console);
}
