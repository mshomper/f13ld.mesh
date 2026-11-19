// node --test proto/simplify-bench/bench.test.mjs [-- extra bench args]: runs the bench in-process (same as bench.mjs).
// Arguments for the bench come from BENCH_ARGS (space separated), default "--quick --check".
import test from 'node:test';
import { main } from './bench.mjs';

test('simplify bench', { timeout: 600000 }, async () => {
  const extra = (process.env.BENCH_ARGS || '--quick --check').split(/\s+/).filter(Boolean);
  for (const a of extra) if (!process.argv.includes(a)) process.argv.push(a);
  await main();
});
