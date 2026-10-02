// A7/A8 check: import a body, export it as a solid body, inspect the 3MF:
// envelope in mm, vertex count, and whether every edge is shared by exactly
// two triangles (watertight / manifold).
// Usage: node importtest.js <siteDir> <label>
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { unzipSync, strFromU8 } = require('fflate');
const H = fs.readFileSync(__dirname + '/harness.js', 'utf8');
const NM = path.join(__dirname, 'node_modules');
eval(H.slice(H.indexOf('const MIME'), H.indexOf('async function run')).replace(/\bconst (MIME|mime|ENTRY)\b/g, 'var $1'));
const [ROOT, LABEL] = process.argv.slice(2);
const REC = { family: 'tpms', surface: { type: 'raw_preset', preset: 'splitP' }, geometry: { mode: 'solid', offset: 0 } };

async function run(file) {
  const site = 'i.test';
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.route('**/*', async route => {
    const url = route.request().url(); const u = new URL(url);
    if (u.host === site) { const p = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname); const f = path.join(ROOT, p);
      return fs.existsSync(f) ? route.fulfill({ body: fs.readFileSync(f), contentType: mime(f) }) : route.fulfill({ status: 404, body: '' }); }
    if (u.host.startsWith('fonts.')) return route.fulfill({ body: '', contentType: 'text/css' });
    const hit = cdn(url); if (hit) return route.fulfill({ body: hit.body, contentType: hit.type }); return route.abort();
  });
  const page = await ctx.newPage();
  await page.goto(`http://${site}/index.html?r=` + encodeURIComponent(JSON.stringify(REC)));
  await page.waitForTimeout(1500);
  await page.setInputFiles('#shapeInput', path.join(__dirname, 'fixtures', file));
  await page.waitForSelector('.shapeCard[data-body-id]', { timeout: 120000 });
  await page.waitForTimeout(1500);
  const dl = page.waitForEvent('download', { timeout: 120000 });
  page.evaluate(() => window.triggerExport()).catch(() => {});
  const d = await dl; const z = unzipSync(fs.readFileSync(await d.path()));
  const xml = strFromU8(z[Object.keys(z).find(k => k.endsWith('.model'))]);
  await browser.close();
  const V = [...xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].map(m => [+m[1], +m[2], +m[3]]);
  const T = [...xml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)].map(m => [+m[1], +m[2], +m[3]]);
  const mn = [0, 1, 2].map(i => Math.min(...V.map(v => v[i]))), mx = [0, 1, 2].map(i => Math.max(...V.map(v => v[i])));
  const edges = new Map();
  for (const t of T) for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) { const k = a < b ? a + ',' + b : b + ',' + a; edges.set(k, (edges.get(k) || 0) + 1); }
  const open = [...edges.values()].filter(n => n !== 2).length;
  return { verts: V.length, tris: T.length, min: mn.map(v => +v.toFixed(2)), max: mx.map(v => +v.toFixed(2)), openEdges: open };
}
(async () => {
  for (const [f, note] of [['box50n.stl', 'CAD box (2,-3,1)→(52,11,7) mm'], ['box50_inch_moved.3mf', 'same box, inch units, moved +100 mm in x → expect (102,-3,1)→(152,11,7)']]) {
    const r = await run(f);
    console.log(`${LABEL}  ${f.padEnd(22)} verts ${r.verts}  tris ${r.tris}  min ${r.min.join(',')}  max ${r.max.join(',')}  non-manifold edges ${r.openEdges}   [${note}]`);
  }
})();
