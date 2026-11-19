// proto/gpu-bake/lib/loader.mjs
// Loads the REAL worker field code (worker/m05 .. m32) from source text, the same files
// the mesh worker / field-bake-worker.js import, into one function scope, and returns the
// functions the bake needs. Works in Node and in the browser (no vm, no importScripts):
// the sources are concatenated and evaluated once with `new Function`.
//
// Used by the page (sources fetched, or inlined in the single file) and by cpu-bench.mjs.
// selftest.mjs additionally loads the same files the tests/ way (vm context) as the
// independent "real" side.

export const WORKER_FILES = [
  'm05-sdf-registry.js', 'm10-noise.js', 'm11-grain-fields.js', 'm12-reaction-diffusion.js',
  'm20-sdf-noise-tpms.js', 'm21-sdf-beam.js', 'm22-sdf-grain.js', 'm23-sdf-bundle.js',
  'm24-sdf-wave.js', 'm25-sdf-foam.js', 'm30-sdf-assembly.js', 'm31-weld-grid.js',
  'm32-export-field.js',
];

const EXPORTS = ['buildSDF', 'buildExportField', 'weldGridDims', 'weldBakeLayers',
  'evalField', 'buildSpinodoidWaves', 'buildGRFWaves', 'grainParamsFromField', 'compileTermsList'];

// sources: { 'm05-sdf-registry.js': text, ... }
export function loadWorkerCode(sources) {
  let body = '"use strict";\n';
  for (const f of WORKER_FILES) {
    if (typeof sources[f] !== 'string') throw new Error('worker source missing: ' + f);
    body += '// ---- ' + f + '\n' + sources[f] + '\n';
  }
  body += 'return {' + EXPORTS.map(n => n + ': (typeof ' + n + " === 'function' ? " + n + ' : null)').join(', ') + '};';
  // `self` is what the worker files post progress to; a no-op here.
  const fn = new Function('self', body);
  return fn({ postMessage() {} });
}
