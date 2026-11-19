// proto/gpu-bake/lib/parallel.mjs -- split a CPU bake or an emulated bake over worker threads
// (Node only). Each thread loads the real worker code itself and writes its z layers straight
// into a shared array.
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { cubeGrid } from './grid.mjs';

export function threadCount() {
  const c = (os.availableParallelism ? os.availableParallelism() : os.cpus().length);
  return Math.max(1, Math.min(6, c - 1));
}

export class BakePool {
  constructor(count = threadCount()) {
    this.count = count;
    this.workers = [];
    for (let i = 0; i < count; i++) this.workers.push(new Worker(new URL('./bake-thread.mjs', import.meta.url)));
  }
  async run(job, n, BytesArr) {
    const g = cubeGrid(n), P = this.count, nz1 = g.n[2] + 1, nz2 = g.n[2] + 2;
    const total = g.mainCount + g.offCount;
    const sab = new SharedArrayBuffer(total * BytesArr.BYTES_PER_ELEMENT);
    const at = (len, t) => Math.round(len * t / P);
    await Promise.all(this.workers.map((w, t) => new Promise((res, rej) => {
      w.once('message', res); w.once('error', rej);
      w.postMessage({ ...job, n, sab, zRange: { main: [at(nz1, t), at(nz1, t + 1)], off: [at(nz2, t), at(nz2, t + 1)] } });
    })));
    return new BytesArr(sab);
  }
  cpu(key, recipe, n) { return this.run({ op: 'cpu', key, recipe }, n, Float64Array); }
  emu(key, recipe, n, perturb) { return this.run({ op: 'emu', key, recipe, perturb }, n, Float32Array); }
  close() { for (const w of this.workers) w.terminate(); }
}
