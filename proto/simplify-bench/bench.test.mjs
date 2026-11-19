// node --test proto/simplify-bench/bench.test.mjs: runs the bench in-process (same as bench.mjs).
// Bench arguments: the first line of proto/simplify-bench/bench.args if that file exists, else BENCH_ARGS, else
// "--quick --check".
import test from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { main } from './bench.mjs';

test('simplify bench', { timeout: 1800000 }, async () => {
  const f = fileURLToPath(new URL('./bench.args', import.meta.url));
  const line = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/)[0] : (process.env.BENCH_ARGS || '--quick --check');
  for (const a of line.split(/\s+/).filter(Boolean)) if (!process.argv.includes(a)) process.argv.push(a);
  await main();
});
