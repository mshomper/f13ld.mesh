// proto/simplify-bench/microcheck.test.mjs - closed-check cost alone: today's meshClosedReport (two Float64 sorts)
// against cand/b1a.js (open-addressing hash) on the raw slab meshes, plus a result equality check.
//   MICRO_ARGS="med" node --test proto/simplify-bench/microcheck.test.mjs     (args: quality [case])
import test from 'node:test';
import path from 'node:path';
import { loadWorker, SLAB_FILES } from './lib/env.mjs';
import { readSlabs } from './lib/slabio.mjs';
import { DATA, CASES } from './make-jobs.mjs';

test('closed check: sort vs hash', { timeout: 300000 }, async () => {
  const [qual = 'med', one] = (process.env.MICRO_ARGS || 'med').split(/\s+/), only = one ? [one] : CASES;
  const T = await loadWorker({ files: SLAB_FILES }), B = await loadWorker({ files: SLAB_FILES, patches: ['cand/b1a.js'] });
  const time = (fn, n) => { fn(); const t = performance.now(); let r; for (let i = 0; i < n; i++) r = fn(); return [(performance.now() - t) / n, r]; };
  for (const name of only) {
    const { slabs } = readSlabs(path.join(DATA, name + '.' + qual + '.slb'));
    const s = slabs[Math.floor(slabs.length / 2)], nV = s.pos.length / 3, open = new Uint8Array(nV); for (const v of s.seamV) open[v] = 1;
    const [t0, r0] = time(() => T.meshClosedReport(s.pos, s.idx, false, open), 5), [t1, r1] = time(() => B.meshClosedReport(s.pos, s.idx, false, open), 5);
    console.log(name.padEnd(28), s.idx.length / 3, 'tris', 'sort', t0.toFixed(1), 'ms', 'hash', t1.toFixed(1), 'ms', 'same ok', r0.ok === r1.ok);
  }
});
