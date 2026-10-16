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
boxStl(STL.A, [0, 0, 0], [20, 16, 10]); boxStl(STL.B, [18, 0, 0], [38, 16, 10]); boxStl(STL.C, [50, 0, 0], [64, 12, 10]);
const RECIPE = JSON.parse(fs.readFileSync(path.join(__dirname, 'recipes.json'), 'utf8'))['tpms-gyroid-sheet'].recipe;

const sel = (page, id) => page.evaluate(id => (window.railSelectPart || window.switchActiveBody)(id), id);
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
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
  const idle = async () => { await page.waitForTimeout(450); await page.waitForFunction(() => document.getElementById('computeOverlay').classList.contains('hidden') && !(window.rm && rm.isHeld && rm.isHeld()) && window.F13LD_previewBake.workers().jobs === 0, null, { timeout: 300000 }).catch(() => {}); await page.waitForTimeout(400); };
  for (const k of ['A', 'B', 'C']) {
    const n = await uiBodyCount(page);
    await page.setInputFiles('#shapeInput', STL[k]);
    await page.waitForFunction(([n, S]) => document.querySelectorAll(S).length > n, [n, UI_BODY], { timeout: 180000 });
    await idle();
  }
  const ids = await page.evaluate(() => window.F13LD_weld.bodyIds());
  for (const i of [0, 1]) { await sel(page, ids[i]); await idle(); await uiAssignRecipe(page); await idle(); }
  await sel(page, ids[0]); await idle();
  await page.evaluate(([a, b]) => window.F13LD_weld.group([a, b], 0.6), [ids[0], ids[1]]); await idle();
  let fails = 0;
  const check = (ok, label, extra) => { console.log((ok ? 'ok    ' : 'FAIL  ') + label + (extra ? '  ' + extra : '')); if (!ok) fails++; };
  const SHOTS = process.env.SHOTS || ''; let shotN = 0;
  const state = async () => { await idle(); return page.evaluate(([a, b, SHOT]) => {
    const s = 10 / ((bodies.get(activeBodyId) && bodies.get(activeBodyId).cellSizeMm) || 3);
    const g = {}; for (const m of (rm._ghostMeta || []).filter(Boolean)) g[m.bodyId] = m.kind;
    // lit pixels of a fresh frame (luma well above the background)
    rm._dirty = true; rm.render();
    const c = document.createElement('canvas'); c.width = rm.canvas.width; c.height = rm.canvas.height;
    const x = c.getContext('2d'); x.drawImage(rm.canvas, 0, 0); const px = x.getImageData(0, 0, c.width, c.height).data;
    let lit = 0; for (let i = 0; i < px.length; i += 4) if (0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2] > 60) lit++;
    return { asm: rm._assemblyMode, N: rm.bakeN, x0: rm.worldMin[0] / s, x1: rm.worldMax[0] / s, ghosts: g,
      aX: [bodies.get(a).bbox.mnx, bodies.get(a).bbox.mxx], bX: [bodies.get(b).bbox.mnx, bodies.get(b).bbox.mxx],
      lit: lit / (c.width * c.height), toast: /Every part in this weld is hidden/.test(document.body.innerText),
      png: SHOT ? rm.canvas.toDataURL('image/png') : null };
  }, [ids[0], ids[1], !!SHOTS]).then(r => { if (SHOTS && r.png) { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, String(++shotN).padStart(2, '0') + '.png'), Buffer.from(r.png.split(',')[1], 'base64')); } return r; }); };
  const near = (u, v) => Math.abs(u - v) < 0.05;
  const eyeRow = id => page.$eval(`.rl-part[data-body-id="${id}"] [data-act="vis"]`, el => el.click());
  const eyeWeld = () => page.$eval('.rl-whead [data-act="vis"]', el => el.click());
  const [A, B, C] = ids;
  let s = await state();
  const fullX = [s.aX[0], s.bX[1]];
  check(s.asm && s.N >= 96, 'weld preview: grid sized to the weld', `N ${s.N}`);
  const litWeld = s.lit;
  check(near(s.x0, fullX[0]) && near(s.x1, fullX[1]), 'weld box spans A and B');
  await eyeRow(B); s = await state();
  check(s.ghosts[B] === 'ghost' && near(s.x1, s.aX[1]), 'B ghost: shell, out of the solid weld', JSON.stringify(s.ghosts));
  await eyeRow(B); s = await state();
  check(!s.ghosts[B] && near(s.x1, s.aX[1]), 'B hidden: not drawn, out of the weld');
  await eyeRow(B); s = await state();
  check(!s.ghosts[B] && near(s.x1, fullX[1]), 'B shown: back in the weld');
  await eyeRow(A); s = await state();
  check(s.ghosts[A] === 'ghost' && near(s.x0, s.bX[0]), 'selected A ghost: shell, out of the solid weld', JSON.stringify(s.ghosts));
  await eyeRow(A); s = await state();
  check(!s.ghosts[A] && near(s.x0, s.bX[0]), 'selected A hidden: out of the weld');
  await eyeRow(A); s = await state();
  check(!s.ghosts[A] && near(s.x0, fullX[0]) && near(s.x1, fullX[1]), 'A shown: weld whole again');
  await eyeWeld(); s = await state();
  check(s.ghosts[A] === 'ghost' && s.ghosts[B] === 'ghost' && s.N === 2, 'weld ghost: both shells, no solid weld', JSON.stringify(s.ghosts));
  await eyeWeld(); s = await state();
  check(!s.ghosts[A] && !s.ghosts[B] && s.N === 2 && s.toast, 'weld hidden: empty view and message', 'toast ' + s.toast);
  // Only part C is left on screen now; the weld's share of the first frame is
  // what disappeared (v0.12.0 drew a speckled weld here: well under 1 %).
  check(litWeld - s.lit > (+process.env.MINLIT || 0.01), 'weld is drawn solidly (lit pixels the weld adds)', ((litWeld - s.lit) * 100).toFixed(2) + ' % of the frame');
  await eyeWeld(); s = await state();
  check(s.N >= 96 && near(s.x1, fullX[1]), 'weld shown: weld back');
  await sel(page, C); s = await state();
  check(!s.asm && s.ghosts[A] === 'solid' && s.ghosts[B] === 'solid', 'C selected: weld parts drawn as solid shells');
  await eyeWeld(); s = await state();
  check(s.ghosts[A] === 'ghost' && s.ghosts[B] === 'ghost', 'C selected, weld ghost: shells');
  await eyeWeld(); s = await state();
  check(!s.ghosts[A] && !s.ghosts[B], 'C selected, weld hidden: not drawn');
  await sel(page, A); s = await state();
  check(s.asm && s.N === 2, 'select A in the hidden weld: empty view');
  await eyeWeld(); s = await state();
  check(s.asm && s.N >= 96 && near(s.x0, fullX[0]) && near(s.x1, fullX[1]), 'weld shown again');
  check(errors.length === 0, 'no console errors', errors.slice(0, 4).join(' | '));
  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
