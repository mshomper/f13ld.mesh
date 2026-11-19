// Builds gpu-bake-single.html: index.html with every browser module AND the real worker field
// code inlined, so it opens by double-click (file://). Plain Node, no dependencies, deterministic
// (no timestamps; line endings normalised to LF):   node proto/gpu-bake/build-single.mjs
// The .mjs sources stay the source of truth. Fails loudly on a non-relative import or a name clash.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKER_FILES } from './lib/loader.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const repo = join(dir, '..', '..');
const ORDER = ['lib/loader', 'lib/grid', 'lib/field', 'lib/params', 'lib/emu', 'lib/bands', 'lib/hybrid', 'lib/wgsl', 'main'];
const BASES = ORDER.map(o => o.split('/').pop());
const fail = m => { console.error('build-single: ' + m); process.exit(1); };
const lf = s => s.replace(/\r\n/g, '\n');

const seen = new Map();
const parts = [];
for (const name of ORDER) {
  const file = name + '.mjs';
  const lines = lf(readFileSync(join(dir, file), 'utf8')).split('\n');
  const out = [];
  let inTpl = false; // inside a multi-line `template literal` (the WGSL kernels): copy verbatim
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const wasIn = inTpl;
    if ((line.replace(/\\./g, '').match(/`/g) || []).length % 2) inTpl = !inTpl;
    if (wasIn) { out.push(line); continue; }
    const imp = line.match(/^\s*import\s+(?:[^'"]*?\s+from\s+)?(['"])([^'"]+)\1\s*;?\s*$/);
    if (imp) {
      const m = imp[2].match(/^\.\/(?:lib\/)?([\w.-]+)\.mjs$/);
      if (!m || !BASES.includes(m[1])) fail(`${file}:${i + 1}: import is not a known relative module: ${imp[2]}`);
      out.push('// (import removed: ' + imp[2] + ')');
      continue;
    }
    if (/^\s*import\b(?!\s*\()/.test(line)) fail(`${file}:${i + 1}: unhandled import form: ${line.trim()}`);
    if (/\bimport\s*\(/.test(line) && !/^\s*\/\//.test(line)) fail(`${file}:${i + 1}: unhandled dynamic import: ${line.trim()}`);
    if (/^export\s*\{[^}]*\}\s*;?\s*$/.test(line)) { out.push('// ' + line); continue; }
    if (/^export\s+default\b/.test(line) || /^export\s+\*/.test(line)) fail(`${file}:${i + 1}: unsupported export form`);
    line = line.replace(/^export\s+/, '');
    const d = line.match(/^(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/);
    if (d) {
      if (seen.has(d[1])) fail(`name clash: "${d[1]}" declared in ${seen.get(d[1])}.mjs and ${file}:${i + 1}`);
      seen.set(d[1], name);
    }
    out.push(line);
  }
  parts.push(`// ===== ${file} =====\n` + out.join('\n').replace(/\n+$/, ''));
}
const script = parts.join('\n\n');
if (/<\/script/i.test(script)) fail('a module contains "</script"');

const src = {};
for (const f of WORKER_FILES) src[f] = lf(readFileSync(join(repo, 'worker', f), 'utf8'));
const srcJson = JSON.stringify(src).replace(/<\//g, '<\\/');   // "<\/" is a valid JSON escape for "/"

let html = lf(readFileSync(join(dir, 'index.html'), 'utf8'));
const tag = '<script type="module" src="./main.mjs"></script>';
if (!html.includes(tag)) fail('index.html does not contain ' + tag);
html = html.replace(tag, () => '<script>window.__WORKER_SRC__=' + srcJson + ';</script>\n<script type="module">\n' + script + '\n</script>');
writeFileSync(join(dir, 'gpu-bake-single.html'), html);
console.log(`wrote gpu-bake-single.html (${Buffer.byteLength(html)} bytes, ${seen.size} top-level names, ${ORDER.length} modules, ${WORKER_FILES.length} worker files)`);
