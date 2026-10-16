// v0.13.0 weld visibility, in the browser: a gyroid weld of parts A + B and a
// solid part C. Walks every eye (part, selected part, weld) with the weld
// selected and with C selected, and checks what the preview draws: hidden
// parts leave the weld and aren't drawn; ghosted parts leave the solid weld
// preview and draw as translucent shells (export still includes them); a fully
// hidden weld shows an empty view; the weld grid is sized to the weld and the
// weld is actually drawn (lit pixels).
//
//   node weldvis.js <build>     (SHOTS=<dir> saves the frame of each step; CORES=n, default 6; MINLIT = least share of the frame the weld must light, default 0.01)
const fs = require('fs'), os = require('os'), path = require('path');
const { chromium } = require('playwright');
const NM = path.join(__dirname, 'node_modules');
const _H = fs.readFileSync(path.join(__dirname, 'harness.js'), 'utf8');
eval(_H.slice(_H.indexOf('// UI-ADAPTERS-BEGIN'), _H.indexOf('// UI-ADAPTERS-END')));
const [BUILD] = process.argv.slice(2);
const CORES = +(process.env.CORES || 6);
const MIME = { js: 'application/javascript', mjs: 'application/javascript', html: 'text/html', css: 'text/css', wasm: 'application/wasm', json: 'application/json' };
const mime = p => MIME[p.split('.').pop()] || 'application/octet-stream';
const ENTRY = { 'fflate': 'esm/browser.js', 'meshoptimizer': 'index.js', 'manifold-3d': 'manifold.js' };
function cdn(url) {
  const u = new URL(url);
  if (u.host === 'esm.sh') {
    if (u.pathname.startsWith('/three@0.158.0')) return { body: fs.readFileSync(NM + '/three/build/three.module.js'), type: MIME.js };
    if (u.pathname.startsWith('/three-mesh-bvh@0.7.8')) {
      let s = fs.readFileSync(NM + '/three-mesh-bvh/build/index.module.js', 'utf8');
      return { body: s.replace(/from\s*['"]three['"]/g, "from 'https://esm.sh/three@0.158.0'"), type: MIME.js };
    }
  }
  if (u.host === 'cdn.jsdelivr.net') {
    const m = u.pathname.match(/^\/npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.*)$/);
    if (m) { let rest = m[2]; if (rest === '+esm') rest = ENTRY[m[1]]; const f = path.join(NM, m[1], rest); if (fs.existsSync(f)) return { body: fs.readFileSync(f), type: mime(f) }; }
  }
  return null;
}
function boxStl(file, lo, hi) {
  const P = []; for (let c = 0; c < 8; c++) P.push([c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]]);
  const T = [[0,2,1],[1,2,3],[4,5,6],[5,7,6],[0,1,4],[1,5,4],[2,6,3],[3,6,7],[0,4,2],[2,4,6],[1,3,5],[3,7,5]];
  let s = 'solid box\n';
  for (const t of T) { s += ' facet normal 0 0 0\n  outer loop\n'; for (const i of t) s += `   vertex ${P[i].join(' ')}\n`; s += '  endloop\n endfacet\n'; }
  fs.writeFileSync(file, s + 'endsolid box\n');
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pcache-'));
const STL = { A: path.join(TMP, 'a.stl'), B: path.join(TMP, 'b.stl'), C: path.join(TMP, 'c.stl') };
boxStl(STL.A, [0, 0, 0], [20, 16, 10]); boxStl(STL.B, [18, 0, 0], [38, 16, 10]); boxStl(STL.C, [36, 0, 0], [50, 12, 10]);
const ALL = JSON.parse(fs.readFileSync(path.join(__dirname, 'recipes.json'), 'utf8'));
const RECIPE = ALL['tpms-gyroid-sheet'].recipe, NOISE = ALL['noise-simplex-sheet'].recipe;



// v0.14.0 (P2) live structure settings. On a three-part weld (A lattice, B
// lattice, C solid) and on a single part, every structure setting redraws
// with no bake and no held frame, and the frame changes: cell size, rotation,
// shift, wall offset, fill, skin, fillet, join rule, anchor, grade. A noise
// part re-bakes its region in the background when shifted (no hold).
const sel = (page, id) => page.evaluate(id => (window.railSelectPart || window.switchActiveBody)(id), id);
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 760, height: 560 } });
  const site = 'build.test';
  await ctx.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.host === site) { let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html'; const f = path.join(BUILD, p);
      return fs.existsSync(f) ? route.fulfill({ body: fs.readFileSync(f), contentType: mime(f) }) : route.fulfill({ status: 404, body: '' }); }
    if (u.host.startsWith('fonts.')) return route.fulfill({ body: '', contentType: 'text/css' });
    const hit = cdn(route.request().url()); if (hit) return route.fulfill({ body: hit.body, contentType: hit.type, headers: { 'access-control-allow-origin': '*' } });
    return route.abort();
  });
  await ctx.addInitScript(n => Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => n }), CORES);
  await ctx.addInitScript(() => { try { localStorage.setItem('f13ld.mesh.view', JSON.stringify({ shadows: false, occlusion: false })); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  await page.goto(`http://${site}/index.html?r=` + encodeURIComponent(JSON.stringify(RECIPE)));
  await page.waitForTimeout(1500);
  const idle = async () => { await page.waitForTimeout(450); await page.waitForFunction(() => document.getElementById('computeOverlay').classList.contains('hidden') && !(window.rm && rm.isHeld && rm.isHeld()) && window.F13LD_previewBake.workers().jobs === 0 && F13LD_scene.state().pending === 0, null, { timeout: 300000 }).catch(() => {}); await page.waitForTimeout(400); };
  for (const k of ['A', 'B', 'C']) {
    const n = await uiBodyCount(page);
    await page.setInputFiles('#shapeInput', STL[k]);
    await page.waitForFunction(([n, S]) => document.querySelectorAll(S).length > n, [n, UI_BODY], { timeout: 180000 });
    await idle();
  }
  const ids = await page.evaluate(() => window.F13LD_weld.bodyIds());
  const [A, B, C] = ids;
  for (const id of [A, B]) { await sel(page, id); await idle(); await uiAssignRecipe(page); await idle(); }
  await sel(page, A); await idle();
  const gid = await page.evaluate(ids => window.F13LD_weld.group(ids, 0.6), ids); await idle();
  let fails = 0;
  const check = (ok, label, extra) => { console.log((ok ? 'ok    ' : 'FAIL  ') + label + (extra ? '  ' + extra : '')); if (!ok) fails++; };
  // Frame hash + bake count + hold state right after one change (no waiting
  // for bakes: a live change must not need one).
  const frame = () => page.evaluate(() => { rm._dirty = true; if (rm._sceneProvider) rm._sceneProvider(); rm.render();
    const gl = rm.gl, w = rm.canvas.width, h = rm.canvas.height, px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let hsh = 0; for (let i = 0; i < px.length; i += 16) hsh = (hsh * 31 + px[i] + px[i + 1] * 7 + px[i + 2] * 13) >>> 0;
    return { h: hsh, bakes: F13LD_previewBake.stats().bakes, held: rm.isHeld(), pend: F13LD_scene.state().pending }; });
  const live = async (label, fn) => {
    const a = await frame();
    await page.evaluate(fn);
    const b = await frame();
    check(b.bakes === a.bakes && !b.held && b.pend === 0 && b.h !== a.h, label, `bakes +${b.bakes - a.bakes}, held ${b.held}, frame ${b.h !== a.h ? 'changed' : 'same'}`);
  };
  const weldOk = await page.evaluate(() => { const s = F13LD_scene.state(); return s.groups.length === 1 && s.groups[0].count === 3; });
  check(weldOk, 'weld drawn as one group of three members');
  await live('weld · cell size', () => railSetCellMm(4));
  await live('weld · rotation', () => railSetXform('rotZDeg', 30));
  await live('weld · shift', () => railSetXform('spatialOffsetMmX', 0.7));
  await live('weld · wall offset', () => railSetXform('isoOffsetMm', 0.2));
  await live('weld · fill lattice + skin', () => setBodyFill(activeBodyId, 'skin'));
  await live('weld · skin thickness (section on)', () => { rm.setClip({ axis: 1, flip: false, t: 0 }); setBodySkin(activeBodyId, 0.8); });
  await page.evaluate(() => rm.setClip(null));
  await live('weld · fill lattice', () => setBodyFill(activeBodyId, 'lattice'));
  await live('weld · fillet', () => { weldGroups.get(bodyGroup.get(activeBodyId)).filletMm = 1.2; railPreviewSoon(); });
  await live('weld · join rule anchor', () => { const g = weldGroups.get(bodyGroup.get(activeBodyId)); g.joinRule = 'anchor'; g.anchorMm = 1.0; railPreviewSoon(); });
  await live('weld · anchor depth', () => { weldGroups.get(bodyGroup.get(activeBodyId)).anchorMm = 1.8; railPreviewSoon(); });
  await live('weld · join rule graded', () => { const g = weldGroups.get(bodyGroup.get(activeBodyId)); g.joinRule = 'graded'; g.gradeMm = 1.5; railPreviewSoon(); });
  await live('weld · grade distance', () => { weldGroups.get(bodyGroup.get(activeBodyId)).gradeMm = 3.0; railPreviewSoon(); });
  await live('select the solid part: weld stays drawn welded', () => railSelectPart(bodyOrder[2]));
  const welded = await page.evaluate(() => F13LD_scene.state().groups.some(g => g.count === 3));
  check(welded, 'weld is still one group with another part selected');
  // Single part (B out of the weld).
  await page.evaluate(([b]) => { if (typeof rlLeave === 'function') rlLeave(b); else bodyGroup.delete(b); }, [B]); await idle();
  await sel(page, B); await idle();
  await live('part · cell size', () => railSetCellMm(2.5));
  await live('part · rotation', () => railSetXform('rotXDeg', 20));
  await live('part · shift', () => railSetXform('spatialOffsetMmY', 0.5));
  await live('part · wall offset', () => railSetXform('isoOffsetMm', -0.15));
  await live('part · fill lattice + skin', () => setBodyFill(activeBodyId, 'skin'));
  await live('part · skin thickness (section on)', () => { rm.setClip({ axis: 1, flip: false, t: 0 }); setBodySkin(activeBodyId, 0.6); });
  await page.evaluate(() => rm.setClip(null));
  // Noise part: shift re-bakes its region in the background, no hold.
  await page.evaluate(r => handleJSON(JSON.stringify(r), 'noise.json'), NOISE); await idle();
  const hasNoise = await page.evaluate(() => recipeOrder.some(id => recipes.get(id).family === 'noise'));
  if (hasNoise) {
    await page.evaluate(() => assignRecipeToBody(activeBodyId, recipeOrder.find(id => recipes.get(id).family === 'noise'))); await idle();
    const a = await frame();
    await page.evaluate(() => railSetXform('spatialOffsetMmX', 1.3));
    const b = await frame();
    check(!b.held, 'noise · shift: view not held', `held ${b.held}`);
    await idle();
    const c = await frame();
    check(c.bakes === a.bakes + 1, 'noise · shift: one background region bake', `bakes +${c.bakes - a.bakes}`);
  } else console.log('skip  noise part (no recipe loader hook in this build)');
  check(errors.length === 0, 'no console errors', errors.slice(0, 4).join(' | '));
  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
