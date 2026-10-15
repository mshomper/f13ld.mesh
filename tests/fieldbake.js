// v0.11.0 single-body field pre-bake: Cancel and a second export while the
// field is being computed on several cores.
// Usage: node fieldbake.js <build> [case] [quality]
//   Starts an export, waits for "computing field on N cores", presses Cancel,
//   checks every worker is gone, then exports again and checks the report
//   shows the cores chip. Defaults: foam2-open-lloyd at ultra, 4 cores.
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const NM = path.join(__dirname, 'node_modules');
const [BUILD, CASE = 'foam2-open-lloyd', QUAL = 'ultra'] = process.argv.slice(2);
const CORES = +(process.env.CORES || 4);
const MIME = { js: 'application/javascript', mjs: 'application/javascript', html: 'text/html',
  css: 'text/css', wasm: 'application/wasm', json: 'application/json' };
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
(async () => {
  const R = JSON.parse(fs.readFileSync(path.join(__dirname, 'recipes.json'), 'utf8'));
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.host === 'build.test') { let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html'; const f = path.join(BUILD, p);
      return fs.existsSync(f) ? route.fulfill({ body: fs.readFileSync(f), contentType: mime(f) }) : route.fulfill({ status: 404, body: '' }); }
    if (u.host.startsWith('fonts.')) return route.fulfill({ body: '', contentType: 'text/css' });
    const hit = cdn(route.request().url());
    return hit ? route.fulfill({ body: hit.body, contentType: hit.type, headers: { 'access-control-allow-origin': '*' } }) : route.abort();
  });
  await ctx.addInitScript(n => Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => n }), CORES);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://build.test/index.html?r=' + encodeURIComponent(JSON.stringify(R[CASE].recipe)));
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => document.getElementById('computeOverlay').classList.contains('hidden'), null, { timeout: 120000 }).catch(() => {});
  await page.evaluate(q => window.setQual(q), QUAL);
  const base = page.workers().length;
  page.evaluate(() => window.triggerExport()).catch(() => {});
  let saw = 0;
  await page.waitForFunction(() => /computing field on \d+ cores/.test((document.getElementById('coSub') || {}).textContent || ''), null, { timeout: 120000 })
    .then(() => { saw = 1; }).catch(() => {});
  const during = page.workers().length;
  await page.evaluate(() => window.cancelMesh());
  await page.waitForTimeout(1500);
  const after = page.workers().length;
  console.log(`cancel during field bake: saw progress=${!!saw} workers before=${base} during=${during} after=${after} → ${saw && during > base + 1 && after <= base ? 'PASS' : 'FAIL'}`);
  const dl = page.waitForEvent('download', { timeout: 540000 });
  page.evaluate(() => window.triggerExport()).catch(() => {});
  const d = await dl.catch(e => null);
  const rep = await page.evaluate(() => ((document.querySelector('.exp-report') || {}).innerText || '').replace(/\s+/g, ' '));
  console.log(`export again: ${d ? 'downloaded' : 'NO FILE'}  report: ${rep}`);
  console.log(`page errors: ${errors.length ? errors.slice(0, 3).join(' | ') : 'none'}`);
  await browser.close();
})();
