// v0.13.1 touch gestures on the viewer, in a mobile-sized browser with touch:
// pinch out zooms in, pinch in zooms out (within the wheel's limits), two
// fingers moving together pan, lifting one finger keeps rotating from the
// other without a jump, and the canvas asks the browser not to zoom the page.
//
//   node pinch.js <build>
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pinch-'));
const RECIPE = JSON.parse(fs.readFileSync(path.join(__dirname, 'recipes.json'), 'utf8'))['tpms-gyroid-sheet'].recipe;

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const site = 'build.test';
  await ctx.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.host === site) { let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html'; const f = path.join(BUILD, p);
      return fs.existsSync(f) ? route.fulfill({ body: fs.readFileSync(f), contentType: mime(f) }) : route.fulfill({ status: 404, body: '' }); }
    if (u.host.startsWith('fonts.')) return route.fulfill({ body: '', contentType: 'text/css' });
    const hit = cdn(route.request().url()); if (hit) return route.fulfill({ body: hit.body, contentType: hit.type, headers: { 'access-control-allow-origin': '*' } });
    return route.abort();
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://${site}/index.html?r=` + encodeURIComponent(JSON.stringify(RECIPE)));
  await page.waitForTimeout(2500);
  const cdp = await ctx.newCDPSession(page);
  const box = await page.evaluate(() => { const r = rm.canvas.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; });
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p[0], y: p[1], id: i })) });
  const cam = () => page.evaluate(() => ({ z: rm.camZoom, px: rm.panX, py: rm.panY, rot: rm.rotMat.slice(), held: rm._interacting }));
  // two fingers apart by d around (cx, cy), moved in steps
  async function pinch(d0, d1, dx = 0) {
    const sc = Math.min(1, box.w * 0.8 / Math.max(d0, d1) );   // keep both fingers on the canvas
    d0 *= sc; d1 *= sc;
    const cx = box.x, cy = box.y, steps = 8;
    await touch('touchStart', [[cx - d0 / 2, cy], [cx + d0 / 2, cy]]);
    for (let i = 1; i <= steps; i++) { const d = d0 + (d1 - d0) * i / steps, ox = dx * i / steps; await touch('touchMove', [[cx - d / 2 + ox, cy], [cx + d / 2 + ox, cy]]); }
    return { cx: cx + dx, cy, right: [cx + d1 / 2 + dx, cy] };
  }
  let fails = 0;
  const check = (ok, label, extra) => { console.log((ok ? 'ok    ' : 'FAIL  ') + label + (extra ? '  ' + extra : '')); if (!ok) fails++; };
  const ta = await page.evaluate(() => getComputedStyle(rm.canvas).touchAction);
  check(ta === 'none', 'canvas tells the browser not to zoom the page', 'touch-action ' + ta);
  console.log('canvas ' + box.w.toFixed(0) + ' x ' + box.h.toFixed(0) + ' px, page ' + JSON.stringify(await page.evaluate(() => ({ inner: innerWidth, scroll: document.documentElement.scrollWidth, vv: visualViewport && visualViewport.width }))));
  let c0 = await cam();
  await pinch(80, 200); await touch('touchEnd', []);
  let c1 = await cam();
  check(c1.z < c0.z * 0.6, 'pinch out zooms in', c0.z.toFixed(1) + ' -> ' + c1.z.toFixed(1));
  await pinch(200, 80); await touch('touchEnd', []);
  let c2 = await cam();
  check(c2.z > c1.z * 1.6 && Math.abs(c2.z - c0.z) / c0.z < 0.05, 'pinch in zooms back out', c1.z.toFixed(1) + ' -> ' + c2.z.toFixed(1));
  await pinch(100, 100, 60); await touch('touchEnd', []);
  let c3 = await cam();
  check(Math.abs(c3.px - c2.px) > 0.01 && Math.abs(c3.z - c2.z) / c2.z < 0.02, 'two fingers moving together pan without zooming', 'panX ' + c2.px.toFixed(2) + ' -> ' + c3.px.toFixed(2));
  // second finger lands just off the canvas: still a pinch
  {
    const z0 = (await cam()).z, x0 = box.x - box.w / 2;
    await touch('touchStart', [[x0 + 20, box.y]]);
    await touch('touchStart', [[x0 + 20, box.y], [x0 - 10, box.y - 200]]);
    for (let i = 1; i <= 6; i++) await touch('touchMove', [[x0 + 20 + i * 15, box.y], [x0 - 10, box.y - 200 - i * 15]]);
    await touch('touchEnd', []);
    const z1 = (await cam()).z;
    check(Math.abs(z1 - z0) > 0.05, 'second finger landing off the canvas still pinches', z0.toFixed(2) + ' -> ' + z1.toFixed(2));
  }
  const lim = await page.evaluate(() => [rm.viewH * 0.3, Math.max(80, rm.viewH * 8)]);
  for (let i = 0; i < 4; i++) { await pinch(40, 300); await touch('touchEnd', []); }
  let c4 = await cam();
  check(c4.z >= lim[0] - 1e-6, 'zoom stops at the near limit', c4.z.toFixed(2) + ' >= ' + lim[0].toFixed(2));
  for (let i = 0; i < 6; i++) { await pinch(300, 40); await touch('touchEnd', []); }
  let c5 = await cam();
  check(c5.z <= lim[1] + 1e-6, 'zoom stops at the far limit', c5.z.toFixed(2) + ' <= ' + lim[1].toFixed(2));
  // lift one finger: the other keeps rotating from where it is (no jump).
  // CDP can't release one of two touch points, so this step dispatches the
  // browser's own TouchEvents in the page.
  const end = await pinch(120, 140); await touch('touchEnd', []);
  const r0 = await page.evaluate(([L, R]) => {
    const c = rm.canvas, T = (id, p) => new Touch({ identifier: id, target: c, clientX: p[0], clientY: p[1] });
    const a = T(0, L), b = T(1, R);
    c.dispatchEvent(new TouchEvent('touchstart', { touches: [a, b], targetTouches: [a, b], changedTouches: [a, b], bubbles: true, cancelable: true }));
    window.dispatchEvent(new TouchEvent('touchend', { touches: [b], changedTouches: [a], bubbles: true, cancelable: true }));
    const r = rm.rotMat.slice();
    const b2 = T(1, [R[0] + 2, R[1]]);
    window.dispatchEvent(new TouchEvent('touchmove', { touches: [b2], changedTouches: [b2], bubbles: true, cancelable: true }));
    window.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [b2], bubbles: true, cancelable: true }));
    return r;
  }, [[end.right[0] - 140, end.right[1]], end.right]);
  const r1 = (await cam()).rot;
  const dr = Math.max(...r1.map((v, i) => Math.abs(v - r0[i])));
  check(dr > 0 && dr < 0.05, 'one finger left keeps rotating, no jump', 'rotation change ' + dr.toFixed(4));
  const after = await cam();
  check(after.held === false, 'shadows come back after the gesture');
  check(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
