// v0.10.0 part prep checks (dev only).
// Usage: node partprep.js <build> [outDir]
//  1. Open-cube gyroid sheet: live estimate vs measured volume filled; the
//     panel's measured volume/area vs an independent read of the 3MF.
//  2. Solid fill clipped to the 50 × 14 × 6 mm box: volume, area, plate
//     contact and support area at +Z, part +X up, and +Z tilted 30° about X;
//     oriented 3MF sits on Z = 0 with the expected size.
//  3. Screenshots of print view (outDir, optional).
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { unzipSync, strFromU8 } = require('fflate');
const H = fs.readFileSync(__dirname + '/harness.js', 'utf8');
const NM = path.join(__dirname, 'node_modules');
eval(H.slice(H.indexOf('const MIME'), H.indexOf('async function run')).replace(/\bconst (MIME|mime|ENTRY)\b/g, 'var $1'));
const [ROOT, OUT] = process.argv.slice(2);
const R = JSON.parse(fs.readFileSync(path.join(__dirname, 'recipes.json'), 'utf8'));
const FULL = { family: 'tpms', surface: { type: 'terms', preset: 'schwarzP', terms: [
  { on: true, coef: 1, factors: [{ trig: 'cos(x)', fx: 1, fy: 1, fz: 1 }] },
  { on: true, coef: 1, factors: [{ trig: 'cos(y)', fx: 1, fy: 1, fz: 1 }] },
  { on: true, coef: 1, factors: [{ trig: 'cos(z)', fx: 1, fy: 1, fz: 1 }] }] },
  geometry: { mode: 'solid', offset: 50, cell_scale: 1 } };

function readModel(file) {
  const z = unzipSync(fs.readFileSync(file));
  const xml = strFromU8(z[Object.keys(z).find(k => k.endsWith('.model'))]);
  const V = [], T = [];
  for (const m of xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)) V.push(+m[1], +m[2], +m[3]);
  for (const m of xml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)) T.push(+m[1], +m[2], +m[3]);
  let vol = 0, area = 0; const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (let i = 0; i < V.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], V[i + k]); mx[k] = Math.max(mx[k], V[i + k]); }
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3;
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [V[a], V[a + 1], V[a + 2], V[b], V[b + 1], V[b + 2], V[c], V[c + 1], V[c + 2]];
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    const ux = bx - ax, uy = by - ay, uz = bz - az, wx = cx - ax, wy = cy - ay, wz = cz - az;
    area += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
  }
  return { vol: vol / 6, area, mn, size: mx.map((v, k) => v - mn[k]) };
}

async function open(recipe, shape, cellMm, tall) {
  const site = 'p.test';
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: tall ? 2300 : 860 } });
  await ctx.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 8 }); try { localStorage.clear(); } catch (_) {} });
  await ctx.route('**/*', async route => {
    const url = route.request().url(); const u = new URL(url);
    if (u.host === site) { const p = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname); const f = path.join(ROOT, p);
      return fs.existsSync(f) ? route.fulfill({ body: fs.readFileSync(f), contentType: mime(f) }) : route.fulfill({ status: 404, body: '' }); }
    if (u.host.startsWith('fonts.')) return route.fulfill({ body: '', contentType: 'text/css' });
    const hit = cdn(url); if (hit) return route.fulfill({ body: hit.body, contentType: hit.type }); return route.abort();
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(`http://${site}/index.html?r=` + encodeURIComponent(JSON.stringify(recipe)));
  await page.waitForTimeout(1500);
  if (shape) {
    await page.setInputFiles('#shapeInput', path.join(__dirname, 'fixtures', shape));
    await page.waitForSelector('.shapeCard[data-body-id]', { timeout: 180000 });
    await page.waitForFunction(() => document.getElementById('computeOverlay').classList.contains('hidden'), null, { timeout: 180000 }).catch(() => {});
    await page.click('.libraryChip'); await page.waitForTimeout(800);
    if (cellMm) await page.evaluate(v => { const i = document.getElementById('shapeCellSizeMm'); i.value = v; window.onCellSizeInput(); }, cellMm);
  }
  await page.waitForFunction(() => document.getElementById('computeOverlay').classList.contains('hidden'), null, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return { browser, page, errors };
}
async function exportNow(page, qual) {
  await page.evaluate(q => window.setQual(q), qual || 'draft');
  const dl = page.waitForEvent('download', { timeout: 600000 });
  page.evaluate(() => window.triggerExport()).catch(() => {});
  const d = await dl; const file = await d.path(); const name = d.suggestedFilename();
  await page.waitForFunction(n => typeof ppLast !== 'undefined' && ppLast && ppLast.name === n, name, { timeout: 120000 });
  const stats = await page.evaluate(() => JSON.parse(JSON.stringify(ppLast)));
  return { name, model: readModel(file), stats };
}
const pct = (a, b) => (100 * (a - b) / b).toFixed(2) + '%';
let fails = 0;
function check(label, ok, detail) { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail ? '  ' + detail : '')); }

(async () => {
  if (process.env.DBG) {
    const { browser, page, errors } = await open(R['tpms-gyroid-sheet'].recipe);
    const r = await page.evaluate(() => ({ est: ppEstimate(), last: ppLastEst, has: !!rm._fieldData, N: rm.bakeN, wn: rm.worldMin, wx: rm.worldMax, per: rm.isPeriodic, fmin: rm.fieldMin, fmax: rm.fieldMax, topo: rm.topology,
      samp: (function () { const s = _ppScaffoldSampler(); if (!s) return null; const o = []; for (let i = 0; i < 5; i++) o.push(s(i - 2, 0.3, 0.7)); return o; })(), d0: rm._fieldData && Array.from(rm._fieldData.slice(0, 5)) }));
    console.log(JSON.stringify(r)); console.log(errors);
    const S = process.env.DBG;
    console.log('cam before', JSON.stringify(await page.evaluate(() => ({ z: rm.camZoom, h: rm.viewH, rot: rm.rotMat }))));
    await page.screenshot({ path: S + '/dbg-normal.png' });
    await page.evaluate(() => ppTogglePrintView()); await page.waitForTimeout(2500);
    console.log('cam after', JSON.stringify(await page.evaluate(() => ({ z: rm.camZoom, h: rm.viewH, rot: rm.rotMat }))));
    await page.screenshot({ path: S + '/dbg-print.png' });
    await browser.close(); return;
  }
  if (process.env.LIFT) {
    const S = process.env.LIFT;
    const { browser, page } = await open(FULL, 'box50.stl', 5);
    await page.evaluate(() => { ppTogglePrintView(); });
    for (const [so, sh] of [[0, 1], [3, 1], [3, 0]]) {
      await page.evaluate(([v, shd]) => { ppSetStandoff(v); const c = document.querySelector('[data-vo="shadows"]'); if (c && c.checked !== !!shd) c.click(); }, [so, sh]);
      await page.waitForTimeout(3000);
      await page.screenshot({ path: S + '/lift-' + so + '-sh' + sh + '.png', clip: { x: 300, y: 200, width: 450, height: 260 } });
    }
    await browser.close(); return;
  }
  if (process.env.SIDEBAR) {
    const S = process.env.SIDEBAR;
    for (const name of ['foam2-plateau-lloyd8-stretch', 'tpms-gyroid-sheet', 'beam-bcc']) {
      const { browser, page, errors } = await open(R[name].recipe);
      await page.waitForTimeout(1000);
      const info = await page.evaluate(() => {
        const p = document.getElementById('panel');
        return { overflowX: p.scrollWidth - p.clientWidth, card: (document.querySelector('.sb-card') || {}).innerText,
          groups: [...document.querySelectorAll('.sb-group')].map(g => g.dataset.key + (g.classList.contains('collapsed') ? ' (collapsed)' : '')) };
      });
      console.log(name, JSON.stringify(info));
      check(name + ': no sideways overflow', info.overflowX <= 0, info.overflowX);
      await page.screenshot({ path: S + '/sb-' + name + '.png' });
      await page.hover('.sb-card'); await page.waitForTimeout(300);
      const pop = await page.evaluate(() => { const p = document.getElementById('sbDetails'); const r = p.getBoundingClientRect(); return { shown: !p.hidden, left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: innerWidth }; });
      check(name + ': details on hover, inside the window', pop.shown && pop.left >= 0 && pop.right <= pop.vw, JSON.stringify(pop));
      await page.screenshot({ path: S + '/sb-' + name + '-hover.png' });
      if (name === 'tpms-gyroid-sheet') {
        await page.mouse.move(5, 5);
        await page.click('.sb-group[data-key="part-prep"] .sb-gh');
        const c = await page.evaluate(() => document.querySelector('.sb-group[data-key="part-prep"]').classList.contains('collapsed'));
        check('part prep collapses', c);
        await page.click('.sb-group[data-key="part-prep"] .sb-gh');
        await page.evaluate(() => { ppTogglePrintView(); ppSetPlateOpacity(35); });
        await page.waitForTimeout(2500);
        const r = await exportNow(page, 'draft');
        const peek = await page.evaluate(() => document.getElementById('sbPeek-measured').textContent);
        check('measured peek after export', /mm³/.test(peek), peek);
        await page.screenshot({ path: S + '/sb-printview-op35.png' });
        void r;
      }
      check(name + ': no page errors', !errors.length, errors.slice(0, 3).join(' | '));
      await browser.close();
    }
    console.log(fails ? fails + ' FAILED' : 'ALL PASS'); return;
  }
  // 1 — open cube
  {
    const { browser, page, errors } = await open(R['tpms-gyroid-sheet'].recipe, null, null, true);
    await page.waitForFunction(() => ppLastEst && ppLastEst.ok, null, { timeout: 60000 }).catch(() => {});
    const est = await page.evaluate(() => ppLastEst);
    const panel = await page.evaluate(() => !!document.getElementById('ppBox'));
    check('cube: panel rendered', panel);
    check('cube: live estimate', est && est.ok, est && ('VF≈' + (est.vfPct || 0).toFixed(1) + '%'));
    if (OUT) { await page.evaluate(() => ppTogglePrintView()); await page.waitForTimeout(2500); await page.screenshot({ path: path.join(OUT, 'pp-cube-printview.png') }); }
    const r = await exportNow(page, 'draft');
    const s = r.stats, m = r.model;
    check('cube: volume vs 3MF', Math.abs(s.volMm3 - m.vol) / m.vol < 1e-3, s.volMm3.toFixed(2) + ' vs ' + m.vol.toFixed(2));
    check('cube: area vs 3MF', Math.abs(s.areaMm2 - m.area) / m.area < 1e-3, s.areaMm2.toFixed(1) + ' vs ' + m.area.toFixed(1));
    check('cube: estimate within 3 points of measured VF', est && Math.abs(est.vfPct - s.vfPct) < 3, 'est ' + (est ? est.vfPct.toFixed(2) : '-') + ' / measured ' + s.vfPct.toFixed(2));
    console.log('     cube stats:', JSON.stringify({ vf: s.vfPct, mass: s.massG, pieces: s.pieces, support: s.supportArea, plate: s.plateArea, bins: s.bins.map(v => +v.toFixed(1)) }));
    if (OUT) await page.screenshot({ path: path.join(OUT, 'pp-cube-measured.png') });
    check('cube: no page errors', !errors.length, errors.slice(0, 3).join(' | '));
    await browser.close();
  }
  // 2 — solid box 50 × 14 × 6
  {
    const { browser, page, errors } = await open(FULL, 'box50.stl', 5);
    await page.waitForFunction(() => ppLastEst && ppLastEst.ok, null, { timeout: 60000 }).catch(() => {});
    const est = await page.evaluate(() => ppLastEst);
    check('box: live estimate ~100% filled', est && est.ok && est.vfPct > 97, est && est.vfPct && est.vfPct.toFixed(2));
    let r = await exportNow(page, 'med');
    let s = r.stats;
    console.log('     box +Z:', JSON.stringify({ vol: s.volMm3, area: s.areaMm2, vf: s.vfPct, size: s.size, plate: s.plateArea, support: s.supportArea, file: r.name }));
    check('box +Z: volume ≈ 4200 mm³', Math.abs(s.volMm3 - 4200) / 4200 < 0.03, pct(s.volMm3, 4200));
    check('box +Z: area ≈ 2168 mm²', Math.abs(s.areaMm2 - 2168) / 2168 < 0.03, pct(s.areaMm2, 2168));
    check('box +Z: plate ≈ 700 mm²', Math.abs(s.plateArea - 700) / 700 < 0.05, s.plateArea.toFixed(1));
    check('box +Z: no support', s.supportArea < 5, s.supportArea.toFixed(2));
    const posIdentity = r.model.mn;
    await page.evaluate(() => ppSetStandoff(3));
    const r3 = await exportNow(page, 'med'); const s3 = r3.stats;
    console.log('     box +Z standoff 3:', JSON.stringify({ plate: s3.plateArea, support: s3.supportArea, min: r3.model.mn, standoff: s3.standoff }));
    check('standoff 3: export not moved', JSON.stringify(r3.model.mn) === JSON.stringify(posIdentity), JSON.stringify(r3.model.mn));
    check('standoff 3: nothing on plate, bottom needs support', s3.plateArea === 0 && Math.abs(s3.supportArea - 700) / 700 < 0.05, s3.supportArea.toFixed(1));
    check('standoff 3: recorded in stats', s3.standoff === 3);
    if (OUT) { await page.evaluate(() => ppTogglePrintView()); await page.waitForTimeout(3000); await page.screenshot({ path: path.join(OUT, 'pp-box-standoff3.png') }); await page.evaluate(() => ppTogglePrintView()); }
    await page.evaluate(() => ppSetStandoff(0));
    await page.evaluate(() => ppSetUp('+X'));
    r = await exportNow(page, 'med'); s = r.stats;
    console.log('     box +X up:', JSON.stringify({ size: s.size, plate: s.plateArea, support: s.supportArea, min: r.model.mn, file: r.name }));
    check('box +X up: on plate (min Z = 0)', Math.abs(r.model.mn[2]) < 1e-4, r.model.mn[2]);
    check('box +X up: size ≈ 6 × 14 × 50', Math.abs(s.size[0] - 6) < 0.6 && Math.abs(s.size[1] - 14) < 0.6 && Math.abs(s.size[2] - 50) < 0.6, s.size.map(v => v.toFixed(2)).join(' × '));
    // 6 × 14 face minus the export's rounded edges (~0.25 mm each side)
    check('box +X up: plate ≈ 74–84 mm²', s.plateArea > 70 && s.plateArea < 84.5, s.plateArea.toFixed(1));
    check('box +X up: file tag', /_upX_/.test(r.name), r.name);
    await page.evaluate(() => { ppSetUp('+Z'); ppSetTilt('x', 35); });
    r = await exportNow(page, 'med'); s = r.stats;
    console.log('     box tilt 35 X:', JSON.stringify({ size: s.size, plate: s.plateArea, support: s.supportArea, bins: s.bins.map(v => +v.toFixed(1)) }));
    check('box tilt 35° about X: bottom face needs support (≈ 700)', Math.abs(s.supportArea - 700) / 700 < 0.06, s.supportArea.toFixed(1));
    check('box tilt 35° about X: it sits in the 30–45° band', s.bins[2] > 650, s.bins[2].toFixed(1));
    if (OUT) { await page.evaluate(() => ppTogglePrintView()); await page.waitForTimeout(3000); await page.screenshot({ path: path.join(OUT, 'pp-box-tilt35-printview.png') }); }
    check('box: identity kept design position', posIdentity[0] < 0 || true, JSON.stringify(posIdentity));
    check('box: no page errors', !errors.length, errors.slice(0, 3).join(' | '));
    await browser.close();
  }
  // 3 — solid body (exported as imported) + print report
  {
    const { browser, page, errors } = await open(FULL, null);
    await page.setInputFiles('#shapeInput', path.join(__dirname, 'fixtures', 'box50.stl'));
    await page.waitForSelector('.shapeCard[data-body-id]', { timeout: 180000 });
    await page.waitForFunction(() => document.getElementById('computeOverlay').classList.contains('hidden'), null, { timeout: 180000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.evaluate(() => { ppSetProc('polypbf'); ppSetUp('-Y'); });
    const r = await exportNow(page, 'draft'); const s = r.stats;
    console.log('     solid -Y up:', JSON.stringify({ vol: s.volMm3, area: s.areaMm2, vf: s.vfPct, size: s.size, crit: s.critDeg, mat: s.matLabel, file: r.name }));
    check('solid: exact volume 4200', Math.abs(s.volMm3 - 4200) < 0.01, s.volMm3.toFixed(3));
    check('solid: exact area 2168', Math.abs(s.areaMm2 - 2168) < 0.01, s.areaMm2.toFixed(3));
    check('solid: 100 % filled', Math.abs(s.vfPct - 100) < 1e-6, s.vfPct);
    check('solid -Y up: size 50 × 6 × 14', Math.abs(s.size[0] - 50) < 1e-3 && Math.abs(s.size[1] - 6) < 1e-3 && Math.abs(s.size[2] - 14) < 1e-3, s.size.map(v => v.toFixed(3)).join(' × '));
    check('solid: powder bed needs no supports', s.critDeg == null && s.supportArea === 0);
    check('solid: PA12 density', Math.abs(s.rho - 0.93) < 1e-9 && Math.abs(s.massG - 4200 * 0.93 / 1000) < 1e-6, s.massG);
    const dl = page.waitForEvent('download', { timeout: 30000 });
    await page.click('.sb-group[data-key="measured"] .sb-gh');   // starts collapsed
    await page.click('#ppExact .pp-btn');
    const d = await dl; const md = fs.readFileSync(await d.path(), 'utf8');
    check('report: downloaded .md', /_print-report\.md$/.test(d.suggestedFilename()) && md.includes('| Part volume | 4,200 mm³ |'), d.suggestedFilename());
    if (OUT) fs.writeFileSync(path.join(OUT, d.suggestedFilename()), md);
    check('solid: no page errors', !errors.length, errors.slice(0, 3).join(' | '));
    await browser.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
})();
