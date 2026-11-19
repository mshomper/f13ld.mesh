// proto/simplify-bench/lib/env.mjs - load F13LD.mesh worker scripts into a Node vm context, as
// tests/slabmesh.js does. Dev tool only; nothing here is wired into the app.
//
//   const ctx = await loadWorker({ source: 'branch' | 'main', files: [...] })
//
// 'branch' reads the files of this worktree; 'main' reads them with `git show main:<file>` so the
// byte-identity check can run the unmodified code. MeshoptSimplifier comes from tests/node_modules
// (meshoptimizer, MIT).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const NM = path.join(ROOT, 'tests', 'node_modules');

// scripts the slab pipeline needs (m34 marching, m35 cleanup, m36 final pass), in load order
export const SLAB_FILES = ['worker/m31-weld-grid.js', 'worker/m34-slab-mesher.js', 'worker/m35-slab-cleanup.js', 'worker/m36-slab-pool.js'];
// scripts that build a recipe's field (Node-built jobs); m00 (CDN loaders) is replaced by stubs
export const FIELD_FILES = ['worker/m05-sdf-registry.js', 'worker/m10-noise.js', 'worker/m11-grain-fields.js', 'worker/m12-reaction-diffusion.js',
  'worker/m20-sdf-noise-tpms.js', 'worker/m21-sdf-beam.js', 'worker/m22-sdf-grain.js', 'worker/m23-sdf-bundle.js', 'worker/m24-sdf-wave.js',
  'worker/m25-sdf-foam.js', 'worker/m30-sdf-assembly.js', 'worker/m31-weld-grid.js', 'worker/m32-export-field.js'];

export function readSource(file, source) {
  if (source === 'main') return execFileSync('git', ['show', 'main:' + file], { cwd: ROOT, maxBuffer: 1 << 28 }).toString('utf8');
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

let _meshopt = null;
export async function meshopt() {
  if (_meshopt) return _meshopt;
  const mod = await import(pathToFileURL(path.join(NM, 'meshoptimizer', 'index.js')).href);
  await mod.MeshoptSimplifier.ready;
  return (_meshopt = mod.MeshoptSimplifier);
}

export async function loadWorker({ source = 'branch', files = SLAB_FILES } = {}) {
  const ctx = { console, performance, Math, Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Uint16Array, Int8Array, Int16Array,
    Map, Set, Array, Object, Number, String, JSON, Date, Error, Promise, ArrayBuffer, DataView, self: {}, meshoptReady: Promise.resolve(),
    setTimeout, clearTimeout };
  vm.createContext(ctx);
  ctx.MeshoptSimplifier = await meshopt();
  for (const f of files) vm.runInContext(readSource(f, source), ctx, { filename: f });
  return ctx;
}
