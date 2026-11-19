// node --test proto/simplify-bench/build-single.test.mjs: builds the single-file page and runs build-single.mjs --check.
import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('single file builds with nothing external and runs', { timeout: 120000 }, () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./build-single.mjs', import.meta.url)), '--check'], { encoding: 'utf8' });
  console.log(r.stdout); console.log(r.stderr);
  assert.strictEqual(r.status, 0);
});
