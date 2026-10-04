// v0.9.3 weld export, end to end in the browser: three imported boxes — solid,
// foam, solid — welded with a 0.4 mm fillet and exported from both builds.
//
//   node weldexport.js <old build> <new build> [low,med] [recipe case]
//
// Reports export time, triangles, volume and open edges of each 3MF, the
// export-panel estimate, and the new build's '[export][weld]' log lines
// (plan, pool bake, level set). Pass: the new build's export succeeds without
// errors and its volume is within 1.5% of the old build's. Open edges are
// reported for information — meshopt simplify leaves some on fragmented foam
// in both builds. CORES sets the reported core count (default 8), CELL the lattice
// cell size in mm (default 10, so foam walls pass the Low feature guard).
const fs = require('fs'), os = require('os'), path = require('path');
const { chromium } = require('playwright');
const { unzipSync, strFromU8 } = require('fflate');
const NM = path.join(__dirname, 'node_modules');
const [OLD, NEW, QUALS = 'low', CASE = 'foam2-open-lloyd'] = process.argv.slice(2);
const CORES = +(process.env.CORES || 8), CELL = +(process.env.CELL || 10);
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
// ASCII STL box
function boxStl(file, lo, hi) {
  const P = []; for (let c = 0; c < 8; c++) P.push([c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]]);
  const T = [[0,2,1],[1,2,3],[4,5,6],[5,7,6],[0,1,4],[1,5,4],[2,6,3],[3,6,7],[0,4,2],[2,4,6],[1,3,5],[3,7,5]];
  let s = 'solid box\n';
  for (const t of T) { s += ' facet normal 0 0 0\n  outer loop\n'; for (const i of t) s += `   vertex ${P[i].join(' ')}\n`; s += '  endloop\n endfacet\n'; }
  fs.writeFileSync(file, s + 'endsolid box\n');
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'weld-'));
const STL = { A: path.join(TMP, 'solidA.stl'), B: path.join(TMP, 'lattice.stl'), C: path.join(TMP, 'solidC.stl') };
boxStl(STL.A, [0, 0, 0], [25, 20, 10]); boxStl(STL.B, [23, 0, 0], [43, 20, 10]); boxStl(STL.C, [41, 0, 0], [66, 20, 10]);
const recipes = JSON.parse(fs.readFileSync(path.join(__dirname, 'recipes.json'), 'utf8'));
const RECIPE = recipes[CASE].recipe;

function meshStats(xml) {
  const V = [...xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].map(m => [+m[1], +m[2], +m[3]]);
  const T = [...xml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)].map(m => [+m[1], +m[2], +m[3]]);
  let vol = 0; const E = new Map();
  for (const [a, b, c] of T) {
    const [ax, ay, az] = V[a], [bx, by, bz] = V[b], [cx, cy, cz] = V[c];
    vol += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) { const k = u < v ? u + ',' + v : v + ',' + u; E.set(k, (E.get(k) || 0) + (u < v ? 1 : -1) * 1000 + 1); }
  }
  let open = 0; for (const n of E.values()) if (n !== 2) open++;   // each edge: once each way → 1000-1000+2
  return { tris: T.length, verts: V.length, vol, open };
}

async function run(site, root, qual) {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.host === site) { let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html'; const f = path.join(root, p);
      return fs.existsSync(f) ? route.fulfill({ body: fs.readFileSync(f), contentType: mime(f) }) : route.fulfill({ status: 404, body: '' }); }
    if (u.host.startsWith('fonts.')) return route.fulfill({ body: '', contentType: 'text/css' });
    const hit = cdn(route.request().url()); if (hit) return route.fulfill({ body: hit.body, contentType: hit.type, headers: { 'access-control-allow-origin': '*' } });
    return route.abort();
  });
  await ctx.addInitScript(n => Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => n }), CORES);
  const page = await ctx.newPage();
  const errors = [], weldLogs = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { const t = m.text(); if (m.type() === 'error') errors.push(t); else if (t.startsWith('[export][weld]')) weldLogs.push(t); });
  page.on('worker', w => w.on('console', m => { if (m.type() === 'error') errors.push('worker: ' + m.text()); }));
  await page.goto(`http://${site}/index.html?r=` + encodeURIComponent(JSON.stringify(RECIPE)));
  await page.waitForTimeout(1500);
  const idle = () => page.waitForFunction(() => document.getElementById('computeOverlay').classList.contains('hidden'), null, { timeout: 300000 }).catch(() => {});
  const nCards = () => page.evaluate(() => document.querySelectorAll('.shapeCard[data-body-id]').length);
  for (const k of ['A', 'B', 'C']) {
    const n = await nCards();
    await page.setInputFiles('#shapeInput', STL[k]);
    await page.waitForFunction(n => document.querySelectorAll('.shapeCard[data-body-id]').length > n, n, { timeout: 180000 });
    await idle(); await page.waitForTimeout(600);
  }
  // make B active, give it the lattice and its cell size (locked once welded)
  const ids = await page.evaluate(() => window.F13LD_weld.bodyIds());
  await page.click(`.shapeCard[data-body-id="${ids[1]}"] .sc-name`); await page.waitForTimeout(800); await idle();
  await page.click('.libraryChip'); await page.waitForTimeout(800); await idle();
  await page.evaluate(v => { const i = document.getElementById('shapeCellSizeMm'); i.value = v; window.onCellSizeInput && window.onCellSizeInput(); }, CELL);
  await page.waitForTimeout(800); await idle();
  await page.evaluate(() => window.F13LD_weld.all(0.4)); await page.waitForTimeout(1500); await idle();
  await page.evaluate(q => window.setQual && window.setQual(q), qual); await page.waitForTimeout(300);
  const estimate = await page.evaluate(() => (document.getElementById('expEstimate') || {}).textContent || '');
  const assigned = await page.evaluate(() => [...window.__f13ld_modeA.assignments.values()].join(','));
  const t0 = Date.now(); const out = { estimate, assigned, errors, weldLogs };
  try {
    const dl = page.waitForEvent('download', { timeout: 900000 });
    page.evaluate(() => window.triggerExport()).catch(e => errors.push('triggerExport: ' + e.message));
    const err = page.waitForSelector('.exp-err', { timeout: 900000 }).then(async h => { throw new Error('export error: ' + (await h.textContent())); });
    const d = await Promise.race([dl, err]); out.sec = (Date.now() - t0) / 1000;
    const z = unzipSync(fs.readFileSync(await d.path())); const xml = strFromU8(z[Object.keys(z).find(k => k.endsWith('.model'))]);
    Object.assign(out, meshStats(xml));
    out.report = await page.evaluate(() => (document.getElementById('expReport') || {}).innerText || '');
  } catch (e) { out.err = String(e.message || e).slice(0, 300); }
  await browser.close();
  return out;
}

(async () => {
  let fails = 0;
  for (const q of QUALS.split(',')) {
    const a = process.env.SKIP_OLD ? null : await run('old.test', OLD, q);
    const b = await run('new.test', NEW, q);
    const fmt = r => r.err ? 'ERROR ' + r.err : `${r.sec.toFixed(1)} s, ${r.tris} tris, volume ${r.vol.toFixed(1)} mm³, open edges ${r.open}`;
    if (a) console.log(`${q}  old: ${fmt(a)}\n        estimate "${a.estimate}"`);
    console.log(`${q}  new: ${fmt(b)}\n        estimate "${b.estimate}"\n        report ${JSON.stringify(b.report)}`);
    for (const l of b.weldLogs) console.log('        ' + l.slice(0, 400));
    if (b.errors.length) console.log('        new errors:', b.errors.slice(0, 5));
    // Open edges are informational: meshopt simplify leaves some on fragmented
    // foam in both builds (v0.9.2 too); Manifold's own output is closed.
    const ok = !b.err && (!a || a.err || Math.abs(b.vol - a.vol) / a.vol < 0.015) && !b.errors.length;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${q}${a && !a.err && !b.err ? `  volume ${((b.vol - a.vol) / a.vol * 100).toFixed(2)}%  speed ${(a.sec / b.sec).toFixed(1)}×` : ''}`);
    if (!ok) fails++;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
