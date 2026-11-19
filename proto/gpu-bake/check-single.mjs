// Checks gpu-bake-single.html: no external script, module import or stylesheet; the WGSL kernels
// and the inlined worker code are present; the inline module script parses.
//   node proto/gpu-bake/check-single.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(dir, 'gpu-bake-single.html'), 'utf8');
const problems = [];
const bad = (m) => problems.push(m);

for (const m of html.matchAll(/<script\b([^>]*)>/gi)) if (/\bsrc\s*=/.test(m[1])) bad('external script: ' + m[0]);
for (const m of html.matchAll(/<link\b[^>]*>/gi)) if (/rel\s*=\s*["']?stylesheet/i.test(m[0]) || /\bhref\s*=/.test(m[0])) bad('external link: ' + m[0]);
for (const m of html.matchAll(/@import\b[^;]*;/g)) bad('css @import: ' + m[0]);
// the module script body: no import statements or dynamic imports of anything
const mod = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!mod) bad('no inline module script');
else {
  const body = mod[1];
  for (const m of body.matchAll(/^\s*import\s[^\n]*$/gm)) bad('module import statement: ' + m[0].trim());
  for (const m of body.matchAll(/(^|[^.\w])import\s*\(/g)) bad('dynamic import(): ' + body.slice(m.index, m.index + 40));
  if (/^\s*export\s/m.test(body)) bad('export statement left in the inline script');
  try { new Function(body.replace(/\bimport\.meta\b/g, '({})')); } catch (e) { bad('inline script does not parse as a function body: ' + e.message); }
}
// the kernels
for (const needle of ['@compute @workgroup_size(256)', 'fn phi(', 'fn field(px: f32, py: f32, pz: f32)', 'cos(a)', 'WGSL_TPMS', 'WGSL_GRAIN', 'fn red(']) {
  if (!html.includes(needle)) bad('missing kernel text: ' + needle);
}
if ((html.match(/fn field\(/g) || []).length < 2) bad('expected both a TPMS and a grain "fn field(" kernel');
// the real worker code
for (const needle of ['function buildExportField', 'function weldBakeLayers', 'function buildSpinodoidWaves', 'function compileTermsList']) {
  if (!html.includes(needle)) bad('missing worker code: ' + needle);
}
if (!html.includes('=== F13LD.mesh GPU bake bench') || !html.includes('=== end ===')) bad('log markers missing');

if (problems.length) { console.error('check-single FAILED:\n  ' + problems.join('\n  ')); process.exit(1); }
console.log(`check-single OK: ${html.length} chars, no external script / module import / stylesheet, both WGSL kernels and the worker code inlined`);
