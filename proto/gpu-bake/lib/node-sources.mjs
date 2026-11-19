// proto/gpu-bake/lib/node-sources.mjs -- reads the real worker files from the repo (Node only).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKER_FILES } from './loader.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..', '..');
export const GPU_BAKE_DIR = path.resolve(here, '..');
export function readWorkerSources() {
  const out = {};
  for (const f of WORKER_FILES) out[f] = fs.readFileSync(path.join(REPO_ROOT, 'worker', f), 'utf8');
  return out;
}
