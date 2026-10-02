// Geometry accuracy measurements: export a fully-solid fill clipped to a body
// of known size, and report the 3MF envelope vs the CAD envelope.
// Usage: node measure.js <siteDir> <label> [quals]
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { unzipSync, strFromU8 } = require('fflate');
const H = fs.readFileSync(__dirname + '/harness.js', 'utf8');
const NM = path.join(__dirname, 'node_modules');
eval(H.slice(H.indexOf('const MIME'), H.indexOf('async function run')).replace(/\bconst (MIME|mime|ENTRY)\b/g, 'var $1'));
const [ROOT, LABEL, QUALS] = process.argv.slice(2);

// TPMS solid mode with a huge offset → solid everywhere; export == clipped body.
const FULL = { family: 'tpms', surface: { type: 'terms', preset: 'schwarzP', terms: [
  { on: true, coef: 1, factors: [{ trig: 'cos(x)', fx: 1, fy: 1, fz: 1 }] },
  { on: true, coef: 1, factors: [{ trig: 'cos(y)', fx: 1, fy: 1, fz: 1 }] },
  { on: true, coef: 1, factors: [{ trig: 'cos(z)', fx: 1, fy: 1, fz: 1 }] }] },
  geometry: { mode: 'solid', offset: 50, cell_scale: 1 } };

function envelope(xml) {
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9]; let n = 0;
  for (const m of xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)) {
    const p = [+m[1], +m[2], +m[3]]; n++;
    for (let i = 0; i < 3; i++) { if (p[i] < mn[i]) mn[i] = p[i]; if (p[i] > mx[i]) mx[i] = p[i]; }
  }
  return { mn, mx, n };
}

async function one(body, cad, qual, cellMm) {
  const site = 'm.test';
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 8 }));
  await ctx.route('**/*', async route => {
    const url = route.request().url(); const u = new URL(url);
    if (u.host === site) { const p = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname); const f = path.join(ROOT, p);
      return fs.existsSync(f) ? route.fulfill({ body: fs.readFileSync(f), contentType: mime(f) }) : route.fulfill({ status: 404, body: '' }); }
    if (u.host.startsWith('fonts.')) return route.fulfill({ body: '', contentType: 'text/css' });
    const hit = cdn(url); if (hit) return route.fulfill({ body: hit.body, contentType: hit.type }); return route.abort();
  });
  const page = await ctx.newPage();
  await page.goto(`http://${site}/index.html?r=` + encodeURIComponent(JSON.stringify(FULL)));
  await page.waitForTimeout(1500);
  await page.setInputFiles('#shapeInput', path.join(__dirname, 'fixtures', body));
  await page.waitForSelector('.shapeCard[data-body-id]', { timeout: 180000 });
  await page.waitForFunction(() => document.getElementById('computeOverlay').classList.contains('hidden'), null, { timeout: 180000 }).catch(() => {});
  await page.click('.libraryChip'); await page.waitForTimeout(800);
  await page.evaluate(v => { const i = document.getElementById('shapeCellSizeMm'); i.value = v; window.onCellSizeInput(); }, cellMm);
  await page.waitForTimeout(1500);
  await page.evaluate(q => window.setQual(q), qual);
  const dl = page.waitForEvent('download', { timeout: 600000 });
  page.evaluate(() => window.triggerExport()).catch(() => {});
  const d = await dl; const z = unzipSync(fs.readFileSync(await d.path()));
  const xml = strFromU8(z[Object.keys(z).find(k => k.endsWith('.model'))]);
  await browser.close();
  const e = envelope(xml);
  // radial error of side-wall vertices (cylinder about z axis, r=10)
  let acc = 0, mxr = 0, nr = 0;
  for (const m of xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)) {
    const x = +m[1], y = +m[2], z = +m[3]; if (z < 1 || z > 19) continue;
    const d = Math.hypot(x, y) - 10; if (Math.abs(d) > 2) continue; acc += d * d; nr++; if (Math.abs(d) > Math.abs(mxr)) mxr = d;
  }
  const size = [0, 1, 2].map(i => e.mx[i] - e.mn[i]);
  const cadSize = [0, 1, 2].map(i => cad[1][i] - cad[0][i]);
  const perSide = [0, 1, 2].map(i => ((size[i] - cadSize[i]) / 2));
  return { size: size.map(v => +v.toFixed(3)), perSide: perSide.map(v => +v.toFixed(3)),
    minShift: [0, 1, 2].map(i => +(e.mn[i] - cad[0][i]).toFixed(3)), verts: e.n,
    radial: { rms: nr ? +Math.sqrt(acc / nr).toFixed(3) : null, max: +mxr.toFixed(3) } };
}

(async () => {
  const quals = (QUALS || 'draft').split(',');
  for (const q of quals) {
    if (!process.env.ONLY || process.env.ONLY === 'box') {
      const r = await one('box50.stl', [[2, -3, 1], [52, 11, 7]], q, 3);
      console.log(`${LABEL}  box 50x14x6  ${q.padEnd(5)}  size ${r.size.join(' x ')}  error/side ${r.perSide.join(' / ')} mm  (min-corner shift ${r.minShift.join(', ')})`);
    }
    if (!process.env.ONLY || process.env.ONLY === 'cyl') {
      const r = await one('cyl20.stl', [[-10, -10, 0], [10, 10, 20]], q, 3);
      console.log(`${LABEL}  cylinder D20 x 20  ${q.padEnd(5)}  size ${r.size.join(' x ')}  error/side ${r.perSide.join(' / ')} mm  radial RMS ${r.radial.rms} / max ${r.radial.max} mm`);
    }
  }
})();
