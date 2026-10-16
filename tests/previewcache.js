// v0.13.0 preview rebuild, phase 1 — single build, in the browser:
//   switching parts / welds re-uses baked fields (no bake), the view is held
//   during a bake and released after it, a newer preview cancels an older bake,
//   weld rotation / wall offset re-bake, and no console errors.
//
//   node previewcache.js <build>     (CORES=n, default 6)
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
boxStl(STL.A, [0, 0, 0], [20, 16, 10]); boxStl(STL.B, [18, 0, 0], [38, 16, 10]); boxStl(STL.C, [50, 0, 0], [64, 12, 10]);
const RECIPE = JSON.parse(fs.readFileSync(path.join(__dirname, 'recipes.json'), 'utf8'))['tpms-gyroid-sheet'].recipe;

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
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
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('worker', w => w.on('console', m => { if (m.type() === 'error') errors.push('worker: ' + m.text()); }));
  await page.goto(`http://${site}/index.html?r=` + encodeURIComponent(JSON.stringify(RECIPE)));
  await page.waitForTimeout(1500);
  const idle = () => page.waitForFunction(() => document.getElementById('computeOverlay').classList.contains('hidden') && !(window.rm && rm.isHeld && rm.isHeld()) && window.F13LD_previewBake.workers().jobs === 0, null, { timeout: 300000 }).catch(() => {});
  const stats = () => page.evaluate(() => window.F13LD_previewBake.stats());
  let fails = 0;
  const check = (ok, label, extra) => { console.log((ok ? 'ok    ' : 'FAIL  ') + label + (extra ? '  ' + extra : '')); if (!ok) fails++; };

  for (const k of ['A', 'B', 'C']) {
    const n = await uiBodyCount(page);
    await page.setInputFiles('#shapeInput', STL[k]);
    await page.waitForFunction(([n, S]) => document.querySelectorAll(S).length > n, [n, UI_BODY], { timeout: 180000 });
    await idle(); await page.waitForTimeout(400);
  }
  const ids = await page.evaluate(() => window.F13LD_weld.bodyIds());
  // A and B get the gyroid; C stays solid.
  for (const i of [0, 1]) { await uiSelectBody(page, ids[i]); await idle(); await uiAssignRecipe(page); await idle(); }
  await page.waitForTimeout(500); await idle();

  // 1. Switching between two lattice parts with the same recipe and quality: no bake.
  let s0 = await stats();
  await uiSelectBody(page, ids[0]); await idle();
  await uiSelectBody(page, ids[1]); await idle();
  await uiSelectBody(page, ids[0]); await idle();
  let s1 = await stats();
  check(s1.bakes === s0.bakes, 'switch lattice parts: no bake', `bakes +${s1.bakes - s0.bakes}, hits +${s1.hits - s0.hits}`);
  // 2. Selecting a solid part: no bake.
  await uiSelectBody(page, ids[2]); await idle();
  let s2 = await stats();
  check(s2.bakes === s1.bakes, 'select solid part: no bake', `bakes +${s2.bakes - s1.bakes}`);
  const texCount = await page.evaluate(() => rm._gridTex ? rm._gridTex.size : -1);
  check(texCount >= 3, 'part shape textures kept on the GPU', `${texCount} grid textures`);
  // 3. Weld A + B: one bake; select the other member and back: no bake.
  await uiSelectBody(page, ids[0]); await idle();
  await page.evaluate(([a, b]) => window.F13LD_weld.group([a, b], 0.6), [ids[0], ids[1]]); await page.waitForTimeout(200); await idle();
  let s3 = await stats();
  check(s3.bakes > s2.bakes, 'weld A+B: baked', `bakes +${s3.bakes - s2.bakes}`);
  const muts = await page.evaluate(() => new Promise(res => { let n = 0; const o = new MutationObserver(l => { n += l.length; }); o.observe(document.getElementById('rail') || document.body, { childList: true, subtree: true, attributes: true }); setTimeout(() => { o.disconnect(); res(n); }, 2000); }));
  const anim = await page.evaluate(() => document.getAnimations().map(a => (a.effect && a.effect.target && (a.effect.target.id || a.effect.target.className)) + ':' + a.playState).slice(0, 8));
  check(muts < 50, 'rail settles after the weld', `${muts} mutations in 2 s; animations ${JSON.stringify(anim)}`);
  const asm = await page.evaluate(() => rm._assemblyMode);
  check(asm === true, 'weld preview in assembly mode');
  await uiSelectBody(page, ids[1]); await idle();
  await uiSelectBody(page, ids[0]); await idle();
  let s4 = await stats();
  check(s4.bakes === s3.bakes, 'switch inside the weld: no bake', `bakes +${s4.bakes - s3.bakes}, hits +${s4.hits - s3.hits}`);
  // 4. Leave the weld (solid C) and come back: no bake, assembly mode back on.
  await uiSelectBody(page, ids[2]); await idle();
  const asmOff = await page.evaluate(() => rm._assemblyMode);
  await uiSelectBody(page, ids[1]); await idle();
  let s5 = await stats();
  check(asmOff === false && s5.bakes === s4.bakes, 'leave and re-enter the weld: no bake', `assembly off at C: ${asmOff === false}`);
  // 5. Weld rotation re-bakes, and the view is held while it runs.
  const camBefore = await page.evaluate(() => ({ z: rm.camZoom, h: rm.viewH }));
  let heldSeen = false;
  await uiSetXform(page, 'rotZDeg', 30);
  for (let i = 0; i < 40; i++) {
    const st = await page.evaluate(() => ({ held: !!(rm.isHeld && rm.isHeld()), jobs: window.F13LD_previewBake.workers().jobs }));
    if (st.held) heldSeen = true;
    if (!st.held && st.jobs === 0 && i > 3) break;
    await page.waitForTimeout(150);
  }
  await idle();
  let s6 = await stats();
  check(s6.bakes > s5.bakes, 'weld member rotation re-bakes', `bakes +${s6.bakes - s5.bakes}`);
  check(heldSeen, 'view held during the weld re-bake');
  const camAfter = await page.evaluate(() => ({ z: rm.camZoom, h: rm.viewH }));
  check(Math.abs(camAfter.z - camBefore.z) < 1e-6, 'camera kept through the re-bake', `zoom ${camBefore.z.toFixed(2)} -> ${camAfter.z.toFixed(2)}`);
  // 6. Weld wall offset re-bakes.
  await uiSetXform(page, 'isoOffsetMm', 0.2); await page.waitForTimeout(400); await idle();
  let s7 = await stats();
  check(s7.bakes > s6.bakes, 'weld member wall offset re-bakes', `bakes +${s7.bakes - s6.bakes}`);
  // 7. A newer preview cancels the running one; nothing is left running.
  const c0 = s7.cancelled;
  await page.evaluate(() => { triggerPreview('high'); setTimeout(() => triggerPreview('med'), 30); });
  await page.waitForTimeout(200); await idle();
  let s8 = await stats();
  const w = await page.evaluate(() => window.F13LD_previewBake.workers());
  check(s8.cancelled > c0 && w.jobs === 0 && w.busy === 0, 'newer preview cancels the older bake', `cancelled +${s8.cancelled - c0}, workers ${JSON.stringify(w)}`);
  check(!(await page.evaluate(() => rm.isHeld())), 'hold released at the end');
  const tri = await page.evaluate(() => (document.getElementById('triPill') || {}).textContent || '');
  check(/preview/.test(tri), 'preview pill', tri);
  check(errors.length === 0, 'no console errors', errors.slice(0, 4).join(' | '));
  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
