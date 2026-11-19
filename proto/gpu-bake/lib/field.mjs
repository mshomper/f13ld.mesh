// proto/gpu-bake/lib/field.mjs
// CPU field of an open-cube export from the real worker code, plus the float32 coordinate tables
// the kernels read. Shared by the page, selftest and the bake threads.
import { axisTables } from './grid.mjs';

// The open-cube export message as m61/m90 build it (only the fields the field depends on).
export function exportJob(recipe, edgeWorld) { return { mode: 'export', recipe, edgeWorld }; }

// The levelSet callback for an open cube: worker/m32-export-field.js buildExportField,
// = p => -sdf(p) (Manifold convention, positive inside).
export function cpuField(worker, recipe, edgeWorld) {
  return worker.buildExportField(exportJob(recipe, edgeWorld), edgeWorld, null);
}

// Float32 coordinate tables: the exporter's float64 coordinates, each rounded once to float32.
// The kernel reads these instead of computing min + s*i in float32.
export function f32Tables(g) {
  const T = axisTables(g), out = {};
  for (const k of Object.keys(T)) out[k] = Float32Array.from(T[k]);
  return out;
}
// One flat float32 array for the GPU: mx,my,mz,ox,oy,oz concatenated, with the start offsets.
export function flatTables(g) {
  const T = f32Tables(g), keys = ['mx', 'my', 'mz', 'ox', 'oy', 'oz'];
  let len = 0; const start = [];
  for (const k of keys) { start.push(len); len += T[k].length; }
  const flat = new Float32Array(len);
  keys.forEach((k, i) => flat.set(T[k], start[i]));
  return { flat, start };
}

// The grain recipes' preview range: the app caches the preview bake's raw min/max on the recipe
// (recipe._previewFieldMin/Max) and the export reads it (m30 buildSDF). Here a 32^3 cell-centred
// scan of the raw spinodoid field stands in for the preview bake (CPU, float64).
export function setPreviewRange(worker, recipe) {
  const f = recipe.json.field, params = worker.grainParamsFromField(f), waves = worker.buildSpinodoidWaves(params), PI5 = Math.PI / 5, M = 32;
  let mn = Infinity, mx = -Infinity;
  for (let k = 0; k < M; k++) for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
    const v = worker.evalField(waves, ((i + 0.5) / M * 10 - 5) * PI5, ((j + 0.5) / M * 10 - 5) * PI5, ((k + 0.5) / M * 10 - 5) * PI5, null);
    if (v < mn) mn = v; if (v > mx) mx = v;
  }
  const range = mx - mn;
  recipe._previewFieldMin = mn - range * 0.05; recipe._previewFieldMax = mx + range * 0.05;   // padded like the noise convention; any fixed pair serves
  return recipe;
}
