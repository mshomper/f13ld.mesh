// v0.13.0 single-part view, in the browser, on a 50 mm sphere:
//   - no shadow rings on a solid part (luminance along a line across the lit
//     side has few ripples),
//   - each preview quality refines the part's shape grid in the background
//     (Draft 96 … Ultra 256, capped by the GPU), and export still reads the
//     import grid,
//   - the selected part's eye works: ghost draws it as a shell, hidden leaves
//     it out with a message, shown brings it back.
//
//   node shapeview.js <build>     (CORES=n, default 6; SHOTS=<dir> saves the ghost frame)
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shapeview-'));
const RECIPE = JSON.parse(fs.readFileSync(path.join(__dirname, 'recipes.json'), 'utf8'))['tpms-gyroid-sheet'].recipe;

function sphereStl(file, R) {
  const nu = 120, nv = 60, P = (i, j) => [R * Math.sin(Math.PI * j / nv) * Math.cos(2 * Math.PI * i / nu), R * Math.sin(Math.PI * j / nv) * Math.sin(2 * Math.PI * i / nu), R * Math.cos(Math.PI * j / nv)];
  let s = 'solid s\n';
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
    const tris = []; if (j > 0) tris.push([a, b, c]); if (j < nv - 1) tris.push([a, c, d]);
    for (const t of tris) s += ' facet normal 0 0 0\n  outer loop\n' + t.map(v => `   vertex ${v[0].toFixed(5)} ${v[1].toFixed(5)} ${v[2].toFixed(5)}\n`).join('') + '  endloop\n endfacet\n';
  }
  fs.writeFileSync(file, s + 'endsolid s\n');
}
const SPH = path.join(TMP, 'sphere.stl'); sphereStl(SPH, 25);
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
  await page.goto(`http://${site}/index.html?r=` + encodeURIComponent(JSON.stringify(RECIPE)));
  await page.waitForTimeout(1500);
  const idle = async () => { await page.waitForTimeout(400); await page.waitForFunction(() => document.getElementById('computeOverlay').classList.contains('hidden') && !(window.rm && rm.isHeld && rm.isHeld()) && window.F13LD_previewBake.workers().jobs === 0 && window.F13LD_previewGrids.pending() === 0, null, { timeout: 300000 }).catch(() => {}); await page.waitForTimeout(400); };
  await page.setInputFiles('#shapeInput', SPH);
  await page.waitForFunction(S => document.querySelectorAll(S).length > 0, UI_BODY, { timeout: 180000 });
  await idle();
  let fails = 0;
  const check = (ok, label, extra) => { console.log((ok ? 'ok    ' : 'FAIL  ') + label + (extra ? '  ' + extra : '')); if (!ok) fails++; };
  // Frame stats: lit share, and ripples = local extrema of the luminance along
  // the horizontal and vertical lines through the brightest pixel's row/column.
  const frame = () => page.evaluate(() => {
    rm._dirty = true; rm.render();
    const c = document.createElement('canvas'); c.width = rm.canvas.width; c.height = rm.canvas.height;
    const x = c.getContext('2d'); x.drawImage(rm.canvas, 0, 0); const W = c.width, H = c.height, px = x.getImageData(0, 0, W, H).data;
    const L = (i, j) => { const k = (j * W + i) * 4; return 0.3 * px[k] + 0.59 * px[k + 1] + 0.11 * px[k + 2]; };
    let lit = 0, bx = 0, by = 0, best = -1, sum = 0, cnt = 0;
    for (let j = 0; j < H; j += 2) for (let i = 0; i < W; i += 2) { const l = L(i, j); if (l > 60) lit++; if (l > 20) { sum += l; cnt++; } if (l > best) { best = l; bx = i; by = j; } }
    const ripples = line => { let n = 0, prev = 0; const v = []; for (let t = 0; t < line.length; t += 3) { let s = 0, m = 0; for (let q = t; q < Math.min(line.length, t + 3); q++) { s += line[q]; m++; } v.push(s / m); }
      for (let t = 1; t < v.length; t++) { const d = v[t] - v[t - 1]; if (Math.abs(d) < 1.5) continue; if (prev && Math.sign(d) !== Math.sign(prev)) n++; prev = d; } return n; };
    const row = [], col = []; for (let i = 0; i < W; i++) { const l = L(i, by); if (l > 60) row.push(l); } for (let j = 0; j < H; j++) { const l = L(bx, j); if (l > 60) col.push(l); }
    return { lit: lit / (W * H / 4), luma: cnt ? sum / cnt : 0, png: window.__SHOT ? rm.canvas.toDataURL('image/png') : null, ripples: ripples(row) + ripples(col) };
  });
  const id = await page.evaluate(() => activeBodyId);
  let f = await frame();
  check(f.lit > 0.05, 'solid sphere drawn', (f.lit * 100).toFixed(1) + ' %');
  check(f.ripples <= 6, 'no shadow rings on the solid sphere', f.ripples + ' ripples');
  // Quality → shape grid
  for (const q of ['draft', 'ultra']) {
    await page.evaluate(q => { document.getElementById('btn' + q[0].toUpperCase() + q.slice(1)).click(); }, q);
    await idle();
    const g = await page.evaluate(id => ({ grids: window.F13LD_previewGrids.of(id), bound: rm.shapeData.N, want: Math.min(window.F13LD_previewGrids.sizes()[rm._quality], rm.gl.getParameter(rm.gl.MAX_3D_TEXTURE_SIZE)), q: rm._quality }), id);
    check(g.bound >= g.want && g.grids.import === 64, q + ': shape grid refined, export grid untouched', JSON.stringify(g));
  }
  f = await frame();
  check(f.ripples <= 6, 'no shadow rings at Ultra', f.ripples + ' ripples');
  const lit0 = f.lit, luma0 = f.luma;
  // Selected part's eye
  const eye = () => page.$eval(`.rl-part[data-body-id="${id}"] [data-act="vis"]`, el => el.click());
  const muted = await page.$eval(`.rl-part[data-body-id="${id}"] [data-act="vis"]`, el => el.classList.contains('rl-muted'));
  check(!muted, 'selected part eye is not greyed out');
  await eye(); await idle();
  let s = await page.evaluate(id => ({ vis: rm._activeVis, ghost: (rm._ghostMeta || []).filter(Boolean).some(m => m.bodyId === id && m.kind === 'ghost') }), id);
  f = await frame();
  check(s.vis === 'ghost' && s.ghost && f.luma < luma0 * 0.75, 'ghost: drawn as a translucent shell', JSON.stringify(s) + ' mean brightness ' + f.luma.toFixed(0) + ' (solid ' + luma0.toFixed(0) + ')');
  if (process.env.SHOTS) { fs.mkdirSync(process.env.SHOTS, { recursive: true }); await page.evaluate(() => { window.__SHOT = 1; }); const g = await frame(); fs.writeFileSync(path.join(process.env.SHOTS, 'ghost.png'), Buffer.from(g.png.split(',')[1], 'base64')); await page.evaluate(() => { window.__SHOT = 0; }); }
  await eye(); await idle();
  s = await page.evaluate(() => ({ vis: rm._activeVis, toast: /This part is hidden/.test(document.body.innerText) }));
  f = await frame();
  check(s.vis === 'hidden' && f.lit < 0.005 && s.toast, 'hidden: not drawn, message shown', JSON.stringify(s) + ' lit ' + (f.lit * 100).toFixed(2) + ' %');
  await eye(); await idle();
  f = await frame();
  check(Math.abs(f.lit - lit0) < lit0 * 0.1, 'shown: drawn again', (f.lit * 100).toFixed(1) + ' %');
  // Lattice in the sphere draws solidly (steps no longer cut short)
  await uiAssignRecipe(page); await idle();
  f = await frame();
  check(f.lit > lit0 * 0.45, 'gyroid in the sphere drawn solidly', (f.lit * 100).toFixed(1) + ' % (solid ' + (lit0 * 100).toFixed(1) + ' %)');
  check(errors.length === 0, 'no console errors', errors.slice(0, 4).join(' | '));
  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
