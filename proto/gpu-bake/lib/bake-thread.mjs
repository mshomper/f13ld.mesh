// proto/gpu-bake/lib/bake-thread.mjs -- worker thread for parallel.mjs (Node only).
import { parentPort } from 'node:worker_threads';
import { loadWorkerCode } from './loader.mjs';
import { readWorkerSources } from './node-sources.mjs';
import { cubeGrid, bakeCpu } from './grid.mjs';
import { cpuField, f32Tables } from './field.mjs';
import { kernelParams } from './params.mjs';
import { emuBake } from './emu.mjs';

const worker = loadWorkerCode(readWorkerSources());
parentPort.on('message', m => {
  const g = cubeGrid(m.n);
  if (m.op === 'cpu') {
    const fn = cpuField(worker, m.recipe, g.edge);
    bakeCpu(fn, g, m.zRange, new Float64Array(m.sab));
  } else if (m.op === 'emu') {
    const params = kernelParams(worker, m.key, m.recipe);
    emuBake(params, f32Tables(g), g, { perturb: m.perturb, zRange: m.zRange, out: new Float32Array(m.sab) });
  }
  parentPort.postMessage({ done: true });
});
