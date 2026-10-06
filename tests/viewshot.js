// Preview screenshots for viewer/shader work (dev only).
// Usage: node viewshot.js <build> <outDir> [case,case,…] [quality]
// Loads each recipes.json case (cube or shape mode), waits for the preview,
// and saves <outDir>/<case>.png of the viewport. Compare two builds by
// running it twice into different folders. Env VIEW='{"shadows":false}'
// sets viewer options before the shot.
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const NM = path.join(__dirname, 'node_modules');
const [BUILD, OUT, CASES, QUAL] = process.argv.slice(2);
const MIME = { js: 'application/javascript', mjs: 'application/javascript', html: 'text/html',
  css: 'text/css', wasm: 'application/wasm', json: 'application/json', stl: 'model/stl' };
const mime = p => MIME[p.split('.').pop()] || 'application/octet-stream';
const ENTRY = { 'fflate': 'esm/browser.js', 'meshoptimizer': 'index.js', 'manifold-3d': 'manifold.js' };
function cdn(url) {
  const u = new URL(url);
  if (u.host === 'esm.sh') {
    if (u.pathname.startsWith('/three@0.158.0')) return { body: fs.readFileSync(NM + '/three/build/three.module.js'), type: MIME.js };
    if (u.pathname.startsWith('/three-mesh-bvh@0.7.8')) {
      let s = fs.readFileSync(NM + '/three-mesh-bvh/build/index.module.js', 'utf8');
      s = s.replace(/from\s*['"]three['"]/g, "from 'https://esm.sh/three@0.158.0'");
      return { body: s, type: MIME.js };
    }
  }
  if (u.host === 'cdn.jsdelivr.net') {
    const m = u.pathname.match(/^\/npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.*)$/);
    if (m) { let rest = m[2]; if (rest === '+esm') rest = ENTRY[m[1]]; const f = path.join(NM, m[1], rest); if (fs.existsSync(f)) return { body: fs.readFileSync(f), type: mime(f) }; }
  }
  return null;
}
(async () => {
  const all = JSON.parse(fs.readFileSync(path.join(__dirname, 'recipes.json'), 'utf8'));
  const names = CASES ? CASES.split(',') : Object.keys(all);
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  for (const name of names) {
    const spec = all[name]; if (!spec) { console.log('no case', name); continue; }
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
    await ctx.route('**/*', async route => {
      const u = new URL(route.request().url());
      if (u.host === 'site.test') { let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html'; const f = path.join(BUILD, p);
        return fs.existsSync(f) ? route.fulfill({ body: fs.readFileSync(f), contentType: mime(f) }) : route.fulfill({ status: 404, body: '' }); }
      if (u.host.startsWith('fonts.')) return route.fulfill({ body: '', contentType: 'text/css' });
      const hit = cdn(u.href); if (hit) return route.fulfill({ body: hit.body, contentType: hit.type, headers: { 'access-control-allow-origin': '*' } });
      return route.abort();
    });
    if (spec.cores) await ctx.addInitScript(n => Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => n }), spec.cores);
    if (process.env.VIEW) await ctx.addInitScript(v => { try { localStorage.setItem('f13ld.mesh.view', v); } catch (e) {} }, process.env.VIEW);
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    await page.goto('http://site.test/index.html?r=' + encodeURIComponent(JSON.stringify(spec.recipe)));
    await page.waitForTimeout(1500);
    const idle = () => page.waitForFunction(() => { const o = document.getElementById('computeOverlay'); return !o || o.classList.contains('hidden'); }, null, { timeout: 180000 }).catch(() => {});
    if (spec.shape) {
      await page.setInputFiles('#shapeInput', path.join(__dirname, 'fixtures', spec.shape));
      await page.waitForSelector('.shapeCard[data-body-id]', { timeout: 120000 }); await idle();
      await page.waitForTimeout(800); await page.click('.libraryChip'); await page.waitForTimeout(800);
      if (spec.cellMm != null) await page.evaluate(v => { const i = document.getElementById('shapeCellSizeMm'); if (i) { i.value = v; window.onCellSizeInput && window.onCellSizeInput(); } }, spec.cellMm);
    }
    await idle();
    if (QUAL) { await page.evaluate(q => window.triggerPreview && window.triggerPreview(q), QUAL); await page.waitForTimeout(500); await idle(); }
    await page.evaluate(() => { if (typeof rm !== 'undefined') rm._dirty = true; });
    await page.waitForTimeout(2500);
    await page.locator('#previewArea').screenshot({ path: path.join(OUT, name + '.png') });
    console.log(name, errs.length ? 'ERRORS: ' + errs.slice(0, 3).join(' | ') : 'ok');
    await ctx.close();
  }
  await browser.close();
})();
