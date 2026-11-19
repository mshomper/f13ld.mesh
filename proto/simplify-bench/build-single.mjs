// proto/simplify-bench/build-single.mjs - builds simplify-bench-single.html: index.html with everything inlined
// (the browser modules as one <script type="module">, the worker scripts and candidate scripts as text, the meshoptimizer
// simplifier as a classic script, and the six Draft meshes as base64) so it opens from file:// by double-click.
//   node proto/simplify-bench/build-single.mjs            build
//   node proto/simplify-bench/build-single.mjs --check    build, then fail (exit 1) if the output references any external
//                                                         script or file, does not parse, or does not run the bench in Node
// Approach copied from proto/gpu-mesh/build-single.mjs (expedition branch): relative imports are removed and the modules
// concatenated in dependency order; fails on a name clash. Build-time edits of the embedded text, both unreachable in the
// single file: the DEV blocks of page.mjs are dropped, and the CDN fallback import in m35 slabMeshoptReady is replaced by a rejection.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(dir, '..', '..');
const ORDER = ['lib/geom.mjs', 'lib/selftest.mjs', 'lib/slabparse.mjs', 'lib/ctxbuild.mjs', 'lib/pipeline.mjs', 'page.mjs'];
const WORKER_FILES = ['worker/m31-weld-grid.js', 'worker/m34-slab-mesher.js', 'worker/m35-slab-cleanup.js', 'worker/m36-slab-pool.js'];
const CAND_FILES = ['cand/a.js', 'cand/fast.js', 'cand/lazy.js', 'cand/window.js', 'cand/rings.js'];
const BUNDLED = ['tpms-gyroid-sheet', 'noise-simplex-sheet', 'grain-hyperuniform', 'grain-spinodoid', 'foam2-open-lloyd', 'foam2-closed-kelvin-1cube'];
const check = process.argv.includes('--check');
const fail = m => { console.error('build-single: ' + m); process.exit(1); };
const rd = (p, base = dir) => fs.readFileSync(path.join(base, p), 'utf8').replace(/\r\n/g, '\n');

// ---- the modules ----
const seen = new Map(), parts = [];
for (const file of ORDER) {
  const lines = rd(file).replace(/\/\*DEV\*\/[\s\S]*?\/\*END DEV\*\//g, '').split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const imp = line.match(/^\s*import\s+(?:[^'"]*?\s+from\s+)?(['"])([^'"]+)\1\s*;?\s*$/);
    if (imp) {
      const spec = path.posix.normalize(path.posix.join(path.posix.dirname(file), imp[2]));
      if (!/^\.\.?\//.test(imp[2]) || !ORDER.includes(spec)) fail(`${file}:${i + 1}: import is not one of the bundled modules: ${imp[2]}`);
      out.push('// (import removed: ' + imp[2] + ')'); continue;
    }
    if (/^\s*import\b(?!\s*\()/.test(line)) fail(`${file}:${i + 1}: unhandled import form: ${line.trim()}`);
    if (/\bimport\s*\(/.test(line) && !/^\s*\/\//.test(line)) fail(`${file}:${i + 1}: unhandled dynamic import: ${line.trim()}`);
    if (/^export\s*\{[^}]*\}\s*;?\s*$/.test(line)) { out.push('// ' + line); continue; }
    if (/^export\s+default\b/.test(line) || /^export\s+\*/.test(line) || /^export\s*\{[^}]*\}\s*from/.test(line)) fail(`${file}:${i + 1}: unsupported export form`);
    line = line.replace(/^export\s+/, '');
    const d = line.match(/^(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/);
    if (d) { if (seen.has(d[1])) fail(`name clash: "${d[1]}" in ${seen.get(d[1])} and ${file}:${i + 1}`); seen.set(d[1], file); }
    out.push(line);
  }
  parts.push(`// ===== ${file} =====\n` + out.join('\n').replace(/\n+$/, ''));
}
const moduleJs = parts.join('\n\n');
if (/<\/script/i.test(moduleJs)) fail('a module contains "</script"');

// ---- data ----
const safeJson = o => JSON.stringify(o).replace(/<\//g, '<\\/');
const files = {};
for (const k of WORKER_FILES) {
  let t = rd(k, root);
  if (k.endsWith('m35-slab-cleanup.js')) t = t.replace(/import\(\s*'https:\/\/cdn\.jsdelivr\.net\/npm\/meshoptimizer@1\.1\.1\/\+esm'\s*\)/, "Promise.reject(new Error('no CDN in the single file'))");
  files[k] = t;
}
for (const k of CAND_FILES) files[k] = rd(k);
const meshes = {};
for (const n of BUNDLED) { const f = path.join(dir, 'data', n + '.draft.slb'); if (!fs.existsSync(f)) fail('missing data file ' + f + ' (run make-jobs.mjs --quals draft)'); meshes[n] = fs.readFileSync(f).toString('base64'); }
const meshopt = rd('vendor/meshopt_simplifier.js').replace(/^\s*export\s*\{\s*MeshoptSimplifier\s*\}\s*;?\s*$/m, '');
if (/export\s*\{/.test(meshopt)) fail('could not strip the export from the meshoptimizer module');
if (/<\/script/i.test(meshopt)) fail('meshoptimizer file contains "</script"');

let html = rd('index.html');
const tag = '<script type="module" src="./page.mjs"></script>';
if (!html.includes(tag)) fail('index.html does not contain ' + tag);
html = html.replace(tag, () => `<script>\n${meshopt}\n</script>\n<script>window.__F13LD_BENCH_SRC__ = ${safeJson({ files, meshes })};</script>\n<script type="module">\n${moduleJs}\n</script>`);
const outFile = path.join(dir, 'simplify-bench-single.html');
fs.writeFileSync(outFile, html);
console.log(`wrote ${path.relative(root, outFile)} (${(Buffer.byteLength(html) / 1e6).toFixed(2)} MB, ${seen.size} top-level names, ${ORDER.length} modules)`);

if (check) {
  const bad = [];
  const stripped = html.replace(/<script>\nvar MeshoptSimplifier[\s\S]*?<\/script>/, '').replace(/window\.__F13LD_BENCH_SRC__ = [\s\S]*?\};<\/script>/, '</script>');
  if (/<script\b[^>]*\bsrc\s*=/i.test(html)) bad.push('a <script src=...> tag');
  if (/<link\b/i.test(html)) bad.push('a <link> tag');
  if (/@import|url\(\s*['"]?(?!data:)/i.test(html)) bad.push('a CSS @import or url()');
  if (/<(?:img|iframe|audio|video|source|embed|object)\b[^>]*\bsrc\s*=/i.test(html)) bad.push('an element with src=');
  { const m = stripped.match(/.{0,40}https?:\/\/.{0,60}/); if (m) bad.push('an http(s) address in the page code: ' + m[0]); }
  { const m = meshopt.match(/.{0,40}https?:\/\/.{0,60}/); if (m) bad.push('an http(s) address in the meshoptimizer file: ' + m[0]); }
  if (/\bfetch\s*\(|\bimport\s*\(|\bXMLHttpRequest\b|\bnew\s+Worker\b|importScripts/.test(moduleJs)) bad.push('fetch / import() / Worker in the page code');
  // the embedded worker texts must not point at a network address either (only m36's unused pool code names a worker file)
  for (const [k, t] of Object.entries(files)) if (/https?:\/\//.test(t)) bad.push('an http(s) address in embedded ' + k);
  // parse the module script
  try { const acornPath = path.join(root, 'tests', 'node_modules', 'acorn', 'dist', 'acorn.mjs'); if (fs.existsSync(acornPath)) { const acorn = await import(pathToFileURL(acornPath).href); acorn.parse(moduleJs, { ecmaVersion: 'latest', sourceType: 'module' }); } else new vm.Script(moduleJs.replace(/^\s*(?:export\s+)/gm, '')); }
  catch (e) { bad.push('the module script does not parse: ' + e.message); }
  // run it: a tiny fake DOM, click Run on the first bundled mesh, expect two result cards (today and B1a) and "done"
  try {
    const fakeEl = () => { const el = { children: [], listeners: {}, classList: { toggle() {}, add() {}, remove() {} }, style: {}, textContent: '', innerHTML: '', value: '', checked: false, disabled: false, scrollTop: 0, scrollHeight: 0,
      addEventListener(t, f) { this.listeners[t] = f; }, appendChild(c) { this.children.push(c); }, click() {} }; return el; };
    const els = {}, doc = { body: fakeEl(), getElementById: id => els[id] || (els[id] = fakeEl()), createElement: () => fakeEl(),
      querySelectorAll: sel => /#methods/.test(sel) ? [{ value: 'today' }, { value: 'B1a' }] : [] };
    els.full = Object.assign(fakeEl(), { checked: false }); els.meshes = Object.assign(fakeEl(), { value: BUNDLED[0] }); els.edge = Object.assign(fakeEl(), { value: '0.1' });
    const sb = { document: doc, console, performance, TextDecoder, Response, Blob, DecompressionStream, atob, setTimeout, Math, Float32Array, Float64Array, Uint32Array, Uint8Array, Int32Array, Map, Set, Promise, JSON, Object, Array, Number, String, Date, Error, DataView, Function, WebAssembly, Symbol, parseInt, isFinite, addEventListener() {} };
    sb.window = sb; vm.createContext(sb);
    vm.runInContext(meshopt, sb); vm.runInContext(`window.__F13LD_BENCH_SRC__ = ${safeJson({ files, meshes })};`, sb);
    vm.runInContext('(async()=>{' + moduleJs.replace(/^\s*(?:export\s+)/gm, '') + '\n})()', sb);
    for (let i = 0; i < 100 && !(els.run && els.run.listeners.click && !els.run.disabled); i++) await new Promise(r => setTimeout(r, 50));
    if (!els.run || !els.run.listeners.click) bad.push('the page did not register its Run button');
    else {
      els.run.listeners.click();
      for (let i = 0; i < 600 && !/done|error/.test(els.log.textContent); i++) await new Promise(r => setTimeout(r, 100));
      if (!/done/.test(els.log.textContent) || els.cards.children.length !== 2) bad.push('the single file did not run the bench in Node: ' + els.log.textContent.slice(-300));
      else console.log('single file ran the bench in Node (fake DOM): ' + els.log.textContent.trim().split('\n').slice(-3).join(' | '));
    }
  } catch (e) { bad.push('running the single file failed: ' + e.message); }
  if (bad.length) { console.error('CHECK FAILED:\n  ' + bad.join('\n  ')); process.exit(1); }
  console.log('CHECK OK: no external script or file referenced, module parses, bench runs');
  process.exit(0);
}
