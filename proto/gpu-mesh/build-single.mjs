// Builds gpu-mesh-single.html: index.html with the browser modules inlined as one <script type="module">.
// Plain Node, no dependencies:  node proto/gpu-mesh/build-single.mjs
// The .mjs sources stay the source of truth. Fails loudly on a non-relative import or a top-level name clash.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const ORDER = ['tables', 'cpu-mesher', 'meshcheck', 'gpu-mesher', 'viewer', 'main'];
const fail = m => { console.error('build-single: ' + m); process.exit(1); };

const seen = new Map(); // top-level name -> module
const parts = [];
for (const name of ORDER) {
  const file = name + '.mjs';
  const src = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const out = [];
  let inTpl = false; // inside a multi-line `template literal` (e.g. WGSL source): copy verbatim
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const wasIn = inTpl;
    if ((line.replace(/\\./g, '').match(/`/g) || []).length % 2) inTpl = !inTpl;
    if (wasIn) { out.push(line); continue; }
    // static imports (single-line)
    const imp = line.match(/^\s*import\s+(?:[^'"]*?\s+from\s+)?(['"])([^'"]+)\1\s*;?\s*$/);
    if (imp) {
      const spec = imp[2];
      if (!/^\.\/[\w.-]+\.mjs$/.test(spec)) fail(`${file}:${i + 1}: import is not relative: ${spec}`);
      if (!ORDER.includes(spec.slice(2, -4))) fail(`${file}:${i + 1}: import of unknown module ${spec}`);
      out.push('// (import removed: ' + spec + ')');
      continue;
    }
    if (/^\s*import\b(?!\s*\()/.test(line)) fail(`${file}:${i + 1}: unhandled import form: ${line.trim()}`);
    // dynamic imports of the sibling modules: the names are already in scope
    const dyn = line.match(/^\s*const\s+\{[^}]*\}\s*=\s*await\s+import\(\s*(['"])([^'"]+)\1\s*\)\s*;?\s*$/);
    if (dyn) {
      if (!/^\.\/[\w.-]+\.mjs$/.test(dyn[2]) || !ORDER.includes(dyn[2].slice(2, -4))) fail(`${file}:${i + 1}: dynamic import not a known relative module: ${dyn[2]}`);
      out.push('// (dynamic import removed: ' + dyn[2] + ')');
      continue;
    }
    if (/\bimport\s*\(/.test(line) && !/^\s*\/\//.test(line)) fail(`${file}:${i + 1}: unhandled dynamic import: ${line.trim()}`);
    // export { A, B };  -> dropped (names are already declared in scope)
    if (/^export\s*\{[^}]*\}\s*;?\s*$/.test(line)) { out.push('// ' + line); continue; }
    if (/^export\s+default\b/.test(line)) fail(`${file}:${i + 1}: export default not supported`);
    if (/^export\s+\*/.test(line) || /^export\s*\{[^}]*\}\s*from/.test(line)) fail(`${file}:${i + 1}: re-export not supported`);
    line = line.replace(/^export\s+/, '');
    // record top-level declarations
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
if (/<\/script/i.test(script)) fail('a module contains "</script", which would end the inline script');

let html = readFileSync(join(dir, 'index.html'), 'utf8');
const tag = '<script type="module" src="./main.mjs"></script>';
if (!html.includes(tag)) fail('index.html does not contain ' + tag);
html = html.replace(tag, () => '<script type="module">\n' + script + '\n</script>');
writeFileSync(join(dir, 'gpu-mesh-single.html'), html);
console.log(`wrote gpu-mesh-single.html (${Buffer.byteLength(html)} bytes, ${seen.size} top-level names, ${ORDER.length} modules)`);
